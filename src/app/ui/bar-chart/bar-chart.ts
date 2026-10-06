import { Component, computed, input } from '@angular/core';
import { Meter } from '../meter/meter';
import { ManaSymbol } from '../mana-symbol/mana-symbol';
import { barPercent, maxValue } from '../chart-scale';

export interface BarChartDatum {
  /** Beschriftung der Kategorie, z.B. ein Spielmodus, eine Platzierung oder ein Kartentyp. */
  label: string;
  value: number;
  /** Optionaler Zusatztext rechts vom Wert, z.B. "7 / 12 Siege". */
  detail?: string;
  /** Eigene Balkenfarbe, z.B. eine Pip-Farbe. Ohne Angabe der Akzentton. */
  color?: string;
  /**
   * Manafarbe (W/U/B/R/G/C), die vor der Beschriftung als Symbol steht - nur bei waagerechten
   * Balken. Die Balkenfarbe allein trägt die Farbidentität nicht: sie ist für Rot-Grün-Blinde
   * mehrdeutig und ohne Legende überhaupt nur zu erraten. Das Symbol sagt es eindeutig.
   */
  symbol?: string;
  /**
   * Nur senkrecht: wie viel möglich gewesen wäre, z.B. alle Partien der Gruppe in einem Monat.
   * Dann steht die Säule blass in voller Höhe, der Wert füllt sie von unten, und oben steht
   * "Wert/total".
   */
  total?: number;
}

/**
 * Balkendiagramm für eine Wertereihe - waagerecht als Liste oder senkrecht als Säulen.
 *
 * Ersetzt drei verbatim kopierte CSS-Blöcke (.curve-chart/.pip-chart in deck-detail-view,
 * precon-browser und public-deck-browser) und eine ganze Reihe reiner Zahlenlisten in
 * Statistik-, Profil- und Turnier-Ansicht.
 *
 * Eine Reihe, eine Farbe - deshalb bewusst ohne Legende: die Überschrift der Sektion sagt bereits,
 * was aufgetragen ist. Mehrfarbige Balken (Pip-Verteilung) tragen ihre Identität über die
 * Beschriftung in derselben Zeile, nie über die Farbe allein.
 */
@Component({
  selector: 'app-bar-chart',
  imports: [Meter, ManaSymbol],
  templateUrl: './bar-chart.html',
  styleUrl: './bar-chart.scss',
})
export class BarChart {
  readonly data = input.required<readonly BarChartDatum[]>();
  readonly orientation = input<'horizontal' | 'vertical'>('horizontal');
  /**
   * 'max'     - auf den größten Wert der Reihe normieren (Absolutwerte wie Spiele oder Karten).
   * 'percent' - feste Skala 0-100 (Anteile wie Winrate, damit 40% überall gleich lang aussieht).
   */
  readonly scale = input<'max' | 'percent'>('max');
  /** Wird an den Wert gehängt, z.B. '%'. */
  readonly valueSuffix = input('');
  /** Breite der Beschriftungsspalte bei waagerechten Balken. */
  readonly labelWidth = input('auto');

  readonly reference = computed(() =>
    this.scale() === 'percent'
      ? 100
      : maxValue(this.data().map((d) => Math.max(d.value, d.total ?? 0))),
  );

  percentOf(value: number): number {
    return barPercent(value, this.reference());
  }
}
