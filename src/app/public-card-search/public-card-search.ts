// NEU
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CardSuggestion, ScryfallCard, ScryfallService } from '../scryfall.service';
import { CardPreviewService } from '../card-preview.service';
import { I18nService } from '../i18n.service';
import { CardImage } from '../card-image/card-image';
import { CARD_EFFECT_FILTERS } from '../card-effect-filters';
import { ColorFilter } from '../ui/color-filter/color-filter';
import { ColorSelection, EMPTY_COLOR_SELECTION } from '../color-filter-match';
import { CmcFilter, CmcFilterValue } from '../ui/cmc-filter/cmc-filter';

/**
 * Öffentliche Kartensuche - ohne Account nutzbar (Fan-Content-Policy). Nutzt bewusst
 * autocompleteAnyCard() statt der Commander-only autocomplete()/searchCards(), da hier jede
 * Karte gefunden werden soll, nicht nur Commander-legale. Filter-Optionen/Labels sind bewusst
 * unabhängig von DeckViewerService kopiert (nicht injiziert - viel zu groß, an Deck-Schreib-
 * Operationen gebunden, unpassend für diese anonyme Route), siehe deck-viewer.service.ts für die
 * ursprünglichen Listen.
 */
@Component({
  selector: 'app-public-card-search',
  imports: [FormsModule, CardImage, ColorFilter, CmcFilter],
  templateUrl: './public-card-search.html',
  styleUrl: './public-card-search.scss',
})
export class PublicCardSearch {
  private readonly scryfall = inject(ScryfallService);
  private readonly cardPreview = inject(CardPreviewService);
  readonly i18n = inject(I18nService);

  readonly query = signal('');
  readonly suggestions = signal<CardSuggestion[]>([]);
  readonly result = signal<ScryfallCard | null>(null);
  readonly searched = signal(false);
  readonly loading = signal(false);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Filter (wirken auf ALLE Karten, keine Commander-Legalitätsprüfung) ---

  readonly typeFilter = signal<'all' | string>('all');
  readonly creatureTypeFilter = signal('');
  readonly cmcFilter = signal<CmcFilterValue>('all');
  readonly colorFilter = signal<ColorSelection>(EMPTY_COLOR_SELECTION);
  readonly effectFilter = signal<'all' | string>('all');
  readonly keywordFilter = signal<'all' | string>('all');
  readonly sortMode = signal<'name' | 'cmc'>('name');

  readonly gridResults = signal<ScryfallCard[]>([]);
  readonly gridBusy = signal(false);
  readonly gridPage = signal(0);

  private static readonly PAGE_SIZE = 30;

  readonly gridTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.gridResults().length / PublicCardSearch.PAGE_SIZE))
  );
  readonly gridEffectivePage = computed(() => Math.min(this.gridPage(), this.gridTotalPages() - 1));
  readonly pagedGridResults = computed(() => {
    const start = this.gridEffectivePage() * PublicCardSearch.PAGE_SIZE;
    return this.gridResults().slice(start, start + PublicCardSearch.PAGE_SIZE);
  });

  readonly typeOptions = [
    'Kreatur',
    'Legendäre Kreatur',
    'Planeswalker',
    'Battle',
    'Spontanzauber',
    'Hexerei',
    'Artefakt',
    'Verzauberung',
    'Land',
  ];

  private static readonly TYPE_TO_SCRYFALL: Record<string, string> = {
    Planeswalker: 'planeswalker',
    Battle: 'battle',
    Kreatur: 'creature',
    'Legendäre Kreatur': 'legendary creature',
    Spontanzauber: 'instant',
    Hexerei: 'sorcery',
    Artefakt: 'artifact',
    Verzauberung: 'enchantment',
    Land: 'land',
  };

  readonly effectFilters = CARD_EFFECT_FILTERS;

  readonly keywordFilters: string[] = [
    'lifelink',
    'deathtouch',
    'flying',
    'trample',
    'vigilance',
    'haste',
    'hexproof',
    'indestructible',
    'menace',
    'reach',
    'first strike',
    'double strike',
    'ward',
    'flash',
    'defender',
  ];

  private static readonly TYPE_LABEL_KEYS: Record<string, string> = {
    Planeswalker: 'deckViewer.type.Planeswalker',
    Battle: 'deckViewer.type.Battle',
    Kreatur: 'deckViewer.type.Kreatur',
    'Legendäre Kreatur': 'deckViewer.type.LegendaereKreatur',
    Spontanzauber: 'deckViewer.type.Spontanzauber',
    Hexerei: 'deckViewer.type.Hexerei',
    Artefakt: 'deckViewer.type.Artefakt',
    Verzauberung: 'deckViewer.type.Verzauberung',
    Land: 'deckViewer.type.Land',
  };

  typeFilterLabel(label: string): string {
    const key = PublicCardSearch.TYPE_LABEL_KEYS[label];
    return key ? this.i18n.t(key) : label;
  }

  effectFilterLabel(value: string): string {
    return this.i18n.t(`effectFilter.${value}`);
  }

  keywordFilterLabel(value: string): string {
    return this.i18n.t(`keywordFilter.${value}`);
  }

  hasActiveFilters(): boolean {
    return (
      this.typeFilter() !== 'all' ||
      this.creatureTypeFilter().trim() !== '' ||
      this.cmcFilter() !== 'all' ||
      this.colorFilter().colors.length > 0 ||
      this.effectFilter() !== 'all' ||
      this.keywordFilter() !== 'all'
    );
  }

  resetFilters(): void {
    this.typeFilter.set('all');
    this.creatureTypeFilter.set('');
    this.cmcFilter.set('all');
    this.colorFilter.set(EMPTY_COLOR_SELECTION);
    this.effectFilter.set('all');
    this.keywordFilter.set('all');
    this.gridResults.set([]);
  }

  setTypeFilter(value: string): void {
    this.typeFilter.set(value);
    this.runFilterSearch();
  }

  onCreatureTypeInput(value: string): void {
    this.creatureTypeFilter.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.runFilterSearch(), 300);
  }

  setCmcFilter(value: CmcFilterValue): void {
    this.cmcFilter.set(value);
    this.runFilterSearch();
  }

  setColorFilter(value: ColorSelection): void {
    this.colorFilter.set(value);
    this.runFilterSearch();
  }

  setEffectFilter(value: string): void {
    this.effectFilter.set(value);
    this.runFilterSearch();
  }

  setKeywordFilter(value: string): void {
    this.keywordFilter.set(value);
    this.runFilterSearch();
  }

  setSortMode(value: 'name' | 'cmc'): void {
    this.sortMode.set(value);
    this.runFilterSearch();
  }

  private async runFilterSearch(): Promise<void> {
    if (!this.hasActiveFilters() && !this.query().trim()) {
      this.gridResults.set([]);
      return;
    }
    this.gridBusy.set(true);
    this.result.set(null);
    this.searched.set(false);
    const type = this.typeFilter();
    const results = await this.scryfall.searchCards(this.query(), {
      type: type === 'all' ? undefined : (PublicCardSearch.TYPE_TO_SCRYFALL[type] ?? type.toLowerCase()),
      creatureType: this.creatureTypeFilter().trim() || undefined,
      colors: this.colorFilter(),
      cmc: this.cmcFilter() === 'all' ? null : (this.cmcFilter() as number),
      effectQuery:
        this.effectFilter() === 'all' ? undefined : this.effectFilters.find((f) => f.value === this.effectFilter())?.query,
      keyword: this.keywordFilter() === 'all' ? undefined : this.keywordFilter(),
      order: this.sortMode(),
      commanderOnly: false,
    });
    this.gridResults.set(results);
    this.gridPage.set(0);
    this.gridBusy.set(false);
  }

  prevGridPage(): void {
    this.gridPage.update((p) => Math.max(0, p - 1));
  }

  nextGridPage(): void {
    this.gridPage.update((p) => Math.min(this.gridTotalPages() - 1, p + 1));
  }

  onQueryInput(value: string): void {
    this.query.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (this.hasActiveFilters()) {
      this.suggestions.set([]);
      this.searchTimer = setTimeout(() => this.runFilterSearch(), 300);
      return;
    }
    this.searchTimer = setTimeout(async () => {
      this.suggestions.set(await this.scryfall.autocompleteAnyCard(value));
    }, 250);
  }

  /**
   * Im Eingabefeld bleibt der GEDRUCKTE Name stehen, den der Nutzer angetippt hat ("Sonnenring") -
   * gesucht wird aber mit dem englischen, mit dem die App überall arbeitet.
   */
  async selectCard(vorschlag: CardSuggestion): Promise<void> {
    this.suggestions.set([]);
    this.gridResults.set([]);
    this.query.set(vorschlag.printedName ?? vorschlag.name);
    this.loading.set(true);
    this.searched.set(true);
    this.result.set(await this.scryfall.findCard(vorschlag.name));
    this.loading.set(false);
  }

  async submit(): Promise<void> {
    if (this.hasActiveFilters()) {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      await this.runFilterSearch();
      return;
    }
    if (!this.query().trim()) return;
    await this.selectCard({ name: this.query() });
  }

  openPreview(card: ScryfallCard): void {
    if (!card.imageUrl) return;
    this.cardPreview.open(card.imageUrl, card.backImageUrl, card.name);
  }
}
