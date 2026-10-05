import { Component, computed, effect, inject, signal } from '@angular/core';
import { PercentPipe } from '@angular/common';
import { DeckViewerService } from '../deck-viewer.service';
import { GoldfishService } from '../goldfish.service';
import { ScryfallService } from '../scryfall.service';
import { CardPreviewService } from '../card-preview.service';
import { CardSuggestion, DeckSuggestionsService } from '../deck-suggestions.service';
import { regelFuer } from '../deck-regeln';
import { isLand } from '../deck-analyse';
import {
  CheckItem,
  colorRequirements,
  deckCheckItems,
  deckHealthScore,
  deckOdds,
  recommendedLands,
} from '../deck-check';
import { ManaSymbol } from '../ui/mana-symbol/mana-symbol';
import { Meter } from '../ui/meter/meter';
import { Icon } from '../ui/icon/icon';

/**
 * Deck-Check oben in der Deck-Analyse: Gesamtwert, Ampel je Kategorie mit Sollwert,
 * Farbquellen-Prüfung, Wahrscheinlichkeiten, Testhand und Empfehlungen aus eigenen Decks.
 * Liest alles aus der Deck-Ansicht (DeckViewerService), die Rechnung steckt in deck-check.ts.
 */
@Component({
  selector: 'app-deck-check',
  imports: [PercentPipe, ManaSymbol, Meter, Icon],
  templateUrl: './deck-check.html',
  styleUrl: './deck-check.scss',
})
export class DeckCheck {
  readonly viewer = inject(DeckViewerService);
  private readonly goldfish = inject(GoldfishService);
  private readonly scryfall = inject(ScryfallService);
  private readonly cardPreview = inject(CardPreviewService);
  readonly suggestionsService = inject(DeckSuggestionsService);
  readonly i18n = this.viewer.i18n;

  /**
   * Quellen der Richtwerte - wer "Frank Karsten" liest, soll nachsehen können, wer das ist und
   * woher die Zahl kommt. Niederländischer Magic-Profi (Hall of Fame) und Mathematiker; seine
   * Artikel zu Länderzahl und Farbquellen sind in der Community der Standard.
   */
  readonly karstenWiki =
    'https://en.wikipedia.org/wiki/Frank_Karsten_(Magic:_The_Gathering_player)';
  readonly karstenLands =
    'https://www.tcgplayer.com/content/article/How-Many-Lands-Do-You-Need-in-Your-Deck-An-Updated-Analysis/cd1c1a24-d439-4a8e-b369-b936edb0b38a/';

  private readonly regel = computed(() => regelFuer(this.viewer.state.viewingDeck()?.format));
  /** 99-Karten-Formate (Commander, PDH, Historic Brawl) - die Karsten-Zahlen gelten je Deckgröße. */
  readonly isCommanderFormat = computed(() => this.regel()?.min === 100);

  private readonly library = computed(() =>
    this.viewer.analysis.analysisDeckCards().filter((c) => !c.isCommander),
  );
  readonly librarySize = computed(() => this.library().reduce((s, c) => s + c.quantity, 0));

  private effectCount(key: string): number | null {
    const stats = this.viewer.effects.effectCategoryStats();
    if (!stats) return null;
    return stats.find((s) => s.key === key)?.count ?? 0;
  }

  readonly effectsLoading = computed(() => this.viewer.effects.effectCategoryStats() === null);

  private readonly checkInput = computed(() => ({
    librarySize: this.librarySize(),
    isCommanderFormat: this.isCommanderFormat(),
    lands: this.viewer.analysis.landCount(),
    averageCmc: this.viewer.analysis.averageCmc(),
    ramp: this.effectCount('ramp'),
    draw: this.effectCount('draw'),
    removal: this.effectCount('removal'),
    boardwipe: this.effectCount('boardwipe'),
  }));

  readonly items = computed<CheckItem[]>(() => deckCheckItems(this.checkInput()));
  readonly score = computed(() => deckHealthScore(this.items()));
  readonly recommendedLands = computed(() => recommendedLands(this.checkInput()));

  readonly colors = computed(() => {
    const details = this.viewer.state.viewingCardDetails();
    const cards = this.library()
      .filter((c) => !isLand(c.typeLine))
      .map((c) => ({
        name: c.cardName,
        cmc: c.cmc,
        manaCost: details.get(c.cardName.toLowerCase())?.manaCost,
      }));
    const sources: Record<string, number> = {};
    for (const s of this.viewer.analysis.manaSourceDistribution()) sources[s.color] = s.count;
    return colorRequirements(cards, sources, this.isCommanderFormat());
  });

  readonly odds = computed(() => {
    const size = this.librarySize();
    if (size < 40) return null;
    const input = this.checkInput();
    return deckOdds(size, input.lands, input.ramp, input.draw);
  });

  // --- Empfehlungen aus eigenen Decks ---
  readonly suggestions = signal<CardSuggestion[]>([]);
  readonly suggestionsLoaded = signal(false);

  constructor() {
    effect(() => {
      const deck = this.viewer.state.viewingDeck();
      this.suggestions.set([]);
      this.suggestionsLoaded.set(false);
      if (!deck) return;
      this.suggestionsService.load(deck.id).then((list) => {
        if (this.viewer.state.viewingDeck()?.id !== deck.id) return;
        this.suggestions.set(list);
        this.suggestionsLoaded.set(true);
      });
    });
  }

  itemLabel(item: CheckItem): string {
    return this.i18n.t(`deckView.check.${item.key}`);
  }

  levelLabel(level: string): string {
    return this.i18n.t(`deckView.check.level.${level}`);
  }

  /** Was zu tun ist, in einem Satz. */
  advice(item: CheckItem): string {
    if (item.level === 'good') return this.i18n.t('deckView.check.adviceOk');
    const diff = item.value < item.min ? item.min - item.value : item.value - item.max;
    return this.i18n.t(
      item.value < item.min ? 'deckView.check.adviceMore' : 'deckView.check.adviceLess',
      { count: diff },
    );
  }

  openTestHand(): void {
    const deck = this.viewer.state.viewingDeck();
    if (deck) this.goldfish.open(deck);
  }

  async previewCard(name: string): Promise<void> {
    const card = await this.scryfall.findCard(name);
    if (card?.imageUrl) this.cardPreview.open(card.imageUrl, card.backImageUrl, card.name);
  }
}
