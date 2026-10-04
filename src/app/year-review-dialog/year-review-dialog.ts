import { Component, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { Match } from '../models';
import { I18nService } from '../i18n.service';
import { YearReview, yearReview } from '../match-insights';
import { drawYearReview, yearReviewBlob, YearReviewLabels } from '../year-review-canvas';

/**
 * Jahresrückblick eines Spielers als Bild zum Teilen. Das Canvas ist die Ansicht (wie beim
 * Steckbrief), die Bedienelemente drumherum folgen der App-Sprache, das Bild ist immer englisch.
 */
@Component({
  selector: 'app-year-review-dialog',
  templateUrl: './year-review-dialog.html',
  styleUrl: './year-review-dialog.scss',
})
export class YearReviewDialog {
  private readonly i18n = inject(I18nService);
  readonly t = (key: string, vars?: Record<string, string | number>) => this.i18n.t(key, vars);

  readonly matches = input.required<readonly Match[]>();
  readonly player = input.required<string>();
  readonly closed = output<void>();

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  /** Jahre mit Partien dieses Spielers, neuestes zuerst. */
  readonly years = computed(() => {
    const player = this.player();
    const set = new Set(
      this.matches()
        .filter((m) => m.players.some((p) => p.name === player))
        .map((m) => new Date(m.date).getFullYear()),
    );
    return [...set].sort((a, b) => b - a);
  });

  readonly selectedYear = signal<number | null>(null);
  readonly year = computed(() => this.selectedYear() ?? this.years()[0] ?? new Date().getFullYear());
  readonly review = computed(() => yearReview(this.matches(), this.player(), this.year()));

  constructor() {
    effect(() => {
      const canvas = this.canvasRef()?.nativeElement;
      const review = this.review();
      if (canvas && review) drawYearReview(canvas, review, this.labels(review));
    });
  }

  private labels(r: YearReview): YearReviewLabels {
    const en = (key: string, vars?: Record<string, string | number>) => this.i18n.tIn('en', key, vars);
    const minutes = (m: number) =>
      m < 60 ? en('match.durationMinutes', { min: m }) : en('match.durationHours', { h: Math.floor(m / 60), min: m % 60 });
    return {
      title: en('stats.review.imageTitle', { year: r.year }),
      games: en('stats.review.games'),
      wins: en('stats.review.wins'),
      winRate: en('stats.review.winRate'),
      bestStreak: en('stats.review.bestStreak'),
      rows: [
        { label: en('stats.review.topDeck'), value: r.topDeck ? `${r.topDeck.label} (${r.topDeck.games})` : null },
        { label: en('stats.review.bestDeck'), value: r.bestDeck ? `${r.bestDeck.label} · ${Math.round(r.bestDeck.winRate)}%` : null },
        { label: en('stats.review.nemesis'), value: r.nemesis ? `${r.nemesis.name} (${r.nemesis.lostTo}/${r.nemesis.games})` : null },
        { label: en('stats.review.victim'), value: r.victim ? `${r.victim.name} (${r.victim.beat}/${r.victim.games})` : null },
        { label: en('stats.review.firstSeat'), value: r.firstSeatWinRate !== null ? `${Math.round(r.firstSeatWinRate)}%` : null },
        { label: en('stats.review.longest'), value: r.longestMinutes ? minutes(r.longestMinutes) : null },
        { label: en('stats.review.totalTime'), value: r.totalMinutes ? minutes(r.totalMinutes) : null },
      ],
      footer: `Statsfinity · ${location.host}`,
    };
  }

  async download(): Promise<void> {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    const blob = await yearReviewBlob(canvas);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `statsfinity-${this.year()}-${this.player().replace(/[\\/:*?"<>|]/g, '')}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Safari braucht die Adresse noch, während der Download anläuft.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
