/*
 * Combo-Pilot für die Forge-Bots der Statsfinity-Bracket-Simulation.
 *
 * Dieser Code wird vor dem Build in Forge (https://github.com/Card-Forge/forge) hineinkopiert und ist
 * damit ein abgeleitetes Werk von Forge. Er steht deshalb wie Forge unter der GNU General Public
 * License, Version 3 oder später. Die Statsfinity-App selbst enthält und lädt diesen Code nicht.
 *
 * WOZU: Forges Bots spielen jedes Deck als Kreaturen-Deck. In 180 Kalibrierungspartien hat kein einziges
 * Deck per Combo gewonnen (sim/testdecks/README.md) - genau das, was Bracket 4 und 5 ausmacht, kam in der
 * Simulation nicht vor. Der Pilot gibt dem Bot die spielbeendenden Combos seines Decks
 * (scripts/forge/siegplan.js, Daten von Commander Spellbook) und spielt sie:
 *
 *   1. Liegen alle Teile einer Combo in ihren Zonen und reicht das Mana, FÜHRT er sie VOR: Ein Zauber
 *      "Combo: ..." mit genau diesen Kosten kommt auf den Stapel und gewinnt beim Auflösen das Spiel.
 *      Das ist die Abkürzung, die man am Turniertisch auch nimmt, statt eine Schleife tausendmal
 *      auszuspielen - aber als echter Zauber: Gegner können ihn kontern.
 *   2. Fehlt nur noch ein Teil auf dem Spielfeld und liegt es in der Hand, wirkt er es - Kreaturen aber nur,
 *      wenn danach im selben Zug vorgeführt werden kann, oder (mit Flash) am Ende des Zuges direkt vor dem
 *      eigenen. Eine allein ausgelegte Combo-Kreatur ist eine Einladung an jeden Gegner: In der ersten
 *      Pilot-Partie hat Thrasios/Tymna dem Ishai-Deck den frisch gewirkten Hullbreaker Horror mit Gilded Drake
 *      gestohlen - der Bot hatte sich dafür im eigenen Zug leergetappt, sogar mit Lotus Petal, einem Teil
 *      seiner zweiten Combo. Aus demselben Grund hält zurueckhalten() den normalen Forge-Bot davon ab, solche
 *      Kreaturen einfach so auszuspielen.
 *   3. Sonst spielt Forge normal. Tutoren greifen von selbst zu fehlenden Teilen, weil siegplan.js sie
 *      als KeyCards in die Deckliste schreibt.
 *
 * Die Combos je Deck liegen als Textdatei <Deckname>.combos im Ordner FORGE_COMBO_DIR, eine Combo je Zeile:
 *   Karte A@B;Karte B@HG | 3 U | 1:2 | Infinite damage
 *   Teile mit ihren erlaubten Zonen (B Spielfeld, H Hand, G Friedhof, C Kommandozone, E Exil, L Bibliothek)
 *   | zusätzliches Mana in Forge-Schreibweise | Platzhalter "Anzahl:höchster Manawert" für Karten, die
 *   Spellbook nur beschreibt ("a permanent castable for {C}{C}") | Ergebnis.
 */
package forge.ai;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import forge.card.CardRarity;
import forge.card.CardRules;
import forge.deck.Deck;
import forge.game.Game;
import forge.game.card.Card;
import forge.game.card.CardFactory;
import forge.game.keyword.Keyword;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;
import forge.item.PaperCard;

public final class ComboPilot {

    private record Teil(String name, String zonen) {}

    private record Combo(List<Teil> teile, String mana, int extraAnzahl, int extraMaxMv, String ergebnis) {}

    /** Je Deckname, einmal je Java-Prozess gelesen (eine Partie = ein Prozess, siehe forge-partie.js). */
    private static final Map<String, List<Combo>> COMBOS = new ConcurrentHashMap<>();

    /**
     * Vorführversuche je Spieler und Zug. Ein gekonterter Versuch darf wiederholt werden, wenn das Mana reicht -
     * aber nicht endlos, falls Forge den Zauber aus einem unvorhergesehenen Grund nicht zu Ende bringt.
     */
    private static final Map<Player, int[]> VERSUCHE = new ConcurrentHashMap<>();
    private static final int MAX_VERSUCHE_JE_ZUG = 3;

    /** Vom Piloten selbst gewählte Zauber - die hält zurueckhalten() nicht auf. */
    private static final Set<SpellAbility> FREIGEGEBEN = ConcurrentHashMap.newKeySet();

    private ComboPilot() {}

    /** null = der Pilot hat nichts vor, Forge entscheidet wie immer. */
    public static List<SpellAbility> waehle(final Player ai) {
        final List<Combo> combos = combosFuer(ai);
        if (combos.isEmpty()) {
            return null;
        }
        for (final Combo c : combos) {
            final SpellAbility sa = vorfuehren(ai, c);
            if (sa != null) {
                return List.of(sa);
            }
        }
        for (final Combo c : combos) {
            final SpellAbility sa = naechstesTeil(ai, c);
            if (sa != null) {
                return List.of(sa);
            }
        }
        return null;
    }

    /**
     * Aus AiController.canPlaySa(): Soll der normale Forge-Bot diesen Zauber gerade NICHT wirken? Betrifft nur
     * Kreaturen, die als Teil einer Sieg-Combo aufs Spielfeld gehören - ausgelegt werden die vom Piloten, wenn
     * es sich lohnt (naechstesTeil). Manasteine wie Sol Ring bleiben frei: Sie sind als Mana ohnehin richtig
     * gespielt und werden selten gezielt entfernt.
     */
    public static boolean zurueckhalten(final Player ai, final SpellAbility sa) {
        if (FREIGEGEBEN.contains(sa) || !sa.isSpell()) {
            return false;
        }
        final Card karte = sa.getHostCard();
        if (karte == null || !karte.isCreature() || karte.isInZone(ZoneType.Battlefield)) {
            return false;
        }
        for (final Combo c : combosFuer(ai)) {
            for (final Teil t : c.teile()) {
                if (t.zonen().contains("B") && t.name().equals(karte.getName())) {
                    return true;
                }
            }
        }
        return false;
    }

    // ------------------------------------------------------------------ Vorführen

    private static SpellAbility vorfuehren(final Player ai, final Combo c) {
        final List<Card> teile = findeTeile(ai, c);
        if (teile == null) {
            return null;
        }
        final Game game = ai.getGame();
        final int zug = game.getPhaseHandler().getTurn();
        final int[] versuche = VERSUCHE.computeIfAbsent(ai, p -> new int[] {-1, 0});
        if (versuche[0] != zug) {
            versuche[0] = zug;
            versuche[1] = 0;
        }
        if (versuche[1] >= MAX_VERSUCHE_JE_ZUG) {
            return null;
        }

        // Kosten: das zusätzliche Mana der Combo plus der Manawert aller Teile, die erst noch aus der Hand
        // gewirkt werden müssen - die Vorführung ersetzt deren Wirken, also müssen auch deren Kosten bezahlt sein.
        int generisch = 0;
        for (int i = 0; i < c.teile().size(); i++) {
            if (teile.get(i).isInZone(ZoneType.Hand)) {
                generisch += teile.get(i).getCMC();
            }
        }
        final int extraMv = extraKarten(ai, teile, c);
        if (extraMv < 0) {
            return null;
        }
        generisch += extraMv;
        final String kosten = kosten(c.mana(), generisch);

        // Reste eines früheren Versuchs, den Forge nicht zu Ende gespielt hat, zuerst wegräumen.
        for (final Card alt : ai.getCardsIn(ZoneType.Hand)) {
            if (alt.getName().startsWith("Combo: ")) {
                ai.getZone(ZoneType.Hand).remove(alt);
            }
        }
        final String name = "Combo: " + c.ergebnis();
        final List<String> skript = List.of(
                "Name:" + name,
                "ManaCost:" + kosten,
                "Types:Instant",
                "A:SP$ WinsGame | Defined$ You | SpellDescription$ Führt die Combo vor und gewinnt das Spiel.",
                "Oracle:Führt die Combo vor und gewinnt das Spiel.");
        final Card karte = CardFactory.getCard(new PaperCard(CardRules.fromScript(skript), "", CardRarity.Common), ai, game);
        // Direkt in die Hand gelegt, nicht über GameAction: Die Karte existiert nur für diesen einen Zauber und
        // soll keine "Karte kommt auf die Hand"-Auslöser erzeugen.
        ai.getZone(ZoneType.Hand).add(karte);
        final SpellAbility sa = karte.getFirstSpellAbility();
        sa.setActivatingPlayer(ai);
        if (!sa.canPlay() || !ComputerUtilCost.canPayCost(sa, ai, false)) {
            ai.getZone(ZoneType.Hand).remove(karte);
            return null;
        }
        versuche[1]++;
        FREIGEGEBEN.add(sa);
        System.out.println("ComboPilot: " + ai.getName() + " führt vor - " + beschreibe(c) + " (Kosten " + kosten + ")");
        return sa;
    }

    // ------------------------------------------------------------------ Teile auslegen

    /**
     * Genau ein Teil fehlt noch auf dem Spielfeld und liegt in der Hand oder Kommandozone: wirken, wenn es sich
     * lohnt (siehe Kopf der Datei). Fehlen mehrere, wartet der Pilot - die Tutoren holen über die KeyCards nach,
     * und eine halbe Combo auf dem Tisch nützt nur den Gegnern.
     */
    private static SpellAbility naechstesTeil(final Player ai, final Combo c) {
        final Set<Card> benutzt = new HashSet<>();
        Card fehlend = null;
        for (final Teil t : c.teile()) {
            final Card anPlatz = suche(ai, t.name(), t.zonen(), benutzt);
            if (anPlatz != null) {
                benutzt.add(anPlatz);
                continue;
            }
            if (fehlend != null || !t.zonen().contains("B")) {
                return null;
            }
            fehlend = suche(ai, t.name(), "HC", benutzt);
            if (fehlend == null) {
                return null;
            }
            benutzt.add(fehlend);
        }
        if (fehlend == null) {
            return null;
        }
        final Game game = ai.getGame();
        if (fehlend.isCreature()) {
            final int rest = ComputerUtilMana.getAvailableManaEstimate(ai, true) - fehlend.getCMC();
            final boolean imSelbenZug = rest >= manaWert(c.mana()) + c.extraAnzahl() * c.extraMaxMv();
            final Player amZug = game.getPhaseHandler().getPlayerTurn();
            final boolean flashVorMeinemZug = fehlend.hasKeyword(Keyword.FLASH)
                    && game.getPhaseHandler().is(PhaseType.END_OF_TURN)
                    && amZug != ai && game.getNextPlayerAfter(amZug) == ai;
            if (!imSelbenZug && !flashVorMeinemZug) {
                return null;
            }
        }
        for (final SpellAbility sa : fehlend.getAllPossibleAbilities(ai, true)) {
            if (!sa.isSpell()) {
                continue;
            }
            sa.setActivatingPlayer(ai);
            if (sa.canPlay() && ComputerUtilCost.canPayCost(sa, ai, false)) {
                FREIGEGEBEN.add(sa);
                System.out.println("ComboPilot: " + ai.getName() + " legt Combo-Teil aus - " + fehlend.getName());
                return sa;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ Zonen

    /** Je Teil die Karte, die es erfüllt, in derselben Reihenfolge - oder null, wenn eines fehlt. */
    private static List<Card> findeTeile(final Player ai, final Combo c) {
        final Set<Card> benutzt = new HashSet<>();
        final List<Card> gefunden = new ArrayList<>();
        for (final Teil t : c.teile()) {
            final Card k = suche(ai, t.name(), t.zonen(), benutzt);
            if (k == null) {
                return null;
            }
            benutzt.add(k);
            gefunden.add(k);
        }
        return gefunden;
    }

    private static Card suche(final Player ai, final String name, final String zonen, final Set<Card> benutzt) {
        for (final char z : zonen.toCharArray()) {
            final ZoneType zone = switch (z) {
                case 'B' -> ZoneType.Battlefield;
                case 'H' -> ZoneType.Hand;
                case 'G' -> ZoneType.Graveyard;
                case 'C' -> ZoneType.Command;
                case 'E' -> ZoneType.Exile;
                case 'L' -> ZoneType.Library;
                default -> null;
            };
            if (zone == null) {
                continue;
            }
            for (final Card k : ai.getCardsIn(zone)) {
                if (!benutzt.contains(k) && k.getName().equals(name)
                        && (zone != ZoneType.Battlefield || k.getController() == ai)) {
                    return k;
                }
            }
        }
        return null;
    }

    /**
     * Spellbook beschreibt manche Teile nur ("a permanent castable for {C}{C}"). Dafür muss eine passende
     * Handkarte da sein, die kein anderes Teil ist. Liefert die Summe ihrer Manawerte oder -1.
     */
    private static int extraKarten(final Player ai, final List<Card> teile, final Combo c) {
        if (c.extraAnzahl() == 0) {
            return 0;
        }
        final List<Card> passend = new ArrayList<>();
        for (final Card k : ai.getCardsIn(ZoneType.Hand)) {
            if (!teile.contains(k) && k.isPermanent() && !k.isLand() && k.getCMC() <= c.extraMaxMv()) {
                passend.add(k);
            }
        }
        if (passend.size() < c.extraAnzahl()) {
            return -1;
        }
        passend.sort((a, b) -> Integer.compare(a.getCMC(), b.getCMC()));
        int summe = 0;
        for (int i = 0; i < c.extraAnzahl(); i++) {
            summe += passend.get(i).getCMC();
        }
        return summe;
    }

    // ------------------------------------------------------------------ Datei

    private static List<Combo> combosFuer(final Player ai) {
        final String ordner = System.getenv("FORGE_COMBO_DIR");
        if (ordner == null || ai.getRegisteredPlayer() == null) {
            return List.of();
        }
        final Deck deck = ai.getRegisteredPlayer().getDeck();
        if (deck == null || deck.getName() == null) {
            return List.of();
        }
        return COMBOS.computeIfAbsent(deck.getName(), n -> lese(new File(ordner, n + ".combos")));
    }

    private static List<Combo> lese(final File datei) {
        if (!datei.isFile()) {
            return List.of();
        }
        final List<Combo> combos = new ArrayList<>();
        try {
            for (final String zeile : Files.readAllLines(datei.toPath(), StandardCharsets.UTF_8)) {
                if (zeile.isBlank() || zeile.startsWith("#")) {
                    continue;
                }
                final String[] f = zeile.split("\\|", -1);
                if (f.length < 4) {
                    continue;
                }
                final List<Teil> teile = new ArrayList<>();
                for (final String t : f[0].trim().split(";")) {
                    final int at = t.lastIndexOf('@');
                    if (at > 0) {
                        teile.add(new Teil(t.substring(0, at).trim(), t.substring(at + 1).trim()));
                    }
                }
                final String[] extra = f[2].trim().split(":");
                combos.add(new Combo(teile, f[1].trim(), Integer.parseInt(extra[0]),
                        extra.length > 1 ? Integer.parseInt(extra[1]) : 0, f[3].trim()));
            }
        } catch (final IOException | RuntimeException e) {
            System.err.println("ComboPilot: " + datei + " nicht lesbar: " + e.getMessage());
        }
        return combos;
    }

    // ------------------------------------------------------------------ Hilfen

    /** "3 U" + 2 generisch -> "5 U"; leer + 0 -> "0". */
    static String kosten(final String mana, final int zusaetzlich) {
        int generisch = zusaetzlich;
        final StringBuilder farbig = new StringBuilder();
        for (final String teil : mana.trim().split("\\s+")) {
            if (teil.isEmpty()) {
                continue;
            }
            if (teil.matches("\\d+")) {
                generisch += Integer.parseInt(teil);
            } else {
                farbig.append(' ').append(teil);
            }
        }
        final String s = (generisch > 0 ? String.valueOf(generisch) : "") + farbig;
        return s.isBlank() ? "0" : s.trim();
    }

    /** Manawert einer Kostenangabe in Forge-Schreibweise: "3 U U" -> 5. */
    static int manaWert(final String mana) {
        int summe = 0;
        for (final String teil : mana.trim().split("\\s+")) {
            if (teil.isEmpty()) {
                continue;
            }
            summe += teil.matches("\\d+") ? Integer.parseInt(teil) : 1;
        }
        return summe;
    }

    private static String beschreibe(final Combo c) {
        final StringBuilder sb = new StringBuilder();
        for (final Teil t : c.teile()) {
            if (sb.length() > 0) {
                sb.append(" + ");
            }
            sb.append(t.name());
        }
        return sb.append(" -> ").append(c.ergebnis()).toString();
    }
}
