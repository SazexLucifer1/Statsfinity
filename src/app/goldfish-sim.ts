import type { MetricCard, MetricCombo, MetricInput } from './deck-metrics';
import { completeCombos, isLand, isUntappedLand, isWinCombo, manaProduced } from './deck-metrics';

/**
 * Goldfish-Simulation: In welchem Zug KÖNNTE dieses Deck gewinnen, und wie oft?
 *
 * "Goldfish" heißt: ohne Gegner. Das Deck spielt gegen niemanden, niemand kontert, niemand
 * entfernt etwas. Genau deshalb misst die Simulation das, was die rechnerischen Kennzahlen in
 * deck-metrics.ts nicht können - nicht "frühestens Zug 3", sondern "in 18 % der Spiele bis Zug 3".
 * Zwei Decks mit derselben günstigsten Combo unterscheiden sich enorm darin, wie zuverlässig sie
 * ihre Teile finden, und genau das ist der Unterschied zwischen einem Deck mit einer Combo und
 * einem cEDH-Deck.
 *
 * ==========================================================================================
 * DIE ANNAHMEN SIND DAS ERGEBNIS
 *
 * Eine Simulation ist nur so gut wie die Regeln, nach denen sie spielt - und eine Zahl, deren
 * Regeln man nicht nachlesen kann, ist wertlos. Deshalb stehen sie hier vollständig und als
 * Konstanten, nicht verstreut im Code:
 *
 *   1. Immer auf dem Spiel (kein Zug im ersten Zug) - das ist der schnellstmögliche Fall.
 *   2. Mulligan bei weniger als MIN_LAENDER oder mehr als MAX_LAENDER Manaquellen in der Hand,
 *      höchstens MAX_MULLIGANS mal. Nach London wandern so viele Karten unter die Bibliothek,
 *      wie oft gemulligant wurde - abgelegt werden die teuersten.
 *   3. Ein Landdrop pro Zug, ungetappte Länder zuerst. Ein getapptes Land erzeugt im Zug seines
 *      Spielens kein Mana.
 *   4. Manaquellen werden gespielt, sobald bezahlbar, billigste zuerst.
 *   5. Ein Tutor wird gespielt, wenn er bezahlbar ist und einer gewinnenden Combo genau ein Teil
 *      fehlt; er legt dieses Teil auf die Hand.
 *   6. Gewonnen ist, sobald alle Teile einer gewinnenden Combo verfügbar sind (Hand, Spiel oder
 *      Kommandozone) und das Mana für die noch ungespielten Teile plus das Zusatzmana der Combo
 *      im selben Zug reicht.
 *   7. Abbruch nach MAX_ZUEGE Zügen.
 *
 * Was die Simulation bewusst NICHT kann: Karten ziehen als Effekt (ein Rhystic Study zieht hier
 * nichts), Manafarben (Mana ist eine Zahl, keine Farbe), Rückseiten, alternative Kosten. Sie
 * überschätzt dadurch farbintensive Decks und unterschätzt Decks, die über Kartenziehen laufen.
 * Beides steht im Bericht, damit niemand die Zahl für mehr hält, als sie ist.
 * ==========================================================================================
 */

export const MIN_LAENDER = 2;
export const MAX_LAENDER = 5;
export const MAX_MULLIGANS = 3;
export const MAX_ZUEGE = 10;
export const STARTHAND = 7;

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

/** Eine Karte je Exemplar - die Simulation zieht Karten, nicht Deckzeilen. */
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

/**
 * Ein einzelnes Spiel. Liefert den Siegzug oder null.
 *
 * Die Reihenfolge im Zug folgt Punkt 3-6 der Annahmen oben und ist bewusst stur: Land, Manaquellen,
 * Tutor, Siegprüfung. Kein Abwägen, keine Vorausplanung - alles davon wären weitere Annahmen.
 */
function spielen(
  bibliothek: MetricCard[],
  siegCombos: MetricCombo[],
  kommandozone: MetricCard[],
  tutorSchluessel: Set<string>,
  manaWerte: Map<string, MetricCard>,
): number | null {
  const hand = bibliothek.slice(0, STARTHAND);
  let naechste = STARTHAND;

  /** Gespielte Manaquellen (ohne Länder) und Länder getrennt - Länder liefern 1, Quellen ihren Ertrag. */
  const gespielteQuellen: MetricCard[] = [];
  let laenderImSpiel = 0;
  let getapptesLandDiesenZug = 0;
  const verfuegbar = new Set(kommandozone.map((c) => c.key));

  for (const karte of hand) verfuegbar.add(karte.key);

  for (let zug = 1; zug <= MAX_ZUEGE; zug++) {
    // 1. Ziehen (nicht im ersten Zug, siehe Annahme 1)
    if (zug > 1 && naechste < bibliothek.length) {
      const gezogen = bibliothek[naechste++];
      hand.push(gezogen);
      verfuegbar.add(gezogen.key);
    }

    // 2. Landdrop, ungetappte zuerst
    getapptesLandDiesenZug = 0;
    const laender = hand.filter(isLand);
    const land = laender.find(isUntappedLand) ?? laender[0];
    if (land) {
      hand.splice(hand.indexOf(land), 1);
      laenderImSpiel++;
      if (!isUntappedLand(land)) getapptesLandDiesenZug = 1;
    }

    let mana =
      laenderImSpiel -
      getapptesLandDiesenZug +
      gespielteQuellen.reduce((s, c) => s + manaProduced(c), 0);

    // 3. Manaquellen ausspielen, billigste zuerst
    for (const quelle of [...hand]
      .filter((c) => !isLand(c) && manaProduced(c) > 0)
      .sort((a, b) => a.cmc - b.cmc)) {
      if (quelle.cmc > mana) continue;
      hand.splice(hand.indexOf(quelle), 1);
      gespielteQuellen.push(quelle);
      mana += manaProduced(quelle) - quelle.cmc;
    }

    // 4. Tutor, wenn er genau ein fehlendes Teil holen kann
    const tutor = hand.find((c) => tutorSchluessel.has(c.key) && c.cmc <= mana);
    if (tutor) {
      const fehlend = fehlendesEinzelteil(siegCombos, verfuegbar);
      if (fehlend) {
        hand.splice(hand.indexOf(tutor), 1);
        mana -= tutor.cmc;
        verfuegbar.add(fehlend);
        const geholt = manaWerte.get(fehlend);
        if (geholt) hand.push(geholt);
      }
    }

    // 5. Reicht es für eine gewinnende Combo?
    for (const combo of siegCombos) {
      if (!combo.cards.every((k) => verfuegbar.has(k))) continue;
      const offen = combo.cards
        .filter((k) => !gespielteQuellen.some((q) => q.key === k))
        .reduce((summe, k) => summe + (manaWerte.get(k)?.cmc ?? 0), 0);
      if (offen + combo.manaValueNeeded <= mana) return zug;
    }
  }

  return null;
}

/** Der eine fehlende Schlüssel, wenn genau einer einer gewinnenden Combo fehlt - sonst null. */
function fehlendesEinzelteil(siegCombos: MetricCombo[], verfuegbar: Set<string>): string | null {
  for (const combo of siegCombos) {
    const fehlend = combo.cards.filter((k) => !verfuegbar.has(k));
    if (fehlend.length === 1) return fehlend[0];
  }
  return null;
}

/** Taugt die Starthand, oder wird gemulligant? Siehe Annahme 2. */
function handTaugt(hand: MetricCard[]): boolean {
  const quellen = hand.filter(istManaquelle).length;
  return quellen >= MIN_LAENDER && quellen <= MAX_LAENDER;
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

  const manaWerte = new Map(input.cards.map((c) => [c.key, c]));
  const kommandozone = input.cards.filter((c) => c.isCommander);
  const tutorSchluessel = new Set(
    input.cards.filter((c) => input.flags.get(c.key)?.tutor === true).map((c) => c.key),
  );
  // Der Commander liegt in der Kommandozone, nicht in der Bibliothek - sonst zöge die Simulation
  // ihn und die Combos, die ihn brauchen, kämen nur mit Glück zustande.
  const stapel = bibliothekAus(input.cards.filter((c) => !c.isCommander));

  const zufall = rng(seed);
  const siegZuege: number[] = [];

  for (let spiel = 0; spiel < games; spiel++) {
    let bibliothek = mischen(stapel, zufall);
    for (let mulligan = 0; mulligan < MAX_MULLIGANS; mulligan++) {
      if (handTaugt(bibliothek.slice(0, STARTHAND))) break;
      bibliothek = mischen(stapel, zufall);
      // London: je Mulligan eine Karte zurück - die teuerste der Starthand.
      const hand = bibliothek.slice(0, STARTHAND);
      const teuerste = hand.reduce((max, c) => (c.cmc > max.cmc ? c : max), hand[0]);
      if (teuerste) bibliothek.splice(bibliothek.indexOf(teuerste), 1);
    }

    const zug = spielen(bibliothek, siegCombos, kommandozone, tutorSchluessel, manaWerte);
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
