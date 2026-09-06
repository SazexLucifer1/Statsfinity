import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe, CurrencyPipe } from '@angular/common';
import { PublicDeckService, PublicDeck, PublicDeckStats } from '../public-deck.service';
import { ScryfallCard, ScryfallService } from '../scryfall.service';
import { CardPreviewService } from '../card-preview.service';
import { I18nService } from '../i18n.service';
import { CardImage } from '../card-image/card-image';
import { PartnerCardImage } from '../partner-card-image/partner-card-image';
import { normalizeCardName } from '../array-utils';
import { BarChart, BarChartDatum } from '../ui/bar-chart/bar-chart';
import { ColorFilter } from '../ui/color-filter/color-filter';
import { ColorSelection, EMPTY_COLOR_SELECTION, matchesColorSelection } from '../color-filter-match';
import {
  manaCurveChartData,
  pipChartData,
  typeChartData,
} from '../ui/bar-chart/deck-chart-data';

interface PublicDeckCardEntry {
  card: ScryfallCard;
  quantity: number;
  isCommander: boolean;
}

interface ManaCurveBucket {
  label: string;
  count: number;
}

interface PipCount {
  color: 'W' | 'U' | 'B' | 'R' | 'G';
  label: string;
  count: number;
}

interface TypeBreakdownEntry {
  type: string;
  label: string;
  count: number;
}

interface CardSection {
  label: string;
  cards: PublicDeckCardEntry[];
}

/**
 * Reihenfolge der Typ-Abschnitte - dieselben internen (deutschen) Label-Schlüssel wie
 * DeckViewerService.TYPE_ORDER, damit dieselben i18n.service.ts-Übersetzungs-Keys
 * (deckViewer.type.*) ohne Duplikate wiederverwendet werden können.
 */
const TYPE_ORDER: { label: string; test: (typeLine: string) => boolean }[] = [
  { label: 'Planeswalker', test: (t) => t.includes('Planeswalker') },
  { label: 'Battle', test: (t) => t.includes('Battle') },
  { label: 'Kreatur', test: (t) => t.includes('Creature') },
  { label: 'Spontanzauber', test: (t) => t.includes('Instant') },
  { label: 'Hexerei', test: (t) => t.includes('Sorcery') },
  { label: 'Artefakt', test: (t) => t.includes('Artifact') },
  { label: 'Verzauberung', test: (t) => t.includes('Enchantment') },
  { label: 'Land', test: (t) => t.includes('Land') },
];

const TYPE_PRIORITY: { type: string; test: RegExp }[] = [
  { type: 'creature', test: /Creature/ },
  { type: 'planeswalker', test: /Planeswalker/ },
  { type: 'battle', test: /Battle/ },
  { type: 'land', test: /Land/ },
  { type: 'artifact', test: /Artifact/ },
  { type: 'enchantment', test: /Enchantment/ },
  { type: 'instant', test: /Instant/ },
  { type: 'sorcery', test: /Sorcery/ },
];

const PIP_COLORS: PipCount['color'][] = ['W', 'U', 'B', 'R', 'G'];

/** Wie DeckViewerService.LABEL_KEYS - dieselben (deutschen) Sektions-Label-Schlüssel auf dieselben i18n-Keys gemappt. */
const LABEL_KEYS: Record<string, string> = {
  Planeswalker: 'deckViewer.type.Planeswalker',
  Battle: 'deckViewer.type.Battle',
  Kreatur: 'deckViewer.type.Kreatur',
  Spontanzauber: 'deckViewer.type.Spontanzauber',
  Hexerei: 'deckViewer.type.Hexerei',
  Artefakt: 'deckViewer.type.Artefakt',
  Verzauberung: 'deckViewer.type.Verzauberung',
  Land: 'deckViewer.type.Land',
  Sonstiges: 'deckViewer.type.Sonstiges',
};

function categoryFor(card: ScryfallCard): string {
  const type = card.typeLine ?? '';
  return TYPE_ORDER.find((c) => c.test(type))?.label ?? 'Sonstiges';
}

function parseSubtypes(typeLine: string | undefined): string[] {
  const parts = (typeLine ?? '').split('—');
  if (parts.length < 2) return [];
  return parts[1].trim().split(/\s+/).filter(Boolean);
}

function sortByCmc(a: PublicDeckCardEntry, b: PublicDeckCardEntry): number {
  return (a.card.cmc ?? 0) - (b.card.cmc ?? 0) || a.card.name.localeCompare(b.card.name);
}

/**
 * Öffentliche Decks anderer Nutzer durchsuchen (Name/Farbe/Archetyp/Kreaturtyp, sortiert nach
 * "neu"/Winrate) und rein lesend ansehen - ohne Account nutzbar, eigener Umschalter im Suche-Tab
 * (siehe sql/public-deck-browse-2026-08-26.sql für die zugrundeliegende RLS-/Schema-Änderung).
 * Hält den Zustand komplett lokal statt DeckViewerService zu injizieren - gleiche Entscheidung wie
 * commander-recommendations.ts/precon-browser.ts.
 *
 * Die Deck-Detailansicht (nach openDeck()) portiert bewusst nur einen SCHLANKEN Ausschnitt der
 * Analyse-/Filter-Logik aus DeckViewerService (Manakurve, Pip-Verteilung, Typ-Verteilung,
 * Land-/Ø-Manawert-/Preis-Kennzahlen, Such-/Manawert-/Typ-/Kreaturtyp-/Farb-Filter) - direkt hier
 * neu berechnet aus ScryfallCard-Feldern (cmc/typeLine/manaCost/colorIdentity liegen bei
 * PublicDeckCardEntry.card bereits direkt vor, anders als bei DeckViewerService, das dafür extra
 * eine viewingCardDetails-Zusatzabfrage braucht). Bewusst NICHT portiert: Tag-Sortiermodus (keine
 * eigenen Tags auf fremden Decks), Keyword-/Effekt-Filter sowie Game-Changer/Tutor/Spellbook-
 * Auswertung (alle an DeckViewerServices große, Auth-/Mutation-lastige Maschinerie gekoppelt).
 */
@Component({
  selector: 'app-public-deck-browser',
  imports: [FormsModule, CardImage, PartnerCardImage, DecimalPipe, CurrencyPipe, BarChart, ColorFilter],
  templateUrl: './public-deck-browser.html',
  styleUrl: './public-deck-browser.scss',
})
export class PublicDeckBrowser {
  private readonly publicDecks = inject(PublicDeckService);
  private readonly scryfall = inject(ScryfallService);
  private readonly cardPreview = inject(CardPreviewService);
  readonly i18n = inject(I18nService);

  readonly nameFilter = signal('');
  readonly browseColors = signal<ColorSelection>(EMPTY_COLOR_SELECTION);
  readonly sort = signal<'recent' | 'winRate'>('recent');
  readonly archetype = signal<string | null>(null);
  readonly archetypeOptions = signal<string[]>([]);
  readonly creatureType = signal<string | null>(null);
  readonly creatureTypeOptions = signal<string[]>([]);
  readonly creatureTypesLoading = signal(false);

  readonly results = signal<PublicDeck[]>([]);
  readonly stats = signal<Map<string, PublicDeckStats>>(new Map());
  readonly commanderCardsByDeck = signal<Map<string, ScryfallCard[]>>(new Map());
  readonly busy = signal(false);
  readonly page = signal(0);

  private static readonly PAGE_SIZE = 30;

  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.results().length / PublicDeckBrowser.PAGE_SIZE)));
  readonly effectivePage = computed(() => Math.min(this.page(), this.totalPages() - 1));
  readonly pagedResults = computed(() => {
    const start = this.effectivePage() * PublicDeckBrowser.PAGE_SIZE;
    return this.results().slice(start, start + PublicDeckBrowser.PAGE_SIZE);
  });

  readonly selectedDeck = signal<PublicDeck | null>(null);
  readonly selectedDeckCommanderCards = signal<ScryfallCard[]>([]);
  readonly allCards = signal<PublicDeckCardEntry[]>([]);
  readonly deckBusy = signal(false);

  readonly totalDeckPrice = signal<number | null>(null);
  readonly priceBusy = signal(false);

  // --- Deck-interne Filter/Sortierung (nur die schlanke Untermenge, siehe Klassenkommentar) ---
  readonly cardSearchQuery = signal('');
  readonly cmcFilter = signal<'all' | number>('all');
  readonly typeFilterValue = signal<'all' | string>('all');
  readonly creatureTypeFilter = signal<'all' | string>('all');
  readonly colorFilter = signal<ColorSelection>(EMPTY_COLOR_SELECTION);

  constructor() {
    this.publicDecks.archetypeOptions().then((options) => this.archetypeOptions.set(options));
    this.loadCreatureTypes();
    this.search();
  }

  private async loadCreatureTypes(): Promise<void> {
    this.creatureTypesLoading.set(true);
    this.creatureTypeOptions.set(await this.scryfall.creatureTypes());
    this.creatureTypesLoading.set(false);
  }

  setSort(value: string): void {
    this.sort.set(value === 'winRate' ? 'winRate' : 'recent');
    this.search();
  }

  setArchetype(value: string): void {
    this.archetype.set(value === 'all' ? null : value);
  }

  setCreatureType(value: string): void {
    this.creatureType.set(value === 'all' ? null : value);
  }

  async search(): Promise<void> {
    this.busy.set(true);
    const { decks, stats } = await this.publicDecks.searchPublicDecks({
      name: this.nameFilter(),
      colors: [...this.browseColors().colors],
      archetype: this.archetype(),
      creatureType: this.creatureType(),
      sort: this.sort(),
    });

    this.results.set(decks);
    this.stats.set(stats);
    this.page.set(0);

    const allCommanderNames = [...new Set(decks.flatMap((d) => d.commanders.map((c) => c.name)))];
    const cardMap = await this.scryfall.findCardsBulk(allCommanderNames);
    const byDeck = new Map<string, ScryfallCard[]>();
    for (const deck of decks) {
      // Individuell gewähltes Artwork (deck_cards.image_url) hat Vorrang vor dem generischen
      // Scryfall-Bild zum Namen - gleiche Priorität wie deck-list.ts' commanderImage(), damit hier
      // dasselbe Bild wie in der eigentlichen Deck-Ansicht erscheint.
      const cards = deck.commanders
        .map((c) => {
          const base = cardMap.get(c.name.toLowerCase());
          if (!base) return undefined;
          return c.imageUrl ? { ...base, imageUrl: c.imageUrl } : base;
        })
        .filter((c): c is ScryfallCard => !!c);
      byDeck.set(deck.id, cards);
    }
    this.commanderCardsByDeck.set(byDeck);

    this.busy.set(false);
  }

  resetFilters(): void {
    this.nameFilter.set('');
    this.browseColors.set(EMPTY_COLOR_SELECTION);
    this.archetype.set(null);
    this.creatureType.set(null);
    this.sort.set('recent');
    this.search();
  }

  statsFor(deckId: string): PublicDeckStats | null {
    return this.stats().get(deckId) ?? null;
  }

  commanderCardsFor(deckId: string): ScryfallCard[] {
    return this.commanderCardsByDeck().get(deckId) ?? [];
  }

  prevPage(): void {
    this.page.update((p) => Math.max(0, p - 1));
  }

  nextPage(): void {
    this.page.update((p) => Math.min(this.totalPages() - 1, p + 1));
  }

  async openDeck(deck: PublicDeck): Promise<void> {
    this.selectedDeck.set(deck);
    this.selectedDeckCommanderCards.set(this.commanderCardsFor(deck.id));
    this.allCards.set([]);
    this.totalDeckPrice.set(null);
    this.resetCardFilters();
    this.deckBusy.set(true);

    const entries = await this.publicDecks.loadDeckCards(deck.id);
    const cardMap = await this.scryfall.findCardsBulk(entries.map((e) => e.name));

    const all: PublicDeckCardEntry[] = [];
    for (const entry of entries) {
      const card = cardMap.get(entry.name.toLowerCase());
      if (card) all.push({ card, quantity: entry.quantity, isCommander: entry.isCommander });
    }

    this.allCards.set(all);
    this.deckBusy.set(false);

    this.loadCardPrices(all);
  }

  private async loadCardPrices(cards: PublicDeckCardEntry[]): Promise<void> {
    this.priceBusy.set(true);
    const names = [...new Set(cards.map((c) => c.card.name))];
    // Nur die Preise; das incomplete-Flag wertet bislang allein die Deck-Ansicht aus ("ab X €",
    // siehe deckPriceIncomplete in deck-viewer.service.ts). Von der geduldigeren Wiederholung
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
    this.selectedDeck.set(null);
    this.selectedDeckCommanderCards.set([]);
    this.allCards.set([]);
  }

  openPreview(card: ScryfallCard): void {
    if (!card.imageUrl) return;
    this.cardPreview.open(card.imageUrl, card.backImageUrl, card.name);
  }

  // --- Deck-Analyse (Manakurve/Pips/Typ-Verteilung/Kennzahlen) - über ALLE Karten inkl. Commander,
  // wie DeckViewerService.analysisDeckCards() (dort ebenfalls nicht commander-ausgeschlossen). ---

  private readonly nonLandCards = computed(() => this.allCards().filter((e) => !(e.card.typeLine ?? '').includes('Land')));

  readonly manaCurve = computed<ManaCurveBucket[]>(() => {
    const buckets = [0, 1, 2, 3, 4, 5, 6].map((cmc) => ({ label: `${cmc}`, count: 0 }));
    const sevenPlus = { label: '7+', count: 0 };
    for (const e of this.nonLandCards()) {
      const cmc = e.card.cmc ?? 0;
      const bucket = cmc >= 7 ? sevenPlus : buckets[Math.min(6, Math.max(0, Math.round(cmc)))];
      bucket.count += e.quantity;
    }
    return [...buckets, sevenPlus];
  });

  readonly averageCmc = computed<number | null>(() => {
    const cards = this.nonLandCards();
    const totalQty = cards.reduce((sum, e) => sum + e.quantity, 0);
    if (totalQty === 0) return null;
    const totalCmc = cards.reduce((sum, e) => sum + (e.card.cmc ?? 0) * e.quantity, 0);
    return totalCmc / totalQty;
  });

  private readonly landCards = computed(() => this.allCards().filter((e) => (e.card.typeLine ?? '').includes('Land')));
  readonly landCount = computed(() => this.landCards().reduce((sum, e) => sum + e.quantity, 0));

  readonly nonBasicLandPercent = computed<number | null>(() => {
    const lands = this.landCards();
    const total = lands.reduce((sum, e) => sum + e.quantity, 0);
    if (total === 0) return null;
    const nonBasic = lands.filter((e) => !(e.card.typeLine ?? '').includes('Basic')).reduce((sum, e) => sum + e.quantity, 0);
    return Math.round((nonBasic / total) * 100);
  });

  readonly typeBreakdown = computed<TypeBreakdownEntry[]>(() => {
    const counts: Record<string, number> = {};
    for (const t of TYPE_PRIORITY) counts[t.type] = 0;
    for (const e of this.allCards()) {
      const typeLine = e.card.typeLine ?? '';
      const match = TYPE_PRIORITY.find((t) => t.test.test(typeLine));
      if (match) counts[match.type] += e.quantity;
    }
    return TYPE_PRIORITY.map((t) => ({ type: t.type, label: this.i18n.t(`deckView.type.${t.type}`), count: counts[t.type] }));
  });

  readonly pipDistribution = computed<PipCount[]>(() => {
    const counts: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const e of this.nonLandCards()) {
      const manaCost = e.card.manaCost;
      if (!manaCost) continue;
      const symbols = manaCost.match(/\{([^}]+)\}/g) ?? [];
      for (const symbol of symbols) {
        const parts = symbol.slice(1, -1).split('/');
        for (const part of parts) {
          if (part in counts) counts[part] += e.quantity;
        }
      }
    }
    return PIP_COLORS.map((color) => ({ color, label: this.i18n.t(`pip.${color}`), count: counts[color] }));
  });

  // --- Diagramm-Reihen für <app-bar-chart> ---
  // Abbildung geteilt mit deck-detail-view und der jeweils anderen Browser-Ansicht.
  readonly manaCurveChart = computed<BarChartDatum[]>(() => manaCurveChartData(this.manaCurve()));
  readonly pipDistributionChart = computed<BarChartDatum[]>(() =>
    pipChartData(this.pipDistribution()),
  );
  readonly typeBreakdownChart = computed<BarChartDatum[]>(() =>
    typeChartData(this.typeBreakdown()),
  );




  // --- Karten-Filter/Gruppierung für die Kartenliste (Commander bewusst ausgeschlossen - der wird
  // schon prominent im Kopfbereich gezeigt, siehe public-deck-browser.html). ---

  private readonly sectionSourceCards = computed(() => this.allCards().filter((e) => !e.isCommander));

  readonly groupedCards = computed<CardSection[]>(() => {
    const groups = new Map<string, PublicDeckCardEntry[]>();
    for (const e of this.sectionSourceCards()) {
      const category = categoryFor(e.card);
      const list = groups.get(category) ?? [];
      list.push(e);
      groups.set(category, list);
    }

    const sections: CardSection[] = [];
    for (const { label } of TYPE_ORDER) {
      const cards = groups.get(label);
      if (cards?.length) sections.push({ label, cards: [...cards].sort(sortByCmc) });
    }
    const other = groups.get('Sonstiges');
    if (other?.length) sections.push({ label: 'Sonstiges', cards: [...other].sort(sortByCmc) });
    return sections;
  });

  readonly availableTypeSections = computed(() => this.groupedCards().map((s) => s.label));

  readonly availableCreatureTypes = computed(() => {
    const types = new Set<string>();
    for (const e of this.sectionSourceCards()) {
      if (!(e.card.typeLine ?? '').includes('Creature')) continue;
      for (const t of parseSubtypes(e.card.typeLine)) types.add(t);
    }
    return [...types].sort((a, b) => a.localeCompare(b));
  });

  private cardMatchesFilters(e: PublicDeckCardEntry): boolean {
    const query = this.cardSearchQuery().trim().toLowerCase();
    if (query && !e.card.name.toLowerCase().includes(query)) return false;

    const cmc = this.cmcFilter();
    if (cmc !== 'all') {
      const bucket = (e.card.cmc ?? 0) >= 7 ? 7 : Math.round(e.card.cmc ?? 0);
      if (bucket !== cmc) return false;
    }

    const creatureType = this.creatureTypeFilter();
    if (creatureType !== 'all' && !parseSubtypes(e.card.typeLine).includes(creatureType)) return false;

    if (!matchesColorSelection(e.card.colorIdentity ?? [], this.colorFilter())) return false;

    return true;
  }

  readonly filteredGroupedCards = computed<CardSection[]>(() => {
    const typeFilter = this.typeFilterValue();
    return this.groupedCards()
      .filter((section) => typeFilter === 'all' || section.label === typeFilter)
      .map((section) => ({ label: section.label, cards: section.cards.filter((e) => this.cardMatchesFilters(e)) }))
      .filter((section) => section.cards.length > 0);
  });

  readonly hasActiveCardFilters = computed(
    () =>
      this.cardSearchQuery().trim() !== '' ||
      this.cmcFilter() !== 'all' ||
      this.typeFilterValue() !== 'all' ||
      this.creatureTypeFilter() !== 'all' ||
      this.colorFilter().colors.length > 0
  );

  resetCardFilters(): void {
    this.cardSearchQuery.set('');
    this.cmcFilter.set('all');
    this.typeFilterValue.set('all');
    this.creatureTypeFilter.set('all');
    this.colorFilter.set(EMPTY_COLOR_SELECTION);
  }

  translateLabel(label: string): string {
    const key = LABEL_KEYS[label];
    return key ? this.i18n.t(key) : label;
  }

  sectionCardCount(cards: PublicDeckCardEntry[]): number {
    return cards.reduce((sum, e) => sum + e.quantity, 0);
  }
}
