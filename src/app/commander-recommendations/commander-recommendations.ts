// NEU
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PercentPipe } from '@angular/common';
import { ScryfallCard, ScryfallService } from '../scryfall.service';
import { EdhrecCardlist, EdhrecService, EdhrecTag } from '../edhrec.service';
import { CardPreviewService } from '../card-preview.service';
import { ProfileService } from '../profile.service';
import { I18nService } from '../i18n.service';
import { CardImage } from '../card-image/card-image';
import { PartnerCardImage } from '../partner-card-image/partner-card-image';
import { COMMANDER_ARCHETYPE_FILTERS } from '../commander-archetype-filters';
import { ColorFilter } from '../ui/color-filter/color-filter';
import { ColorSelection, EMPTY_COLOR_SELECTION } from '../color-filter-match';

/** Ein Treffer der Commander-Suche - 1 Karte bei einem Solo-Commander, 2 bei einem Partner-Paar (siehe searchCommanderPairs()). */
interface CommanderBrowseEntry {
  cards: ScryfallCard[];
}

/**
 * Commander-Empfehlungen - ohne Account/Deck nutzbar, eigener Umschalter im Suche-Tab. Rein
 * lesend (kein "zum Deck hinzufügen"), dafür mit Zoom über CardPreviewService. Spiegelt das
 * bestehende Muster aus deck-viewer.service.ts/deck-detail-view.html (dort an ein konkretes Deck
 * gebunden), hält den Zustand aber komplett lokal statt DeckViewerService zu injizieren - der ist
 * viel zu groß und an Deck-Schreiboperationen gebunden, unpassend für diese anonyme Route.
 *
 * Zwei unabhängige Bereiche mit unterschiedlicher Datenquelle:
 * - "Entdecken" (Farbe/Mechanik-Filter → Liste von Commandern): läuft über Scryfalls eigene,
 *   dokumentierte API (searchCommanders(), is:commander + Farbidentität + otag:-Mechanik-Filter,
 *   sortiert nach Scryfalls order=edhrec) - EDHRECs eigene, undokumentierte API fand trotz
 *   mehrerer Versuche keine zuverlässigen Endpunkte für diese Art Browsing.
 * - Direkte Namenssuche → EDHREC-Empfehlungen für GENAU diesen einen Commander (welche Karten
 *   synergieren mit ihm, über echte Deck-Statistiken) - das kann Scryfall nicht leisten, bleibt
 *   also bei edhrec.service.ts's getCommanderRecommendations()/getCommanderTags() (bereits vor
 *   dieser Session produktiv im Deck-Baukasten bewährt).
 */
@Component({
  selector: 'app-commander-recommendations',
  imports: [FormsModule, CardImage, PartnerCardImage, PercentPipe, ColorFilter],
  templateUrl: './commander-recommendations.html',
  styleUrl: './commander-recommendations.scss',
})
export class CommanderRecommendations {
  private readonly scryfall = inject(ScryfallService);
  private readonly edhrec = inject(EdhrecService);
  private readonly cardPreview = inject(CardPreviewService);
  private readonly profileService = inject(ProfileService);
  readonly i18n = inject(I18nService);

  readonly query = signal('');
  readonly suggestions = signal<string[]>([]);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly commanderNames = signal<string[] | null>(null);
  readonly commanderCards = signal<ScryfallCard[]>([]);
  readonly tags = signal<EdhrecTag[]>([]);
  readonly selectedTag = signal<string | null>(null);
  readonly lists = signal<EdhrecCardlist[] | null>(null);
  readonly busy = signal(false);
  readonly failed = signal(false);

  readonly expandedCategories = signal<Set<string>>(new Set());
  readonly cardDetails = signal<Map<string, ScryfallCard>>(new Map());
  readonly categoryImagesBusy = signal<Set<string>>(new Set());

  // --- Entdecken: Farb-/Mechanik-Filter statt direkter Namenseingabe (über Scryfall, siehe Klassenkommentar) ---

  readonly browseColors = signal<ColorSelection>(EMPTY_COLOR_SELECTION);
  readonly browseArchetype = signal<string | null>(null);
  readonly browseCreatureType = signal<string | null>(null);
  readonly creatureTypeOptions = signal<string[]>([]);
  readonly creatureTypesLoading = signal(false);
  readonly browseResults = signal<CommanderBrowseEntry[]>([]);
  readonly browseBusy = signal(false);
  readonly browsePage = signal(0);

  constructor() {
    this.loadCreatureTypes();
  }

  private async loadCreatureTypes(): Promise<void> {
    this.creatureTypesLoading.set(true);
    this.creatureTypeOptions.set(await this.scryfall.creatureTypes());
    this.creatureTypesLoading.set(false);
  }

  private static readonly BROWSE_PAGE_SIZE = 30;

  readonly browseTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.browseResults().length / CommanderRecommendations.BROWSE_PAGE_SIZE))
  );
  readonly browseEffectivePage = computed(() => Math.min(this.browsePage(), this.browseTotalPages() - 1));
  readonly pagedBrowseResults = computed(() => {
    const start = this.browseEffectivePage() * CommanderRecommendations.BROWSE_PAGE_SIZE;
    return this.browseResults().slice(start, start + CommanderRecommendations.BROWSE_PAGE_SIZE);
  });

  /** Archetyp-Filter (Voltron, Stax, Aristocrats, ...) - eigene Liste, siehe commander-archetype-filters.ts. */
  readonly archetypeOptions = COMMANDER_ARCHETYPE_FILTERS;

  archetypeLabel(value: string): string {
    return this.i18n.t(`archetypeFilter.${value}`);
  }

  setBrowseArchetype(value: string): void {
    this.browseArchetype.set(value === 'all' ? null : value);
  }

  setBrowseCreatureType(value: string): void {
    this.browseCreatureType.set(value === 'all' ? null : value);
  }

  /** Aktiv, sobald irgendein Filter gesetzt ist - Name (dasselbe Feld wie die Autovervollständigung), Farbe, Archetyp oder Kreaturtyp. */
  canBrowse(): boolean {
    return (
      this.query().trim().length > 0 ||
      this.browseColors().colors.length > 0 ||
      this.browseArchetype() !== null ||
      this.browseCreatureType() !== null
    );
  }

  async browse(): Promise<void> {
    if (!this.canBrowse()) return;
    this.browseBusy.set(true);
    this.browseResults.set([]);

    const colors = [...this.browseColors().colors];
    const archetype = this.browseArchetype();
    const archetypeQuery = archetype ? this.archetypeOptions.find((f) => f.value === archetype)?.query : undefined;
    const filters = { name: this.query(), archetypeQuery, creatureType: this.browseCreatureType() };

    // Paare (Partner, Friends forever, Choose a Background, Doctor's companion, ...) laufen als
    // eigene Abfrage neben den Solo-Commandern (siehe searchCommanderPairs() - nur aktiv, wenn eine
    // Farbe gesetzt ist, da die exakte Paar-Farbidentität sonst kein sinnvolles Ziel hätte).
    const [singles, pairs] = await Promise.all([
      this.scryfall.searchCommanders(colors, filters),
      this.scryfall.searchCommanderPairs(colors, filters),
    ]);

    this.browseResults.set([...singles.map((card) => ({ cards: [card] })), ...pairs.map(([a, b]) => ({ cards: [a, b] }))]);
    this.browsePage.set(0);
    this.browseBusy.set(false);
  }

  resetBrowse(): void {
    this.query.set('');
    this.suggestions.set([]);
    this.browseColors.set(EMPTY_COLOR_SELECTION);
    this.browseArchetype.set(null);
    this.browseCreatureType.set(null);
    this.browseResults.set([]);
  }

  prevBrowsePage(): void {
    this.browsePage.update((p) => Math.max(0, p - 1));
  }

  nextBrowsePage(): void {
    this.browsePage.update((p) => Math.min(this.browseTotalPages() - 1, p + 1));
  }

  // --- Direkte Namenssuche → echte EDHREC-Empfehlungen für diesen einen Commander ---

  onQueryInput(value: string): void {
    this.query.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(async () => {
      this.suggestions.set(await this.scryfall.autocomplete(value));
    }, 250);
  }

  /**
   * EDHREC-Empfehlungen nur für Alpha-Tester (siehe ProfileService.isAlphaTester). Alle anderen
   * behalten das Stöbern (Scryfall) - ein Tipp auf einen Commander zeigt dann nur die Karte.
   */
  readonly edhrecEnabled = computed(() => this.profileService.isAlphaTester());

  /** Tipp auf eine Kachel im Stöbern: mit Alpha-Zugang die Empfehlungen, sonst nur die Vorschau. */
  pickBrowseEntry(cards: ScryfallCard[]): void {
    if (this.edhrecEnabled()) {
      this.selectCommander(cards.map((c) => c.name));
    } else if (cards[0]) {
      this.openCommanderPreview(cards[0]);
    }
  }

  /** Nimmt 1 Namen (Solo-Commander) oder 2 Namen (Partner-Paar, siehe searchCommanderPairs()). */
  async selectCommander(names: string[]): Promise<void> {
    this.suggestions.set([]);
    if (!this.edhrecEnabled()) {
      this.query.set(names.join(' + '));
      const card = await this.scryfall.findCard(names[0]);
      if (card) this.openCommanderPreview(card);
      return;
    }
    this.query.set(names.join(' + '));
    this.commanderNames.set(names);
    this.commanderCards.set([]);
    this.selectedTag.set(null);
    this.expandedCategories.set(new Set());
    this.cardDetails.set(new Map());
    this.tags.set([]);
    await Promise.all([this.loadRecommendations(), this.loadCommanderCards(names)]);
    this.tags.set((await this.edhrec.getCommanderTags(names)) ?? []);
  }

  backToBrowse(): void {
    this.commanderNames.set(null);
    this.commanderCards.set([]);
    this.lists.set(null);
    this.query.set('');
  }

  private async loadCommanderCards(names: string[]): Promise<void> {
    const cards = await Promise.all(names.map((n) => this.scryfall.findCard(n)));
    this.commanderCards.set(cards.filter((c): c is ScryfallCard => c !== null));
  }

  setTag(tagSlug: string | null): void {
    if (tagSlug === this.selectedTag()) return;
    this.selectedTag.set(tagSlug);
    this.expandedCategories.set(new Set());
    this.cardDetails.set(new Map());
    this.loadRecommendations();
  }

  private async loadRecommendations(): Promise<void> {
    const names = this.commanderNames();
    if (!names) return;
    this.busy.set(true);
    this.failed.set(false);
    const result = await this.edhrec.getCommanderRecommendations(names, this.selectedTag());
    this.lists.set(result);
    this.failed.set(result === null);
    this.busy.set(false);
  }

  isExpanded(tag: string): boolean {
    return this.expandedCategories().has(tag);
  }

  async toggleCategory(list: EdhrecCardlist): Promise<void> {
    const expanded = new Set(this.expandedCategories());
    if (expanded.has(list.tag)) {
      expanded.delete(list.tag);
      this.expandedCategories.set(expanded);
      return;
    }
    expanded.add(list.tag);
    this.expandedCategories.set(expanded);

    const known = this.cardDetails();
    const missing = list.cards.map((c) => c.name).filter((n) => !known.has(n.toLowerCase()));
    if (missing.length === 0) return;

    this.categoryImagesBusy.update((set) => new Set(set).add(list.tag));
    const found = await this.scryfall.findCardsBulk(missing);
    this.cardDetails.update((current) => new Map([...current, ...found]));
    this.categoryImagesBusy.update((set) => {
      const next = new Set(set);
      next.delete(list.tag);
      return next;
    });
  }

  isCategoryImagesBusy(tag: string): boolean {
    return this.categoryImagesBusy().has(tag);
  }

  cardImage(cardName: string): string | null {
    return this.cardDetails().get(cardName.toLowerCase())?.imageUrl ?? null;
  }

  cardBackImage(cardName: string): string | null {
    return this.cardDetails().get(cardName.toLowerCase())?.backImageUrl ?? null;
  }

  openPreview(cardName: string): void {
    const card = this.cardDetails().get(cardName.toLowerCase());
    if (!card?.imageUrl) return;
    this.cardPreview.open(card.imageUrl, card.backImageUrl, card.name);
  }

  openCommanderPreview(card: ScryfallCard): void {
    if (!card.imageUrl) return;
    this.cardPreview.open(card.imageUrl, card.backImageUrl, card.name);
  }
}
