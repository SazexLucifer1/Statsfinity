import type { I18nService } from './i18n.service';
import type { RadarChartDatum } from './ui/radar-chart/radar-chart';
import { COLORLESS, COLOR_AXES } from './color-filter-match';

/**
 * Offizielle Namen der Farbkombinationen (Gilden, Schattenreiche/Shards, Keile/Wedges und die
 * Vierfarben-Namen aus Commander 2016).
 *
 * Eigennamen aus dem Spiel: "Grixis" heißt in jeder Sprache Grixis, deshalb stehen sie hier und
 * nicht in i18n.service.ts. Nur die Fälle ohne Eigennamen - eine Farbe, keine Farbe, alle fünf -
 * werden übersetzt.
 */

/** Sortierreihenfolge der Manafarben, wie sie in Magic überall verwendet wird. */
const WUBRG = 'WUBRG';

const COMBO_NAMES: Record<string, string> = {
  // Gilden (Ravnica)
  WU: 'Azorius',
  WB: 'Orzhov',
  WR: 'Boros',
  WG: 'Selesnya',
  UB: 'Dimir',
  UR: 'Izzet',
  UG: 'Simic',
  BR: 'Rakdos',
  BG: 'Golgari',
  RG: 'Gruul',
  // Schattenreiche (Alara) - die drei Farben liegen im Farbkreis nebeneinander
  WUB: 'Esper',
  UBR: 'Grixis',
  BRG: 'Jund',
  WRG: 'Naya',
  WUG: 'Bant',
  // Keile (Khans of Tarkir) - eine Farbe plus ihre beiden Gegenfarben
  WBG: 'Abzan',
  WUR: 'Jeskai',
  UBG: 'Sultai',
  WBR: 'Mardu',
  URG: 'Temur',
  // Vierfarben (Nephilim / Commander 2016)
  WUBR: 'Yore-Tiller',
  UBRG: 'Glint-Eye',
  WBRG: 'Dune-Brood',
  WURG: 'Ink-Treader',
  WUBG: 'Witch-Maw',
};

/** Bringt eine Farbidentität in die WUBRG-Reihenfolge - unabhängig davon, wie sie hereinkommt. */
export function sortColors(colors: readonly string[]): string[] {
  return [...colors].sort((a, b) => WUBRG.indexOf(a) - WUBRG.indexOf(b));
}

/**
 * Eigenname einer Farbkombination aus zwei bis vier Farben, sonst null (eine Farbe, farblos und
 * fünffarbig haben keinen - die Aufrufer schreiben dort ihren eigenen Text).
 */
export function colorComboName(colors: readonly string[]): string | null {
  return COMBO_NAMES[sortColors(colors).join('')] ?? null;
}

/** Diagrammfarbe einer Farbachse (farblos neutral). */
export function colorVar(color: string): string {
  return WUBRG.includes(color) ? `var(--pip-${color.toLowerCase()})` : 'var(--series-neutral)';
}

/** Anzeigename einer Farbachse. */
export function colorLabel(i18n: I18nService, color: string): string {
  return color === COLORLESS ? i18n.t('deckView.colorless') : i18n.t(`pip.${color}`);
}

/** Anzeigename einer Kombination: Eigenname ("Azorius"), sonst Text für mono/farblos/fünffarbig. */
export function colorComboLabel(i18n: I18nService, colors: readonly string[]): string {
  if (colors.length === 0) return i18n.t('deckView.colorless');
  if (colors.length === 1) return i18n.t('colorCombo.mono', { color: colorLabel(i18n, colors[0]) });
  if (colors.length >= 5) return i18n.t('colorCombo.fiveColor');
  return colorComboName(colors) ?? colors.map((c) => colorLabel(i18n, c)).join(' / ');
}

/** Farbverteilung als Netzdiagramm in fester Achsenreihenfolge; fehlende Farben zählen 0. */
export function colorRadarData<T extends { color: string }>(
  i18n: I18nService,
  ranking: readonly T[],
  count: (stat: T) => number,
): RadarChartDatum[] {
  return COLOR_AXES.map((color) => {
    const stat = ranking.find((c) => c.color === color);
    return {
      label: colorLabel(i18n, color),
      value: stat ? count(stat) : 0,
      color: colorVar(color),
      symbol: color,
    };
  });
}
