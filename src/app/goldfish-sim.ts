import type { MetricCard, MetricCombo, MetricInput } from './deck-metrics';
import { completeCombos, isLand, isUntappedLand, isWinCombo, manaProduced } from './deck-metrics';
import type { ManaColor, ManaCost, ManaSource } from './mana';
import { manaUnits, parseManaCost, payFrom } from './mana';

/**
 * Goldfish-Simulation: In welchem Zug kann dieses Deck gewinnen, und wie oft?
 *
 * "Goldfish" heißt: ohne Gegner. Das Deck spielt gegen niemanden, niemand kontert, niemand
 * entfernt etwas. Genau deshalb misst die Simulation, was die Rechenformeln in deck-metrics.ts
 * nicht können - nicht "frühestens Zug 3", sondern "in 18 % der Spiele bis Zug 3".
 *
 * ==========================================================================================
 * JEDE SPIELREGEL HIER IST BELEGT
 *
 * Grundlage sind die offiziellen Comprehensive Rules, Fassung gültig ab 7. August 2026
 * (https://magic.wizards.com/en/rules). Jede Regel steht mit Nummer und Zitat an der Stelle, an
 * der sie angewandt wird. Was hier nicht belegt ist, ist eine bewusste VEREINFACHUNG und als
 * solche unter "Was die Simulation nicht kann" aufgezählt - nichts davon ist geraten.
 *
 * Die erste Fassung dieser Datei hatte drei Regeln schlicht falsch, alle drei zugunsten
 * langsamerer Decks:
 *
 *   - Sie ließ den ersten Zug ohne Ziehen. Das gilt laut CR 103.8a nur für Zweispielerpartien;
 *     CR 103.8c sagt für alles andere ausdrücklich das Gegenteil, und Commander ist ein
 *     Mehrspielerformat.
 *   - Sie legte bei jedem Mulligan eine Karte unter die Bibliothek. CR 103.5c nimmt im
 *     Mehrspieler den ERSTEN Mulligan davon aus.
 *   - Sie ließ Manakreaturen sofort tappen. CR 302.6 verbietet das im Zug ihres Erscheinens.
 * ==========================================================================================
 */

/** Startkartenzahl - CR 103.5: "a number of cards equal to their starting hand size, which is normally seven." */
export const STARTHAND = 7;

/**
 * Wann wird gemulligant. Keine Regel, sondern eine Spielentscheidung: CR 103.5 erlaubt jedem
 * Spieler, mit einer Hand unzufrieden zu sein, sagt aber nichts darüber, wann man das sein sollte.
 * Zwei bis fünf Manaquellen auf sieben Karten ist die verbreitete Faustregel.
 */
export const MIN_MANAQUELLEN = 2;
export const MAX_MANAQUELLEN = 5;

/** Mehr als drei Mulligans lohnen sich nicht - jeder kostet eine Karte (CR 103.5). */
export const MAX_MULLIGANS = 3;

/** Nach zehn Zügen ist eine Partie entschieden; danach misst die Simulation nichts mehr. */
export const MAX_ZUEGE = 10;

export interface GoldfishResult {
  /** Anteil Spiele mit Sieg bis MAX_ZUEGE (0-1). */
  winRate: number;
  /** Median-Zug des Sieges über die gewonnenen Spiele, null wenn keins gewonnen wurde. */
  medianWinTurn: number | null;
  winByTurn3: number;
  winByTurn4: number;
  winByTurn5: number;
  games: number;
}

/**
 * Mulberry32 - winziger Zufallsgenerator mit Startwert.
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
// Karten lesen
// =====================================================================================

/**
 * Wie viele Karten zieht diese Karte für ihren Beherrscher?
 *
 * Bewusst eng gefasst: Nur "draw a card" / "draw N cards", und nur wenn im selben Satz weder ein
 * Gegner noch "each player" steht - sonst zöge ein Howling Mine hier Karten für uns. Karten, die
 * über Bedingungen oder Auslöser ziehen (Rhystic Study), zählen nicht; das ist eine bekannte
 * Untergrenze und steht so im Bericht.
 */
const ZIEH_RE = /draws? (a|one|two|three|four|five|\d+) cards?/gi;
const FREMD_RE = /opponent|each player|target player|other player/i;
const ZAHLWORT: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };

export function cardsDrawn(card: MetricCard): number {
  let summe = 0;
  for (const satz of card.oracleText.split(/(?<=[.;])\s+/)) {
    if (FREMD_RE.test(satz)) continue;
    for (const treffer of satz.matchAll(ZIEH_RE)) {
      const wort = treffer[1].toLowerCase();
      summe += ZAHLWORT[wort] ?? Number(wort) ?? 0;
    }
  }
  return summe;
}

/**
 * Braucht diese Manaquelle die Tap-Fähigkeit einer Kreatur?
 *
 * CR 302.6: "A creature's activated ability with the tap symbol ... can't be activated unless the
 * creature has been under its controller's control continuously since their most recent turn
 * began. ... This rule is informally called the 'summoning sickness' rule."
 *
 * Gilt ausdrücklich nur für KREATUREN - ein Sol Ring darf im Zug seines Erscheinens tappen, ein
 * Llanowar Elves nicht.
 */
function istEinsatzverzoegert(card: MetricCard, seitZug: number, aktuellerZug: number): boolean {
  const kreatur = /Creature/.test(card.typeLine);
  const brauchtTap = /\{T\}/.test(card.oracleText);
  return kreatur && brauchtTap && seitZug >= aktuellerZug;
}

/** Eine Karte im Spiel, samt dem Zug, in dem sie kam - Grundlage für CR 302.6. */
interface Permanent {
  card: MetricCard;
  seitZug: number;
  /** Kam getappt ins Spiel und erzeugt deshalb in diesem Zug noch nichts. */
  getapptGekommen: boolean;
}

function manaQuelleAus(p: Permanent, zug: number): ManaSource | null {
  const menge = manaProduced(p.card);
  if (menge === 0) return null;
  if (p.getapptGekommen && p.seitZug === zug) return null;
  if (istEinsatzverzoegert(p.card, p.seitZug, zug)) return null;

  const farben = (p.card.producedMana ?? []).filter((f): f is ManaColor =>
    ['W', 'U', 'B', 'R', 'G', 'C'].includes(f),
  );
  return { amount: menge, colors: farben };
}

/** Mehrere Kostenzeilen zu einer zusammenfassen - für "alle fehlenden Combo-Teile in einem Zug". */
function kostenSumme(kosten: ManaCost[], zusaetzlichGenerisch = 0): ManaCost {
  return {
    generic: kosten.reduce((s, k) => s + k.generic, zusaetzlichGenerisch),
    requirements: kosten.flatMap((k) => k.requirements),
    hasX: false,
  };
}

// =====================================================================================
// Ein Spiel
// =====================================================================================

export interface Spielstand {
  hand: MetricCard[];
  bibliothek: MetricCard[];
  naechste: number;
  spielfeld: Permanent[];
  /** Kommandozone - CR 903.8: von dort spielbar, beim ersten Mal zu den aufgedruckten Kosten. */
  kommandozone: MetricCard[];
  landGespieltDiesenZug: boolean;
}

function ziehen(stand: Spielstand, anzahl: number): void {
  for (let i = 0; i < anzahl && stand.naechste < stand.bibliothek.length; i++) {
    stand.hand.push(stand.bibliothek[stand.naechste++]);
  }
}

/** Alles, was gerade Mana erzeugen kann - siehe CR 601.2g: Manafähigkeiten vor dem Bezahlen. */
function verfuegbaresMana(stand: Spielstand, zug: number): ManaColor[][] {
  const quellen = stand.spielfeld
    .map((p) => manaQuelleAus(p, zug))
    .filter((q): q is ManaSource => q !== null);
  return manaUnits(quellen);
}

/**
 * Ein einzelnes Spiel. Liefert den Siegzug oder null.
 *
 * Der Zugaufbau folgt CR 500.1 ("A turn consists of five phases") in der Reihenfolge, die für ein
 * Goldfish überhaupt etwas bewirkt: entwickeln (CR 502.3), ziehen (CR 504.1), Hauptphase
 * (CR 505). Kampf und Endphase bleiben leer, weil die Simulation nur Combo-Siege kennt.
 */
function spielen(
  stand: Spielstand,
  siegCombos: MetricCombo[],
  tutoren: Set<string>,
): number | null {
  const nachSchluessel = new Map<string, MetricCard>();
  for (const k of [...stand.bibliothek, ...stand.kommandozone]) nachSchluessel.set(k.key, k);

  for (let zug = 1; zug <= MAX_ZUEGE; zug++) {
    // ENTWICKLUNGSPHASE, Enttappen - CR 502.3: "the active player determines which permanents
    // they control will untap. Then they untap them all simultaneously." Im Modell heißt das:
    // Alle Quellen stehen in jedem Zug wieder zur Verfügung, es wird nichts mitgeschleppt.

    // ZIEHSCHRITT - CR 504.1: "First, the active player draws a card."
    // Auch im ersten Zug: CR 103.8c "In all other multiplayer games, no player skips the draw
    // step of their first turn." Nur die Zweispielerpartie überspringt ihn (CR 103.8a), und
    // Commander wird als Mehrspielerformat gespielt.
    ziehen(stand, 1);

    // HAUPTPHASE - CR 505. Hier passiert alles Übrige.
    stand.landGespieltDiesenZug = false;

    // Ein Land pro Zug - CR 305.2: "A player can normally play one land during their turn."
    // Ungetappte zuerst: Ein Land, das getappt kommt, erzeugt in diesem Zug noch nichts.
    const laender = stand.hand.filter(isLand);
    const land = laender.find(isUntappedLand) ?? laender[0];
    if (land) {
      stand.hand.splice(stand.hand.indexOf(land), 1);
      stand.spielfeld.push({
        card: land,
        seitZug: zug,
        getapptGekommen: !isUntappedLand(land),
      });
      stand.landGespieltDiesenZug = true;
    }

    // Zaubern, solange sich etwas Sinnvolles bezahlen lässt. Die Reihenfolge ist bewusst stur:
    // erst gewinnen, dann Mana entwickeln, dann suchen, dann ziehen. Jede Abweichung davon wäre
    // eine weitere Annahme über Spielkunst, die sich nicht belegen ließe.
    //
    // Das verfügbare Mana wird EINMAL je Zug ermittelt und danach fortgeschrieben. Es in jeder
    // Runde neu aus dem Spielfeld zu lesen wäre falsch: Ausgegebenes Mana käme zurück, und das
    // Deck könnte beliebig viele Zauber pro Zug spielen. CR 500.5 leert den Manavorrat am Ende
    // jedes Abschnitts - innerhalb eines Zuges ist er eine endliche Menge, keine Quelle.
    let mana = verfuegbaresMana(stand, zug);
    let weiter = true;
    while (weiter) {
      weiter = false;

      // 1. Reicht es, um eine gewinnende Combo in diesem Zug abzuschließen?
      if (gewinntJetzt(stand, siegCombos, mana, nachSchluessel)) return zug;

      // 2. Manaquelle ausspielen, billigste zuerst - sie kann im selben Zug weiteres ermöglichen.
      const quelle = billigsteBezahlbare(
        stand.hand.filter((c) => !isLand(c) && manaProduced(c) > 0),
        mana,
      );
      if (quelle) {
        mana = bezahlen(quelle, mana);
        stand.hand.splice(stand.hand.indexOf(quelle), 1);
        const gespielt = { card: quelle, seitZug: zug, getapptGekommen: false };
        stand.spielfeld.push(gespielt);
        // Eine frisch gespielte Manaquelle steht sofort zur Verfügung - sofern sie nicht als
        // Kreatur unter CR 302.6 fällt; genau das prüft manaQuelleAus().
        const neu = manaQuelleAus(gespielt, zug);
        if (neu) mana = [...mana, ...manaUnits([neu])];
        weiter = true;
        continue;
      }

      // 3. Tutor, wenn er genau ein fehlendes Teil einer Siegcombo holt.
      const tutor = billigsteBezahlbare(
        stand.hand.filter((c) => tutoren.has(c.key)),
        mana,
      );
      if (tutor) {
        const fehlend = fehlendesEinzelteil(stand, siegCombos);
        if (fehlend) {
          const geholt = nachSchluessel.get(fehlend);
          if (geholt) {
            mana = bezahlen(tutor, mana);
            stand.hand.splice(stand.hand.indexOf(tutor), 1);
            stand.hand.push(geholt);
            weiter = true;
            continue;
          }
        }
      }

      // 4. Kartenziehen - der Weg, auf dem cEDH-Decks ihre Teile finden.
      const zieher = billigsteBezahlbare(
        stand.hand.filter((c) => cardsDrawn(c) > 0 && !isLand(c)),
        mana,
      );
      if (zieher) {
        mana = bezahlen(zieher, mana);
        stand.hand.splice(stand.hand.indexOf(zieher), 1);
        ziehen(stand, cardsDrawn(zieher));
        weiter = true;
      }
    }
  }

  return null;
}

/** Die billigste Karte aus der Auswahl, die sich mit diesem Mana bezahlen lässt - sonst null. */
function billigsteBezahlbare(karten: MetricCard[], mana: ManaColor[][]): MetricCard | null {
  for (const karte of [...karten].sort((a, b) => a.cmc - b.cmc)) {
    if (payFrom(parseManaCost(karte.manaCost), mana) !== null) return karte;
  }
  return null;
}

function bezahlen(karte: MetricCard, mana: ManaColor[][]): ManaColor[][] {
  return payFrom(parseManaCost(karte.manaCost), mana) ?? mana;
}

/**
 * Lässt sich in diesem Zug eine gewinnende Combo abschließen?
 *
 * Verlangt, dass alle Teile verfügbar sind (Hand, Spielfeld oder Kommandozone) und die noch
 * ungespielten zusammen mit dem Zusatzmana der Combo in einem Zug bezahlbar sind. Die Kosten
 * werden dafür zu einer Zeile zusammengefasst - CR 601.2h verlangt vollständige Bezahlung,
 * Teilzahlungen gibt es nicht.
 */
function gewinntJetzt(
  stand: Spielstand,
  siegCombos: MetricCombo[],
  mana: ManaColor[][],
  nachSchluessel: Map<string, MetricCard>,
): boolean {
  const imSpiel = new Set(stand.spielfeld.map((p) => p.card.key));
  const inHand = new Set(stand.hand.map((c) => c.key));
  const zone = new Set(stand.kommandozone.map((c) => c.key));

  for (const combo of siegCombos) {
    if (!combo.cards.every((k) => imSpiel.has(k) || inHand.has(k) || zone.has(k))) continue;

    const offen = combo.cards.filter((k) => !imSpiel.has(k));
    const kosten = offen.map((k) => parseManaCost(nachSchluessel.get(k)?.manaCost ?? ''));
    if (payFrom(kostenSumme(kosten, combo.manaValueNeeded), mana) !== null) return true;
  }
  return false;
}

/** Der eine fehlende Schlüssel, wenn genau einer einer gewinnenden Combo fehlt - sonst null. */
function fehlendesEinzelteil(stand: Spielstand, siegCombos: MetricCombo[]): string | null {
  const verfuegbar = new Set([
    ...stand.spielfeld.map((p) => p.card.key),
    ...stand.hand.map((c) => c.key),
    ...stand.kommandozone.map((c) => c.key),
  ]);
  for (const combo of siegCombos) {
    const fehlend = combo.cards.filter((k) => !verfuegbar.has(k));
    if (fehlend.length === 1) return fehlend[0];
  }
  return null;
}

// =====================================================================================
// Aufbau und Durchlauf
// =====================================================================================

/** Eine Karte je Exemplar - gezogen werden Karten, keine Deckzeilen. */
function bibliothekAus(cards: MetricCard[]): MetricCard[] {
  const stapel: MetricCard[] = [];
  for (const karte of cards) {
    for (let i = 0; i < karte.quantity; i++) stapel.push(karte);
  }
  return stapel;
}

function mischen<T>(items: T[], zufall: () => number): T[] {
  const kopie = [...items];
  for (let i = kopie.length - 1; i > 0; i--) {
    const j = Math.floor(zufall() * (i + 1));
    [kopie[i], kopie[j]] = [kopie[j], kopie[i]];
  }
  return kopie;
}

function istManaquelle(karte: MetricCard): boolean {
  return isLand(karte) || manaProduced(karte) > 0;
}

function handTaugt(hand: MetricCard[]): boolean {
  const quellen = hand.filter(istManaquelle).length;
  return quellen >= MIN_MANAQUELLEN && quellen <= MAX_MANAQUELLEN;
}

/**
 * Startaufstellung samt Mulligan - CR 103.5.
 *
 * "To take a mulligan, a player shuffles the cards in their hand back into their library, draws a
 * new hand of cards equal to their starting hand size, then puts a number of those cards equal to
 * the number of times that player has taken a mulligan on the bottom of their library."
 *
 * Und der Grund, warum der erste Mulligan hier gratis ist - CR 103.5c: "In a multiplayer game and
 * in any Brawl game, the first mulligan a player takes doesn't count toward the number of cards
 * that player will put on the bottom of their library or the number of mulligans that player may
 * take." Commander wird als Mehrspielerformat gespielt, also gilt das hier.
 *
 * Unter die Bibliothek wandern die teuersten Karten - CR 103.5 lässt die Wahl ("in any order"),
 * und teuer zuerst ist die verbreitete Entscheidung.
 */
export function starthand(stapel: MetricCard[], zufall: () => number): Spielstand {
  let bibliothek = mischen(stapel, zufall);
  let hand = bibliothek.slice(0, STARTHAND);
  let genommen = 0;

  while (!handTaugt(hand) && genommen < MAX_MULLIGANS) {
    genommen++;
    bibliothek = mischen(stapel, zufall);
    hand = bibliothek.slice(0, STARTHAND);

    // CR 103.5c: Der erste Mulligan kostet im Mehrspieler keine Karte.
    const abzulegen = Math.max(0, genommen - 1);
    for (let i = 0; i < abzulegen && hand.length > 0; i++) {
      const teuerste = hand.reduce((max, c) => (c.cmc > max.cmc ? c : max), hand[0]);
      hand.splice(hand.indexOf(teuerste), 1);
    }
  }

  return {
    hand,
    bibliothek,
    naechste: STARTHAND,
    spielfeld: [],
    kommandozone: [],
    landGespieltDiesenZug: false,
  };
}

/**
 * Simuliert `games` Spiele und fasst zusammen.
 *
 * Ohne gewinnende Combo im Deck kommt sofort ein Nullergebnis zurück: Die Simulation kennt nur
 * Combo-Siege. Ein Deck, das über Kreaturen gewinnt, gewinnt hier nie - das ist kein Fehler,
 * sondern die Aussage "dieses Deck hat keinen schnellen, wiederholbaren Weg zum Sieg".
 *
 * Was die Simulation bewusst NICHT kann, und was deshalb zu jeder ihrer Zahlen dazugehört:
 *   - Gegner. Niemand kontert, niemand entfernt, niemand gewinnt vorher.
 *   - Ausgelöstes und bedingtes Kartenziehen (Rhystic Study, Kaskade, Impulse-Effekte).
 *   - Alternativkosten (Force of Will), Rückseiten, Landzyklen, Fetchländer.
 *   - Zauber, die nur unter Bedingungen wirken, und jede Art von Abwägung.
 * Alles davon macht echte Decks schneller, nicht langsamer - die Zahlen sind also eine
 * Untergrenze.
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

  const kommandozone = input.cards.filter((c) => c.isCommander);
  const tutoren = new Set(
    input.cards.filter((c) => input.flags.get(c.key)?.tutor === true).map((c) => c.key),
  );
  // Der Commander liegt in der Kommandozone, nicht in der Bibliothek - CR 903.8 erlaubt, ihn von
  // dort zu spielen. Läge er im Stapel, käme jede Combo mit ihm nur mit Ziehglück zustande.
  const stapel = bibliothekAus(input.cards.filter((c) => !c.isCommander));

  const zufall = rng(seed);
  const siegZuege: number[] = [];

  for (let spiel = 0; spiel < games; spiel++) {
    const stand = starthand(stapel, zufall);
    stand.kommandozone = [...kommandozone];
    const zug = spielen(stand, siegCombos, tutoren);
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
