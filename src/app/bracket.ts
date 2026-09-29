import type { SpellbookCardFlags, SpellbookTwoCardCombo } from './card-data.service';
import type { SpellbookBracketTag } from './commander-spellbook.service';

/**
 * Einstufung eines Commander-Decks in die offiziellen Brackets 1-5 (Exhibition, Core, Upgraded,
 * Optimized, cEDH). Reine Rechenfunktionen ohne Angular/Netzwerk, damit bracket.spec.ts jede Regel
 * einzeln prüfen kann.
 *
 * Bewusst NICHT: 1. Nie 1 oder 5 vergeben - die unterscheiden sich durch Absicht, nicht durch
 * Karten (suggestsCedh weist bei starken B4-Decks darauf hin). 2. Keine Obergrenze - das Ergebnis
 * ist immer "mindestens Bracket X".
 */

export type BracketLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Anzuzeigende Stufe aus den gespeicherten Werten (Listen ohne geladene Karten). Manuell schlägt
 * Automatik; außerhalb von Commander null, damit kein Abzeichen erscheint.
 */
export function storedDeckBracket(deck: {
  format: string | null;
  bracket: number | null;
  bracketAuto: number | null;
}): { level: number; source: 'manual' | 'auto' } | null {
  if (deck.format !== 'Commander') return null;
  if (deck.bracket != null) return { level: deck.bracket, source: 'manual' };
  return deck.bracketAuto != null ? { level: deck.bracketAuto, source: 'auto' } : null;
}

/** Höchste Stufe, die die Automatik vergibt - siehe Punkt 1 oben. */
export const AUTO_BRACKET_MAX = 4;

/**
 * Ab diesem Tuning-Grad (0-1) bekommt ein B4-Deck den cEDH-Hinweis. Am Tuning-Grad statt am
 * Power-Wert, weil der aus dem Bracket abgeleitet ist (Zirkelschluss). 0,85 verlangt praktisch alle
 * Anzeichen zugleich.
 */
export const CEDH_TUNING_HINT = 0.85;

/**
 * Ab diesem Tuning-Wert (0-1) hebt die Feinbewertung um eine Stufe an. Bewusst hoch: harte
 * Kriterien entscheiden, die Feinbewertung löst nur Grenzfälle.
 */
export const TUNING_BUMP_SCHWELLE = 0.8;

/**
 * Ab diesem Kartenwert (€) gilt mindestens Bracket 3. Einzige Regel ohne offizielle Grundlage: Die
 * 92 Precons 2023-2026 liegen im Schnitt bei 74 €, keiner über 150 € (teuerster 147 €). Deutlich
 * darüber heißt gezielt eingekauft - gemessen wird Absicht, nicht Stärke.
 *
 * Nur Untergrenze (gilt auch für Precons, einige Secret-Lair-Decks liegen darüber); nach oben
 * bewirkt der Preis nichts.
 */
export const PREIS_SCHWELLE_EUR = 150;

/**
 * Urteil F: mindestens eine spielbeendende Combo UND mindestens N Tutoren ergibt mindestens Bracket
 * 4. Empirisch statt aus dem Regelwerk: Von 48.638 Decks mit selbst angegebener Stufe
 * (docs/bracket-benchmark-2026-09.md) liegen 93 % der Decks mit beiden Merkmalen in B4/B5; von B2
 * zu B4 Faktor 30.
 *
 * Nur beides zusammen trennt: Combo allein haben 9,9 % der B2-Decks (dort erlaubt), zwei Tutoren
 * allein 6,0 %. 61 % der B4-Decks zeigen keins der Merkmale - das Urteil ist also nur eine
 * Untergrenze.
 *
 * N (Start 2) wird seit 29.09.2026 nachts neu gemessen (bracket_benchmark.combo_tutor_min), sobald
 * B2, B3 und B4 je 100 Decks haben.
 */
export const EMPIRISCH_MIN_COMBOS = 1;

/**
 * Gemessene (nicht-offizielle) Teile der Einstufung, aus der Tabelle bracket_benchmark (nachts
 * gelernt, je Bracket ab 100 Decks). Ohne Tabelle gilt DEFAULT_BRACKET_BENCHMARK.
 */
export interface BracketBenchmark {
  /** Tuning-Spanne je Messgröße: [zählt 0, zählt 1] = Median von Bracket 2 bzw. 5. */
  tuning: Record<TuningPart['key'], [number, number]>;
  /** Urteil F: so viele Tutoren braucht es zusätzlich zur Gewinn-Combo. */
  comboTutorMin: number;
}

/**
 * Startwerte (identisch mit der Tabelle). Tutoren: acht auf 100 Karten sind dicht. Ø Manawert:
 * niedriger ist stärker, Spanne daher umgekehrt. Ungetappte Länder: Precons 70-80 %, ab ~95 %
 * praktisch durchgängig schnell (einfarbige Basisland-Decks bekommen die volle Punktzahl geschenkt,
 * ein bewusst gedämpfter Nebeneffekt). Game Changer: sechs reizen die Liste aus.
 */
export const DEFAULT_BRACKET_BENCHMARK: BracketBenchmark = {
  tuning: {
    tutors: [0, 8],
    averageCmc: [3.4, 2.2],
    untappedLands: [70, 95],
    gameChangers: [0, 6],
  },
  comboTutorMin: 2,
};

/** Welcher Befund die Einstufung getrieben hat - Grundlage der Begründung in der Oberfläche. */
export type BracketReasonKey =
  | 'massLandDenial'
  | 'gameChangerMany'
  | 'gameChangerFew'
  | 'extraTurnLoop'
  | 'comboRuthless'
  | 'comboFast'
  | 'comboMidrange'
  | 'price'
  | 'tuning'
  | 'comboAndTutors'
  | 'nothing';

export interface BracketReason {
  key: BracketReasonKey;
  /** Untergrenze, die dieser Befund für sich genommen erzwingt. */
  minimum: BracketLevel;
  /** Verantwortliche Karten in Anzeigeschreibweise; bei 'nothing', 'tuning' und 'price' leer. */
  cards: string[];
}

/** Die Einzelurteile, aus denen sich das Ergebnis zusammensetzt. */
export interface BracketVerdicts {
  /** Urteil A: die offiziellen Ausschlusskriterien. Immer vorhanden, immer maßgeblich. */
  rules: BracketLevel;
  /** Urteil B: Zweitmeinung aus Commander Spellbooks Live-Auswertung, null wenn nicht verfügbar. */
  spellbook: BracketLevel | null;
  /** Urteil C: Tuning-Grad 0-1 aus Tutorendichte, Manakurve, Manabasis und Game-Changer-Dichte. */
  tuning: number;
  /** Dieselben vier Messgrößen einzeln - damit die Oberfläche den Prozentwert aufschlüsseln kann. */
  tuningParts: TuningPart[];
  /** Urteil D: true, wenn es ein unveränderter Precon ist (dann hebt Urteil C nicht an). */
  precon: boolean;
  /** Urteil E: gemessener Kartenwert in Euro, null solange der Preis noch nicht vorliegt. */
  price: number | null;
  /** Urteil F: so viele Tutoren braucht es zur Gewinn-Combo (gemessen, siehe BracketBenchmark). */
  comboTutorMin: number;
}

export interface BracketAnalysis {
  bracket: BracketLevel;
  /** 1-10, eine Nachkommastelle - die vertraute Powerlevel-Skala, feiner als die fünf Brackets. */
  power: number;
  confidence: 'high' | 'medium' | 'low';
  reasons: BracketReason[];
  /** true = Bracket 4 und sehr hoch bewertet; die Oberfläche fragt dann nach Bracket 5. */
  suggestsCedh: boolean;
  verdicts: BracketVerdicts;
}

/** Eine Deck-Karte, so weit die Einstufung sie braucht. */
export interface BracketCard {
  /** Anzeigename, wandert in BracketReason.cards. */
  name: string;
  /** Normalisierter Vorderseiten-Name - Schlüssel für Markierungen und Combos. */
  key: string;
  quantity: number;
  cmc: number;
  gameChanger: boolean;
  isCommander: boolean;
}

export interface BracketInput {
  cards: BracketCard[];
  /** Kuratierte Markierungen, Schlüssel wie BracketCard.key. Leer = noch kein Nachtlauf. */
  flags: Map<string, SpellbookCardFlags>;
  /** Zwei-Karten-Combos, bei denen mindestens eine Karte im Deck liegt. */
  combos: SpellbookTwoCardCombo[];
  /** Live-Zweitmeinung von Commander Spellbook, null wenn der Aufruf fehlschlug. */
  spellbookTag: SpellbookBracketTag | null;
  isPrecon: boolean;
  averageCmc: number | null;
  /** Anteil Länder, die nicht bedingungslos getappt ins Spiel kommen (0-100). */
  untappedLandPercent: number | null;
  /** Anzahl Tutoren im Deck (aus der kuratierten Liste). */
  tutorCount: number;
  /**
   * Anzahl SPIELBEENDENDER Combos (beliebig viele Karten), die vollständig im Deck liegen - anders
   * als `combos` (Zwei-Karten-Combos jeder Art). Aus winning_combos_in_deck; 0 solange unbekannt,
   * dann hebt Urteil F nicht an.
   */
  winningCombos: number;
  /** Gesamtzahl Karten - Bezugsgröße für die Tutorendichte. */
  totalCards: number;
  /** Kartenwert in Euro (billigste Druckvariante), null = unbekannt und löst nichts aus. */
  totalPrice: number | null;
  /** Gemessene Schwellen aus der Datenbank. Fehlt die Angabe, gelten die Startwerte. */
  benchmark?: BracketBenchmark;
}

/** Eine im Deck vollständig vorhandene Zwei-Karten-Combo, samt der beiden Karten. */
export interface PresentCombo {
  combo: SpellbookTwoCardCombo;
  cards: BracketCard[];
  /** Manabetrag beider Teile plus zusätzlich nötiges Mana - Näherung für "wann steht sie". */
  totalMana: number;
  /** true = eine der beiden Karten gibt Extra-Turns, die Combo ist also eine Zugschleife. */
  isExtraTurnLoop: boolean;
}

/**
 * Combos, die im Deck vollständig vorhanden sind: beide Karten da, und mustBeCommander-Karten auch
 * als Commander markiert (sonst würde ein Deck für eine Combo bestraft, die es nicht ausführen
 * kann).
 */
export function presentCombos(
  cards: BracketCard[],
  combos: SpellbookTwoCardCombo[],
  flags: Map<string, SpellbookCardFlags>,
): PresentCombo[] {
  const byKey = new Map(cards.map((c) => [c.key, c]));
  const gefunden: PresentCombo[] = [];

  for (const combo of combos) {
    const a = byKey.get(combo.cardA);
    const b = byKey.get(combo.cardB);
    if (!a || !b) continue;
    if (combo.aMustBeCommander && !a.isCommander) continue;
    if (combo.bMustBeCommander && !b.isCommander) continue;

    gefunden.push({
      combo,
      cards: [a, b],
      totalMana: a.cmc + b.cmc + (combo.manaValueNeeded ?? 0),
      isExtraTurnLoop: flags.get(a.key)?.extraTurn === true || flags.get(b.key)?.extraTurn === true,
    });
  }

  return gefunden;
}

/**
 * Urteil A - offizielle Ausschlusskriterien als Untergrenze, geschärft nach Draftsims offengelegter
 * Methodik: Combos dreistufig nach Spellbooks eigener Note (schnell → B4, mittel/spät → B3,
 * schwierig → nichts). Extra-Turn-Karten allein sind kein Aufschlag (verboten ist das Verketten).
 * Mass Land Denial und ab vier Game Changern → B4.
 */
export function rulesVerdict(input: BracketInput): {
  level: BracketLevel;
  reasons: BracketReason[];
} {
  const reasons: BracketReason[] = [];
  const anwesend = presentCombos(input.cards, input.combos, input.flags);

  const mld = input.cards.filter((c) => input.flags.get(c.key)?.massLandDenial === true);
  if (mld.length > 0) {
    reasons.push({ key: 'massLandDenial', minimum: 4, cards: mld.map((c) => c.name) });
  }

  const gameChangerCount = input.cards
    .filter((c) => c.gameChanger)
    .reduce((sum, c) => sum + c.quantity, 0);
  const gameChangerNamen = input.cards.filter((c) => c.gameChanger).map((c) => c.name);
  if (gameChangerCount >= 4) {
    reasons.push({ key: 'gameChangerMany', minimum: 4, cards: gameChangerNamen });
  } else if (gameChangerCount >= 1) {
    reasons.push({ key: 'gameChangerFew', minimum: 3, cards: gameChangerNamen });
  }

  const schleifen = anwesend.filter((c) => c.isExtraTurnLoop);
  if (schleifen.length > 0) {
    reasons.push({ key: 'extraTurnLoop', minimum: 4, cards: comboNamen(schleifen) });
  }

  const ruthless = anwesend.filter((c) => c.combo.bracketTag === 'R' && !c.isExtraTurnLoop);
  if (ruthless.length > 0) {
    reasons.push({ key: 'comboRuthless', minimum: 4, cards: comboNamen(ruthless) });
  }

  // "Vor Zug 4": fünf Mana sind mit einem Ramp-Zauber in Zug 3-4 da; mehr ist frühestens Zug 5 und
  // in B3 erlaubt.
  const schnell = anwesend.filter(
    (c) => c.totalMana <= 5 && c.combo.bracketTag !== 'R' && !c.isExtraTurnLoop,
  );
  if (schnell.length > 0) {
    reasons.push({ key: 'comboFast', minimum: 4, cards: comboNamen(schnell) });
  }

  // S (spicy) und P (powerful) sind ernst, aber langsamer. E, C, O sind milde Noten und lösen
  // keinen Aufschlag aus.
  const mittel = anwesend.filter(
    (c) =>
      (c.combo.bracketTag === 'S' || c.combo.bracketTag === 'P') &&
      c.totalMana > 5 &&
      !c.isExtraTurnLoop,
  );
  if (mittel.length > 0) {
    reasons.push({ key: 'comboMidrange', minimum: 3, cards: comboNamen(mittel) });
  }

  const level = reasons.reduce<BracketLevel>((hoechstes, r) => maxLevel(hoechstes, r.minimum), 2);
  if (reasons.length === 0) reasons.push({ key: 'nothing', minimum: 2, cards: [] });

  return { level, reasons };
}

/** Beide Kartennamen je Combo, als "A + B" - so steht es auch in der Begründung. */
function comboNamen(combos: PresentCombo[]): string[] {
  return combos.map((c) => c.cards.map((k) => k.name).join(' + '));
}

function maxLevel(a: BracketLevel, b: BracketLevel): BracketLevel {
  return (a > b ? a : b) as BracketLevel;
}

/**
 * Urteil B - Spellbooks bracketTag. Das ist KEINE Deck-Einstufung (98 Gebirge + Armageddon ergeben
 * "R"), sondern das stärkste Einzelelement - als Untergrenze brauchbar. "B" (gesperrte Karte) sagt
 * nichts über die Stufe → null.
 */
export function spellbookVerdict(tag: SpellbookBracketTag | null): BracketLevel | null {
  switch (tag) {
    case 'R':
      return 4;
    case 'P':
    case 'S':
      return 3;
    case 'O':
    case 'C':
    case 'E':
      return 2;
    default:
      return null;
  }
}

/**
 * Urteil E - Kartenwert als Untergrenze: 3 ab PREIS_SCHWELLE_EUR, sonst oder bei unbekanntem Preis
 * null. Getrennt von rulesVerdict(), weil "Offiziell" nur offizielle Kriterien zeigen soll und die
 * Verlässlichkeit nur A und B vergleicht.
 */
export function priceVerdict(totalPrice: number | null): BracketLevel | null {
  if (totalPrice === null) return null;
  return totalPrice >= PREIS_SCHWELLE_EUR ? 3 : null;
}

/**
 * Urteil C - Tuning-Grad 0-1 aus vier Anzeichen: Tutoren, Manakurve, schnelle Manabasis, Game
 * Changer. Fehlende Werte fließen nicht ein, statt als 0 zu zählen (halb geladene Decks wären sonst
 * zu niedrig).
 */
export function tuningVerdict(input: BracketInput): number {
  const teile = tuningParts(input);
  if (teile.length === 0) return 0;
  return teile.reduce((summe, t) => summe + t.score, 0) / teile.length;
}

/** Eine der Messgrößen, aus denen sich der Tuning-Grad mittelt. */
export interface TuningPart {
  key: 'tutors' | 'averageCmc' | 'untappedLands' | 'gameChangers';
  /** Gemessener Wert in genau der Einheit, in der er angezeigt wird. */
  value: number;
  /** Spannenende, an dem der Teil 0 zählt. */
  from: number;
  /** Spannenende, an dem der Teil 1 zählt. Kleiner als `from`, wenn weniger stärker ist. */
  to: number;
  /** Beitrag dieses Teils, 0 bis 1. */
  score: number;
}

/**
 * Die Messgrößen einzeln, damit die Oberfläche die Prozentzahl erklären kann. tuningVerdict()
 * mittelt über genau diese Liste - Anzeige und Zahl können nicht auseinanderlaufen (Invariante in
 * bracket.spec.ts).
 */
export function tuningParts(input: BracketInput): TuningPart[] {
  const teile: TuningPart[] = [];
  const spannen = (input.benchmark ?? DEFAULT_BRACKET_BENCHMARK).tuning;
  const teil = (key: TuningPart['key'], value: number) => {
    const [from, to] = spannen[key];
    teile.push({ key, value, from, to, score: anteil(value, from, to) });
  };

  if (input.totalCards > 0) {
    teil('tutors', (input.tutorCount / input.totalCards) * 100);
  }
  if (input.averageCmc !== null) {
    teil('averageCmc', input.averageCmc);
  }
  if (input.untappedLandPercent !== null) {
    teil('untappedLands', input.untappedLandPercent);
  }
  teil(
    'gameChangers',
    input.cards.filter((c) => c.gameChanger).reduce((sum, c) => sum + c.quantity, 0),
  );

  return teile;
}

/** Eine Zeile aus bracket_benchmark, so wie sie aus der Datenbank kommt. */
export interface BracketBenchmarkRow {
  bracket: number;
  tutor_density: number | null;
  avg_cmc: number | null;
  untapped_land_percent: number | null;
  game_changers: number | null;
  combo_tutor_min: number | null;
}

/**
 * Tabellenzeilen → Schwellen: Tuning-Spannen B2 bis B5, Urteil F aus der B4-Zeile. Je Merkmal
 * abgesichert: fehlt ein Wert oder ist die Spanne 0 breit, gilt der Startwert.
 */
export function bracketBenchmarkFromRows(rows: BracketBenchmarkRow[]): BracketBenchmark {
  const zeile = (b: number) => rows.find((r) => r.bracket === b);
  const unten = zeile(2);
  const oben = zeile(5);
  const start = DEFAULT_BRACKET_BENCHMARK.tuning;

  const spanne = (
    key: TuningPart['key'],
    spalte: keyof Omit<BracketBenchmarkRow, 'bracket' | 'combo_tutor_min'>,
  ): [number, number] => {
    const von = unten?.[spalte];
    const bis = oben?.[spalte];
    if (von == null || bis == null || von === bis) return start[key];
    return [von, bis];
  };

  const tutoren = zeile(4)?.combo_tutor_min;
  return {
    tuning: {
      tutors: spanne('tutors', 'tutor_density'),
      averageCmc: spanne('averageCmc', 'avg_cmc'),
      untappedLands: spanne('untappedLands', 'untapped_land_percent'),
      gameChangers: spanne('gameChangers', 'game_changers'),
    },
    comboTutorMin:
      tutoren != null && tutoren >= 1 ? tutoren : DEFAULT_BRACKET_BENCHMARK.comboTutorMin,
  };
}

/** Wert linear auf 0..1 abbilden. von > bis dreht die Richtung um (kleiner = stärker). */
function anteil(wert: number, von: number, bis: number): number {
  if (von === bis) return 0;
  const roh = (wert - von) / (bis - von);
  return Math.min(1, Math.max(0, roh));
}

/**
 * Power-Spanne je Bracket, paarweise auf der gängigen 1-10-Skala: 1-2 Exhibition, 3-4 Core, 5-6
 * Upgraded, 7-8 Optimized, 9-10 cEDH.
 */
const POWER_SPANNE: Record<BracketLevel, [number, number]> = {
  1: [1, 2.9],
  2: [3, 4.9],
  3: [5, 6.9],
  4: [7, 8.9],
  5: [9, 10],
};

/** Power-Spanne eines Brackets (für die Rechenweg-Erklärung in der Oberfläche). */
export function powerRange(bracket: BracketLevel): [number, number] {
  return POWER_SPANNE[bracket];
}

/** Power-Wert aus Bracket und Tuning-Grad, auf eine Nachkommastelle. */
export function powerLevel(bracket: BracketLevel, tuning: number): number {
  const [von, bis] = POWER_SPANNE[bracket];
  return Math.round((von + tuning * (bis - von)) * 10) / 10;
}

/**
 * Führt die Urteile zusammen. Untergrenze = Maximum aus A, B und E; C darf danach um höchstens eine
 * Stufe anheben, nie senken.
 *
 * Unveränderte Precons hebt C nicht an (Urteil D) - nicht weil Precons B2 wären (seit 9.2.2026
 * entkoppelt), sondern weil die weiche Heuristik ein unverändertes Precon nicht hochschieben soll.
 * Harte Kriterien aus A gelten für Precons unverändert.
 */
export function analyzeBracket(input: BracketInput): BracketAnalysis {
  const benchmark = input.benchmark ?? DEFAULT_BRACKET_BENCHMARK;
  const { level: rules, reasons } = rulesVerdict(input);
  const spellbook = spellbookVerdict(input.spellbookTag);
  const tuning = tuningVerdict(input);
  const price = priceVerdict(input.totalPrice);

  let bracket = spellbook === null ? rules : maxLevel(rules, spellbook);

  if (price !== null) {
    // Der Preis IST ein Befund - "nichts gefunden" wäre daneben, wenn er gerade die Stufe treibt.
    const nichtsGefunden = reasons.findIndex((r) => r.key === 'nothing');
    if (nichtsGefunden >= 0) reasons.splice(nichtsGefunden, 1);
    reasons.push({ key: 'price', minimum: price, cards: [] });
    bracket = maxLevel(bracket, price);
  }

  // Urteil F (siehe EMPIRISCH_MIN_COMBOS) ist ein harter Befund und steht deshalb vor der
  // Feinbewertung.
  if (
    input.winningCombos >= EMPIRISCH_MIN_COMBOS &&
    input.tutorCount >= benchmark.comboTutorMin &&
    bracket < AUTO_BRACKET_MAX
  ) {
    const nichtsGefunden = reasons.findIndex((r) => r.key === 'nothing');
    if (nichtsGefunden >= 0) reasons.splice(nichtsGefunden, 1);
    reasons.push({ key: 'comboAndTutors', minimum: AUTO_BRACKET_MAX, cards: [] });
    bracket = AUTO_BRACKET_MAX;
  }

  if (tuning >= TUNING_BUMP_SCHWELLE && bracket < AUTO_BRACKET_MAX && !input.isPrecon) {
    bracket = (bracket + 1) as BracketLevel;
    reasons.push({ key: 'tuning', minimum: bracket, cards: [] });
  }

  const power = powerLevel(bracket, tuning);

  // Übereinstimmung von A und B = belastbar; fehlt B oder weicht es um eine Stufe ab = Schätzung;
  // zwei Stufen = eine Quelle sieht, was die andere nicht kennt.
  let confidence: BracketAnalysis['confidence'] = 'medium';
  if (spellbook !== null) {
    const abstand = Math.abs(rules - spellbook);
    confidence = abstand === 0 ? 'high' : abstand === 1 ? 'medium' : 'low';
  }

  return {
    bracket,
    power,
    confidence,
    reasons,
    suggestsCedh: bracket === AUTO_BRACKET_MAX && tuning >= CEDH_TUNING_HINT,
    verdicts: {
      rules,
      spellbook,
      tuning,
      tuningParts: tuningParts(input),
      precon: input.isPrecon,
      price: input.totalPrice,
      comboTutorMin: benchmark.comboTutorMin,
    },
  };
}
