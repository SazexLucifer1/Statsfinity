import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { I18nService } from '../i18n.service';
import { MtgService } from '../mtg.service';
import { ScryfallService } from '../scryfall.service';
import { DeckOpponent, deckOpponents } from '../match-insights';
import { CardImage } from '../card-image/card-image';
import { SplitBar, SplitSegment } from '../ui/split-bar/split-bar';
import { InfoToggle } from '../ui/info-toggle/info-toggle';

/**
 * "Gegen welche Decks" in der Deck-Ansicht: gegen welche Decks dieses Deck gespielt hat und wie
 * es lief. Stand vorher als großflächiges "Deck gegen Deck" im Statistik-Tab (Wunsch des Users,
 * 06.10.2026: gehört zur Statistik des einzelnen Decks). Kompakt: zuerst die häufigsten Gegner,
 * Details erst auf Antippen.
 */
@Component({
  selector: 'app-deck-matchups',
  imports: [CardImage, SplitBar, InfoToggle],
  templateUrl: './deck-matchups.html',
  styleUrl: './deck-matchups.scss',
})
export class DeckMatchups {
  readonly i18n = inject(I18nService);
  private readonly mtg = inject(MtgService);
  private readonly scryfall = inject(ScryfallService);

  readonly deckId = input.required<string>();
  readonly deckName = input('');

  readonly PREVIEW = 4;
  readonly all = signal<DeckOpponent[]>([]);
  readonly loaded = signal(false);
  readonly expanded = signal(false);
  readonly showAll = signal(false);
  readonly open = signal<string | null>(null);
  readonly visible = computed(() =>
    this.showAll() ? this.all() : this.all().slice(0, this.PREVIEW),
  );

  readonly commanderImages = signal<Record<string, string | null>>({});

  constructor() {
    effect(() => {
      const id = this.deckId();
      this.loaded.set(false);
      this.all.set([]);
      this.open.set(null);
      this.mtg.loadMatchesForDeck(id).then((matches) => {
        if (this.deckId() !== id) return;
        this.all.set(deckOpponents(matches, id));
        this.loaded.set(true);
      });
    });
    effect(() => {
      if (!this.expanded()) return;
      const names = new Set(
        this.visible()
          .map((o) => o.commander)
          .filter((c): c is string => !!c),
      );
      const known = this.commanderImages();
      const missing = [...names].filter((n) => !(n.toLowerCase() in known));
      if (missing.length === 0) return;
      this.scryfall.findCardsBulk(missing).then((found) => {
        this.commanderImages.update((current) => {
          const next = { ...current };
          for (const n of missing)
            next[n.toLowerCase()] = found.get(n.toLowerCase())?.imageUrl ?? null;
          return next;
        });
      });
    });
  }

  image(name: string | null): string | null {
    return name ? (this.commanderImages()[name.toLowerCase()] ?? null) : null;
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
