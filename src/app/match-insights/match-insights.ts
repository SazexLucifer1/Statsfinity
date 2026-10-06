import { Component, computed, inject, input, signal } from '@angular/core';
import { Match } from '../models';
import { I18nService } from '../i18n.service';
import { NavigationService } from '../navigation.service';
import { ProfileService } from '../profile.service';
import {
  OPPONENT_MIN_GAMES,
  durationStats,
  favoriteVictim,
  monthlyWinRate,
  monthlyGames,
  nemesis,
  opponentStats,
  recentForm,
  turnOrderStats,
} from '../match-insights';
import { BarChart, BarChartDatum } from '../ui/bar-chart/bar-chart';
import { Meter } from '../ui/meter/meter';
import { InfoToggle } from '../ui/info-toggle/info-toggle';
import { Icon } from '../ui/icon/icon';
import { YearReviewDialog } from '../year-review-dialog/year-review-dialog';

/**
 * "Spiel-Analysen" im Statistik-Tab: Zugreihenfolge, Spieldauer, Gegner und Form ("Deck gegen
 * Deck" steht seit 06.10.2026 je Deck in der Deck-Ansicht, deck-matchups/). Bekommt die schon gefilterten Partien und den gewählten Spieler vom Statistik-Tab - die
 * Rechnung steckt in match-insights.ts, hier wird nur angezeigt.
 */
@Component({
  selector: 'app-match-insights',
  imports: [BarChart, Meter, Icon, YearReviewDialog, InfoToggle],
  templateUrl: './match-insights.html',
  styleUrl: './match-insights.scss',
})
export class MatchInsights {
  readonly i18n = inject(I18nService);
  private readonly navigation = inject(NavigationService);
  private readonly profileService = inject(ProfileService);

  readonly matches = input.required<readonly Match[]>();
  /** Gewählter Spieler aus "Spieler-Details", null = Auswertung über die ganze Gruppe. */
  readonly player = input<string | null>(null);
  /** Alle Partien ohne Jahresfilter - für den Jahresrückblick, der sein Jahr selbst wählt. */
  readonly allMatches = input<readonly Match[]>([]);
  /**
   * Spielername -> Benutzer-ID für alle, die ein Konto haben. Wer hier drinsteht, ist unter
   * "Gegner" anklickbar und öffnet sein Profil; Spieler ohne Konto bleiben reiner Text.
   */
  readonly profileIds = input<Readonly<Record<string, string | null>>>({});

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
  readonly topOpponents = computed(() =>
    this.opponents()
      .filter((o) => o.games >= OPPONENT_MIN_GAMES)
      .slice(0, 8),
  );

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

  readonly monthlyPlayed = computed<BarChartDatum[]>(() => {
    const player = this.player();
    if (!player) return [];
    return monthlyGames(this.matches(), player).map((m) => ({
      label: this.monthLabel(m.month),
      value: m.games,
      total: m.total,
    }));
  });

  private monthLabel(month: string): string {
    const [year, m] = month.split('-').map(Number);
    return new Date(year, m - 1, 1).toLocaleDateString(
      this.i18n.lang() === 'de' ? 'de-DE' : 'en-US',
      {
        month: 'short',
        year: '2-digit',
      },
    );
  }

  isLinked(name: string): boolean {
    return !!this.profileIds()[name];
  }

  async openProfile(name: string): Promise<void> {
    const userId = this.profileIds()[name];
    if (!userId) return;
    this.navigation.goToTab('profile');
    await this.profileService.viewProfile(userId);
  }

  formatMinutes(minutes: number): string {
    if (minutes < 60) return this.i18n.t('match.durationMinutes', { min: minutes });
    return this.i18n.t('match.durationHours', { h: Math.floor(minutes / 60), min: minutes % 60 });
  }

  formLabel(result: 'W' | 'L' | 'D'): string {
    return this.i18n.t(
      result === 'W'
        ? 'stats.insights.formWin'
        : result === 'L'
          ? 'stats.insights.formLoss'
          : 'stats.insights.formDraw',
    );
  }
}
