/**
 * Auswahl und Abgleich der Farbfilter (Kartensuche, Deckbau, Deck- und Precon-Kartenlisten).
 *
 * Liegt außerhalb der Filter-Komponente, weil die Bedeutung einer Auswahl nicht der Bedienung
 * gehört: die Kartenlisten prüfen sie lokal gegen die Farbidentität, die Kartensuche baut daraus
 * eine Scryfall-Abfrage (siehe scryfall.service.ts). Beide müssen dasselbe meinen.
 */

/** Die fünf Manafarben in der üblichen WUBRG-Reihenfolge. */
export const FILTER_COLORS = ['W', 'U', 'B', 'R', 'G'] as const;

/** Eigene Auswahl für "gar keine Farbe" - schließt die fünf Farben aus und wird von ihnen ausgeschlossen. */
export const COLORLESS = 'C';

/**
 * Achsen der Farbstatistik: WUBRG, farblos als sechste. Fest und nie nach Häufigkeit sortiert,
 * damit dieselbe Farbe immer an derselben Stelle des Netzdiagramms liegt.
 */
export const COLOR_AXES = [...FILTER_COLORS, COLORLESS] as const;

/**
 * Wie die gewählten Farben zu lesen sind:
 *
 * - 'exact'   - die Farbidentität ist GENAU diese Auswahl. Blau allein findet nur einfarbig blaue
 *               Karten, Blau + Grün nur Simic-Karten. Das ist der Standard: wer eine Kombination
 *               anklickt, meint meistens genau die.
 * - 'atLeast' - die Farbidentität ENTHÄLT diese Auswahl, darf aber mehr haben. Blau + Grün findet
 *               dann auch Temur- und Fünffarben-Karten.
 */
export type ColorMatchMode = 'exact' | 'atLeast';

/** Gewählte Farben (immer in WUBRG-Reihenfolge, leer = keine Einschränkung) samt Lesart. */
export interface ColorSelection {
  readonly colors: readonly string[];
  readonly mode: ColorMatchMode;
}

export const EMPTY_COLOR_SELECTION: ColorSelection = { colors: [], mode: 'exact' };

/**
 * Schaltet eine Farbe an oder aus. "Farblos" und echte Farben schließen sich gegenseitig aus -
 * eine Karte ohne Farbidentität kann nicht gleichzeitig blau sein, die Kombination wäre immer leer.
 */
export function toggleColorSelection(selection: ColorSelection, color: string): ColorSelection {
  const colors = selection.colors;
  if (color === COLORLESS) {
    return { ...selection, colors: colors.includes(COLORLESS) ? [] : [COLORLESS] };
  }
  const withoutColorless = colors.filter((c) => c !== COLORLESS);
  const next = withoutColorless.includes(color)
    ? withoutColorless.filter((c) => c !== color)
    : [...withoutColorless, color];
  return { ...selection, colors: FILTER_COLORS.filter((c) => next.includes(c)) };
}

/**
 * Ist die Lesart (genau/enthält) für diese Auswahl überhaupt eine Frage?
 *
 * Bei "farblos" nicht: eine leere Farbidentität enthält nichts, was sie erweitern könnte - genau
 * und mindestens sind dasselbe. Ohne Auswahl ebenfalls nicht.
 */
export function colorModeApplies(selection: ColorSelection): boolean {
  return selection.colors.length > 0 && !selection.colors.includes(COLORLESS);
}

/** Passt eine Farbidentität zur Auswahl? Die Lesart steckt in selection.mode. */
export function matchesColorSelection(identity: readonly string[], selection: ColorSelection): boolean {
  const { colors, mode } = selection;
  if (colors.length === 0) return true;
  if (colors.includes(COLORLESS)) return identity.length === 0;
  const containsAll = colors.every((color) => identity.includes(color));
  return mode === 'atLeast' ? containsAll : containsAll && identity.length === colors.length;
}
