import { Component, computed, inject, input } from '@angular/core';
import { I18nService } from '../../i18n.service';
import { PerformanceSummary as Summary, WinConditionCount } from '../../match-insights';
import { Meter } from '../meter/meter';
import { SampleHint } from '../sample-hint/sample-hint';

/** Zahl in der Sprache der Oberfläche (Komma im Deutschen), höchstens `digits` Nachkommastellen. */
export function formatNumber(value: number, lang: string, digits = 1): string {
  return value.toLocaleString(lang === 'de' ? 'de-DE' : 'en-US', {
    maximumFractionDigits: digits,
  });
}

/**
 * Kennzahlen-Kacheln einer Performance-Auswertung (match-insights.ts, performanceSummary) und
 * optional die Verteilung der Siegarten - gemeinsam für den Statistik-Tab (performance-stats/) und
 * die Deck-Ansicht (deck-performance/). Unter jedem Schnitt steht, aus wie vielen Partien er
 * stammt; fehlt der Wert in allen Partien, steht "–" statt einer erfundenen 0.
 */
@Component({
  selector: 'app-performance-summary',
  imports: [Meter, SampleHint],
  templateUrl: './performance-summary.html',
  styleUrl: './performance-summary.scss',
})
export class PerformanceSummaryView {
  readonly i18n = inject(I18nService);

  /** Ohne Zusammenfassung nur die Siegarten (Gruppen-Überblick im Statistik-Tab). */
  readonly summary = input<Summary | null>(null);
  /** Partien/Siege/Winrate zeigen - aus, wo diese Kacheln schon darüber stehen (Deck-Ansicht). */
  readonly showCounts = input(true);
  readonly winConditions = input<readonly WinConditionCount[] | null>(null);

  readonly winConditionMax = computed(() =>
    Math.max(0, ...(this.winConditions() ?? []).map((w) => w.count)),
  );
  readonly winConditionTotal = computed(() =>
    (this.winConditions() ?? []).reduce((sum, w) => sum + w.count, 0),
  );

  num(value: number | null, digits = 1): string {
    return value === null ? '–' : formatNumber(value, this.i18n.lang(), digits);
  }

  minutes(value: number | null): string {
    if (value === null) return '–';
    const m = Math.round(value);
    if (m < 60) return this.i18n.t('match.durationMinutes', { min: m });
    return this.i18n.t('match.durationHours', { h: Math.floor(m / 60), min: m % 60 });
  }
}
