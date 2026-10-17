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
}

/**
 * Spalten der Tabelle, Reihenfolge wie bei CubeCobra: die fünf Farben, mehrfarbig, farblos,
 * Länder. Länder bekommen eine eigene Spalte unabhängig von ihrer Farbidentität - sonst stünden
 * die Dual-Länder unter "mehrfarbig" zwischen den Goldkarten.
 */
export const CUBE_COLUMNS = ['W', 'U', 'B', 'R', 'G', 'M', 'C', 'L'] as const;
export type CubeColumnKey = (typeof CUBE_COLUMNS)[number];

export function colorCategory(
  card: Pick<CubeCardData, 'typeLine' | 'colorIdentity'>,
): CubeColumnKey {
  // Bei Doppelkarten zählt die Vorderseite: ein MDFC-Zauber mit Land-Rückseite ist ein Zauber.
  const front = (card.typeLine ?? '').split(' // ')[0];
  if (front.includes('Land')) return 'L';
  const colors = card.colorIdentity;
  if (colors.length === 0) return 'C';
  if (colors.length > 1) return 'M';
  return colors[0] as CubeColumnKey;
}

export interface CubeTypeGroup<T> {
  /** Typ-Abschnitt wie in der Deck-Ansicht ("Kreatur", "Spontanzauber", ...). */
  type: string;
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

/**
 * Die Tabellen-Ansicht: je Farbspalte Abschnitte nach Kartentyp, darin nach Manawert und Name.
 * Leere Spalten fallen weg.
 */
export function cubeTable<T extends CubeCardData>(cards: readonly T[]): CubeColumn<T>[] {
  const columns: CubeColumn<T>[] = [];
  for (const key of CUBE_COLUMNS) {
    const inColumn = cards.filter((c) => colorCategory(c) === key);
    if (inColumn.length === 0) continue;
    const groups = new Map<string, CubeTypeGroup<T>>();
    for (const card of [...inColumn].sort(byCmcThenName)) {
      const type = typeSection(card.typeLine);
      const group = groups.get(type) ?? { type, count: 0, cards: [] };
      group.cards.push(card);
      group.count += card.quantity;
      groups.set(type, group);
    }
    const rank = (type: string) => {
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
