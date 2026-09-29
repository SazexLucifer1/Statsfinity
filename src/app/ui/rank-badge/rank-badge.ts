import { Component, computed, input } from '@angular/core';
import { RankTier, RANK_TIERS, divisionLabel } from '../../elo';

/** Zwei Töne je Rang: hell (oben im Verlauf, Glanz) und dunkel (unten, Kanten). */
export interface RankColors {
  light: string;
  dark: string;
}

/**
 * Die EINZIGE Farbtabelle der Ränge. Der Profilrahmen und der Ring ums Profilbild holen sich ihre
 * Farben hieraus (als CSS-Variablen, siehe rankStyle()) - stünden sie ein zweites Mal im
 * Stylesheet, passte der Rahmen nach der nächsten Änderung nicht mehr zum Abzeichen.
 */
export const RANK_COLORS: Record<RankTier, RankColors> = {
  wood: { light: '#c89464', dark: '#6b4226' },
  iron: { light: '#c3c9d1', dark: '#555c66' },
  bronze: { light: '#eab07a', dark: '#8c4f22' },
  silver: { light: '#f4f7fa', dark: '#8795a3' },
  gold: { light: '#ffe38f', dark: '#b8801a' },
  platinum: { light: '#b4f5e6', dark: '#26877c' },
  diamond: { light: '#c4e0ff', dark: '#3563d6' },
  infinity: { light: '#ffb070', dark: '#7a2bc4' },
};

/** CSS-Variablen für Rahmen in Rangfarbe (`--rank-light`, `--rank-dark`), null = kein Rang. */
export function rankStyle(tier: RankTier | null): Record<string, string> | null {
  if (!tier) return null;
  const c = RANK_COLORS[tier];
  return { '--rank-light': c.light, '--rank-dark': c.dark };
}

let naechsteId = 0;

/**
 * Abzeichen eines Elo-Rangs (Holz bis Infinity, siehe elo.ts): ein Wappenschild im Verlauf
 * der Rangfarbe, das mit jedem Rang mehr Schmuck bekommt - ab Gold Flügel, ab Platin eine Krone,
 * Diamant einen Edelstein, Infinity das Unendlich-Zeichen
 * (Name und Zeichen spielen auf Statsfinity an). Unten ein Band mit der Division (V bis I),
 * Infinity ist wie Master in LoL nach oben offen und hat keine.
 *
 * Die Größe kommt aus `size` (Pixel). Beschriftet sich selbst über `label`, sonst dekorativ.
 */
@Component({
  selector: 'app-rank-badge',
  templateUrl: './rank-badge.html',
  styleUrl: './rank-badge.scss',
  host: { '[style.--badge-size.px]': 'size()' },
})
export class RankBadge {
  readonly tier = input.required<RankTier>();
  readonly division = input<number | null>(null);
  readonly size = input(64);
  readonly label = input<string | null>(null);

  /** Verläufe brauchen eine im Dokument eindeutige ID, sonst malt jedes Abzeichen im ersten. */
  readonly gid = `rank-grad-${++naechsteId}`;

  readonly colors = computed(() => RANK_COLORS[this.tier()]);
  /** 0 (Holz) bis 7 (Infinity) - bestimmt, wie viel Schmuck dazukommt. */
  readonly level = computed(() => RANK_TIERS.indexOf(this.tier()));
  readonly numeral = computed(() => divisionLabel(this.division()));
}
