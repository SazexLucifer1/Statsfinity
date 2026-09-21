/**
 * Sortier-/Balken-Hilfsfunktionen für Ranglisten (Spieler, Decks, Commander) - reine Funktionen mit
 * primitiven Parametern statt an eine bestimmte Komponente gebunden, damit sowohl der Stats-Tab
 * (gruppenbezogen) als auch GlobalStats (weltweit, ohne Login nutzbar) dieselbe Sortier- und
 * Balkenlogik verwenden können, ohne sie zu duplizieren.
 */

import { PODIUM_SIZE } from './ui/podium/podium';

export type RankSortMode = 'wins' | 'winRate' | 'games';

export function compareBySortMode<T extends { wins: number; winRate: number; games: number }>(
  mode: RankSortMode,
): (a: T, b: T) => number {
  switch (mode) {
    case 'wins':
      return (a, b) => b.wins - a.wins || b.winRate - a.winRate;
    case 'games':
      return (a, b) => b.games - a.games || b.winRate - a.winRate;
    case 'winRate':
      return (a, b) => b.winRate - a.winRate || b.games - a.games;
  }
}

export function barValue(
  entry: { wins: number; games: number; winRate: number },
  mode: RankSortMode,
): number {
  switch (mode) {
    case 'wins':
      return entry.wins;
    case 'games':
      return entry.games;
    case 'winRate':
      return entry.winRate;
  }
}

/**
 * Bezugsgröße für die Balken einer Liste.
 *
 * Bei Winrate fest 100, damit 40% in jeder Liste gleich lang aussieht. Bei Absolutwerten der
 * Größtwert der Liste, sonst wäre bei lauter kleinen Zahlen jeder Balken ein Stummel.
 */
export function barMax(
  list: readonly { wins: number; games: number; winRate: number }[],
  mode: RankSortMode,
): number {
  if (mode === 'winRate') return 100;
  return Math.max(1, ...list.map((e) => barValue(e, mode)));
}

/**
 * Nummerierte Platzierung einer Ranglisten-Zeile ("1.", "2.", …).
 *
 * Stand früher für die ersten drei Ränge auf Medaillen-Emojis um. Die sahen auf jedem System
 * anders aus und waren neben einer sonst rein typografischen Liste der einzige bunte Fleck; die
 * Zahl sagt dasselbe und passt sich der Textfarbe an.
 */
export function medal(index: number): string {
  return `${index + 1}.`;
}

/**
 * Teilt die Zeilen der aktuellen Ranglisten-Seite auf: die ersten drei stehen auf dem
 * Siegertreppchen (ui/podium), der Rest läuft als normale Liste darunter weiter. Ein Treppchen gibt
 * es nur auf der ERSTEN Seite - ab Seite 2 ist keine Top 3 mehr im Blick, dort bleibt alles Liste.
 */
export function splitPodium<T>(pageRows: readonly T[], page: number): { podium: T[]; rest: T[] } {
  if (page !== 0) return { podium: [], rest: [...pageRows] };
  return { podium: pageRows.slice(0, PODIUM_SIZE), rest: pageRows.slice(PODIUM_SIZE) };
}

/**
 * Rang-Index der ersten Zeile UNTER dem Treppchen - Grundlage für medal() in der Liste, damit dort
 * auf der ersten Seite "4." statt "1." steht.
 */
export function podiumRestOffset(page: number, pageSize: number): number {
  return page * pageSize + (page === 0 ? PODIUM_SIZE : 0);
}
