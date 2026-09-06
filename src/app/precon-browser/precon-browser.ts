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
import { BarChart, BarChartDatum } from '../ui/bar-chart/bar-chart';
import { ColorFilter } from '../ui/color-filter/color-filter';
import { ColorSelection, EMPTY_COLOR_SELECTION, matchesColorSelection } from '../color-filter-match';
import {
  manaCurveChartData,
  pipChartData,
  typeChartData,
} from '../ui/bar-chart/deck-chart-data';

interface PreconCardEntry {
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
  cards: PreconCardEntry[];
}

/**
 * Reihenfolge der Typ-Abschnitte - dieselben internen (deutschen) Label-Schlüssel wie
 * DeckViewerService.TYPE_ORDER/public-deck-browser.ts, damit dieselben i18n.service.ts-
 * Übersetzungs-Keys (deckViewer.type.*) ohne Duplikate wiederverwendet werden können.
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

/** Wie DeckViewerService.LABEL_KEYS/public-deck-browser.ts - dieselben Sektions-Label-Schlüssel auf dieselben i18n-Keys gemappt. */
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

function sortByCmc(a: PreconCardEntry, b: PreconCardEntry): number {
  return (a.card.cmc ?? 0) - (b.card.cmc ?? 0) || a.card.name.localeCompare(b.card.name);
}

/**
 * Precons durchsuchen (Jahr + Name) und rein lesend ansehen - ohne Account nutzbar, eigener
 * Umschalter im Suche-Tab. Nutzt PreconService (MTGJSON) wie bisher schon der Import-Dialog
 * (DeckImportService.openPreconDialog()), hier aber zum Anzeigen statt Importieren. Hält den
 * Zustand komplett lokal statt DeckViewerService zu injizieren - der ist viel zu groß und an
 * Deck-Schreiboperationen gebunden, unpassend für diese anonyme Route (gleiche Entscheidung wie
 * commander-recommendations.ts/public-card-search.ts).
 *
 * Die Deck-Detailansicht portiert dieselbe schlanke Analyse-/Filter-Logik wie
 * public-deck-browser.ts (Manakurve, Pip-Verteilung, Typ-Verteilung, Kennzahlen, Filter) - siehe
 * dortigen Klassenkommentar für Details, was bewusst NICHT portiert wurde.
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
  readonly allCards = signal<PreconCardEntry[]>([]);
  readonly deckBusy = signal(false);
  readonly deckFailed = signal(false);

  readonly totalDeckPrice = signal<number | null>(null);
  readonly priceBusy = signal(false);

  // --- Deck-interne Filter/Sortierung (gleiche schlanke Untermenge wie public-deck-browser.ts) ---
  readonly cardSearchQuery = signal('');
  readonly cmcFilter = signal<'all' | number>('all');
  readonly typeFilterValue = signal<'all' | string>('all');
  readonly creatureTypeFilter = signal<'all' | string>('all');
  readonly colorFilter = signal<ColorSelection>(EMPTY_COLOR_SELECTION);

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
    this.resetCardFilters();
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
    const all: PreconCardEntry[] = [];
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

  private async loadCardPrices(cards: PreconCardEntry[]): Promise<void> {
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
    this.selected.set(null);
    this.commanderCards.set([]);
    this.allCards.set([]);
  }

  openPreview(card: ScryfallCard): void {
    if (!card.imageUrl) return;
    this.cardPreview.open(card.imageUrl, card.backImageUrl, card.name);
  }

  // --- Deck-Analyse (Manakurve/Pips/Typ-Verteilung/Kennzahlen) - über ALLE Karten inkl. Commander,
  // wie DeckViewerService.analysisDeckCards()/public-deck-browser.ts. ---

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
  // schon prominent im Kopfbereich gezeigt). ---

  private readonly sectionSourceCards = computed(() => this.allCards().filter((e) => !e.isCommander));

  readonly groupedCards = computed<CardSection[]>(() => {
    const groups = new Map<string, PreconCardEntry[]>();
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

  private cardMatchesFilters(e: PreconCardEntry): boolean {
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

  sectionCardCount(cards: PreconCardEntry[]): number {
    return cards.reduce((sum, e) => sum + e.quantity, 0);
  }
}
