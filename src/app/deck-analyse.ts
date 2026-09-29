import { Signal, computed, signal } from '@angular/core';
import type { I18nService } from './i18n.service';
import type { ScryfallCard } from './scryfall.service';
import type { BarChartDatum } from './ui/bar-chart/bar-chart';
import { manaCurveChartData, pipChartData, typeChartData } from './ui/bar-chart/deck-chart-data';
import { ColorSelection, EMPTY_COLOR_SELECTION, matchesColorSelection } from './color-filter-match';

/**
 * Deck-Analyse (Manakurve, Pips, Typen, Länder) und Typ-Gruppierung der Kartenliste - gemeinsam für
 * deck-viewer.service.ts, precon-browser und public-deck-browser. Vorher stand alles dreimal da.
 */

export interface ManaCurveBucket {
  label: string;
  count: number;
}

export interface PipCount {
  color: 'W' | 'U' | 'B' | 'R' | 'G';
  label: string;
  count: number;
}

export interface TypeBreakdownEntry {
  type: string;
  label: string;
  count: number;
}

/** Was die Analyse von einer Karte braucht - Deck-Ansicht und Browser liefern das unterschiedlich. */
export interface AnalyseKarte {
  quantity: number;
  cmc: number;
  typeLine: string | null | undefined;
  manaCost?: string | null;
}

export const PIP_COLORS: PipCount['color'][] = ['W', 'U', 'B', 'R', 'G'];

/** Typ-Abschnitte der Kartenliste. Die Labels sind interne Schlüssel (deutsch), übersetzt über LABEL_KEYS. */
export const TYPE_ORDER: { label: string; test: (typeLine: string) => boolean }[] = [
  { label: 'Planeswalker', test: (t) => t.includes('Planeswalker') },
  { label: 'Battle', test: (t) => t.includes('Battle') },
  { label: 'Kreatur', test: (t) => t.includes('Creature') },
  { label: 'Spontanzauber', test: (t) => t.includes('Instant') },
  { label: 'Hexerei', test: (t) => t.includes('Sorcery') },
  { label: 'Artefakt', test: (t) => t.includes('Artifact') },
  { label: 'Verzauberung', test: (t) => t.includes('Enchantment') },
  { label: 'Land', test: (t) => t.includes('Land') },
];

/**
 * Genau eine Kategorie je Karte nach fester Priorität ("Artifact Creature" zählt als Kreatur),
 * damit die Balken zusammen die Kartenzahl ergeben.
 */
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

const LABEL_KEYS: Record<string, string> = {
  Planeswalker: 'deckViewer.type.Planeswalker',
  Battle: 'deckViewer.type.Battle',
  Kreatur: 'deckViewer.type.Kreatur',
  'Legendäre Kreatur': 'deckViewer.type.LegendaereKreatur',
  Spontanzauber: 'deckViewer.type.Spontanzauber',
  Hexerei: 'deckViewer.type.Hexerei',
  Artefakt: 'deckViewer.type.Artefakt',
  Verzauberung: 'deckViewer.type.Verzauberung',
  Land: 'deckViewer.type.Land',
  Commander: 'deckViewer.type.Commander',
  Sonstiges: 'deckViewer.type.Sonstiges',
  'Ohne Tag': 'deckViewer.type.OhneTag',
  Maybeboard: 'deckViewer.type.Maybeboard',
  Tokens: 'deckViewer.type.Tokens',
};

/** Übersetzt einen internen Abschnitts-Schlüssel; eigene Tags kommen unverändert zurück. */
export function translateSectionLabel(i18n: I18nService, label: string): string {
  const key = LABEL_KEYS[label];
  return key ? i18n.t(key) : label;
}

export function isLand(typeLine: string | null | undefined): boolean {
  return (typeLine ?? '').includes('Land');
}

export function typeSection(typeLine: string | null | undefined): string {
  const type = typeLine ?? '';
  return TYPE_ORDER.find((c) => c.test(type))?.label ?? 'Sonstiges';
}

/** Untertypen hinter dem Gedankenstrich, z. B. "Elf Druid". */
export function parseSubtypes(typeLine: string | null | undefined): string[] {
  const parts = (typeLine ?? '').split('—');
  if (parts.length < 2) return [];
  return parts[1].trim().split(/\s+/).filter(Boolean);
}

/** Manawert-Stufe für Kurve und Filter: 0-6 gerundet, alles ab 7 ist 7. */
export function cmcBucket(cmc: number): number {
  return cmc >= 7 ? 7 : Math.min(6, Math.max(0, Math.round(cmc)));
}

function sumQty(cards: readonly { quantity: number }[]): number {
  return cards.reduce((sum, c) => sum + c.quantity, 0);
}

/** Manakurve ohne Länder, Stufen 0 bis 7+. */
export function manaCurve(cards: readonly AnalyseKarte[]): ManaCurveBucket[] {
  const buckets = [0, 1, 2, 3, 4, 5, 6, 7].map((cmc) => ({
    label: cmc === 7 ? '7+' : `${cmc}`,
    count: 0,
  }));
  for (const c of cards) if (!isLand(c.typeLine)) buckets[cmcBucket(c.cmc)].count += c.quantity;
  return buckets;
}

/** Ø Manawert ohne Länder (die zögen den Schnitt mit 0 nach unten), null ohne Nichtländer. */
export function averageCmc(cards: readonly AnalyseKarte[]): number | null {
  const nonLands = cards.filter((c) => !isLand(c.typeLine));
  const qty = sumQty(nonLands);
  return qty === 0 ? null : nonLands.reduce((sum, c) => sum + c.cmc * c.quantity, 0) / qty;
}

export function landCount(cards: readonly AnalyseKarte[]): number {
  return sumQty(cards.filter((c) => isLand(c.typeLine)));
}

/** Anteil Nichtbasisländer an allen Ländern (0-100), null ohne Länder. */
export function nonBasicLandPercent(cards: readonly AnalyseKarte[]): number | null {
  const lands = cards.filter((c) => isLand(c.typeLine));
  const total = sumQty(lands);
  if (total === 0) return null;
  const nonBasic = sumQty(lands.filter((c) => !(c.typeLine ?? '').includes('Basic')));
  return Math.round((nonBasic / total) * 100);
}

export function typeBreakdown(
  cards: readonly AnalyseKarte[],
  i18n: I18nService,
): TypeBreakdownEntry[] {
  const counts: Record<string, number> = {};
  for (const t of TYPE_PRIORITY) counts[t.type] = 0;
  for (const c of cards) {
    const match = TYPE_PRIORITY.find((t) => t.test.test(c.typeLine ?? ''));
    if (match) counts[match.type] += c.quantity;
  }
  return TYPE_PRIORITY.map((t) => ({
    type: t.type,
    label: i18n.t(`deckView.type.${t.type}`),
    count: counts[t.type],
  }));
}

/** Farbsymbole in den Manakosten der Nichtländer; Hybrid ({W/U}) zählt für beide Farben. */
export function pipDistribution(cards: readonly AnalyseKarte[], i18n: I18nService): PipCount[] {
  const counts: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const c of cards) {
    if (isLand(c.typeLine) || !c.manaCost) continue;
    for (const symbol of c.manaCost.match(/\{([^}]+)\}/g) ?? []) {
      for (const part of symbol.slice(1, -1).split('/')) {
        if (part in counts) counts[part] += c.quantity;
      }
    }
  }
  return PIP_COLORS.map((color) => ({
    color,
    label: i18n.t(`pip.${color}`),
    count: counts[color],
  }));
}

/** Gruppiert nach TYPE_ORDER (Rest unter "Sonstiges"), innerhalb nach Manawert und Name sortiert. */
export function groupByTypeSection<T>(
  cards: readonly T[],
  typeLineOf: (card: T) => string | null | undefined,
  compare: (a: T, b: T) => number,
): { label: string; cards: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const card of cards) {
    const section = typeSection(typeLineOf(card));
    groups.set(section, [...(groups.get(section) ?? []), card]);
  }
  return [...TYPE_ORDER.map((t) => t.label), 'Sonstiges']
    .filter((label) => groups.get(label)?.length)
    .map((label) => ({ label, cards: [...groups.get(label)!].sort(compare) }));
}

// --- Lesende Deck-Ansicht (precon-browser, public-deck-browser) ---

export interface ReadonlyDeckEntry {
  card: ScryfallCard;
  quantity: number;
  isCommander: boolean;
}

export interface ReadonlyCardSection {
  label: string;
  cards: ReadonlyDeckEntry[];
}

function compareEntries(a: ReadonlyDeckEntry, b: ReadonlyDeckEntry): number {
  return (a.card.cmc ?? 0) - (b.card.cmc ?? 0) || a.card.name.localeCompare(b.card.name);
}

function asAnalyseKarte(e: ReadonlyDeckEntry): AnalyseKarte {
  return {
    quantity: e.quantity,
    cmc: e.card.cmc ?? 0,
    typeLine: e.card.typeLine,
    manaCost: e.card.manaCost,
  };
}

/**
 * Analyse, Filter und Gruppierung für ein Deck, das nur angesehen wird. Analyse über alle Karten
 * inkl. Commander, die Kartenliste ohne Commander (der steht im Kopf).
 */
export class ReadonlyDeckAnalysis {
  readonly cardSearchQuery = signal('');
  readonly cmcFilter = signal<'all' | number>('all');
  readonly typeFilterValue = signal<'all' | string>('all');
  readonly creatureTypeFilter = signal<'all' | string>('all');
  readonly colorFilter = signal<ColorSelection>(EMPTY_COLOR_SELECTION);

  private readonly karten = computed(() => this.entries().map(asAnalyseKarte));

  readonly averageCmc = computed(() => averageCmc(this.karten()));
  readonly landCount = computed(() => landCount(this.karten()));
  readonly nonBasicLandPercent = computed(() => nonBasicLandPercent(this.karten()));
  readonly manaCurveChart = computed<BarChartDatum[]>(() =>
    manaCurveChartData(manaCurve(this.karten())),
  );
  readonly pipDistributionChart = computed<BarChartDatum[]>(() =>
    pipChartData(pipDistribution(this.karten(), this.i18n)),
  );
  readonly typeBreakdownChart = computed<BarChartDatum[]>(() =>
    typeChartData(typeBreakdown(this.karten(), this.i18n)),
  );

  private readonly listCards = computed(() => this.entries().filter((e) => !e.isCommander));

  private readonly groupedCards = computed<ReadonlyCardSection[]>(() =>
    groupByTypeSection(this.listCards(), (e) => e.card.typeLine, compareEntries),
  );

  readonly availableTypeSections = computed(() => this.groupedCards().map((s) => s.label));

  readonly availableCreatureTypes = computed(() => {
    const types = new Set<string>();
    for (const e of this.listCards()) {
      if (!(e.card.typeLine ?? '').includes('Creature')) continue;
      for (const t of parseSubtypes(e.card.typeLine)) types.add(t);
    }
    return [...types].sort((a, b) => a.localeCompare(b));
  });

  readonly filteredGroupedCards = computed<ReadonlyCardSection[]>(() => {
    const typeFilter = this.typeFilterValue();
    return this.groupedCards()
      .filter((section) => typeFilter === 'all' || section.label === typeFilter)
      .map((section) => ({
        label: section.label,
        cards: section.cards.filter((e) => this.matches(e)),
      }))
      .filter((section) => section.cards.length > 0);
  });

  readonly hasActiveCardFilters = computed(
    () =>
      this.cardSearchQuery().trim() !== '' ||
      this.cmcFilter() !== 'all' ||
      this.typeFilterValue() !== 'all' ||
      this.creatureTypeFilter() !== 'all' ||
      this.colorFilter().colors.length > 0,
  );

  constructor(
    private readonly entries: Signal<ReadonlyDeckEntry[]>,
    private readonly i18n: I18nService,
  ) {}

  private matches(e: ReadonlyDeckEntry): boolean {
    const query = this.cardSearchQuery().trim().toLowerCase();
    if (query && !e.card.name.toLowerCase().includes(query)) return false;
    const cmc = this.cmcFilter();
    if (cmc !== 'all' && cmcBucket(e.card.cmc ?? 0) !== cmc) return false;
    const creatureType = this.creatureTypeFilter();
    if (creatureType !== 'all' && !parseSubtypes(e.card.typeLine).includes(creatureType))
      return false;
    return matchesColorSelection(e.card.colorIdentity ?? [], this.colorFilter());
  }

  resetCardFilters(): void {
    this.cardSearchQuery.set('');
    this.cmcFilter.set('all');
    this.typeFilterValue.set('all');
    this.creatureTypeFilter.set('all');
    this.colorFilter.set(EMPTY_COLOR_SELECTION);
  }

  translateLabel(label: string): string {
    return translateSectionLabel(this.i18n, label);
  }

  sectionCardCount(cards: readonly { quantity: number }[]): number {
    return sumQty(cards);
  }
}
