import type { SpellbookCardFlags, SpellbookTwoCardCombo } from './card-data.service';
import type { SpellbookBracketTag } from './commander-spellbook.service';

/**
 * Einstufung eines Commander-Decks in die offiziellen Brackets 1-5.
 *
 * Reine Rechenfunktionen ohne Angular- und ohne Netzwerkbezug - alle Eingaben kommen als Parameter
 * herein, damit sich jede Regel in bracket.spec.ts einzeln festnageln lässt. Die Daten selbst
 * stehen beim Öffnen eines Decks bereits bereit (Kartendetails aus scryfall_cards, Markierungen
 * und Combos aus den Spellbook-Tabellen), es wird hier also nichts nachgeladen.
 *
 * Die offiziellen Stufen: 1 Exhibition, 2 Core, 3 Upgraded, 4 Optimized, 5 cEDH.
 *
 * Zwei Dinge, die diese Einstufung bewusst NICHT tut:
 *
 * 1. Sie vergibt nie 1 oder 5. Beide unterscheiden sich von ihren Nachbarn nicht durch Karten,
 *    sondern durch Absicht - Bracket 1 ist "ich will gar nicht gewinnen", Bracket 5 ist "gebaut
 *    für ein Turniermetagame". Aus einer Kartenliste ist das nicht ableitbar; wer dort hin will,
 *    stellt es selbst ein. Bei sehr hoch bewerteten Bracket-4-Decks weist suggestsCedh darauf hin.
 * 2. Sie behauptet keine Obergrenze. Das Ergebnis ist eine UNTERGRENZE ("mindestens Bracket 3"):
 *    jeder Tisch kann sich einigen, höher zu spielen, aber die harten Kriterien nach unten zu
 *    unterbieten geht nicht.
 */

export type BracketLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Welche Stufe für ein Deck anzuzeigen ist, wenn nur die gespeicherten Werte vorliegen - also
 * überall dort, wo nicht die ganze Kartenliste geladen ist (Deck-Liste, Deck-Auswahl im Match-Tab).
 *
 * Die selbst gewählte Stufe schlägt immer die Automatik. Brackets gibt es nur im Commander; für
 * Brawl, Pauper Commander und den Rest kommt bewusst null zurück, damit dort gar kein Abzeichen
 * erscheint.
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

/** Stufen, die die Automatik überhaupt vergeben darf - siehe Punkt 1 oben. */
export const AUTO_BRACKET_MIN = 2;
export const AUTO_BRACKET_MAX = 4;

/**
 * Ab diesem Tuning-Grad (0-1) bekommt ein Bracket-4-Deck den cEDH-Hinweis.
 *
 * Bewusst an den Tuning-Grad gehängt und nicht an den Power-Wert: der Power-Wert ist aus dem
 * Bracket abgeleitet, ihn wieder zur Bedingung zu machen wäre im Kreis gerechnet. Beim Prüfen in
 * der laufenden App fiel genau das auf - ein Deck mit fünf Game Changern und Tuning-Grad 0,64 kam
 * auf Power 8,6 und bekam den cEDH-Hinweis, obwohl "recht durchgebaut" noch lange kein
 * Turnierdeck ist. 0,85 verlangt, dass praktisch alle Anzeichen zugleich zutreffen.
 */
export const CEDH_TUNING_HINT = 0.85;

/**
 * Ab diesem Tuning-Wert (0-1) hebt die Feinbewertung das Bracket um eine Stufe an. Bewusst hoch
 * angesetzt: die harten Kriterien sollen die Einstufung bestimmen, die Feinbewertung nur den
 * Grenzfall auflösen, bei dem ein Deck zwar keine verbotene Karte enthält, aber erkennbar
 * durchoptimiert ist.
 */
const TUNING_BUMP_SCHWELLE = 0.8;

/** Welcher Befund die Einstufung getrieben hat - Grundlage der Begründung in der Oberfläche. */
export type BracketReasonKey =
  | 'massLandDenial'
  | 'gameChangerMany'
  | 'gameChangerFew'
  | 'extraTurnLoop'
  | 'comboRuthless'
  | 'comboFast'
  | 'comboMidrange'
  | 'tuning'
  | 'nothing';

export interface BracketReason {
  key: BracketReasonKey;
  /** Untergrenze, die dieser Befund für sich genommen erzwingt. */
  minimum: BracketLevel;
  /** Verantwortliche Karten in Anzeigeschreibweise; bei 'nothing' und 'tuning' leer. */
  cards: string[];
}

/** Die vier Einzelurteile, aus denen sich das Ergebnis zusammensetzt. */
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
  nonBasicLandPercent: number | null;
  /** Anzahl Tutoren im Deck (aus der kuratierten Liste). */
  tutorCount: number;
  /** Gesamtzahl Karten - Bezugsgröße für die Tutorendichte. */
  totalCards: number;
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
 * Welche der Combos sind im Deck wirklich VOLLSTÄNDIG vorhanden?
 *
 * "Vollständig" heißt: beide Karten liegen im Deck, und wenn die Quelle für eine davon
 * mustBeCommander verlangt, ist sie auch als Commander markiert (42 der rund 4.000 Combos haben
 * das, z.B. Combos, die auf die Commander-Zone angewiesen sind). Ohne diese Prüfung würde ein Deck
 * für eine Combo bestraft, die es gar nicht ausführen kann.
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
 * Urteil A - die offiziellen Ausschlusskriterien, als Untergrenze.
 *
 * Reihenfolge und Schwellen folgen dem offiziellen Wortlaut, an drei Stellen geschärft durch die
 * offengelegte Methodik von Draftsims Rechner:
 *
 * - Combos werden DREISTUFIG bewertet, nicht zweistufig: schnell (Bracket 4), mittel/spät
 *   (Bracket 3), schwierig/bedingt (kein Aufschlag). Für die Einordnung nehmen wir Spellbooks
 *   eigene Note für genau diese Combo statt einer selbst geratenen Schwelle - dort steckt die
 *   Kuratierung schon drin.
 * - Extra-Turn-Karten allein sind KEIN Aufschlag. Verboten ist laut Regelwerk das Verketten, nicht
 *   der Besitz; erst eine Combo mit einer Extra-Turn-Karte darin ist eine Zugschleife.
 * - Mass Land Denial und vier oder mehr Game Changer schlagen unverändert auf Bracket 4 durch.
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

  // "Vor Zug 4 aufstellbar" - fünf Mana sind mit einem einzigen Ramp-Zauber im dritten oder
  // vierten Zug beieinander. Alles darüber ist frühestens ab Zug fünf realistisch und fällt damit
  // unter das, was Bracket 3 ausdrücklich erlaubt.
  const schnell = anwesend.filter(
    (c) => c.totalMana <= 5 && c.combo.bracketTag !== 'R' && !c.isExtraTurnLoop,
  );
  if (schnell.length > 0) {
    reasons.push({ key: 'comboFast', minimum: 4, cards: comboNamen(schnell) });
  }

  // S (spicy) und P (powerful) sind ernstzunehmende, aber langsamere Combos. E, C und O sind
  // Spellbooks milde Noten - bedingte, umständliche Combos, die laut Regelwerk auch in Bracket 3
  // noch in Ordnung gehen und deshalb gar keinen Aufschlag auslösen.
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
 * Urteil B - Commander Spellbooks Live-Auswertung, richtig gelesen.
 *
 * Deren bracketTag ist KEINE Deck-Einstufung, auch wenn der Name das nahelegt: nachgemessen
 * liefert die API für 98 Gebirge plus ein einzelnes Armageddon ein "R" (Ruthless). Die Skala
 * beschreibt das STÄRKSTE im Deck gefundene Einzelelement - dieselbe Skala, mit der Spellbook auch
 * einzelne Combos benotet. So gelesen ist sie brauchbar: sie liefert eine Untergrenze.
 *
 * "B" heißt "enthält eine im Commander gesperrte Karte" und sagt über die Stufe gar nichts -
 * deshalb null statt einer Zahl.
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
 * Urteil C - Tuning-Grad von 0 bis 1.
 *
 * Vier Anzeichen dafür, dass ein Deck durchoptimiert ist, ohne dass eine einzelne Karte ein hartes
 * Kriterium verletzt: viele Tutoren, niedrige Manakurve, teure Manabasis, viele Game Changer.
 * Fehlt ein Wert (z.B. weil die Kartendetails noch laden), fließt er nicht ein, statt als Null zu
 * zählen - sonst würde ein halb geladenes Deck systematisch zu niedrig bewertet.
 */
export function tuningVerdict(input: BracketInput): number {
  const teile = tuningParts(input);
  if (teile.length === 0) return 0;
  return teile.reduce((summe, t) => summe + t.score, 0) / teile.length;
}

/** Eine der Messgrößen, aus denen sich der Tuning-Grad mittelt. */
export interface TuningPart {
  key: 'tutors' | 'averageCmc' | 'nonBasicLands' | 'gameChangers';
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
 * Die Messgrößen einzeln - dieselbe Rechnung wie tuningVerdict(), nur aufgeschlüsselt.
 *
 * Existiert, damit die Oberfläche nicht bloß "36 %" hinschreiben muss: ohne die gemessenen Werte
 * UND die Spannenenden ist so ein Prozentwert nicht nachvollziehbar. Weil tuningVerdict() über
 * genau diese Liste mittelt, können angezeigte Aufschlüsselung und angezeigte Prozentzahl nicht
 * auseinanderlaufen - bracket.spec.ts nagelt das als Invariante fest.
 */
export function tuningParts(input: BracketInput): TuningPart[] {
  const teile: TuningPart[] = [];
  const teil = (key: TuningPart['key'], value: number, from: number, to: number) =>
    teile.push({ key, value, from, to, score: anteil(value, from, to) });

  if (input.totalCards > 0) {
    // Acht Tutoren auf 100 Karten sind dicht; das erreichen sonst nur sehr zielgerichtete Decks.
    teil('tutors', (input.tutorCount / input.totalCards) * 100, 0, 8);
  }
  if (input.averageCmc !== null) {
    // Niedriger ist stärker, deshalb die Spanne andersherum.
    teil('averageCmc', input.averageCmc, 3.4, 2.2);
  }
  if (input.nonBasicLandPercent !== null) {
    teil('nonBasicLands', input.nonBasicLandPercent, 30, 90);
  }
  teil(
    'gameChangers',
    input.cards.filter((c) => c.gameChanger).reduce((sum, c) => sum + c.quantity, 0),
    0,
    6,
  );

  return teile;
}

/** Wert linear auf 0..1 abbilden. von > bis dreht die Richtung um (kleiner = stärker). */
function anteil(wert: number, von: number, bis: number): number {
  if (von === bis) return 0;
  const roh = (wert - von) / (bis - von);
  return Math.min(1, Math.max(0, roh));
}

/**
 * Power-Spanne je Bracket. Die 1-10-Skala rastet paarweise auf den Brackets ein: 1-2 Exhibition,
 * 3-4 Core, 5-6 Upgraded, 7-8 Optimized, 9-10 cEDH. Bewusst genau diese Paarung und keine
 * gedehnte Spanne für Bracket 4 - nur so bleibt der Wert gegen die verbreitete 1-10-Skala
 * lesbar, statt eine eigene zu sein, die zufällig auch von 1 bis 10 geht.
 */
const POWER_SPANNE: Record<BracketLevel, [number, number]> = {
  1: [1, 2.9],
  2: [3, 4.9],
  3: [5, 6.9],
  4: [7, 8.9],
  5: [9, 10],
};

/** Power-Wert aus Bracket und Tuning-Grad, auf eine Nachkommastelle. */
export function powerLevel(bracket: BracketLevel, tuning: number): number {
  const [von, bis] = POWER_SPANNE[bracket];
  return Math.round((von + tuning * (bis - von)) * 10) / 10;
}

/**
 * Führt die vier Urteile zusammen.
 *
 * Untergrenze ist das höhere aus A und B. Die Feinbewertung (C) darf danach um höchstens eine
 * Stufe ANHEBEN und niemals senken - ein hartes Kriterium aus A lässt sich so nie wegrechnen.
 *
 * Bei unveränderten Precons hebt C gar nicht an (Urteil D). Achtung, der Grund dafür ist NICHT
 * "Precons sind Bracket 2": das Bracket-Update vom 9.2.2026 hat Precons ausdrücklich von Bracket 2
 * entkoppelt, seither ist das keine Regel mehr. Der Grund ist enger: die Feinbewertung ist eine
 * weiche Heuristik über Manakurve und Manabasis, und ein Precon ist genau dafür gebaut - ihn
 * deswegen eine Stufe hochzuschieben, obwohl niemand etwas daran geändert hat, wäre falsch. Die
 * HARTEN Kriterien aus A gelten für Precons dagegen unverändert: eine einzige Game-Changer-Karte
 * hebt auch einen fabrikfrischen Precon auf mindestens Bracket 3 (aktueller Fall: Farewell, im
 * selben Februar-Update neu auf die Game-Changer-Liste gesetzt).
 */
export function analyzeBracket(input: BracketInput): BracketAnalysis {
  const { level: rules, reasons } = rulesVerdict(input);
  const spellbook = spellbookVerdict(input.spellbookTag);
  const tuning = tuningVerdict(input);

  let bracket = spellbook === null ? rules : maxLevel(rules, spellbook);

  if (tuning >= TUNING_BUMP_SCHWELLE && bracket < AUTO_BRACKET_MAX && !input.isPrecon) {
    bracket = (bracket + 1) as BracketLevel;
    reasons.push({ key: 'tuning', minimum: bracket, cards: [] });
  }

  const power = powerLevel(bracket, tuning);

  // Stimmen die beiden unabhängigen Urteile überein, ist die Einstufung belastbar. Fehlt die
  // Zweitmeinung oder weicht sie um eine Stufe ab, bleibt es eine Schätzung; zwei Stufen
  // Abweichung heißt, dass eine der beiden Quellen etwas sieht, das die andere nicht kennt.
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
    verdicts: { rules, spellbook, tuning, tuningParts: tuningParts(input), precon: input.isPrecon },
  };
}
