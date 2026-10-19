import { TYPE_ORDER, typeSection } from './deck-analyse';

/**
 * Rechnen für den Cube-Builder (cube-view/): Tabelle nach Farbspalten wie bei CubeCobra,
 * Probe-Booster, Abgleich mit der Sammlung. Reine Funktionen, damit sie ohne Datenbank prüfbar
 * sind (cube-layout.spec.ts).
 */

/** Eine Karte im Cube samt Daten aus dem Nacht-Cache; Fehlendes ist null/leer. */
export interface CubeCardData {
  name: string;
  quantity: number;
  typeLine: string | null;
  cmc: number | null;
  colorIdentity: readonly string[];
  /** Selbst gesetzte Spalte (aus dem CubeCobra-Export); null = aus Typ und Farben gerechnet. */
  colorCategory?: CubeColumnKey | null;
}

/**
 * Spalten der Tabelle, Reihenfolge wie bei CubeCobra: die fünf Farben, Hybrid, mehrfarbig,
 * farblos, Länder. Länder bekommen eine eigene Spalte unabhängig von ihrer Farbidentität - sonst
 * stünden die Dual-Länder unter "mehrfarbig" zwischen den Goldkarten. Hybrid gibt es nur, wenn
 * eine Karte ausdrücklich dort einsortiert ist (CubeCobra-Export).
 */
export const CUBE_COLUMNS = ['W', 'U', 'B', 'R', 'G', 'H', 'M', 'C', 'L'] as const;
export type CubeColumnKey = (typeof CUBE_COLUMNS)[number];

/** CubeCobras "Color Category" -> Spalte. */
const COBRA_CATEGORIES: Record<string, CubeColumnKey> = {
  white: 'W',
  blue: 'U',
  black: 'B',
  red: 'R',
  green: 'G',
  hybrid: 'H',
  multicolored: 'M',
  multicolor: 'M',
  gold: 'M',
  colorless: 'C',
  lands: 'L',
  land: 'L',
};

export function cobraCategory(value: string | null | undefined): CubeColumnKey | null {
  return COBRA_CATEGORIES[(value ?? '').trim().toLowerCase()] ?? null;
}

export function colorCategory(
  card: Pick<CubeCardData, 'typeLine' | 'colorIdentity' | 'colorCategory'>,
): CubeColumnKey {
  if (card.colorCategory) return card.colorCategory;
  // Bei Doppelkarten zählt die Vorderseite: ein MDFC-Zauber mit Land-Rückseite ist ein Zauber.
  const front = (card.typeLine ?? '').split(' // ')[0];
  if (front.includes('Land')) return 'L';
  const colors = card.colorIdentity;
  if (colors.length === 0) return 'C';
  if (colors.length > 1) return 'M';
  return colors[0] as CubeColumnKey;
}

/**
 * Reihenfolge der Farbkombinationen wie bei CubeCobra: Gilden (Azorius, Dimir, Rakdos, Gruul,
 * Selesnya, dann die Feinde Orzhov, Izzet, Golgari, Boros, Simic), Shards, Wedges, vier, fünf.
 * Schlüssel in WUBRG-Reihenfolge wie sortColors().
 */
const COMBO_ORDER = [
  'WU',
  'UB',
  'BR',
  'RG',
  'WG',
  'WB',
  'UR',
  'BG',
  'WR',
  'UG',
  'WUG',
  'WUB',
  'UBR',
  'BRG',
  'WRG',
  'WBG',
  'WUR',
  'UBG',
  'WBR',
  'URG',
  'UBRG',
  'WBRG',
  'WURG',
  'WUBG',
  'WUBR',
  'WUBRG',
];
const WUBRG = 'WUBRG';

/** Farbkombination als Schlüssel in WUBRG-Reihenfolge ("" = farblos). */
export function comboKey(colors: readonly string[]): string {
  return [...colors]
    .filter((c) => WUBRG.includes(c))
    .sort((a, b) => WUBRG.indexOf(a) - WUBRG.indexOf(b))
    .join('');
}

export interface CubeTypeGroup<T> {
  /**
   * Abschnitt: in den Farbspalten der Typ wie in der Deck-Ansicht ("Kreatur", ...), in
   * Mehrfarbig, Hybrid und Ländern die Farbkombination ("WU", "UB", ...; "" = farblos).
   */
  type: string;
  /** true = `type` ist eine Farbkombination, kein Kartentyp. */
  byColors: boolean;
  count: number;
  cards: T[];
}

export interface CubeColumn<T> {
  key: CubeColumnKey;
  count: number;
  groups: CubeTypeGroup<T>[];
}

function byCmcThenName<T extends CubeCardData>(a: T, b: T): number {
  return (a.cmc ?? 99) - (b.cmc ?? 99) || a.name.localeCompare(b.name);
}

/** In diesen Spalten teilt CubeCobra nach Farbkombination statt nach Typ. */
const COLOR_GROUPED: readonly CubeColumnKey[] = ['H', 'M', 'L'];

/**
 * Die Tabellen-Ansicht: je Farbspalte Abschnitte nach Kartentyp, in Mehrfarbig, Hybrid und
 * Ländern nach Farbkombination (wie CubeCobra), darin nach Manawert und Name. Leere Spalten
 * fallen weg.
 */
export function cubeTable<T extends CubeCardData>(cards: readonly T[]): CubeColumn<T>[] {
  const columns: CubeColumn<T>[] = [];
  for (const key of CUBE_COLUMNS) {
    const inColumn = cards.filter((c) => colorCategory(c) === key);
    if (inColumn.length === 0) continue;
    const byColors = COLOR_GROUPED.includes(key);
    const groups = new Map<string, CubeTypeGroup<T>>();
    for (const card of [...inColumn].sort(byCmcThenName)) {
      const type = byColors ? comboKey(card.colorIdentity) : typeSection(card.typeLine);
      const group = groups.get(type) ?? { type, byColors, count: 0, cards: [] };
      group.cards.push(card);
      group.count += card.quantity;
      groups.set(type, group);
    }
    const rank = (type: string) => {
      if (byColors) {
        // Einfarbige (Länder) nach WUBRG vorn, farblose ganz hinten.
        if (type === '') return 99;
        if (type.length === 1) return -10 + WUBRG.indexOf(type);
        const i = COMBO_ORDER.indexOf(type);
        return i < 0 ? 98 : i;
      }
      const i = TYPE_ORDER.findIndex((t) => t.label === type);
      return i < 0 ? 99 : i;
    };
    columns.push({
      key,
      count: inColumn.reduce((sum, c) => sum + c.quantity, 0),
      groups: [...groups.values()].sort((a, b) => rank(a.type) - rank(b.type)),
    });
  }
  return columns;
}

/** Eine Zeile aus CubeCobras CSV-Export (Cube → Export → Comma-Separated). */
export interface CubeCobraRow {
  name: string;
  quantity: number;
  colorCategory: CubeColumnKey | null;
  set: string | null;
  collectorNumber: string | null;
}

/** Zerlegt CSV mit Anführungszeichen ("a, b" bleibt ein Feld, "" ist ein Anführungszeichen). */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

/**
 * Liest CubeCobras CSV-Export; null, wenn der Text keiner ist (dann ist es eine normale Liste).
 * Behalten wird, was die Sortierung des Originals ausmacht: die selbst gesetzte Farbkategorie
 * und der Druck (Set + Nummer). Zeilen aus dem Maybeboard bleiben draußen, mehrfache Zeilen
 * derselben Karte werden zur Anzahl.
 */
export function parseCubeCobraCsv(text: string): CubeCobraRow[] | null {
  const rows = csvRows(text.trim());
  if (rows.length < 2) return null;
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const nameIdx = col('name');
  if (nameIdx < 0 || (col('color category') < 0 && col('set') < 0)) return null;
  const categoryIdx = col('color category');
  const setIdx = col('set');
  const numberIdx = col('collector number');
  const maybeIdx = col('maybeboard');
  const boardIdx = col('board');
  const byName = new Map<string, CubeCobraRow>();
  for (const raw of rows.slice(1)) {
    // CubeCobra setzt den Namen NICHT in Anführungszeichen ("Anhelo, the Painter,3,...") - jedes
    // Komma darin ergibt ein Feld zu viel. Alle anderen Textfelder sind gequotet, also gehören
    // die überzähligen Felder zum Namen.
    const extra = Math.max(0, raw.length - header.length);
    const r =
      extra > 0
        ? [
            ...raw.slice(0, nameIdx),
            raw.slice(nameIdx, nameIdx + extra + 1).join(','),
            ...raw.slice(nameIdx + extra + 1),
          ]
        : raw;
    const name = repairEncoding((r[nameIdx] ?? '').trim());
    if (!name) continue;
    if (maybeIdx >= 0 && (r[maybeIdx] ?? '').trim().toLowerCase() === 'true') continue;
    const board = boardIdx >= 0 ? (r[boardIdx] ?? '').trim().toLowerCase() : '';
    if (board && board !== 'mainboard') continue;
    const key = name.toLowerCase();
    const prev = byName.get(key);
    if (prev) {
      prev.quantity++;
      continue;
    }
    byName.set(key, {
      name,
      quantity: 1,
      colorCategory: categoryIdx >= 0 ? cobraCategory(r[categoryIdx]) : null,
      set: setIdx >= 0 ? (r[setIdx] ?? '').trim().toLowerCase() || null : null,
      collectorNumber: numberIdx >= 0 ? (r[numberIdx] ?? '').trim() || null : null,
    });
  }
  return [...byName.values()];
}

/**
 * Repariert UTF-8, das als Latin-1 gelesen wurde ("BartolomÃ©" -> "Bartolomé") - so kommt der
 * CubeCobra-Export heraus, wenn ihn ein Programm mit falscher Zeichensatz-Annahme öffnet. Nur
 * wenn die typischen Zeichen vorkommen und die Rückwandlung gültiges UTF-8 ergibt.
 */
export function repairEncoding(text: string): string {
  if (!/[ÃÂÄÅÇÉ][\u0080-\u00ff]/.test(text) || /[^\u0000-\u00ff]/.test(text)) return text;
  try {
    const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return text;
  }
}

/** Kartenzahl je Farbspalte, alle Spalten (auch leere) in fester Reihenfolge. */
export function columnCounts(
  cards: readonly CubeCardData[],
): { key: CubeColumnKey; count: number }[] {
  return CUBE_COLUMNS.map((key) => ({
    key,
    count: cards.filter((c) => colorCategory(c) === key).reduce((sum, c) => sum + c.quantity, 0),
  }));
}

/** Jede Karte so oft, wie sie im Cube liegt. */
export function expandCopies<T extends { quantity: number }>(cards: readonly T[]): T[] {
  return cards.flatMap((c) => Array.from({ length: Math.max(0, c.quantity) }, () => c));
}

/**
 * Probe-Booster: `size` zufällige Exemplare ohne Zurücklegen (Fisher-Yates über die Exemplare,
 * nicht über die Namen - ein Cube mit zwei Exemplaren einer Karte kann beide in einen Booster
 * geben). `random` ist nur für den Test austauschbar.
 */
export function samplePack<T extends { quantity: number }>(
  cards: readonly T[],
  size = 15,
  random: () => number = Math.random,
): T[] {
  const pool = expandCopies(cards);
  const count = Math.min(size, pool.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/**
 * Was dem Cube in der Sammlung fehlt: je Karte, wie viele Exemplare nicht abgedeckt sind.
 * `owned` liefert die Zahl der Exemplare in der Sammlung (alle Drucke, Foil und nicht).
 */
export function collectionGaps(
  cards: readonly Pick<CubeCardData, 'name' | 'quantity'>[],
  owned: (name: string) => number,
): { name: string; missing: number }[] {
  return cards
    .map((c) => ({ name: c.name, missing: Math.max(0, c.quantity - owned(c.name)) }))
    .filter((g) => g.missing > 0);
}
