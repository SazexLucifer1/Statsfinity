import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { I18nService } from '../i18n.service';
import { DeckSocialService } from '../deck-social.service';
import { supabase } from '../supabase.client';
import { DeckOpponent, deckOpponents, winRateOf } from '../match-insights';
import { Match } from '../models';
import { SampleHint } from '../ui/sample-hint/sample-hint';
import { formatRate, gameCount } from '../ui/performance-summary/performance-summary';
import { CardThumb } from '../ui/card-thumb/card-thumb';
import { SplitBar, SplitSegment } from '../ui/split-bar/split-bar';
import { InfoToggle } from '../ui/info-toggle/info-toggle';

/**
 * "Gegen welche Decks" in der Deck-Ansicht: gegen welche Decks dieses Deck gespielt hat und wie
 * es lief. Stand vorher als großflächiges "Deck gegen Deck" im Statistik-Tab (Wunsch des Users,
 * 06.10.2026: gehört zur Statistik des einzelnen Decks). Kompakt: zuerst die häufigsten Gegner,
 * Details erst auf Antippen. Die Partien lädt deck-performance/ und reicht sie herein - beide
 * zeigen dieselben Partien, eine zweite Abfrage wäre doppelt.
 */
@Component({
  selector: 'app-deck-matchups',
  imports: [CardThumb, SplitBar, InfoToggle, SampleHint],
  templateUrl: './deck-matchups.html',
  styleUrl: './deck-matchups.scss',
})
export class DeckMatchups {
  readonly i18n = inject(I18nService);
  private readonly social = inject(DeckSocialService);

  /** Namen accountloser Deck-Besitzer (players.display_name), je players.id. */
  private readonly playerOwners = signal<ReadonlyMap<string, string>>(new Map());

  readonly deckId = input.required<string>();
  readonly deckName = input('');
  /** Partien mit diesem Deck; null = noch nicht geladen. */
  readonly matches = input<readonly Match[] | null>(null);

  readonly PREVIEW = 4;
  readonly all = signal<DeckOpponent[]>([]);
  readonly loaded = signal(false);
  readonly expanded = signal(false);
  readonly showAll = signal(false);
  readonly open = signal<string | null>(null);
  readonly visible = computed(() =>
    this.showAll() ? this.all() : this.all().slice(0, this.PREVIEW),
  );

  constructor() {
    effect(() => {
      const id = this.deckId();
      const matches = this.matches();
      this.open.set(null);
      if (!matches) {
        this.loaded.set(false);
        this.all.set([]);
        return;
      }
      const opponents = deckOpponents(matches, id);
      this.all.set(opponents);
      this.loaded.set(true);
      void this.loadOwners(opponents);
    });
  }

  /**
   * Besitzer der Gegnerdecks: Konto-Decks über deck_social_stats() (Profilname, wie das „von …“
   * im Stöbern), Decks accountloser Spieler über deren players-Zeile.
   */
  private async loadOwners(opponents: DeckOpponent[]): Promise<void> {
    const accountDecks = opponents.filter((o) => o.deckId && o.ownerUserId).map((o) => o.deckId!);
    const playerIds = [
      ...new Set(
        opponents
          .map((o) => (!o.ownerUserId ? o.ownerPlayerId : null))
          .filter((x): x is string => !!x),
      ),
    ];
    await Promise.all([
      this.social.load(accountDecks),
      (async () => {
        if (playerIds.length === 0) return;
        const { data } = await supabase
          .from('players')
          .select('id, display_name')
          .in('id', playerIds);
        this.playerOwners.set(
          new Map(
            ((data as { id: string; display_name: string }[] | null) ?? []).map((p) => [
              p.id,
              p.display_name,
            ]),
          ),
        );
      })(),
    ]);
  }

  /** Wem das Gegnerdeck gehört - nicht, wer es gespielt hat. null ohne verknüpftes Deck. */
  owner(o: DeckOpponent): string | null {
    if (o.deckId && o.ownerUserId) return this.social.statsFor(o.deckId)?.ownerName ?? null;
    if (o.ownerPlayerId) return this.playerOwners().get(o.ownerPlayerId) ?? null;
    return null;
  }

  /** Siegquote gegen diesen Gegner in den aufgezeichneten Partien - nur gezählt, nicht gedeutet. */
  rate(o: DeckOpponent): string {
    return formatRate(winRateOf(o.wins, o.games), this.i18n.lang());
  }

  games(count: number): string {
    return gameCount(count, this.i18n);
  }

  key(o: DeckOpponent): string {
    return o.deckId ?? o.label;
  }

  toggle(label: string): void {
    this.open.set(this.open() === label ? null : label);
  }

  segments(o: DeckOpponent): SplitSegment[] {
    return [
      {
        label: this.deckName() || this.i18n.t('deckView.matchups.thisDeck'),
        value: o.wins,
        color: 'var(--series-1)',
      },
      {
        label: this.i18n.t('stats.insights.otherResult'),
        value: o.games - o.wins - o.losses,
        color: 'var(--series-neutral)',
      },
      { label: o.label, value: o.losses, color: 'var(--series-2)' },
    ];
  }
}
