import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../i18n.service';
import { CollectionService, PrintInfo } from '../collection.service';
import { CardDataService, SpellbookCardFlags } from '../card-data.service';
import { CardPreviewService } from '../card-preview.service';
import { DeckEffectsService } from '../deck-effects.service';
import { ScryfallCard, ScryfallService } from '../scryfall.service';
import { DeckFormat, SCRYFALL_FORMAT } from '../models';
import { collectionKey, printImageUrl } from '../collection-coverage';
import { EMPTY_COLOR_SELECTION, matchesColorSelection } from '../color-filter-match';
import { TYPE_ORDER, cmcBucket, translateSectionLabel, typeSection } from '../deck-analyse';
import { CmcFilter } from '../ui/cmc-filter/cmc-filter';
import { ColorFilter } from '../ui/color-filter/color-filter';
import { Icon } from '../ui/icon/icon';

/** Eine Karte im Auswahl-Raster. */
export interface PickerCard {
  name: string;
  /** Druck aus der eigenen Sammlung (nur im Sammlungs-Modus), sonst null = Standardbild. */
  scryfallId: string | null;
  image: string | null;
  backImage: string | null;
  /** Exemplare in der Sammlung; null im Modus "Alle Karten". */
  owned: number | null;
}

/** Sammlungskarte samt Daten fürs lokale Filtern. */
interface OwnedCard extends PickerCard {
  typeLine: string | null;
  cmc: number | null;
  colorIdentity: readonly string[];
  keywords: readonly string[];
  effects: ReadonlySet<string>;
}

const PAGE = 60;
/** Wie im Deck-Editor: Typ-Abschnitt -> Scryfall-Typwort. */
const TYPE_TO_SCRYFALL: Record<string, string> = {
  Planeswalker: 'planeswalker',
  Battle: 'battle',
  Kreatur: 'creature',
  Spontanzauber: 'instant',
  Hexerei: 'sorcery',
  Artefakt: 'artifact',
  Verzauberung: 'enchantment',
  Land: 'land',
};
/** Effekte ohne eigene Kategorie im Nacht-Cache - die kommen aus den Spellbook-Merkmalen. */
const FLAG_EFFECTS: Record<string, keyof SpellbookCardFlags> = {
  tutor: 'tutor',
  extraturn: 'extraTurn',
  mld: 'massLandDenial',
};

/**
 * Kartenauswahl des Cube-Builders (Wunsch des Users, 19.10.2026): ein Bilder-Raster mit Plus-Knopf
 * wie beim Karten-Hinzufügen im Deck-Editor, das ohne Suchbegriff ALLE in Frage kommenden Karten
 * zeigt und sich über Filter verkleinert.
 *
 * - "Alle Karten": blättert seitenweise durch Scryfall (ScryfallService.browseCards()).
 * - "Nur meine Sammlung": die eigene Sammlung, eine Kachel je Kartenname, lokal gefiltert.
 *
 * Ist ein Format gesetzt, erscheinen nur dort legale Karten: bei Scryfall über legal:, in der
 * Sammlung über die Legalitäten aus CollectionService.printInfo(). Ohne Format (freier Modus) alles.
 */
@Component({
  selector: 'app-cube-card-picker',
  imports: [FormsModule, CmcFilter, ColorFilter, Icon],
  templateUrl: './cube-card-picker.html',
  styleUrl: './cube-card-picker.scss',
})
export class CubeCardPicker {
  readonly i18n = inject(I18nService);
  readonly effectsService = inject(DeckEffectsService);
  private readonly collection = inject(CollectionService);
  private readonly cardData = inject(CardDataService);
  private readonly scryfall = inject(ScryfallService);
  private readonly preview = inject(CardPreviewService);

  readonly collectionOnly = input.required<boolean>();
  readonly format = input<DeckFormat | null>(null);
  /** Exemplare je Kartenname (klein geschrieben), die schon im Cube liegen. */
  readonly inCube = input.required<ReadonlyMap<string, number>>();
  readonly add = output<PickerCard>();

  readonly typeOptions = TYPE_ORDER.map((t) => t.label);

  // Filter
  readonly query = signal('');
  readonly type = signal('all');
  readonly cmc = signal<'all' | number>('all');
  readonly colors = signal(EMPTY_COLOR_SELECTION);
  readonly effect = signal('all');
  readonly keyword = signal('all');
  readonly order = signal<'name' | 'cmc'>('name');
  readonly limit = signal(PAGE);

  /** Bei Scryfall gibt es nur Effekte mit eigener Abfrage; lokale Quellen gehen nur in der Sammlung. */
  readonly effectOptions = computed(() =>
    this.collectionOnly()
      ? this.effectsService.effectFilters
      : this.effectsService.effectFilters.filter((f) => f.query),
  );

  // --- Alle Karten (Scryfall) ---
  private readonly remote = signal<PickerCard[]>([]);
  readonly remoteTotal = signal(0);
  private remotePage = 1;
  readonly remoteHasMore = signal(false);
  readonly busy = signal(false);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchRun = 0;

  // --- Sammlung ---
  private readonly details = signal<ReadonlyMap<string, ScryfallCard>>(new Map());
  private readonly effectNames = signal<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  private readonly flags = signal<ReadonlyMap<string, SpellbookCardFlags>>(new Map());
  private readonly prints = signal<ReadonlyMap<string, PrintInfo | null>>(new Map());
  readonly checkingLegality = signal(false);
  private readonly requestedNames = new Set<string>();
  private readonly requestedIds = new Set<string>();

  /** Eine Karte je Name, mit dem zuletzt hinzugefügten Druck als Bild. */
  private readonly ownedBase = computed(() => {
    const byName = new Map<string, { name: string; scryfallId: string; owned: number }>();
    for (const e of this.collection.entries() ?? []) {
      const key = e.cardName.toLowerCase();
      const prev = byName.get(key);
      if (prev) prev.owned += e.quantity;
      else byName.set(key, { name: e.cardName, scryfallId: e.scryfallId, owned: e.quantity });
    }
    return [...byName.values()];
  });

  private readonly ownedCards = computed<OwnedCard[]>(() => {
    const details = this.details();
    const effectNames = this.effectNames();
    const flags = this.flags();
    return this.ownedBase().map((o) => {
      const card = details.get(o.name.toLowerCase());
      const key = collectionKey(o.name);
      const effects = new Set<string>();
      for (const [category, names] of effectNames) if (names.has(key)) effects.add(category);
      const flag = flags.get(this.cardData.spellbookKey(o.name));
      for (const [eff, field] of Object.entries(FLAG_EFFECTS)) if (flag?.[field]) effects.add(eff);
      return {
        name: o.name,
        scryfallId: o.scryfallId,
        image: printImageUrl(o.scryfallId),
        backImage: null,
        owned: o.owned,
        typeLine: card?.typeLine ?? null,
        cmc: card?.cmc ?? null,
        colorIdentity: card?.colorIdentity ?? [],
        keywords: card?.keywords ?? [],
        effects,
      };
    });
  });

  private readonly ownedFiltered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const type = this.type();
    const cmc = this.cmc();
    const colors = this.colors();
    const eff = this.effect();
    const keyword = this.keyword();
    const format = this.format();
    const prints = this.prints();
    const list = this.ownedCards().filter((c) => {
      if (q && !c.name.toLowerCase().includes(q)) return false;
      if (type !== 'all' && typeSection(c.typeLine) !== type) return false;
      if (cmc !== 'all' && (c.cmc === null || cmcBucket(c.cmc) !== cmc)) return false;
      if (colors.colors.length && !matchesColorSelection(c.colorIdentity, colors)) return false;
      if (eff !== 'all' && !c.effects.has(eff)) return false;
      if (keyword !== 'all' && !c.keywords.some((k) => k.toLowerCase() === keyword)) return false;
      if (format && c.scryfallId) {
        // Unbekannt (noch nicht geladen oder Scryfall ohne Antwort) bleibt sichtbar.
        const legal = prints.get(c.scryfallId)?.legalities[SCRYFALL_FORMAT[format]];
        if (legal && legal !== 'legal' && legal !== 'restricted') return false;
      }
      return true;
    });
    const byName = (a: OwnedCard, b: OwnedCard) => a.name.localeCompare(b.name);
    return this.order() === 'cmc'
      ? list.sort((a, b) => (a.cmc ?? 99) - (b.cmc ?? 99) || byName(a, b))
      : list.sort(byName);
  });

  readonly results = computed<PickerCard[]>(() =>
    this.collectionOnly() ? this.ownedFiltered() : this.remote(),
  );
  readonly total = computed(() =>
    this.collectionOnly() ? this.ownedFiltered().length : this.remoteTotal(),
  );
  readonly visible = computed(() => this.results().slice(0, this.limit()));
  readonly canShowMore = computed(
    () => this.results().length > this.limit() || (!this.collectionOnly() && this.remoteHasMore()),
  );

  constructor() {
    void this.collection.ensureLoaded();
    void this.cardData.spellbookCardFlags().then((flags) => this.flags.set(flags));

    // Sammlung: Kartendaten nachladen, Legalitäten nur, wenn ein Format gilt.
    effect(() => {
      if (!this.collectionOnly()) return;
      const base = this.ownedBase();
      const format = this.format();
      untracked(() => void this.loadOwned(base, !!format));
    });

    // Alle Karten: bei jeder Filteränderung neu suchen (kurz gesammelt, wie im Deck-Editor).
    effect(() => {
      const collectionOnly = this.collectionOnly();
      const args = {
        query: this.query(),
        type: this.type(),
        cmc: this.cmc(),
        colors: this.colors(),
        effect: this.effect(),
        keyword: this.keyword(),
        order: this.order(),
        format: this.format(),
      };
      untracked(() => {
        this.limit.set(PAGE);
        if (collectionOnly) return;
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => void this.search(args, 1), 300);
      });
    });
  }

  private async search(
    args: {
      query: string;
      type: string;
      cmc: 'all' | number;
      colors: typeof EMPTY_COLOR_SELECTION;
      effect: string;
      keyword: string;
      order: 'name' | 'cmc';
      format: DeckFormat | null;
    },
    page: number,
  ): Promise<void> {
    const run = ++this.searchRun;
    this.busy.set(true);
    const result = await this.scryfall.browseCards(
      args.query,
      {
        type: args.type === 'all' ? undefined : TYPE_TO_SCRYFALL[args.type],
        cmc: args.cmc === 'all' ? null : args.cmc,
        colors: args.colors,
        effectQuery:
          args.effect === 'all'
            ? undefined
            : this.effectsService.effectFilters.find((f) => f.value === args.effect)?.query ||
              undefined,
        keyword: args.keyword === 'all' ? undefined : args.keyword,
        order: args.order,
        format: args.format,
      },
      page,
    );
    if (run !== this.searchRun) return;
    const cards: PickerCard[] = result.cards.map((c) => ({
      name: c.name,
      scryfallId: null,
      image: c.imageUrl ?? null,
      backImage: c.backImageUrl ?? null,
      owned: null,
    }));
    this.remote.update((list) => (page === 1 ? cards : [...list, ...cards]));
    this.remoteTotal.set(result.total);
    this.remoteHasMore.set(result.hasMore);
    this.remotePage = page;
    this.lastArgs = args;
    this.busy.set(false);
  }
  private lastArgs: Parameters<CubeCardPicker['search']>[0] | null = null;

  private async loadOwned(
    base: readonly { name: string; scryfallId: string }[],
    withLegality: boolean,
  ): Promise<void> {
    const names = base.map((b) => b.name).filter((n) => !this.requestedNames.has(n));
    names.forEach((n) => this.requestedNames.add(n));
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
    if (!withLegality) return;
    const ids = base.map((b) => b.scryfallId).filter((id) => !this.requestedIds.has(id));
    if (!ids.length) return;
    ids.forEach((id) => this.requestedIds.add(id));
    this.checkingLegality.set(true);
    const info = await this.collection.printInfo(ids);
    this.prints.update((map) => new Map([...map, ...info]));
    this.checkingLegality.set(false);
  }

  /** Weitere Kacheln zeigen; bei Scryfall dazu bei Bedarf die nächste Seite holen. */
  async showMore(): Promise<void> {
    const next = this.limit() + PAGE;
    if (
      !this.collectionOnly() &&
      next > this.remote().length &&
      this.remoteHasMore() &&
      this.lastArgs &&
      !this.busy()
    ) {
      await this.search(this.lastArgs, this.remotePage + 1);
    }
    this.limit.set(next);
  }

  countInCube(card: PickerCard): number {
    return this.inCube().get(card.name.toLowerCase()) ?? 0;
  }

  /** Im Sammlungs-Modus nicht mehr Exemplare, als man besitzt. */
  canAdd(card: PickerCard): boolean {
    return card.owned === null || this.countInCube(card) < card.owned;
  }

  openPreview(card: PickerCard): void {
    if (card.image) this.preview.open(card.image, card.backImage, card.name);
  }

  typeLabel(type: string): string {
    return translateSectionLabel(this.i18n, type);
  }

  resetFilters(): void {
    this.query.set('');
    this.type.set('all');
    this.cmc.set('all');
    this.colors.set(EMPTY_COLOR_SELECTION);
    this.effect.set('all');
    this.keyword.set('all');
  }
}
