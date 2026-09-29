import type { BracketLevel } from './bracket';

/**
 * Bracket-Benchmark an den eigenen Decks: Wie gut trennen einzelne Merkmale die Bracket-Stufen?
 *
 * Gleiche Methode wie docs/bracket-benchmark-archidekt-2026-09.md, damit die Zahlen vergleichbar
 * sind: AUC über Ränge (Mann-Whitney) - zieht man zufällig ein Deck der höheren und eines der
 * niedrigeren Stufe, wie oft hat das höhere den größeren Wert? 0,5 heißt "trennt gar nicht",
 * Gleichstand zählt halb. Die Merkmale je Deck liefert sql/bracket-benchmark-eigen-2026-09-29.sql.
 */

export type MerkmalKey =
  | 'gameChanger'
  | 'tutoren'
  | 'combos'
  | 'laender'
  | 'rampe'
  | 'interaktion'
  | 'mld'
  | 'extrazuege'
  | 'avgCmc';

/** Ein Deck mit selbst gesetzter Stufe und seinen Merkmalen. */
export interface BenchmarkDeck {
  bracket: BracketLevel;
  werte: Record<MerkmalKey, number | null>;
}

/** Reihenfolge der Tabelle: erst die, zu denen es einen Archidekt-Wert gibt. */
export const MERKMALE: MerkmalKey[] = [
  'gameChanger',
  'tutoren',
  'combos',
  'laender',
  'rampe',
  'interaktion',
  'avgCmc',
  'mld',
  'extrazuege',
];

/**
 * Archidekt-Benchmark, Bracket 2 gegen 4 (48.638 Decks, September 2026). Nur Merkmale, die dort
 * genauso gezählt wurden - Ø Manawert, Massen-Landzerstörung und Extrazüge gab es dort nicht.
 */
export const ARCHIDEKT_AUC: Partial<Record<MerkmalKey, number>> = {
  gameChanger: 0.898,
  tutoren: 0.771,
  combos: 0.633,
  laender: 0.366,
  rampe: 0.622,
  interaktion: 0.509,
};

/** Unter so vielen Decks je Stufe ist eine AUC Zufall - dann keine Zahl anzeigen. */
export const MIN_DECKS_JE_STUFE = 5;

/** Mann-Whitney-AUC: Anteil der Paare (hoch, niedrig) mit hoch > niedrig, Gleichstand halb. */
export function auc(niedrig: number[], hoch: number[]): number | null {
  if (!niedrig.length || !hoch.length) return null;
  let summe = 0;
  for (const h of hoch) for (const n of niedrig) summe += h > n ? 1 : h === n ? 0.5 : 0;
  return summe / (niedrig.length * hoch.length);
}

export interface BenchmarkErgebnis {
  /** Decks je Stufe 1-5. */
  anzahl: Record<BracketLevel, number>;
  /** AUC Bracket 2 gegen 4 je Merkmal, null bei zu wenig Decks. */
  auc: Record<MerkmalKey, number | null>;
}

/** Wertet die Decks aus: Anzahl je Stufe und AUC 2 gegen 4 je Merkmal. */
export function auswerten(decks: BenchmarkDeck[]): BenchmarkErgebnis {
  const anzahl = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<BracketLevel, number>;
  for (const d of decks) anzahl[d.bracket]++;
  const genug = anzahl[2] >= MIN_DECKS_JE_STUFE && anzahl[4] >= MIN_DECKS_JE_STUFE;

  const werte = (stufe: BracketLevel, m: MerkmalKey) =>
    decks
      .filter((d) => d.bracket === stufe)
      .map((d) => d.werte[m])
      .filter((w): w is number => w != null);

  const ergebnis = {} as Record<MerkmalKey, number | null>;
  for (const m of MERKMALE) ergebnis[m] = genug ? auc(werte(2, m), werte(4, m)) : null;
  return { anzahl, auc: ergebnis };
}
