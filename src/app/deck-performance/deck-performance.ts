import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { I18nService } from '../i18n.service';
import { MtgService } from '../mtg.service';
import { DeckVersionService } from '../deck-version.service';
import { Match } from '../models';
import {
  compareLatestVersions,
  deckVersionStats,
  performanceSummary,
  pickDeck,
  winConditionStats,
} from '../match-insights';
import { DeckMatchups } from '../deck-matchups/deck-matchups';
import { InfoToggle } from '../ui/info-toggle/info-toggle';
import { SampleHint } from '../ui/sample-hint/sample-hint';
import {
  PerformanceSummaryView,
  formatNumber,
} from '../ui/performance-summary/performance-summary';

/**
 * Performance eines Decks in der Deck-Ansicht: Kennzahlen, Siegarten und Versionen aus allen
 * gespeicherten Partien mit diesem Deck, darunter die Gegnerdecks (deck-matchups/). Lädt die
 * Partien einmal und reicht sie an deck-matchups weiter. Zugeklappt eine Zeile - die Deck-Ansicht
 * ist lang genug. Gerechnet wird in match-insights.ts; Ursachen behauptet hier nichts.
 */
@Component({
  selector: 'app-deck-performance',
  imports: [DeckMatchups, InfoToggle, SampleHint, PerformanceSummaryView],
  templateUrl: './deck-performance.html',
  styleUrl: './deck-performance.scss',
})
export class DeckPerformance {
  readonly i18n = inject(I18nService);
  private readonly mtg = inject(MtgService);
  readonly versions = inject(DeckVersionService);

  readonly deckId = input.required<string>();
  readonly deckName = input('');

  /** Partien mit diesem Deck (ohne Turnierspiele, die nicht in die Statistik zählen). */
  readonly matches = signal<readonly Match[] | null>(null);
  readonly expanded = signal(false);

  readonly summary = computed(() => {
    const matches = this.matches();
    return matches ? performanceSummary(matches, pickDeck(this.deckId())) : null;
  });
  readonly winConditions = computed(() => {
    const matches = this.matches();
    return matches ? winConditionStats(matches, pickDeck(this.deckId())) : null;
  });
  readonly versionStats = computed(() => {
    const matches = this.matches();
    return matches ? deckVersionStats(matches, this.deckId()) : [];
  });
  /** Versionen erst zeigen, wenn es mehr als eine Gruppe gibt - eine einzige wäre nur die Gesamtzeile. */
  readonly showVersions = computed(() => this.versionStats().length > 1);
  readonly comparison = computed(() => compareLatestVersions(this.versionStats()));

  constructor() {
    effect(() => {
      const id = this.deckId();
      this.matches.set(null);
      this.mtg.loadMatchesForDeck(id).then((matches) => {
        if (this.deckId() !== id) return;
        this.matches.set(matches.filter((m) => m.countsInGeneralStats !== false));
      });
    });
  }

  num(value: number | null, digits = 1): string {
    return value === null ? '–' : formatNumber(value, this.i18n.lang(), digits);
  }

  rate(value: number | null): string {
    return value === null ? '–' : `${formatNumber(value, this.i18n.lang(), 0)} %`;
  }

  compareText(): string | null {
    const c = this.comparison();
    if (!c) return null;
    const key =
      c.direction === 'higher'
        ? 'deckView.performance.compareHigher'
        : c.direction === 'lower'
          ? 'deckView.performance.compareLower'
          : 'deckView.performance.compareEqual';
    return this.i18n.t(key, { newer: c.newer.version ?? '', older: c.older.version ?? '' });
  }
}
