import { Component, computed, inject, input, signal } from '@angular/core';
import { Match } from '../models';
import { I18nService } from '../i18n.service';
import {
  commanderMatchups,
  deckPerformance,
  overallSummary,
  performanceSummary,
  pickPlayer,
  winConditionStats,
} from '../match-insights';
import { InfoToggle } from '../ui/info-toggle/info-toggle';
import { SampleHint } from '../ui/sample-hint/sample-hint';
import {
  PerformanceSummaryView,
  formatNumber,
} from '../ui/performance-summary/performance-summary';

/**
 * "Performance" im Statistik-Tab: Gesamt, Decks, Siegarten und - mit gewähltem Spieler - die
 * Bilanz gegen gegnerische Commander. Bekommt dieselben gefilterten Partien wie die Spiel-Analysen
 * (match-insights/); gerechnet wird in match-insights.ts, ausschließlich aus gespeicherten Daten.
 */
@Component({
  selector: 'app-performance-stats',
  imports: [InfoToggle, SampleHint, PerformanceSummaryView],
  templateUrl: './performance-stats.html',
  styleUrl: './performance-stats.scss',
})
export class PerformanceStats {
  readonly i18n = inject(I18nService);

  readonly matches = input.required<readonly Match[]>();
  /** Gewählter Spieler aus "Spieler-Details", null = ganze Gruppe. */
  readonly player = input<string | null>(null);

  readonly PREVIEW = 6;
  readonly expanded = signal(true);
  readonly showAllDecks = signal(false);
  readonly showAllMatchups = signal(false);

  readonly overall = computed(() => overallSummary(this.matches()));
  readonly playerSummary = computed(() => {
    const player = this.player();
    return player ? performanceSummary(this.matches(), pickPlayer(player)) : null;
  });
  readonly winConditions = computed(() => {
    const player = this.player();
    return winConditionStats(this.matches(), player ? pickPlayer(player) : undefined);
  });

  readonly decks = computed(() => deckPerformance(this.matches(), this.player()));
  readonly visibleDecks = computed(() =>
    this.showAllDecks() ? this.decks() : this.decks().slice(0, this.PREVIEW),
  );

  readonly matchups = computed(() => {
    const player = this.player();
    return player ? commanderMatchups(this.matches(), pickPlayer(player)) : [];
  });
  readonly visibleMatchups = computed(() =>
    this.showAllMatchups() ? this.matchups() : this.matchups().slice(0, this.PREVIEW),
  );

  num(value: number | null, digits = 1): string {
    return value === null ? '–' : formatNumber(value, this.i18n.lang(), digits);
  }

  rate(value: number | null): string {
    return value === null ? '–' : `${formatNumber(value, this.i18n.lang(), 0)} %`;
  }

  minutes(value: number | null): string {
    if (value === null) return '–';
    const m = Math.round(value);
    if (m < 60) return this.i18n.t('match.durationMinutes', { min: m });
    return this.i18n.t('match.durationHours', { h: Math.floor(m / 60), min: m % 60 });
  }
}
