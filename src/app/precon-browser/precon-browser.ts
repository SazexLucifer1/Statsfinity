import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe, CurrencyPipe } from '@angular/common';
import { PreconService, PreconSummary } from '../precon.service';
import { DeckService } from '../deck.service';
import { ScryfallCard, ScryfallService } from '../scryfall.service';
import { CardPreviewService } from '../card-preview.service';
import { I18nService } from '../i18n.service';
import { CardImage } from '../card-image/card-image';
import { PartnerCardImage } from '../partner-card-image/partner-card-image';
import { normalizeCardName } from '../array-utils';
import { BarChart } from '../ui/bar-chart/bar-chart';
import { ColorFilter } from '../ui/color-filter/color-filter';
import { ReadonlyDeckAnalysis, ReadonlyDeckEntry } from '../deck-analyse';

/**
 * Precons (MTGJSON) nach Jahr und Name durchsuchen und lesend ansehen, auch ohne Account.
 * Bewusst ohne DeckViewerService: der hängt an Auth und Schreiboperationen.
 */
@Component({
  selector: 'app-precon-browser',
  imports: [FormsModule, CardImage, PartnerCardImage, DecimalPipe, CurrencyPipe, BarChart, ColorFilter],
  templateUrl: './precon-browser.html',
  styleUrl: './precon-browser.scss',
})
export class PreconBrowser {
  private readonly precon = inject(PreconService);
  private readonly deckService = inject(DeckService);
  private readonly scryfall = inject(ScryfallService);
  private readonly cardPreview = inject(CardPreviewService);
  readonly i18n = inject(I18nService);

  readonly year = signal(new Date().getFullYear());
  readonly nameFilter = signal('');
  readonly precons = signal<PreconSummary[]>([]);
  readonly busy = signal(false);

  readonly filteredPrecons = computed(() => {
    const query = this.nameFilter().trim().toLowerCase();
    if (!query) return this.precons();
    return this.precons().filter((p) => p.name.toLowerCase().includes(query));
  });

  readonly selected = signal<PreconSummary | null>(null);
  readonly commanderCards = signal<ScryfallCard[]>([]);
  readonly allCards = signal<ReadonlyDeckEntry[]>([]);
  readonly deckBusy = signal(false);
  readonly deckFailed = signal(false);

  readonly analyse = new ReadonlyDeckAnalysis(this.allCards, this.i18n);

  readonly totalDeckPrice = signal<number | null>(null);
  readonly priceBusy = signal(false);

  constructor() {
    this.searchPrecons();
  }

  setYear(value: string): void {
    const year = Number(value);
    if (Number.isNaN(year)) return;
    this.year.set(year);
    this.searchPrecons();
  }

  async searchPrecons(): Promise<void> {
    this.busy.set(true);
    this.precons.set(await this.precon.getPreconsForYear(this.year()));
    this.busy.set(false);
  }

  async openPrecon(p: PreconSummary): Promise<void> {
    this.selected.set(p);
    this.commanderCards.set([]);
    this.allCards.set([]);
    this.totalDeckPrice.set(null);
    this.analyse.resetCardFilters();
    this.deckBusy.set(true);
    this.deckFailed.set(false);

    const text = await this.precon.loadPreconAsText(p.fileName);
    if (!text) {
      this.deckFailed.set(true);
      this.deckBusy.set(false);
      return;
    }

    const parsed = this.deckService.parseDecklistText(text);
    const cardMap = await this.scryfall.findCardsBulk(parsed.map((p) => p.name));

    const commanders: ScryfallCard[] = [];
    const all: ReadonlyDeckEntry[] = [];
    for (const entry of parsed) {
      const card = cardMap.get(entry.name.toLowerCase());
      if (!card) continue;
      if (entry.isCommander) commanders.push(card);
      all.push({ card, quantity: entry.quantity, isCommander: entry.isCommander });
    }

    this.commanderCards.set(commanders);
    this.allCards.set(all);
    this.deckBusy.set(false);

    this.loadCardPrices(all);
  }

  private async loadCardPrices(cards: ReadonlyDeckEntry[]): Promise<void> {
    this.priceBusy.set(true);
    const names = [...new Set(cards.map((c) => c.card.name))];
    // Nur die Preise; das incomplete-Flag wertet bislang allein die Deck-Ansicht aus ("ab X €",
    // siehe deckPriceIncomplete in deck-analysis.service.ts). Von der geduldigeren Wiederholung
    // in cheapestPrices() profitiert diese Ansicht trotzdem.
    const { prices } = await this.scryfall.cheapestPrices(names);
    let total = 0;
    for (const c of cards) {
      const price = prices.get(normalizeCardName(c.card.name.split(' // ')[0].trim()));
      if (price != null) total += price * c.quantity;
    }
    this.totalDeckPrice.set(total);
    this.priceBusy.set(false);
  }

  backToList(): void {
    this.selected.set(null);
    this.commanderCards.set([]);
    this.allCards.set([]);
  }

  openPreview(card: ScryfallCard): void {
    if (!card.imageUrl) return;
    this.cardPreview.open(card.imageUrl, card.backImageUrl, card.name);
  }
}
