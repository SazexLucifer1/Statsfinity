/**
 * Deck-Check: aus den Zahlen der Deck-Analyse ein Urteil mit Handlungsanweisung - "Bretträumung 2,
 * Ziel 6 (Control: eher mehr)" statt nur "Bretträumung 2".
 *
 * Alles reine Funktionen ohne Angular, damit deck-check.spec.ts sie prüfen kann.
 *
 * Die Richtwerte für Commander kommen aus der Deckbau-Tabelle des Users (public/richtwerte/,
 * Blatt "Kennzahlen Kartentypen", Entscheidung des Users 05.10.2026): je Kategorie eine Spanne und
 * welche Spielweisen eher an welches Ende gehören. Der Zielwert startet in der Mitte der Spanne und
 * wandert je passender Spielweise um ein Viertel der Spanne Richtung "weniger" oder "mehr", nie
 * darüber hinaus. Grün ist der Zielwert ± Toleranz, gelb noch innerhalb der Spanne, rot außerhalb.
 * Wer eine Zahl ändert, ändert CATEGORY_RULES - und die Tabelle in public/richtwerte/ gleich mit,
 * sonst lädt jemand eine Begründung herunter, die nicht mehr stimmt.
 *
 * 60-Karten-Formate: Die Tabelle gilt für Commander. Dort bleibt nur die Länderzahl nach Frank
 * Karstens Regression (19,59 + 1,90 × Ø Manawert − 0,28 × billige Rampe/Draw).
 *
 * Doppelseitige Karten mit Land-Rückseite (Tabelle + Karsten): Kann das Land ungetappt kommen
 * (z. B. "you may pay 3 life"), zählt es 1:1 als Land; kommt es immer getappt, 0,38.
 */

export type CheckLevel = 'good' | 'warn' | 'bad';

export type CategoryKey = 'lands' | 'ramp' | 'draw' | 'removal' | 'boardwipe';

/** Spielweisen, die der Besitzer am Deck festlegt (decks.play_styles). */
export const PLAY_STYLES = [
  'aggro',
  'control',
  'combo',
  'landfall',
  'creatures',
  'cedh',
  'commanderDraws',
  'commanderRemoves',
  'weakness',
] as const;
export type PlayStyle = (typeof PLAY_STYLES)[number];

/** Kurve wird nicht gewählt, sondern aus dem Ø Manawert abgelesen. */
export type CurveStyle = 'lowCurve' | 'highCurve';
export type Influence = PlayStyle | CurveStyle;

/**
 * Ab wann eine Kurve niedrig bzw. hoch ist. Die cEDH-Kurve aus der Tabelle (Blatt "Mana Curve")
 * liegt bei Ø 2,8; Casual-Commander-Decks bei etwa 3,0-3,5.
 */
export const LOW_CURVE_MAX = 2.8;
export const HIGH_CURVE_MIN = 3.6;

export function curveStyle(averageCmc: number | null | undefined): CurveStyle | null {
  if (averageCmc == null) return null;
  if (averageCmc <= LOW_CURVE_MAX) return 'lowCurve';
  if (averageCmc >= HIGH_CURVE_MIN) return 'highCurve';
  return null;
}

export interface CategoryRule {
  min: number;
  max: number;
  /** Spielweisen, die eher weniger brauchen. */
  fewer: readonly Influence[];
  /** Spielweisen, die eher mehr brauchen. */
  more: readonly Influence[];
  /** Ab welcher Abweichung vom Ziel es nicht mehr grün ist. */
  tolerance: number;
}

/** Aus der Tabelle des Users, Blatt "Kennzahlen Kartentypen". */
export const CATEGORY_RULES: Record<CategoryKey, CategoryRule> = {
  lands: {
    min: 29,
    max: 37,
    fewer: ['cedh', 'lowCurve'],
    more: ['landfall', 'highCurve'],
    tolerance: 1,
  },
  ramp: {
    min: 9,
    max: 17,
    fewer: ['lowCurve', 'aggro'],
    more: ['landfall', 'highCurve'],
    tolerance: 2,
  },
  draw: {
    min: 7,
    max: 15,
    fewer: ['commanderDraws', 'aggro'],
    more: ['combo', 'control'],
    tolerance: 2,
  },
  removal: {
    min: 7,
    max: 15,
    fewer: ['commanderRemoves', 'combo'],
    more: ['weakness', 'control'],
    tolerance: 2,
  },
  boardwipe: { min: 0, max: 8, fewer: ['creatures', 'aggro'], more: ['control'], tolerance: 1 },
};

/** Empfohlene Win Cons laut Tabelle: etwa 3, je nach Deck ± 3. */
export const WINCON_TARGET = 3;

/**
 * Wann ein Combo-Ergebnis von Commander Spellbook ein Sieg ist - die WEITE Sieg-Definition aus
 * `spellbook_winning_combo_muster()` (sql/sieg-definition-breit-2026-09-17.sql) plus
 * "lifeloss": So schreibt Spellbook den unendlichen Lebensverlust ("Infinite lifeloss"), und genau
 * das fehlt dem SQL-Muster, das nur "loss of life" kennt. Die SQL-Fassung (Urteil F, Bracket)
 * bleibt bewusst unverändert, weil deren Schwellen an ihr geeicht sind.
 */
const WIN_RESULT =
  /win the game|(opponent|player)[^,]{0,40}loses? the game|(near-)?infinite[^,]{0,30}(damage|mill|turns|combat phases|storm count|loss of life|lifeloss|poison)|cast all spells in your library/i;
/** Ausnahmen wie `spellbook_sieg_ausnahme()`: trifft das Muster, ist aber kein Sieg. */
const WIN_EXCEPTION =
  /damage to [^,]{0,25}creatures|damage to you|mill for you|self-mill|self lifeloss/i;

export function isWinningResult(result: string): boolean {
  return WIN_RESULT.test(result) && !WIN_EXCEPTION.test(result);
}

export interface WinCon {
  /** Die kürzeste Combo der Gruppe - steht stellvertretend für ihre Varianten. */
  cardNames: string[];
  variants: number;
}

/**
 * Spielbeendende Combos, zu Win Cons zusammengefasst. Spellbook führt jede Variante einzeln
 * (Aristocrats mit Zulaport oder Blood Artist, mit Gravecrawler oder Reassembling Skeleton) -
 * gezählt nach Combos stünde ein Deck mit einer einzigen Engine bei 30 Win Cons. Zwei Combos
 * gehören zusammen, wenn sie mindestens zwei Karten teilen.
 */
export function groupWinCons(combos: readonly { cardNames: string[] }[]): WinCon[] {
  const parent = combos.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const sets = combos.map((c) => new Set(c.cardNames));
  for (let i = 0; i < combos.length; i++) {
    for (let j = i + 1; j < combos.length; j++) {
      let shared = 0;
      for (const name of sets[j]) if (sets[i].has(name)) shared++;
      if (shared >= 2) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  combos.forEach((_, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  });
  return [...groups.values()]
    .map((members) => {
      const shortest = members.reduce((a, b) =>
        combos[b].cardNames.length < combos[a].cardNames.length ? b : a,
      );
      return { cardNames: combos[shortest].cardNames, variants: members.length };
    })
    .sort((a, b) => b.variants - a.variants);
}

export interface CategoryTarget {
  target: number;
  min: number;
  max: number;
  /** Die Spielweisen, die das Ziel tatsächlich verschoben haben. */
  fewer: Influence[];
  more: Influence[];
}

export function categoryTarget(key: CategoryKey, influences: readonly Influence[]): CategoryTarget {
  const rule = CATEGORY_RULES[key];
  const fewer = rule.fewer.filter((i) => influences.includes(i));
  const more = rule.more.filter((i) => influences.includes(i));
  const step = (rule.max - rule.min) / 4;
  const raw = (rule.min + rule.max) / 2 + step * (more.length - fewer.length);
  const target = Math.round(Math.min(rule.max, Math.max(rule.min, raw)));
  return { target, min: rule.min, max: rule.max, fewer, more };
}

export interface CheckItem extends CategoryTarget {
  key: CategoryKey;
  value: number;
  level: CheckLevel;
}

export interface DeckCheckInput {
  isCommanderFormat: boolean;
  /** Effektive Länderzahl (siehe effectiveLands). */
  lands: number;
  averageCmc: number | null;
  ramp: number | null;
  draw: number | null;
  removal: number | null;
  boardwipe: number | null;
  /** Gewählte Spielweisen; die Kurve kommt automatisch dazu. */
  playStyles?: readonly PlayStyle[];
  /** Nur 60 Karten: Rampe-/Draw-Karten mit Manawert ≤ 2 (Karsten). */
  cheapRampDraw?: number | null;
}

/** Spielweisen samt automatisch erkannter Kurve. */
export function influencesFor(
  input: Pick<DeckCheckInput, 'playStyles' | 'averageCmc'>,
): Influence[] {
  const curve = curveStyle(input.averageCmc);
  return [...(input.playStyles ?? []), ...(curve ? [curve] : [])];
}

/** Länderzahl für 60-Karten-Decks nach Karsten, gerundet. */
export function recommendedLands60(
  averageCmc: number | null,
  cheapRampDraw: number | null | undefined,
): number {
  return Math.round(19.59 + 1.9 * (averageCmc ?? 2.6) - 0.28 * (cheapRampDraw ?? 0));
}

/** So viel "Land" ist eine doppelseitige Karte, deren Land-Rückseite immer getappt kommt (Karsten). */
export const MDFC_TAPPED_WEIGHT = 0.38;

/**
 * Kann die Land-Rückseite ungetappt ins Spiel kommen? "you may pay 3 life. If you don't, it enters
 * tapped" ja, "This land enters tapped" nein. Ohne bekannten Text vorsichtshalber nein.
 */
export function mdfcCanEnterUntapped(backOracleText: string | null | undefined): boolean {
  const text = (backOracleText ?? '').toLowerCase();
  if (!text) return false;
  if (text.includes('you may pay')) return true;
  return !text.includes('tapped');
}

export interface LandInfo {
  lands: number;
  /** Doppelseitige Karten, deren Land ungetappt kommen kann - zählen voll. */
  mdfcUntapped: number;
  /** Doppelseitige Karten, deren Land immer getappt kommt - zählen 0,38. */
  mdfcTapped: number;
  value: number;
}

/**
 * Effektive Länderzahl: echte Länder voll, doppelseitige Karten mit Land-Rückseite je nachdem, ob
 * das Land ungetappt kommen kann. Erwartet die Typzeile wie Scryfall sie liefert ("Sorcery // Land").
 */
export function effectiveLands(
  cards: readonly {
    typeLine: string | null | undefined;
    quantity: number;
    backOracleText?: string | null;
  }[],
): LandInfo {
  let lands = 0;
  let mdfcUntapped = 0;
  let mdfcTapped = 0;
  for (const c of cards) {
    const [front, back] = (c.typeLine ?? '').split(' // ');
    if (front.includes('Land')) lands += c.quantity;
    else if (back?.includes('Land')) {
      if (mdfcCanEnterUntapped(c.backOracleText)) mdfcUntapped += c.quantity;
      else mdfcTapped += c.quantity;
    }
  }
  const value = Math.round((lands + mdfcUntapped + mdfcTapped * MDFC_TAPPED_WEIGHT) * 10) / 10;
  return { lands, mdfcUntapped, mdfcTapped, value };
}

function levelFor(value: number, t: CategoryTarget, tolerance: number): CheckLevel {
  if (Math.abs(value - t.target) <= tolerance) return 'good';
  return value >= t.min && value <= t.max ? 'warn' : 'bad';
}

export function deckCheckItems(input: DeckCheckInput): CheckItem[] {
  if (!input.isCommanderFormat) {
    const target = recommendedLands60(input.averageCmc, input.cheapRampDraw);
    const t: CategoryTarget = { target, min: target - 2, max: target + 2, fewer: [], more: [] };
    return [{ key: 'lands', value: input.lands, ...t, level: levelFor(input.lands, t, 1) }];
  }
  const influences = influencesFor(input);
  const items: CheckItem[] = [];
  const values: Record<CategoryKey, number | null> = {
    lands: input.lands,
    ramp: input.ramp,
    draw: input.draw,
    removal: input.removal,
    boardwipe: input.boardwipe,
  };
  for (const key of Object.keys(CATEGORY_RULES) as CategoryKey[]) {
    const value = values[key];
    if (value === null) continue;
    const t = categoryTarget(key, influences);
    items.push({ key, value, ...t, level: levelFor(value, t, CATEGORY_RULES[key].tolerance) });
  }
  return items;
}

/** 0–100: grün zählt voll, gelb halb, rot nicht. */
export function deckHealthScore(items: readonly CheckItem[]): number {
  if (items.length === 0) return 0;
  const points = items.reduce(
    (sum, i) => sum + (i.level === 'good' ? 1 : i.level === 'warn' ? 0.5 : 0),
    0,
  );
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
export function hypergeometric(
  deckSize: number,
  successes: number,
  draws: number,
  k: number,
): number {
  return (choose(successes, k) * choose(deckSize - successes, draws - k)) / choose(deckSize, draws);
}

/** P(mindestens k Treffer). */
export function atLeast(deckSize: number, successes: number, draws: number, k: number): number {
  let p = 0;
  for (let i = k; i <= Math.min(draws, successes); i++)
    p += hypergeometric(deckSize, successes, draws, i);
  return Math.min(1, p);
}

/** P(zwischen lo und hi Treffer, beide eingeschlossen). */
export function between(
  deckSize: number,
  successes: number,
  draws: number,
  lo: number,
  hi: number,
): number {
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

export function deckOdds(
  librarySize: number,
  lands: number,
  ramp: number | null,
  draw: number | null,
): DeckOdds {
  return {
    keepableHand: between(librarySize, lands, 7, 2, 4),
    threeLandsByTurn3: atLeast(librarySize, lands, 9, 3),
    fourLandsByTurn4: atLeast(librarySize, lands, 10, 4),
    rampEarly: ramp === null ? null : atLeast(librarySize, ramp, 9, 1),
    drawByTurn4: draw === null ? null : atLeast(librarySize, draw, 10, 1),
  };
}

// --- Beständigkeit (fließt in den Power-Wert, siehe combinedTuning() in bracket.ts) ---

export type ConsistencyKey =
  'keepableHand' | 'sourcesByTurn3' | 'colorSources' | 'rampEarly' | 'drawByTurn4' | 'gameplan';

/**
 * Spannen und Gewichte der Beständigkeit (Entscheidung des Users, 05.10.2026). [zählt 0, zählt 1],
 * dazwischen linear. Die Grenzen sind für 99 Karten nachgerechnet: 31 Länder ergeben 68 %
 * spielbare Starthände, 40 Länder 76 %; 8 Rampen liegen zu 55 % in den ersten 9 Karten, 18 zu 85 %.
 * Wahrscheinlichkeiten als Anteil 0-1, Farbquellen als Quellen ÷ Soll, Gameplan als Deck-Check-Wert.
 */
export const CONSISTENCY_RULES: Record<
  ConsistencyKey,
  { from: number; to: number; weight: number }
> = {
  keepableHand: { from: 0.66, to: 0.76, weight: 0.15 },
  // Länder UND Rampe: ein rampenlastiges Deck mit weniger Ländern soll nicht bestraft werden.
  sourcesByTurn3: { from: 0.7, to: 0.92, weight: 0.15 },
  colorSources: { from: 0.6, to: 1, weight: 0.15 },
  rampEarly: { from: 0.55, to: 0.85, weight: 0.15 },
  drawByTurn4: { from: 0.55, to: 0.85, weight: 0.15 },
  gameplan: { from: 0, to: 100, weight: 0.25 },
};

export interface ConsistencyPart {
  key: ConsistencyKey;
  value: number;
  from: number;
  to: number;
  /** Beitrag 0-1. */
  score: number;
  weight: number;
}

export interface ConsistencyInput {
  /** Karten ohne Commander. */
  librarySize: number;
  /** Effektive Länder (doppelseitige Karten anteilig). */
  lands: number;
  /** null = Wirkungs-Kategorien noch nicht geladen. */
  ramp: number | null;
  draw: number | null;
  colors: readonly ColorRequirement[];
  /** Deck-Check-Wert 0-100 (Ampel nach Spielweise). */
  healthScore: number;
}

function anteil(value: number, from: number, to: number): number {
  return Math.min(1, Math.max(0, (value - from) / (to - from)));
}

/** Die Messgrößen einzeln - die Oberfläche schlüsselt den Wert damit auf. Fehlende entfallen. */
export function consistencyParts(input: ConsistencyInput): ConsistencyPart[] {
  if (input.librarySize < 40) return [];
  const parts: ConsistencyPart[] = [];
  const add = (key: ConsistencyKey, value: number) => {
    const { from, to, weight } = CONSISTENCY_RULES[key];
    parts.push({ key, value, from, to, score: anteil(value, from, to), weight });
  };
  const size = input.librarySize;
  const lands = Math.floor(input.lands);
  add('keepableHand', between(size, lands, 7, 2, 4));
  if (input.ramp !== null) {
    add('sourcesByTurn3', atLeast(size, Math.min(size, lands + input.ramp), 9, 3));
    add('rampEarly', atLeast(size, input.ramp, 9, 1));
  }
  if (input.colors.length > 0) {
    const weakest = Math.min(
      ...input.colors.map((c) => (c.required > 0 ? Math.min(1, c.sources / c.required) : 1)),
    );
    add('colorSources', weakest);
  }
  if (input.draw !== null) add('drawByTurn4', atLeast(size, input.draw, 10, 1));
  if (input.ramp !== null && input.draw !== null) add('gameplan', input.healthScore);
  return parts;
}

/** Gewichtetes Mittel der Teile, null wenn keiner ermittelbar war. */
export function consistencyScore(parts: readonly ConsistencyPart[]): number | null {
  const weights = parts.reduce((sum, p) => sum + p.weight, 0);
  if (weights === 0) return null;
  return parts.reduce((sum, p) => sum + p.score * p.weight, 0) / weights;
}
