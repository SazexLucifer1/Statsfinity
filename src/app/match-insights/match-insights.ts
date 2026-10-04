import { Component, computed, inject, input, signal } from '@angular/core';
import { Match } from '../models';
import { I18nService } from '../i18n.service';
import {
  OPPONENT_MIN_GAMES,
  deckMatchups,
  durationStats,
  favoriteVictim,
  monthlyWinRate,
  nemesis,
  opponentStats,
  recentForm,
  turnOrderStats,
} from '../match-insights';
import { BarChart, BarChartDatum } from '../ui/bar-chart/bar-chart';
import { Meter } from '../ui/meter/meter';
import { SplitBar, SplitSegment } from '../ui/split-bar/split-bar';
import { Icon } from '../ui/icon/icon';
import { YearReviewDialog } from '../year-review-dialog/year-review-dialog';

/**
 * "Spiel-Analysen" im Statistik-Tab: Zugreihenfolge, Spieldauer, Gegner, Deck gegen Deck und
 * Form. Bekommt die schon gefilterten Partien und den gewählten Spieler vom Statistik-Tab - die
 * Rechnung steckt in match-insights.ts, hier wird nur angezeigt.
 */
@Component({
  selector: 'app-match-insights',
  imports: [BarChart, Meter, SplitBar, Icon, YearReviewDialog],
  templateUrl: './match-insights.html',
  styleUrl: './match-insights.scss',
})
export class MatchInsights {
  readonly i18n = inject(I18nService);

  readonly matches = input.required<readonly Match[]>();
  /** Gewählter Spieler aus "Spieler-Details", null = Auswertung über die ganze Gruppe. */
  readonly player = input<string | null>(null);
  /** Alle Partien ohne Jahresfilter - für den Jahresrückblick, der sein Jahr selbst wählt. */
  readonly allMatches = input<readonly Match[]>([]);

  readonly expanded = signal(true);
  readonly showYearReview = signal(false);
  readonly OPPONENT_MIN_GAMES = OPPONENT_MIN_GAMES;

  readonly seats = computed(() => turnOrderStats(this.matches(), this.player()));
  readonly seatChart = computed<BarChartDatum[]>(() =>
    this.seats().map((s) => ({
      label: this.i18n.t('stats.insights.seatLabel', { seat: s.seat }),
      value: Math.round(s.winRate),
      detail: this.i18n.t('stats.insights.winsOfGames', { wins: s.wins, games: s.games }),
    })),
  );
  readonly seatGames = computed(() => this.seats().reduce((sum, s) => sum + s.games, 0));

  readonly duration = computed(() => durationStats(this.matches(), this.player()));

  readonly opponents = computed(() => {
    const player = this.player();
    return player ? opponentStats(this.matches(), player) : [];
  });
  readonly nemesis = computed(() => nemesis(this.opponents()));
  readonly victim = computed(() => favoriteVictim(this.opponents()));
  readonly topOpponents = computed(() => this.opponents().filter((o) => o.games >= OPPONENT_MIN_GAMES).slice(0, 8));

  readonly matchups = computed(() => deckMatchups(this.matches(), this.player()).slice(0, 10));

  readonly form = computed(() => {
    const player = this.player();
    return player ? recentForm(this.matches(), player) : [];
  });
  readonly monthly = computed<BarChartDatum[]>(() => {
    const player = this.player();
    if (!player) return [];
    return monthlyWinRate(this.matches(), player).map((m) => ({
      label: this.monthLabel(m.month),
      value: Math.round(m.winRate),
      detail: this.i18n.t('stats.insights.winsOfGames', { wins: m.wins, games: m.games }),
    }));
  });

  private monthLabel(month: string): string {
    const [year, m] = month.split('-').map(Number);
    return new Date(year, m - 1, 1).toLocaleDateString(this.i18n.lang() === 'de' ? 'de-DE' : 'en-US', {
      month: 'short',
      year: '2-digit',
    });
  }

  matchupSegments(m: { a: string; b: string; aWins: number; bWins: number; games: number }): SplitSegment[] {
    return [
      { label: m.a, value: m.aWins, color: 'var(--series-1)' },
      { label: this.i18n.t('stats.insights.otherResult'), value: m.games - m.aWins - m.bWins, color: 'var(--series-neutral)' },
      { label: m.b, value: m.bWins, color: 'var(--series-2)' },
    ];
  }

  formatMinutes(minutes: number): string {
    if (minutes < 60) return this.i18n.t('match.durationMinutes', { min: minutes });
    return this.i18n.t('match.durationHours', { h: Math.floor(minutes / 60), min: minutes % 60 });
  }

  formLabel(result: 'W' | 'L' | 'D'): string {
    return this.i18n.t(result === 'W' ? 'stats.insights.formWin' : result === 'L' ? 'stats.insights.formLoss' : 'stats.insights.formDraw');
  }
}
