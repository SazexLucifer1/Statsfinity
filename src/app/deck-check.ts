/**
 * Deck-Check: aus den Zahlen der Deck-Analyse ein Urteil mit Handlungsanweisung - "Rampe 6,
 * empfohlen 10–12" statt nur "Rampe 6". Das ist der Teil, in dem Mythic Tools ausgereifter wirkte:
 * dort gibt es einen "Deck Health Score", hier stand bisher nur die Zahl.
 *
 * Alles reine Funktionen ohne Angular, damit deck-check.spec.ts sie prüfen kann. Die Richtwerte
 * sind veröffentlichte Faustregeln, keine eigene Erfindung:
 *   - Länderzahl: Frank Karstens Regression ("How Many Lands Do You Need to Consistently Hit Your
 *     Land Drops?", 2022) - 99 Karten: 31,42 + 3,13 × Ø Manawert − 0,28 × billige Rampe/Draw,
 *     60 Karten: 19,59 + 1,90 × Ø Manawert − 0,28 × billige Rampe/Draw.
 *   - Farbquellen: angelehnt an Karstens Tabellen für rund 90 % Wahrscheinlichkeit, eine Karte auf
 *     Kurve zu wirken (Commander- und 60-Karten-Fassung), gerundet. Ein Richtwert, kein Gesetz -
 *     wer die Zahlen nachschärft, ändert nur KARSTEN_99/KARSTEN_60.
 *   - Rampe/Kartenziehen/Removal/Bretträumung: die verbreitete Commander-Vorlage ("10 Rampe,
 *     10 Draw, 8–10 Removal, 2–4 Wipes"). Für 60-Karten-Formate gibt es keine sinnvolle feste
 *     Zahl - dort entfallen sie.
 */

export type CheckLevel = 'good' | 'warn' | 'bad';

export interface CheckItem {
  key: 'lands' | 'ramp' | 'draw' | 'removal' | 'boardwipe';
  value: number;
  min: number;
  max: number;
  level: CheckLevel;
}

export interface DeckCheckInput {
  /** Karten im Deck ohne Commander (Bibliothek): 99 bei Commander, 60 bei Constructed. */
  librarySize: number;
  isCommanderFormat: boolean;
  lands: number;
  averageCmc: number | null;
  /** Karten der Kategorie Rampe (Effekt-Kategorie), inklusive Manasteine. */
  ramp: number | null;
  draw: number | null;
  removal: number | null;
  boardwipe: number | null;
}

/** Empfohlene Länderzahl nach Karsten, gerundet. */
export function recommendedLands(input: Pick<DeckCheckInput, 'isCommanderFormat' | 'averageCmc' | 'ramp' | 'draw'>): number {
  const avg = input.averageCmc ?? (input.isCommanderFormat ? 3.2 : 2.6);
  // Karsten zählt nur BILLIGE Rampe/Draw (Manawert ≤ 2). Die Kategorien hier unterscheiden das
  // nicht - grob die Hälfte davon ist billig, deshalb halbes Gewicht.
  const cheap = ((input.ramp ?? 0) + (input.draw ?? 0)) / 2;
  const raw = input.isCommanderFormat ? 31.42 + 3.13 * avg - 0.28 * cheap : 19.59 + 1.9 * avg - 0.28 * cheap;
  return Math.round(raw);
}

function level(value: number, min: number, max: number, tolerance: number): CheckLevel {
  if (value >= min && value <= max) return 'good';
  const off = value < min ? min - value : value - max;
  return off <= tolerance ? 'warn' : 'bad';
}

export function deckCheckItems(input: DeckCheckInput): CheckItem[] {
  const target = recommendedLands(input);
  const items: CheckItem[] = [
    { key: 'lands', value: input.lands, min: target - 1, max: target + 1, level: level(input.lands, target - 1, target + 1, 2) },
  ];
  if (!input.isCommanderFormat) return items;
  const add = (key: CheckItem['key'], value: number | null, min: number, max: number, tolerance: number) => {
    if (value === null) return;
    items.push({ key, value, min, max, level: level(value, min, max, tolerance) });
  };
  add('ramp', input.ramp, 10, 14, 2);
  add('draw', input.draw, 10, 15, 3);
  add('removal', input.removal, 8, 12, 2);
  add('boardwipe', input.boardwipe, 2, 4, 1);
  return items;
}

/** 0–100: grün zählt voll, gelb halb, rot nicht. */
export function deckHealthScore(items: readonly CheckItem[]): number {
  if (items.length === 0) return 0;
  const points = items.reduce((sum, i) => sum + (i.level === 'good' ? 1 : i.level === 'warn' ? 0.5 : 0), 0);
  return Math.round((points / items.length) * 100);
}

// --- Farbquellen (Karsten) ---

/**
 * Nötige Farbquellen für 90 % Wahrscheinlichkeit, eine Karte auf Kurve zu wirken.
 * Index: [Anzahl farbiger Symbole 1..3][Manawert 1..6].
 */
const KARSTEN_99: Record<number, Record<number, number>> = {
  1: { 1: 19, 2: 19, 3: 18, 4: 16, 5: 15, 6: 14 },
  2: { 2: 30, 3: 28, 4: 26, 5: 24, 6: 22 },
  3: { 3: 36, 4: 33, 5: 31, 6: 29 },
};
const KARSTEN_60: Record<number, Record<number, number>> = {
  1: { 1: 14, 2: 13, 3: 12, 4: 10, 5: 9, 6: 9 },
  2: { 2: 20, 3: 18, 4: 16, 5: 15, 6: 14 },
  3: { 3: 23, 4: 21, 5: 19, 6: 18 },
};

export function requiredSources(pips: number, cmc: number, isCommanderFormat: boolean): number {
  const table = isCommanderFormat ? KARSTEN_99 : KARSTEN_60;
  const p = Math.min(3, Math.max(1, pips));
  const row = table[p];
  const minCmc = Math.min(...Object.keys(row).map(Number));
  const c = Math.min(6, Math.max(minCmc, Math.round(cmc)));
  return row[c];
}

/** Farbige Symbole je Farbe in einer Manakosten-Angabe ("{2}{G}{G}" -> {G: 2}). Hybrid zählt nicht. */
export function colorPips(manaCost: string | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [, symbol] of (manaCost ?? '').matchAll(/\{([^}]+)\}/g)) {
    if (/^[WUBRG]$/.test(symbol)) counts[symbol] = (counts[symbol] ?? 0) + 1;
  }
  return counts;
}

export interface ColorRequirement {
  color: string;
  sources: number;
  required: number;
  /** Die Karte, die am meisten verlangt. */
  card: string;
  manaCost: string;
  level: CheckLevel;
}

export interface ManaCard {
  name: string;
  cmc: number;
  manaCost: string | null | undefined;
}

/**
 * Je Farbe die anspruchsvollste Karte und ob die Quellen dafür reichen. Gelb ab 2 fehlenden
 * Quellen, rot ab 5.
 */
export function colorRequirements(
  cards: readonly ManaCard[],
  sourcesByColor: Record<string, number>,
  isCommanderFormat: boolean,
): ColorRequirement[] {
  const worst = new Map<string, { required: number; card: ManaCard }>();
  for (const card of cards) {
    for (const [color, pips] of Object.entries(colorPips(card.manaCost))) {
      const required = requiredSources(pips, card.cmc, isCommanderFormat);
      const current = worst.get(color);
      if (!current || required > current.required) worst.set(color, { required, card });
    }
  }
  return ['W', 'U', 'B', 'R', 'G']
    .filter((color) => worst.has(color))
    .map((color) => {
      const { required, card } = worst.get(color)!;
      const sources = sourcesByColor[color] ?? 0;
      const missing = required - sources;
      return {
        color,
        sources,
        required,
        card: card.name,
        manaCost: card.manaCost ?? '',
        level: missing <= 1 ? 'good' : missing <= 4 ? 'warn' : 'bad',
      };
    });
}

// --- Wahrscheinlichkeiten (hypergeometrisch, exakt) ---

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

/** P(genau k Treffer) beim Ziehen von draws Karten aus deckSize mit successes Treffern. */
export function hypergeometric(deckSize: number, successes: number, draws: number, k: number): number {
  return (choose(successes, k) * choose(deckSize - successes, draws - k)) / choose(deckSize, draws);
}

/** P(mindestens k Treffer). */
export function atLeast(deckSize: number, successes: number, draws: number, k: number): number {
  let p = 0;
  for (let i = k; i <= Math.min(draws, successes); i++) p += hypergeometric(deckSize, successes, draws, i);
  return Math.min(1, p);
}

/** P(zwischen lo und hi Treffer, beide eingeschlossen). */
export function between(deckSize: number, successes: number, draws: number, lo: number, hi: number): number {
  let p = 0;
  for (let i = lo; i <= hi; i++) p += hypergeometric(deckSize, successes, draws, i);
  return Math.min(1, p);
}

export interface DeckOdds {
  /** Starthand mit 2–4 Ländern (gut spielbar). */
  keepableHand: number;
  /** 3 Länder bis Zug 3 (auf dem Draw: 7 + 2 gezogene Karten). */
  threeLandsByTurn3: number;
  /** 4 Länder bis Zug 4 (7 + 3). */
  fourLandsByTurn4: number;
  /** Mindestens eine Rampe in Starthand + 2 Zügen. */
  rampEarly: number | null;
  /** Mindestens ein Kartenzieher bis Zug 4. */
  drawByTurn4: number | null;
}

export function deckOdds(librarySize: number, lands: number, ramp: number | null, draw: number | null): DeckOdds {
  return {
    keepableHand: between(librarySize, lands, 7, 2, 4),
    threeLandsByTurn3: atLeast(librarySize, lands, 9, 3),
    fourLandsByTurn4: atLeast(librarySize, lands, 10, 4),
    rampEarly: ramp === null ? null : atLeast(librarySize, ramp, 9, 1),
    drawByTurn4: draw === null ? null : atLeast(librarySize, draw, 10, 1),
  };
}
