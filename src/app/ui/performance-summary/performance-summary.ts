import { Component, computed, inject, input } from '@angular/core';
import { I18nService } from '../../i18n.service';
import {
  OverallSummary,
  PerformanceSummary as Summary,
  WinConditionCount,
} from '../../match-insights';
import { InfoToggle } from '../info-toggle/info-toggle';
import { Meter } from '../meter/meter';
import { SampleHint } from '../sample-hint/sample-hint';

/** Platzhalter für einen fehlenden Wert - nie null, NaN oder eine erfundene 0. */
export const NO_VALUE = '—';

/** Zahl in der Sprache der Oberfläche (Komma im Deutschen), höchstens `digits` Nachkommastellen. */
export function formatNumber(value: number, lang: string, digits = 1): string {
  return value.toLocaleString(lang === 'de' ? 'de-DE' : 'en-US', {
    maximumFractionDigits: digits,
  });
}

/** Prozentwert ohne Nachkommastellen, "—" ohne Spiele. */
export function formatRate(value: number | null, lang: string): string {
  return value === null ? NO_VALUE : `${formatNumber(value, lang, 0)} %`;
}

/** Durchschnitt mit `digits` Nachkommastellen, "—" ohne Werte. */
export function formatAverage(value: number | null, lang: string, digits = 1): string {
  return value === null ? NO_VALUE : formatNumber(value, lang, digits);
}

/** Minuten als "42 Min." bzw. "1 Std. 5 Min.", "—" ohne Werte. */
export function formatMinutes(value: number | null, i18n: I18nService): string {
  if (value === null) return NO_VALUE;
  const m = Math.round(value);
  if (m < 60) return i18n.t('match.durationMinutes', { min: m });
  return i18n.t('match.durationHours', { h: Math.floor(m / 60), min: m % 60 });
}

/** "1 Spiel" / "15 Spiele". */
export function gameCount(count: number, i18n: I18nService): string {
  return count === 1
    ? i18n.t('stats.performance.gameCountOne')
    : i18n.t('stats.performance.gameCount', { count });
}

/** Grundlage eines Schnitts: "aus 3 Spielen" bzw. "Keine Daten". */
export function basisLabel(count: number, i18n: I18nService): string {
  if (count === 0) return i18n.t('stats.performance.noData');
  return count === 1
    ? i18n.t('stats.performance.fromGameOne')
    : i18n.t('stats.performance.fromGames', { count });
}

interface Fact {
  label: string;
  value: string;
  basis: string;
  missing: boolean;
}

/**
 * Kennzahlen einer Performance-Auswertung (match-insights.ts) - gemeinsam für den Statistik-Tab
 * (performance-stats/) und die Deck-Ansicht (deck-performance/).
 *
 * Aufbau nach Wichtigkeit: oben eine ruhige Zeile mit Winrate, Spielen und Siegen; darunter die
 * Schnitte als Liste, jeder mit seiner Grundlage ("aus 3 Spielen" bzw. "Keine Daten"); zuletzt
 * die Siegarten. Bewusst keine Kachel je Zahl - die Werte sollen sich auf einen Blick lesen
 * lassen, nicht als Raster gleich lauter Kästen.
 */
@Component({
  selector: 'app-performance-summary',
  imports: [InfoToggle, Meter, SampleHint],
  templateUrl: './performance-summary.html',
  styleUrl: './performance-summary.scss',
})
export class PerformanceSummaryView {
  readonly i18n = inject(I18nService);

  /** Auswertung eines Spielers oder Decks. */
  readonly summary = input<Summary | null>(null);
  /** Überblick ohne Spieler (Gruppe) - dort gibt es keine sinnvolle Winrate. */
  readonly overall = input<OverallSummary | null>(null);
  /** Winrate/Spiele/Siege zeigen - aus, wo diese Zahlen schon direkt darüber stehen. */
  readonly showCounts = input(true);
  readonly winConditions = input<readonly WinConditionCount[] | null>(null);

  readonly rate = computed(() => formatRate(this.summary()?.winRate ?? null, this.i18n.lang()));

  readonly facts = computed<Fact[]>(() => {
    const lang = this.i18n.lang();
    const fact = (label: string, value: string, count: number): Fact => ({
      label: this.i18n.t(label),
      value: count === 0 ? NO_VALUE : value,
      basis: basisLabel(count, this.i18n),
      missing: count === 0,
    });
    const s = this.summary();
    if (s) {
      return [
        fact(
          'stats.performance.avgPlacement',
          formatAverage(s.avgPlacement, lang, 2),
          s.placementGames,
        ),
        fact('stats.performance.avgWinTurn', formatAverage(s.avgWinTurn, lang), s.winTurnGames),
        fact(
          'stats.performance.avgDuration',
          formatMinutes(s.avgMinutes, this.i18n),
          s.durationGames,
        ),
      ];
    }
    const o = this.overall();
    if (o) {
      return [
        fact('stats.performance.avgTurn', formatAverage(o.avgTurn, lang), o.turnGames),
        fact(
          'stats.performance.avgDuration',
          formatMinutes(o.avgMinutes, this.i18n),
          o.durationGames,
        ),
      ];
    }
    return [];
  });

  /** Nur Siegarten mit Treffern, "Unbekannt" zuletzt - Nullzeilen wären reines Rauschen. */
  readonly conditions = computed(() => (this.winConditions() ?? []).filter((w) => w.count > 0));
  readonly conditionMax = computed(() => Math.max(0, ...this.conditions().map((w) => w.count)));
}
