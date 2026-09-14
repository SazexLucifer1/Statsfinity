import type { MetricCard, MetricCombo, MetricInput } from './deck-metrics';
import { completeCombos, isLand, isUntappedLand, isWinCombo, manaProduced } from './deck-metrics';
import type { ManaColor, ManaCost, ManaSource, ManaUnit } from './mana-symbols';
import { parseManaCost, payManaCost, poolAus } from './mana-symbols';

/**
 * Goldfish-Simulation: In welchem Zug KÖNNTE dieses Deck gewinnen, und wie oft?
 *
 * "Goldfish" heißt: ohne Gegner. Das Deck spielt gegen niemanden, niemand kontert, niemand
 * entfernt etwas. Genau deshalb misst die Simulation das, was die rechnerischen Kennzahlen in
 * deck-metrics.ts nicht können - nicht "frühestens Zug 3", sondern "in 18 % der Spiele bis Zug 3".
 *
 * ==========================================================================================
 * SIE SPIELT NACH DEN OFFIZIELLEN REGELN, UND JEDE REGEL IST BELEGT
 *
 * Eine Simulation ist nur so gut wie die Regeln, nach denen sie spielt - und eine Regel, die man
 * nicht nachschlagen kann, ist keine Regel, sondern eine Behauptung. Deshalb steht an jeder
 * Stelle, an der hier eine Regel greift, ihre Nummer aus den Comprehensive Rules; die Absätze im
 * Wortlaut samt Fassung und Fundstelle in docs/mtg-regeln.md.
 *
 * Was Regel ist (CR-Nummer im Code an der jeweiligen Stelle):
 *
 *   R1  Commander ist Mehrspieler-Freeforall: 40 Leben, 100 Karten, Singleton, Commander in der
 *       Kommandozone, Commander-Steuer ab dem zweiten Wirken.      903.1/.2/.5a/.5b/.7/.8, 119.1c
 *   R2  Sieben Karten Starthand, London-Mulligan: neue Sieben, danach Karten unter die
 *       Bibliothek - im Mehrspieler-Spiel ist der erste Mulligan davon frei.        103.5, 103.5c
 *   R3  Im Mehrspieler-Spiel überspringt NIEMAND den Ziehschritt des ersten Zuges - auch nicht,
 *       wer anfängt. (Im Zweispieler-Spiel wäre es andersherum.)                  103.8a, 103.8c
 *   R4  Zugablauf: Enttappen, Versorgung, Ziehen, erste Hauptphase, Endschritt.
 *                                                   500.1, 502.3, 503.1, 504.1, 505.6, 513.1
 *   R5  Ein Land je Zug, aus der Hand, in der eigenen Hauptphase.              305.1, 305.2, .2a
 *   R6  Getappte Bleibende liefern kein Mana - was getappt ins Spiel kommt, ist in diesem Zug
 *       keine Manaquelle.                                                       701.26a, 106.12
 *   R7  Einsatzverzögerung: Eine KREATUR mit {T} in den Aktivierungskosten kann erst tappen,
 *       wenn sie seit Zugbeginn im Spiel ist. Für Artefakte gilt das nicht - ein Sol Ring
 *       liefert im Zug seines Ausspielens.                                                 302.6
 *   R8  Farbiges Mana lässt sich nur mit der passenden Farbe bezahlen, generisches mit allem;
 *       Hybrid, Phyrexia und {X} nach ihren eigenen Regeln.  107.3, 107.4a-h, 202.3e, 601.2b/f/g
 *       (die ganze Rechnung dazu in mana-symbols.ts)
 *   R9  Der Manavorrat leert sich am Ende jedes Schritts und jeder Phase - innerhalb der
 *       Hauptphase bleibt er erhalten, und Manafähigkeiten dürfen mitten im Bezahlen aktiviert
 *       werden.                                                               106.4, 605.3a
 *   R10 Ziehen heißt: oberste Karte der Bibliothek auf die Hand.                            121.1
 *   R11 Lebenspunkte lassen sich nur zahlen, solange welche da sind.                        118.3
 *
 * Was HEURISTIK ist - Entscheidungen, die kein Regelwerk trifft, sondern ein Spieler. Sie sind
 * bewusst stur und ohne Vorausplanung gehalten, damit das Ergebnis erklärbar bleibt:
 *
 *   H1  Behalten oder mulligan: MIN_QUELLEN bis MAX_QUELLEN Manaquellen in der Hand, höchstens
 *       MAX_MULLIGANS mal. Unter die Bibliothek wandern die teuersten Karten.
 *   H2  Landdrop: ungetapptes Land vor getapptem; unter gleichen ein Land, das eine Farbe
 *       liefert, die noch fehlt.
 *   H3  Reihenfolge in der Hauptphase: Siegprüfung, Fast Mana, Commander (sofern er Mana macht
 *       oder zieht), Kartenziehen, übrige Rampe, Tutor - nach jeder gespielten Karte von vorn,
 *       weil jede neues Mana oder neue Karten bringen kann.
 *   H4  Ein Tutor wird gespielt, wenn er bezahlbar ist und einer gewinnenden Combo noch etwas
 *       fehlt; er legt ein fehlendes Teil jener Combo auf die Hand, der am wenigsten fehlt.
 *   H5  Gewonnen ist, sobald alle Teile einer gewinnenden Combo verfügbar sind (Hand, Spiel oder
 *       Kommandozone) und das Mana für die noch ungespielten Teile plus das Zusatzmana der Combo
 *       im selben Zug reicht.
 *   H6  Abbruch nach MAX_ZUEGE Zügen.
 *
 * Was sie NICHT kann, und in welche Richtung sie dadurch irrt:
 *
 *   - Nur Combo-Siege. Ein Deck, das über Kreaturenschaden gewinnt, gewinnt hier nie. Das ist
 *     keine Lücke, sondern die Aussage "dieses Deck hat keinen schnellen, wiederholbaren Weg".
 *   - Kartenziehen nur als einmaliger Effekt (Instant/Sorcery und ETB) und als unbedingter
 *     Trigger im Versorgungs-, Zieh- oder Endschritt. Bedingtes Ziehen (Rhystic Study, "you may
 *     draw"), aktivierte Ziehfähigkeiten und alles über Kampfschaden fehlen - die Simulation
 *     unterschätzt dadurch Decks, die darüber laufen.
 *   - Manaquellen kommen aus Scryfalls produced_mana plus der ergiebigsten "Add"-Klausel. Eine
 *     Karte mit zwei verschieden teuren Manafähigkeiten wird dadurch zu gut bewertet, eine mit
 *     "Add {G} for each …" zu schlecht.
 *   - Keine Rückseiten, keine alternativen Kosten (Force of Will bleibt {3}{U}{U}), kein Stax,
 *     keine Friedhöfe, kein Angriff.
 * ==========================================================================================
 */

/** Manaquellen in der Starthand, ab/bis denen sie behalten wird (H1). */
export const MIN_QUELLEN = 2;
export const MAX_QUELLEN = 5;
export const MAX_MULLIGANS = 3;
export const MAX_ZUEGE = 10;

/** CR 103.5: "Each player draws a number of cards equal to their starting hand size, which is normally seven." */
export const STARTHAND = 7;

/** CR 119.1c: "In a Commander game, each player's starting life total is 40." */
export const STARTLEBEN = 40;

/** CR 305.2: "A player can normally play one land during their turn […]" */
const LANDDROPS_PRO_ZUG = 1;

/** Sicherheitsnetz gegen Endlosschleifen in der Hauptphase - mehr Karten spielt keine Hand. */
const MAX_AKTIONEN_PRO_ZUG = 40;

export interface GoldfishResult {
  /** Anteil Spiele, die überhaupt bis MAX_ZUEGE gewonnen haben (0-1). */
  winRate: number;
  /** Median-Zug des Sieges über die gewonnenen Spiele, null wenn keins gewonnen wurde. */
  medianWinTurn: number | null;
  /** Anteil Spiele mit Sieg bis einschließlich Zug 3 / 4 / 5 (0-1). */
  winByTurn3: number;
  winByTurn4: number;
  winByTurn5: number;
  /** Wie viele Spiele gerechnet wurden - für die Einordnung der Prozentwerte. */
  games: number;
}

/**
 * Mulberry32 - winziger, schneller Zufallsgenerator mit Startwert.
 *
 * Bewusst NICHT Math.random(): Zwei Läufe über dasselbe Deck müssen dieselbe Zahl liefern, sonst
 * ist weder der Test festzunageln noch ein Bericht reproduzierbar.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =====================================================================================
// Was eine Karte in der Simulation tut - einmal je Deck ausgerechnet, nicht je Spiel
// =====================================================================================

const KREATUR_RE = /Creature/;
const SOFORT_RE = /Instant|Sorcery/;

/**
 * Braucht die Manafähigkeit dieser Karte das Tap-Symbol? Entscheidet über die
 * Einsatzverzögerung (R7).
 *
 * CR 106.12: "To 'tap [a permanent] for mana' is to activate a mana ability of that permanent that
 * includes the {T} symbol in its activation cost."
 */
const TAP_FUER_MANA_RE = /\{T\}[^:]*:[^.]*\badd\b/i;

/**
 * Einmaliges Kartenziehen beim Wirken bzw. beim Ins-Spiel-Kommen.
 *
 * Bewusst eng: Nur Instants/Sorceries und ETB-Auslöser. Alles Bedingte ("Whenever an opponent
 * casts", "you may draw") bleibt draußen, weil es ohne Gegner nicht auslöst und eine geschätzte
 * Trefferquote schlechter wäre als gar keine.
 */
const ZIEHT_RE = /\bdraws? (a|one|two|three|four|five|six|seven|eight|nine|ten|\d+) cards?/i;
const ZURUECK_RE =
  /puts? (a|one|two|three|four|five|six|seven|\d+) cards? from your hand on top of your library/i;
const ETB_ZIEHT_RE = /when[^.]*?\benters\b[^.]*?\bdraws? (a|one|two|three|\d+) cards?/i;

/**
 * Ein Ziehtrigger, der in jedem eigenen Zug feuert.
 *
 * CR 500.1 zählt die Phasen auf, die in JEDEM Zug stattfinden - "Each of these phases takes place
 * every turn, even if nothing happens during the phase". Ein Trigger im Versorgungs-, Zieh- oder
 * Endschritt zieht damit jeden Zug erneut, ohne dass ein Gegner etwas tun muss.
 *
 * Die zweite Gruppe fängt den Rest des Satzes ein, weil genau dort die Bedingung steht, die so
 * einen Trigger wertlos macht: "draw a card IF your life total is greater …". Ohne diese Prüfung
 * zöge die Simulation Karten, die am Tisch niemand bekäme.
 */
const VERSORGUNG_RE = /at the beginning of (?:your|each) (?:upkeep|draw step|end step)([^.]*)/i;
const BEDINGT_RE = /\bif\b|\bunless\b|\bmay\b|\bfor each\b/i;

const ZAHLWORT: Record<string, number> = {
  a: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function zahl(wort: string): number {
  return ZAHLWORT[wort.toLowerCase()] ?? Number(wort) ?? 0;
}

/** Eine Deckkarte mit allem, was die Simulation an ihr braucht - einmal vorgerechnet. */
interface SimKarte {
  karte: MetricCard;
  kosten: ManaCost;
  land: boolean;
  /** Kommt bedingungslos getappt ins Spiel (R6). */
  getappt: boolean;
  kreatur: boolean;
  /** Instant oder Sorcery - liegt nach dem Wirken nicht im Spiel. */
  fluechtig: boolean;
  /** Was sie an Mana liefert, oder null. */
  quelle: ManaSource | null;
  /** Ihre Manafähigkeit braucht {T} (R7). */
  brauchtTap: boolean;
  /** Karten, die sie beim Wirken bzw. Ins-Spiel-Kommen netto zieht. */
  ziehtEinmalig: number;
  /** Karten, die sie in jedem eigenen Versorgungsschritt zieht. */
  ziehtProZug: number;
  tutor: boolean;
}

function farbenAus(card: MetricCard): ManaColor[] {
  const erlaubt: readonly string[] = ['W', 'U', 'B', 'R', 'G', 'C'];
  return card.producedMana.filter((f): f is ManaColor => erlaubt.includes(f));
}

/**
 * Welche Manaquelle ist diese Karte?
 *
 * Menge aus der ergiebigsten "Add"-Klausel (manaProduced() in deck-metrics.ts), Farben aus
 * Scryfalls produced_mana. Ein Land ohne "Add"-Klausel, das laut Scryfall trotzdem Mana erzeugt
 * (Regeltext in Erinnerungsklammern fehlt bei manchen Drucken), liefert ein Mana - sonst fiele
 * ausgerechnet ein Teil der Manabasis stumm aus der Rechnung.
 */
function quelleAus(card: MetricCard): ManaSource | null {
  const farben = farbenAus(card);
  if (farben.length === 0) return null;
  const menge = manaProduced(card);
  if (menge > 0) return { amount: menge, colors: farben };
  return isLand(card) ? { amount: 1, colors: farben } : null;
}

function ziehungenAus(card: MetricCard): { einmalig: number; proZug: number } {
  const text = card.oracleText;

  const versorgung = VERSORGUNG_RE.exec(text);
  const klausel = versorgung?.[1] ?? '';
  const proZugTreffer = BEDINGT_RE.test(klausel) ? null : ZIEHT_RE.exec(klausel);

  let einmalig = 0;
  if (SOFORT_RE.test(card.typeLine)) {
    const treffer = ZIEHT_RE.exec(text);
    if (treffer) einmalig = zahl(treffer[1]);
  } else {
    const treffer = ETB_ZIEHT_RE.exec(text);
    if (treffer) einmalig = zahl(treffer[1]);
  }
  const zurueck = ZURUECK_RE.exec(text);
  if (zurueck) einmalig -= zahl(zurueck[1]);

  return { einmalig: Math.max(0, einmalig), proZug: proZugTreffer ? zahl(proZugTreffer[1]) : 0 };
}

function simKarteAus(card: MetricCard, tutor: boolean): SimKarte {
  const { einmalig, proZug } = ziehungenAus(card);
  return {
    karte: card,
    kosten: parseManaCost(card.manaCost),
    land: isLand(card),
    getappt: !isUntappedLand(card),
    kreatur: KREATUR_RE.test(card.typeLine),
    fluechtig: SOFORT_RE.test(card.typeLine),
    quelle: quelleAus(card),
    brauchtTap: TAP_FUER_MANA_RE.test(card.oracleText),
    ziehtEinmalig: einmalig,
    ziehtProZug: proZug,
    tutor,
  };
}

// =====================================================================================
// Ein einzelnes Spiel
// =====================================================================================

/** Ein bleibendes Objekt im Spiel. */
interface Bleibend {
  sim: SimKarte;
  /** Zug, in dem es ins Spiel kam - für die Einsatzverzögerung (R7, CR 302.6). */
  seitZug: number;
  /** Ist es gerade getappt? (R6, CR 701.26a) */
  getappt: boolean;
  /** Hat es in diesem Zug schon Mana in den Vorrat gegeben? */
  abgerufen: boolean;
}

interface Spielstand {
  hand: SimKarte[];
  bibliothek: SimKarte[];
  gezogen: number;
  spiel: Bleibend[];
  kommandozone: SimKarte[];
  /** CR 106.4: der Manavorrat der laufenden Hauptphase. */
  pool: ManaUnit[];
  leben: number;
  zug: number;
  landdropsOffen: number;
  /** Alles, was verfügbar ist: Hand, Spiel, Kommandozone - der Schlüsselvorrat für Combos. */
  verfuegbar: Set<string>;
  imSpiel: Set<string>;
}

function generisch(betrag: number): ManaCost {
  return { generic: betrag, requirements: [], unknown: [] };
}

/** CR 121.1: "A player draws a card by putting the top card of their library into their hand." */
function ziehen(stand: Spielstand, anzahl: number): void {
  for (let i = 0; i < anzahl && stand.gezogen < stand.bibliothek.length; i++) {
    const karte = stand.bibliothek[stand.gezogen++];
    stand.hand.push(karte);
    stand.verfuegbar.add(karte.karte.key);
  }
}

/**
 * Alles abrufen, was in diesem Zug noch Mana liefern kann.
 *
 * CR 605.3a erlaubt das Aktivieren von Manafähigkeiten jederzeit, auch mitten im Bezahlen - die
 * Simulation zieht das an den Anfang und nach jede gespielte Manaquelle vor. Innerhalb der
 * Hauptphase geht dabei nichts verloren, weil der Vorrat sich erst am Ende der Phase leert
 * (CR 106.4).
 */
function manaAbrufen(stand: Spielstand): void {
  for (const bleibend of stand.spiel) {
    if (bleibend.abgerufen || bleibend.getappt || !bleibend.sim.quelle) continue;
    // CR 302.6: Einsatzverzögerung gilt nur für Kreaturen mit {T} in den Aktivierungskosten.
    if (bleibend.sim.kreatur && bleibend.sim.brauchtTap && bleibend.seitZug >= stand.zug) continue;
    bleibend.abgerufen = true;
    bleibend.getappt = bleibend.sim.brauchtTap;
    stand.pool.push(...poolAus([bleibend.sim.quelle]));
  }
}

/** Eine Karte aus der Hand ins Spiel bzw. auf den Friedhof bringen, nachdem bezahlt wurde. */
function wirken(stand: Spielstand, sim: SimKarte): void {
  stand.hand.splice(stand.hand.indexOf(sim), 1);
  if (!sim.fluechtig) {
    stand.spiel.push({ sim, seitZug: stand.zug, getappt: sim.getappt, abgerufen: false });
    stand.imSpiel.add(sim.karte.key);
  }
  // Ein Ritual (Instant/Sorcery mit "Add") liefert sein Mana beim Verrechnen, nicht dauerhaft.
  if (sim.fluechtig && sim.quelle) stand.pool.push(...poolAus([sim.quelle]));
  if (sim.ziehtEinmalig > 0) ziehen(stand, sim.ziehtEinmalig);
}

/** Kann und will die Simulation diese Karte jetzt bezahlen? Wenn ja, wird gezahlt. */
function bezahlen(stand: Spielstand, kosten: ManaCost): boolean {
  const zahlung = payManaCost(kosten, stand.pool, stand.leben);
  if (!zahlung) return false;
  stand.pool = zahlung.pool;
  stand.leben -= zahlung.lifePaid; // CR 118.3
  return true;
}

/**
 * H2 - Landdrop. CR 305.1/305.2a: ein Land je Zug, aus der Hand, Hauptphase, Stapel leer.
 *
 * Ungetappt vor getappt, und unter gleichen das Land, das eine Farbe beisteuert, die im Spiel noch
 * fehlt. Ohne den zweiten Teil legte die Simulation in einem dreifarbigen Deck fünf Inseln und
 * erklärte jeden schwarzen Zauberspruch für unbezahlbar.
 */
function landLegen(stand: Spielstand): void {
  if (stand.landdropsOffen <= 0) return;
  const laender = stand.hand.filter((s) => s.land);
  if (laender.length === 0) return;

  const vorhandeneFarben = new Set<ManaColor>();
  for (const bleibend of stand.spiel) {
    for (const farbe of bleibend.sim.quelle?.colors ?? []) vorhandeneFarben.add(farbe);
  }

  const wert = (s: SimKarte) => {
    const neueFarben = (s.quelle?.colors ?? []).filter((f) => !vorhandeneFarben.has(f)).length;
    return (s.getappt ? 0 : 100) + Math.min(neueFarben, 5) * 10 + (s.quelle?.amount ?? 0);
  };
  const land = laender.reduce((beste, s) => (wert(s) > wert(beste) ? s : beste), laender[0]);

  stand.hand.splice(stand.hand.indexOf(land), 1);
  stand.landdropsOffen--;
  stand.spiel.push({ sim: land, seitZug: stand.zug, getappt: land.getappt, abgerufen: false });
  stand.imSpiel.add(land.karte.key);
}

/**
 * H5 - Reicht es in diesem Zug für eine gewinnende Combo?
 *
 * Bezahlt wird der Reihe nach aus demselben Vorrat: erst die noch nicht gespielten Teile (billigste
 * zuerst), dann das Zusatzmana, das Commander Spellbook der Combo zuschreibt. Teile, die Länder
 * sind, brauchen einen offenen Landdrop (CR 305.2) - sonst wäre der Sieg mit zwei Ländern in der
 * Hand billiger, als er ist.
 */
function sieg(stand: Spielstand, combos: MetricCombo[], nachSchluessel: Map<string, SimKarte>) {
  for (const combo of combos) {
    if (!combo.cards.every((k) => stand.verfuegbar.has(k))) continue;

    const offen = combo.cards
      .filter((k) => !stand.imSpiel.has(k))
      .map((k) => nachSchluessel.get(k))
      .filter((s): s is SimKarte => s !== undefined)
      .sort((a, b) => a.karte.cmc - b.karte.cmc);

    if (offen.filter((s) => s.land).length > stand.landdropsOffen) continue;

    let pool = stand.pool;
    let leben = stand.leben;
    let reicht = true;
    for (const teil of offen) {
      if (teil.land) continue; // Landdrop, kein Manabetrag
      const zahlung = payManaCost(teil.kosten, pool, leben);
      if (!zahlung) {
        reicht = false;
        break;
      }
      pool = zahlung.pool;
      leben -= zahlung.lifePaid;
    }
    if (!reicht) continue;

    if (combo.manaValueNeeded > 0 && !payManaCost(generisch(combo.manaValueNeeded), pool, leben)) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * H4 - welches Teil holt ein Tutor?
 *
 * Das Teil der Combo, der am wenigsten fehlt. Die erste Fassung holte nur, wenn GENAU ein Teil
 * fehlte; das unterschätzte jedes Deck, das Tutoren verkettet - und genau das tun die Decks, die
 * hier interessieren. Fehlen zwei Teile, holt der erste Tutor eines davon, und ab dem nächsten Zug
 * greift die alte Regel.
 *
 * Ein Teil, das nur als Commander zählt (MetricCombo.mustBeCommander), wird nicht gesucht: Es
 * steht ohnehin in der Kommandozone oder gar nicht im Deck.
 */
function fehlendesTeil(combos: MetricCombo[], verfuegbar: Set<string>): string | null {
  let beste: { schluessel: string; fehlend: number } | null = null;
  for (const combo of combos) {
    const fehlend = combo.cards.filter(
      (k) => !verfuegbar.has(k) && !combo.mustBeCommander.includes(k),
    );
    if (fehlend.length === 0) continue;
    if (!beste || fehlend.length < beste.fehlend) {
      beste = { schluessel: fehlend[0], fehlend: fehlend.length };
    }
  }
  return beste?.schluessel ?? null;
}

/**
 * H3 - eine Hauptphase. Liefert true, wenn in diesem Zug gewonnen wurde.
 *
 * Die Reihenfolge ist stur und ohne Vorausplanung: nach jeder gespielten Karte beginnt sie von
 * vorn, weil eine Manaquelle neues Mana und ein Ziehzauber neue Karten auf die Hand bringt. Kein
 * Abwägen, kein Aufheben für nächsten Zug - alles davon wären weitere Annahmen.
 */
function hauptphase(
  stand: Spielstand,
  siegCombos: MetricCombo[],
  nachSchluessel: Map<string, SimKarte>,
): boolean {
  landLegen(stand);
  manaAbrufen(stand);

  for (let aktion = 0; aktion < MAX_AKTIONEN_PRO_ZUG; aktion++) {
    if (sieg(stand, siegCombos, nachSchluessel)) return true;

    // 1. Fast Mana: liefert noch in diesem Zug mehr, als es kostet.
    const schnell = stand.hand
      .filter((s) => !s.land && s.quelle !== null && s.quelle.amount > s.karte.cmc)
      .sort((a, b) => a.karte.cmc - b.karte.cmc)
      .find((s) => payManaCost(s.kosten, stand.pool, stand.leben) !== null);
    if (schnell && bezahlen(stand, schnell.kosten)) {
      wirken(stand, schnell);
      manaAbrufen(stand);
      continue;
    }

    // 2. Den Commander, wenn er selbst Mana macht oder zieht.
    //
    // CR 903.8: "A player may cast a commander they own from the command zone. A commander cast
    // from the command zone costs an additional {2} for each previous time the player casting it
    // has cast it from the command zone that game." Beim ERSTEN Mal ist dieser Aufschlag null, und
    // ein zweites Mal kommt in dieser Simulation nicht vor - es stirbt hier niemand.
    //
    // Ohne diesen Schritt stünde ein Kinnan oder Selvala nur als Combo-Teil in der Kommandozone
    // herum, obwohl der halbe Sinn dieser Commander ihre Manafähigkeit ist.
    const kommandeur = stand.kommandozone.find(
      (s) =>
        (s.quelle !== null || s.ziehtProZug > 0) &&
        payManaCost(s.kosten, stand.pool, stand.leben) !== null,
    );
    if (kommandeur && bezahlen(stand, kommandeur.kosten)) {
      stand.kommandozone.splice(stand.kommandozone.indexOf(kommandeur), 1);
      stand.spiel.push({
        sim: kommandeur,
        seitZug: stand.zug,
        getappt: kommandeur.getappt,
        abgerufen: false,
      });
      stand.imSpiel.add(kommandeur.karte.key);
      if (kommandeur.ziehtEinmalig > 0) ziehen(stand, kommandeur.ziehtEinmalig);
      manaAbrufen(stand);
      continue;
    }

    // 3. Kartenziehen - bevor das Mana in Rampe fließt, die dieser Zug nicht mehr nutzt.
    const zieht = stand.hand
      .filter((s) => s.ziehtEinmalig > 0 || s.ziehtProZug > 0)
      .sort((a, b) => a.karte.cmc - b.karte.cmc)
      .find((s) => payManaCost(s.kosten, stand.pool, stand.leben) !== null);
    if (zieht && bezahlen(stand, zieht.kosten)) {
      wirken(stand, zieht);
      manaAbrufen(stand);
      continue;
    }

    // 4. Übrige Manaquellen - zahlen sich erst ab dem nächsten Zug aus, aber sie zahlen sich aus.
    const rampe = stand.hand
      .filter((s) => !s.land && s.quelle !== null)
      .sort((a, b) => a.karte.cmc - b.karte.cmc)
      .find((s) => payManaCost(s.kosten, stand.pool, stand.leben) !== null);
    if (rampe && bezahlen(stand, rampe.kosten)) {
      wirken(stand, rampe);
      manaAbrufen(stand);
      continue;
    }

    // 5. H4 - Tutor, wenn er genau ein fehlendes Teil holen kann.
    const fehlend = fehlendesTeil(siegCombos, stand.verfuegbar);
    const tutor = fehlend
      ? stand.hand
          .filter((s) => s.tutor)
          .sort((a, b) => a.karte.cmc - b.karte.cmc)
          .find((s) => payManaCost(s.kosten, stand.pool, stand.leben) !== null)
      : undefined;
    if (fehlend && tutor && bezahlen(stand, tutor.kosten)) {
      stand.hand.splice(stand.hand.indexOf(tutor), 1);
      stand.verfuegbar.add(fehlend);
      const geholt = nachSchluessel.get(fehlend);
      if (geholt) stand.hand.push(geholt);
      continue;
    }

    break;
  }

  return sieg(stand, siegCombos, nachSchluessel);
}

/** Ein einzelnes Spiel. Liefert den Siegzug oder null. */
function spielen(
  bibliothek: SimKarte[],
  siegCombos: MetricCombo[],
  kommandozone: SimKarte[],
  nachSchluessel: Map<string, SimKarte>,
  starthand: number,
): number | null {
  const stand: Spielstand = {
    hand: [],
    bibliothek,
    gezogen: 0,
    spiel: [],
    // Eigene Kopie je Spiel: Wird der Commander gewirkt, verlässt er die Kommandozone - ohne
    // Kopie fehlte er ab dem zweiten der 2000 Spiele.
    kommandozone: [...kommandozone],
    pool: [],
    leben: STARTLEBEN, // CR 119.1c
    zug: 0,
    landdropsOffen: 0,
    // CR 903.8: Der Commander steht in der Kommandozone bereit, ohne gezogen werden zu müssen.
    verfuegbar: new Set(kommandozone.map((s) => s.karte.key)),
    imSpiel: new Set(),
  };
  ziehen(stand, starthand);

  for (let zug = 1; zug <= MAX_ZUEGE; zug++) {
    stand.zug = zug;

    // CR 502.3 (Enttappen): alles enttappt, und alles ist ab jetzt seit Zugbeginn im Spiel.
    for (const bleibend of stand.spiel) {
      bleibend.getappt = false;
      bleibend.abgerufen = false;
    }
    // CR 106.4: Der Vorrat des Vorzugs ist längst leer.
    stand.pool = [];
    stand.landdropsOffen = LANDDROPS_PRO_ZUG;

    // Wiederkehrende Ziehtrigger (CR 503 Versorgungsschritt, CR 504 Ziehschritt, CR 513
    // Endschritt). Alle drei werden hier am Zuganfang abgehandelt, und das geht auf: Ein
    // Versorgungs-Trigger feuert ohnehin jetzt, und ein Endschritt-Trigger des VORIGEN Zuges
    // hätte die Karte ebenfalls genau bis zu dieser Hauptphase auf der Hand.
    for (const bleibend of stand.spiel) {
      if (bleibend.sim.ziehtProZug > 0) ziehen(stand, bleibend.sim.ziehtProZug);
    }

    // CR 504.1 (Ziehschritt) - und CR 103.8c: im Mehrspieler-Spiel zieht auch der erste Zug.
    ziehen(stand, 1);

    // CR 505.6: erste Hauptphase.
    if (hauptphase(stand, siegCombos, nachSchluessel)) return zug;
  }

  return null;
}

// =====================================================================================
// Viele Spiele
// =====================================================================================

/** Eine Karte je Exemplar - die Simulation zieht Karten, nicht Deckzeilen. */
function bibliothekAus(karten: SimKarte[]): SimKarte[] {
  const stapel: SimKarte[] = [];
  for (const sim of karten) {
    for (let i = 0; i < sim.karte.quantity; i++) stapel.push(sim);
  }
  return stapel;
}

function mischen<T>(items: readonly T[], zufall: () => number): T[] {
  const kopie = [...items];
  for (let i = kopie.length - 1; i > 0; i--) {
    const j = Math.floor(zufall() * (i + 1));
    [kopie[i], kopie[j]] = [kopie[j], kopie[i]];
  }
  return kopie;
}

function istManaquelle(sim: SimKarte): boolean {
  return sim.land || sim.quelle !== null;
}

/** H1 - taugt die Starthand? */
function handTaugt(hand: readonly SimKarte[]): boolean {
  const quellen = hand.filter(istManaquelle).length;
  return quellen >= MIN_QUELLEN && quellen <= MAX_QUELLEN;
}

/**
 * London-Mulligan (R2, CR 103.5).
 *
 * "To take a mulligan, a player shuffles the cards in their hand back into their library, draws a
 * new hand of cards equal to their starting hand size, then puts a number of those cards equal to
 * the number of times that player has taken a mulligan on the bottom of their library in any
 * order."
 *
 * Genau so: immer sieben neue, und erst danach wandern Karten nach unten. WIE VIELE, sagt für
 * Commander aber nicht 103.5 allein, sondern CR 103.5c: "In a multiplayer game and in any Brawl
 * game, the first mulligan a player takes doesn't count toward the number of cards that player will
 * put on the bottom of their library or the number of mulligans that player may take. Subsequent
 * mulligans are counted toward these numbers as normal." Der erste Mulligan ist im Commander also
 * gratis - eine Regel, die eine Simulation, die sie übersieht, systematisch zu langsam macht.
 *
 * Unter die Bibliothek gehen die teuersten Karten (H1) - sie sind das, was eine Starthand am
 * wenigsten braucht.
 */
function starthandZiehen(
  stapel: readonly SimKarte[],
  zufall: () => number,
): { bibliothek: SimKarte[]; handGroesse: number } {
  let bibliothek = mischen(stapel, zufall);

  for (let mulligan = 0; mulligan <= MAX_MULLIGANS; mulligan++) {
    const hand = bibliothek.slice(0, STARTHAND);
    if (handTaugt(hand) || mulligan === MAX_MULLIGANS) {
      // CR 103.5c: der erste Mulligan zählt im Mehrspieler-Spiel nicht mit.
      const zurueck = Math.max(0, mulligan - 1);
      if (zurueck === 0) return { bibliothek, handGroesse: STARTHAND };

      // Die teuersten `zurueck` Karten unter die Bibliothek. Sortiert werden POSITIONEN und
      // nicht Karten: Ein Deck enthält dieselbe Karte zwar nur einmal (CR 903.5b), Standardländer
      // aber beliebig oft, und die teilen sich hier ein Objekt - über indexOf() träfe das
      // Zurücklegen dann zweimal dieselbe Stelle und die Hand behielte eine Karte zu viel.
      const nachUnten = hand
        .map((karte, index) => ({ karte, index }))
        .sort((a, b) => b.karte.karte.cmc - a.karte.karte.cmc)
        .slice(0, zurueck)
        .map((e) => e.index);
      const bleibt = hand.filter((_, i) => !nachUnten.includes(i));
      bibliothek = [...bleibt, ...bibliothek.slice(STARTHAND), ...nachUnten.map((i) => hand[i])];
      return { bibliothek, handGroesse: bleibt.length };
    }
    bibliothek = mischen(stapel, zufall);
  }

  return { bibliothek, handGroesse: STARTHAND };
}

/**
 * Simuliert `games` Spiele und fasst zusammen.
 *
 * Ohne gewinnende Combo im Deck kommt sofort ein Nullergebnis zurück: Die Simulation kennt nur
 * Combo-Siege. Ein Deck, das über Kreaturen gewinnt, gewinnt hier nie - das ist kein Fehler,
 * sondern die Aussage "dieses Deck hat keinen schnellen, wiederholbaren Weg zum Sieg".
 */
export function simulateGoldfish(input: MetricInput, games = 2000, seed = 1): GoldfishResult {
  const siegCombos = completeCombos(input).filter(isWinCombo);
  const leer: GoldfishResult = {
    winRate: 0,
    medianWinTurn: null,
    winByTurn3: 0,
    winByTurn4: 0,
    winByTurn5: 0,
    games,
  };
  if (siegCombos.length === 0) return leer;

  const simKarten = input.cards.map((c) => simKarteAus(c, input.flags.get(c.key)?.tutor === true));
  const nachSchluessel = new Map(simKarten.map((s) => [s.karte.key, s]));
  // CR 903.5a/903.8: Der Commander liegt in der Kommandozone, nicht in der Bibliothek.
  const kommandozone = simKarten.filter((s) => s.karte.isCommander);
  const stapel = bibliothekAus(simKarten.filter((s) => !s.karte.isCommander));

  const zufall = rng(seed);
  const siegZuege: number[] = [];

  for (let spiel = 0; spiel < games; spiel++) {
    const { bibliothek, handGroesse } = starthandZiehen(stapel, zufall);
    const zug = spielen(bibliothek, siegCombos, kommandozone, nachSchluessel, handGroesse);
    if (zug !== null) siegZuege.push(zug);
  }

  const sortiert = [...siegZuege].sort((a, b) => a - b);
  const anteilBis = (zug: number) => siegZuege.filter((z) => z <= zug).length / games;

  return {
    winRate: siegZuege.length / games,
    medianWinTurn:
      sortiert.length === 0
        ? null
        : sortiert.length % 2
          ? sortiert[(sortiert.length - 1) / 2]
          : (sortiert[sortiert.length / 2 - 1] + sortiert[sortiert.length / 2]) / 2,
    winByTurn3: anteilBis(3),
    winByTurn4: anteilBis(4),
    winByTurn5: anteilBis(5),
    games,
  };
}

/** Nur für den Test: ohne Export ließe sich das Kostenlesen der Simulation nicht festnageln. */
/**
 * Nur für den Test und für das Auswertungsskript: Ohne diesen Export ließe sich weder festnageln,
 * wie die Simulation eine Karte liest, noch im Bericht nachzählen, wie viel sie davon erfasst.
 */
export const _intern = { simKarteAus, ziehungenAus, quelleAus, starthandZiehen, bibliothekAus };
