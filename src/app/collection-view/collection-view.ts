import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { I18nService } from '../i18n.service';
import { CollectionService, PrintInfo } from '../collection.service';
import {
  CollectionEntry,
  CollectionPrint,
  collectionKey,
  printImageUrl,
} from '../collection-coverage';
import {
  CollectionFilters,
  CollectionGroup,
  CollectionItem,
  CollectionSection,
  CollectionSort,
  activeFilterCount,
  collectionValue,
  filterCollection,
  groupCollection,
  mergePrints,
  sortCollection,
} from '../collection-filter';
import { CardPreviewService } from '../card-preview.service';
import { CardDataService, SpellbookCardFlags } from '../card-data.service';
import { ScryfallCard, ScryfallService, ScryfallSet } from '../scryfall.service';
import { DeckEffectsService } from '../deck-effects.service';
import { ART_LANGUAGES } from '../art-languages';
import { EMPTY_COLOR_SELECTION } from '../color-filter-match';
import { colorComboLabel } from '../color-combo-names';
import { TYPE_ORDER, translateSectionLabel } from '../deck-analyse';
import { Icon } from '../ui/icon/icon';
import { InfoToggle } from '../ui/info-toggle/info-toggle';
import { CmcFilter } from '../ui/cmc-filter/cmc-filter';
import { RarityFilter } from '../ui/rarity-filter/rarity-filter';
import { ColorFilter } from '../ui/color-filter/color-filter';
import { MultiSelect } from '../ui/multi-select/multi-select';
import { CardScanner } from '../card-scanner/card-scanner';

const PAGE = 60;
/** Effekte ohne eigene Kategorie im Nacht-Cache - die kommen aus den Spellbook-Merkmalen. */
const FLAG_EFFECTS: Record<string, keyof SpellbookCardFlags> = {
  tutor: 'tutor',
  extraturn: 'extraTurn',
  mld: 'massLandDenial',
};

/**
 * Die Sammlung als eigene Seite, wie die Deck-Ansicht (Wunsch des Users, 18.10.2026: im Profil
 * war zu wenig Platz). Geöffnet über CollectionService.openView() aus dem Profil - die eigene
 * Sammlung bearbeitbar, die eines Freundes nur lesend.
 *
 * Kartendaten (Typ, Manawert, Farben, Fähigkeiten, Effekte) kommen aus dem Nacht-Cache wie in der
 * Deck-Analyse, Seltenheit/Setname/Preis je Druck gebündelt von Scryfall (printInfo()). Gefiltert,
 * sortiert und gruppiert wird in collection-filter.ts.
 */
@Component({
  selector: 'app-collection-view',
  imports: [
    FormsModule,
    DecimalPipe,
    Icon,
    InfoToggle,
    CmcFilter,
    RarityFilter,
    ColorFilter,
    MultiSelect,
    CardScanner,
  ],
  templateUrl: './collection-view.html',
  styleUrl: './collection-view.scss',
})
export class CollectionView {
  readonly i18n = inject(I18nService);
  readonly collection = inject(CollectionService);
  readonly effects = inject(DeckEffectsService);
  private readonly preview = inject(CardPreviewService);
  private readonly cardData = inject(CardDataService);
  private readonly scryfall = inject(ScryfallService);

  readonly typeSections = TYPE_ORDER.map((t) => t.label);

  readonly userId = computed(() => this.collection.view()?.userId ?? null);
  readonly ownerName = computed(() => this.collection.view()?.name ?? null);
  readonly editable = computed(() => !this.userId());

  private readonly friendEntries = signal<CollectionEntry[] | null>(null);
  readonly entries = computed(
    () => (this.userId() ? this.friendEntries() : this.collection.entries()) ?? [],
  );
  readonly loaded = computed(
    () => (this.userId() ? this.friendEntries() : this.collection.entries()) !== null,
  );

  // Nachgeschlagene Kartendaten - wachsen mit, statt bei jeder neuen Karte alles neu zu laden.
  private readonly details = signal<ReadonlyMap<string, ScryfallCard>>(new Map());
  private readonly effectNames = signal<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  private readonly flags = signal<ReadonlyMap<string, SpellbookCardFlags>>(new Map());
  private readonly prints = signal<ReadonlyMap<string, PrintInfo | null>>(new Map());
  private readonly sets = signal<ReadonlyMap<string, ScryfallSet>>(new Map());
  readonly priceProgress = signal<{ done: number; total: number } | null>(null);
  private readonly requestedNames = new Set<string>();
  private readonly requestedIds = new Set<string>();

  // Ansicht
  readonly mode = signal<'grid' | 'list'>('grid');
  readonly sort = signal<CollectionSort>('added');
  readonly group = signal<CollectionGroup>('none');
  readonly merge = signal(false);
  readonly filtersOpen = signal(false);
  readonly limit = signal(PAGE);

  // Filter
  readonly search = signal('');
  readonly langs = signal<Set<string>>(new Set());
  readonly setFilter = signal<Set<string>>(new Set());
  readonly rarityFilter = signal<ReadonlySet<string>>(new Set());
  readonly foil = signal<CollectionFilters['foil']>('all');
  readonly cmc = signal<'all' | number>('all');
  readonly colors = signal(EMPTY_COLOR_SELECTION);
  readonly type = signal('all');
  readonly effect = signal('all');
  readonly keyword = signal('all');
  readonly usage = signal<CollectionFilters['usage']>('all');

  readonly filters = computed<CollectionFilters>(() => ({
    search: this.search(),
    langs: this.langs(),
    // Alle angehakt heißt "kein Filter" - so zeigt die Auswahl (ui/multi-select) "Alle Sets".
    sets:
      this.setFilter().size >= this.setOptions().length
        ? new Set<string>()
        : new Set([...this.setFilter()].map((label) => this.setCodeByLabel().get(label) ?? label)),
    rarities: this.rarityFilter(),
    foil: this.foil(),
    cmc: this.cmc(),
    colors: this.colors(),
    type: this.type(),
    effect: this.effect(),
    keyword: this.keyword(),
    usage: this.usage(),
  }));
  readonly filterCount = computed(() => activeFilterCount(this.filters()));

  /** Exemplare je Karte in eigenen Decks (nur bei der eigenen Sammlung bekannt). */
  private readonly usedByName = computed(() => {
    const map = new Map<string, number>();
    if (!this.editable()) return map;
    for (const u of this.collection.deckUsage() ?? []) {
      const key = collectionKey(u.cardName);
      map.set(key, (map.get(key) ?? 0) + u.quantity);
    }
    return map;
  });

  readonly items = computed<CollectionItem[]>(() => {
    const details = this.details();
    const effectNames = this.effectNames();
    const flags = this.flags();
    const prints = this.prints();
    const used = this.usedByName();
    return this.entries().map((entry) => {
      const card = details.get(entry.cardName.toLowerCase());
      const key = collectionKey(entry.cardName);
      const effects = new Set<string>();
      for (const [category, names] of effectNames) if (names.has(key)) effects.add(category);
      const flag = flags.get(this.cardData.spellbookKey(entry.cardName));
      for (const [effect, field] of Object.entries(FLAG_EFFECTS))
        if (flag?.[field]) effects.add(effect);
      const info = prints.get(entry.scryfallId);
      return {
        entry,
        typeLine: card?.typeLine ?? null,
        cmc: card?.cmc ?? null,
        colorIdentity: card?.colorIdentity ?? [],
        keywords: card?.keywords ?? [],
        effects,
        rarity: info?.rarity ?? null,
        setName: info?.setName ?? this.sets().get(entry.setCode)?.name ?? null,
        price: (entry.foil ? (info?.eurFoil ?? info?.eur) : (info?.eur ?? info?.eurFoil)) ?? null,
        priceFromEnglish: info?.priceFromEnglish ?? false,
        inDecks: used.get(key) ?? 0,
      };
    });
  });

  readonly filtered = computed(() => {
    const list = filterCollection(this.items(), this.filters());
    return sortCollection(this.merge() ? mergePrints(list) : list, this.sort());
  });
  readonly sections = computed(() => groupCollection(this.filtered(), this.group()));

  /** Abschnitte gekürzt auf die ersten `limit` Karten - große Sammlungen nicht auf einmal zeichnen. */
  readonly visibleSections = computed(() => {
    let left = this.limit();
    const out: CollectionSection[] = [];
    for (const section of this.sections()) {
      if (left <= 0) break;
      out.push({ ...section, items: section.items.slice(0, left) });
      left -= section.items.length;
    }
    return out;
  });
  readonly hiddenCount = computed(() => Math.max(0, this.filtered().length - this.limit()));

  readonly totalCards = computed(() => this.entries().reduce((sum, e) => sum + e.quantity, 0));
  readonly distinctCards = computed(() => new Set(this.entries().map((e) => e.cardName)).size);
  readonly totalValue = computed(() => collectionValue(this.items()));
  readonly filteredCards = computed(() =>
    this.filtered().reduce((s, i) => s + i.entry.quantity, 0),
  );
  readonly filteredValue = computed(() => collectionValue(this.filtered()));

  /** Sprachen in der Sammlung, Reihenfolge wie im Profil. */
  readonly languages = computed(() => {
    const counts = new Map<string, number>();
    for (const e of this.entries()) counts.set(e.lang, (counts.get(e.lang) ?? 0) + e.quantity);
    const order = ART_LANGUAGES.map((l) => l.code as string);
    return [...counts.entries()]
      .sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99))
      .map(([code, count]) => ({ code, count }));
  });

  /** Sets der Sammlung als Auswahl "FRA · Aetherdrift", neueste zuerst. */
  readonly setOptions = computed(() => {
    const codes = [...new Set(this.entries().map((e) => e.setCode))];
    const sets = this.sets();
    return codes
      .sort((a, b) =>
        (sets.get(b)?.released_at ?? '').localeCompare(sets.get(a)?.released_at ?? ''),
      )
      .map((code) => this.setLabel(code));
  });
  private readonly setCodeByLabel = computed(() => {
    const map = new Map<string, string>();
    for (const code of new Set(this.entries().map((e) => e.setCode)))
      map.set(this.setLabel(code), code);
    return map;
  });

  // Hinzufügen per Suche
  readonly scannerOpen = signal(false);
  readonly canScan =
    typeof window !== 'undefined' &&
    window.matchMedia('(pointer: coarse)').matches &&
    !!navigator.mediaDevices?.getUserMedia;
  readonly addOpen = signal(false);
  readonly addQuery = signal('');
  readonly suggestions = signal<string[]>([]);
  readonly addCardName = signal<string | null>(null);
  readonly addPrints = signal<CollectionPrint[]>([]);
  readonly printsBusy = signal(false);
  readonly addFoil = signal(false);
  readonly addLangFilter = signal<string | null>(null);
  private suggestTimer: ReturnType<typeof setTimeout> | null = null;
  readonly shownPrints = computed(() => {
    const lang = this.addLangFilter();
    return lang ? this.addPrints().filter((p) => p.lang === lang) : this.addPrints();
  });
  readonly printLanguages = computed(() => [...new Set(this.addPrints().map((p) => p.lang))]);

  constructor() {
    effect(() => {
      const uid = this.userId();
      if (!uid) {
        void this.collection.ensureLoaded();
        void this.collection.ensureDeckUsage();
        return;
      }
      this.friendEntries.set(null);
      void this.collection.loadFor(uid).then((rows) => {
        if (this.userId() === uid) this.friendEntries.set(rows);
      });
    });
    effect(() => void this.loadMissing(this.entries()));
    void this.scryfall
      .allSets()
      .then((sets) => this.sets.set(new Map(sets.map((s) => [s.code, s]))));
    void this.cardData.spellbookCardFlags().then((flags) => this.flags.set(flags));
    // Neue Sets (andere Sammlung, frisch gescannte Karte) sind angehakt, solange alle es waren.
    let knownSets: readonly string[] = [];
    effect(() => {
      const options = this.setOptions();
      const selected = untracked(this.setFilter);
      if (selected.size === 0 || knownSets.every((o) => selected.has(o))) {
        this.setFilter.set(new Set(options));
      }
      knownSets = options;
    });
    // Nach jedem Filterwechsel wieder oben anfangen.
    effect(() => {
      this.filters();
      this.sort();
      this.group();
      this.merge();
      this.limit.set(PAGE);
    });
  }

  /** Lädt Kartendaten und Druck-Angaben nur für Karten, die noch fehlen. */
  private async loadMissing(entries: readonly CollectionEntry[]): Promise<void> {
    const names = [...new Set(entries.map((e) => e.cardName))].filter(
      (n) => !this.requestedNames.has(n),
    );
    const ids = [...new Set(entries.map((e) => e.scryfallId))].filter(
      (id) => !this.requestedIds.has(id),
    );
    names.forEach((n) => this.requestedNames.add(n));
    ids.forEach((id) => this.requestedIds.add(id));
    if (names.length) {
      const [cards, effects] = await Promise.all([
        this.cardData.findCardsBulk(names),
        this.cardData.effectCategories(names),
      ]);
      this.details.update((map) => new Map([...map, ...cards]));
      this.effectNames.update((map) => {
        const next = new Map<string, ReadonlySet<string>>(map);
        for (const [category, set] of effects)
          next.set(category, new Set([...(map.get(category) ?? []), ...set]));
        return next;
      });
    }
    if (ids.length) {
      const info = await this.collection.printInfo(ids, (done, total) =>
        this.priceProgress.set(done < total ? { done, total } : null),
      );
      this.prints.update((map) => new Map([...map, ...info]));
    }
  }

  close(): void {
    this.collection.closeView();
  }

  // --- Anzeige ----------------------------------------------------------------------------

  image(entry: CollectionEntry): string {
    return printImageUrl(entry.scryfallId, this.mode() === 'grid' ? 'normal' : 'small');
  }

  /**
   * Antippen einer Kachel: einzeln die Vorschau, zusammengefasst die Verteilung aller eigenen
   * Drucke dieser Karte (Wunsch des Users, 19.10.2026).
   */
  open(item: CollectionItem): void {
    if (this.merge()) this.detailName.set(item.entry.cardName);
    else this.openPreview(item.entry);
  }

  /** Karte, deren Drucke gerade im Detailfenster stehen. */
  readonly detailName = signal<string | null>(null);
  /** Alle eigenen Drucke der Karte - ungefiltert, meiste Exemplare zuerst. */
  readonly detailItems = computed(() => {
    const name = this.detailName();
    if (!name) return [];
    const key = collectionKey(name);
    return this.items()
      .filter((i) => collectionKey(i.entry.cardName) === key)
      .sort(
        (a, b) =>
          b.entry.quantity - a.entry.quantity || a.entry.setCode.localeCompare(b.entry.setCode),
      );
  });
  readonly detailCards = computed(() =>
    this.detailItems().reduce((sum, i) => sum + i.entry.quantity, 0),
  );
  readonly detailValue = computed(() => collectionValue(this.detailItems()));

  /** Im Detailfenster je Druck ändern - dort ist jeder Eintrag ein einzelner Druck. */
  changePrint(item: CollectionItem, delta: number): void {
    void this.collection.setQuantity(item.entry, item.entry.foil, item.entry.quantity + delta);
  }

  openPreview(entry: CollectionEntry): void {
    this.preview.open(printImageUrl(entry.scryfallId), null, entry.cardName);
  }

  setLabel(code: string): string {
    const name = this.sets().get(code)?.name;
    return name ? `${code.toUpperCase()} · ${name}` : code.toUpperCase();
  }

  sectionLabel(section: CollectionSection): string {
    switch (this.group()) {
      case 'set':
        return this.setLabel(section.key);
      case 'color':
        return section.key === 'C'
          ? this.i18n.t('collection.colorless')
          : colorComboLabel(this.i18n, section.key.split(''));
      case 'type':
        return translateSectionLabel(this.i18n, section.key);
      case 'rarity':
        return section.key
          ? this.i18n.t(`collection.rarity.${section.key}`)
          : this.i18n.t('collection.unknown');
      default:
        return '';
    }
  }

  sectionLabelFor(typeLabel: string): string {
    return translateSectionLabel(this.i18n, typeLabel);
  }

  /** "12 / 281": verschiedene Sammlernummern dieses Sets, die man besitzt. */
  setProgress(section: CollectionSection): string | null {
    if (this.group() !== 'set') return null;
    const total = this.sets().get(section.key)?.card_count;
    if (!total) return null;
    const owned = new Set(
      this.entries()
        .filter((e) => e.setCode === section.key)
        .map((e) => e.collectorNumber),
    ).size;
    return this.i18n.t('collection.setProgress', { owned, total });
  }

  sectionValue(section: CollectionSection): number {
    return collectionValue(section.items);
  }

  showMore(): void {
    this.limit.update((n) => n + PAGE);
  }

  // --- Filter -----------------------------------------------------------------------------

  toggleLang(code: string): void {
    this.langs.update((set) => toggled(set, code));
  }

  setEffect(value: string): void {
    this.effect.set(value);
  }

  resetFilters(): void {
    this.langs.set(new Set());
    this.setFilter.set(new Set(this.setOptions()));
    this.rarityFilter.set(new Set());
    this.foil.set('all');
    this.cmc.set('all');
    this.colors.set(EMPTY_COLOR_SELECTION);
    this.type.set('all');
    this.effect.set('all');
    this.keyword.set('all');
    this.usage.set('all');
  }

  // --- Bearbeiten -------------------------------------------------------------------------

  change(item: CollectionItem, delta: number): void {
    // Zusammengefasste Einträge stehen für mehrere Drucke - dort nichts ändern.
    if (this.merge()) return;
    void this.collection.setQuantity(item.entry, item.entry.foil, item.entry.quantity + delta);
  }

  openAdd(): void {
    this.addOpen.set(true);
    this.addQuery.set('');
    this.suggestions.set([]);
    this.addCardName.set(null);
    this.addPrints.set([]);
  }

  closeAdd(): void {
    this.addOpen.set(false);
  }

  onAddQuery(value: string): void {
    this.addQuery.set(value);
    if (this.suggestTimer) clearTimeout(this.suggestTimer);
    this.suggestTimer = setTimeout(async () => {
      const names = await this.collection.suggestNames(value);
      if (this.addQuery() === value) this.suggestions.set(names);
    }, 300);
  }

  async pickCard(name: string): Promise<void> {
    this.addCardName.set(name);
    this.addLangFilter.set(null);
    this.addPrints.set([]);
    this.printsBusy.set(true);
    const prints = await this.collection.printsOf(name);
    if (this.addCardName() !== name) return;
    this.addPrints.set(prints);
    this.printsBusy.set(false);
  }

  backToSearch(): void {
    this.addCardName.set(null);
    this.addPrints.set([]);
  }

  ownedOf(print: CollectionPrint): number {
    return this.collection.quantityOf(print.scryfallId, this.addFoil());
  }

  canFoil(print: CollectionPrint): boolean {
    return this.addFoil()
      ? print.finishes.some((f) => f !== 'nonfoil')
      : print.finishes.includes('nonfoil');
  }

  addPrint(print: CollectionPrint, delta: number): void {
    void this.collection.add(print, this.addFoil(), delta);
  }
}

function toggled(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
