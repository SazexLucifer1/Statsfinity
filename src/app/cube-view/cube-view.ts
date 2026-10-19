import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../i18n.service';
import { CubeCard, CubeService } from '../cube.service';
import { CollectionService } from '../collection.service';
import { CardDataService } from '../card-data.service';
import { CardPreviewService } from '../card-preview.service';
import { DeckService } from '../deck.service';
import { DialogService } from '../dialog.service';
import { ScryfallCard, ScryfallService } from '../scryfall.service';
import { collectionKey, printImageUrl } from '../collection-coverage';
import { CollectionPrint } from '../collection-coverage';
import { CubePacksPanel } from '../cube-packs-panel/cube-packs-panel';
import {
  CUBE_COLUMNS,
  CubeCardData,
  CubeColumnKey,
  CubeTypeGroup,
  collectionGaps,
  parseCubeCobraCsv,
  colorCategory,
  columnCounts,
  cubeTable,
} from '../cube-layout';
import { colorComboLabel, colorComboName } from '../color-combo-names';
import { manaCurve, translateSectionLabel, typeBreakdown } from '../deck-analyse';
import { BarChart, BarChartDatum } from '../ui/bar-chart/bar-chart';
import { manaCurveChartData, typeChartData } from '../ui/bar-chart/deck-chart-data';
import { Icon } from '../ui/icon/icon';
import { OverflowMenu } from '../ui/overflow-menu/overflow-menu';
import { CubeCardPicker, PickerCard } from '../cube-card-picker/cube-card-picker';
import { DECK_FORMATS, DeckFormat } from '../models';

/** Eine Karte im Cube samt Kartendaten und Besitz. */
interface CubeItem extends CubeCardData {
  card: CubeCard;
  image: string | null;
  backImage: string | null;
  /** Exemplare in der eigenen Sammlung (alle Drucke). */
  owned: number;
}

const PACK_SIZE = 15;

/**
 * Cube-Builder als eigene Seite wie die Sammlung (Wunsch des Users, 17.10.2026, Vorbild
 * CubeCobra). Ohne gewählten Cube die Übersicht der eigenen Cubes, sonst der Cube mit vier
 * Reitern: Karten (Tabelle nach Farbspalten, Bilder, Liste), Hinzufügen (Bilder-Raster mit Filtern,
 * cube-card-picker/), Analyse, Probe-Booster. Das Format des Cubes (null = frei) bestimmt, welche
 * Karten die Auswahl anbietet.
 *
 * "Nur Karten aus meiner Sammlung" ist eine Einstellung je Cube (cube_lists.collection_only):
 * an, schlägt das Hinzufügen nur Karten aus der Sammlung vor, nimmt höchstens so viele Exemplare,
 * wie man besitzt, und zeigt bevorzugt das eigene Artwork. Karten, die schon im Cube liegen,
 * bleiben beim Umschalten drin - sie werden nur markiert.
 *
 * Kartendaten (Typ, Manawert, Farben, Bild) kommen aus dem Nacht-Cache wie in der Deck-Ansicht,
 * gerechnet wird in cube-layout.ts.
 */
@Component({
  selector: 'app-cube-view',
  imports: [FormsModule, BarChart, Icon, OverflowMenu, CubeCardPicker, CubePacksPanel],
  templateUrl: './cube-view.html',
  styleUrl: './cube-view.scss',
})
export class CubeView {
  readonly i18n = inject(I18nService);
  readonly cubes = inject(CubeService);
  readonly collection = inject(CollectionService);
  private readonly cardData = inject(CardDataService);
  private readonly preview = inject(CardPreviewService);
  private readonly deckService = inject(DeckService);
  private readonly dialog = inject(DialogService);
  private readonly scryfall = inject(ScryfallService);

  readonly cubeId = computed(() => this.cubes.view()?.cubeId ?? null);
  readonly current = computed(
    () => this.cubes.cubes()?.find((c) => c.id === this.cubeId()) ?? null,
  );

  // --- Übersicht ---
  readonly newName = signal('');
  readonly newFormat = signal<DeckFormat | null>(null);
  readonly creating = signal(false);
  readonly formats = DECK_FORMATS;

  // --- Geöffneter Cube ---
  readonly cards = signal<CubeCard[] | null>(null);
  private readonly details = signal<ReadonlyMap<string, ScryfallCard>>(new Map());
  private readonly requested = new Set<string>();

  readonly tab = signal<'cards' | 'add' | 'analysis' | 'pack'>('cards');
  readonly display = signal<'table' | 'spoiler' | 'list'>('table');
  readonly search = signal('');
  readonly columns = CUBE_COLUMNS;

  // Karte bearbeiten (Tabelle, Bilder, Liste)
  private readonly selectedName = signal<string | null>(null);
  /** Aus der aktuellen Liste nachgeschlagen, damit Anzahl & Co. nach dem Speichern stimmen. */
  readonly selected = computed(
    () => this.items().find((i) => i.name === this.selectedName()) ?? null,
  );
  readonly prints = signal<CollectionPrint[]>([]);
  readonly printsBusy = signal(false);

  // Hinzufügen
  readonly addMessage = signal<string | null>(null);
  readonly bulkOpen = signal(false);
  readonly bulkText = signal('');
  readonly bulkBusy = signal(false);
  /** Massen-Import ersetzt die bisherige Kartenliste, statt sie zu ergänzen. */
  readonly bulkReplace = signal(false);
  /** Namen, die der letzte Import nicht gefunden hat. */
  readonly importUnknown = signal<string[]>([]);

  // Bearbeiten
  readonly editOpen = signal(false);
  readonly editName = signal('');
  readonly editDescription = signal('');
  readonly editFormat = signal<DeckFormat | null>(null);

  readonly collectionOnly = computed(() => this.current()?.collectionOnly ?? false);

  readonly items = computed<CubeItem[]>(() => {
    const details = this.details();
    const owned = this.collection.ownedByName();
    return (this.cards() ?? []).map((card) => {
      const d = details.get(card.cardName.toLowerCase());
      const ownedCount = (owned.get(collectionKey(card.cardName)) ?? []).reduce(
        (sum, e) => sum + e.quantity,
        0,
      );
      return {
        card,
        name: card.cardName,
        quantity: card.quantity,
        typeLine: d?.typeLine ?? null,
        cmc: d?.cmc ?? null,
        colorIdentity: d?.colorIdentity ?? [],
        colorCategory: card.colorCategory,
        image: card.scryfallId ? printImageUrl(card.scryfallId) : (d?.imageUrl ?? null),
        backImage: card.scryfallId ? null : (d?.backImageUrl ?? null),
        owned: ownedCount,
      };
    });
  });

  /** Exemplare je Kartenname im Cube - für die Kennzeichnung in der Kartenauswahl. */
  readonly inCube = computed(
    () => new Map((this.cards() ?? []).map((c) => [c.cardName.toLowerCase(), c.quantity])),
  );

  readonly totalCards = computed(() => this.items().reduce((sum, i) => sum + i.quantity, 0));

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const items = this.items();
    if (!q) return items;
    return items.filter(
      (i) => i.name.toLowerCase().includes(q) || (i.typeLine ?? '').toLowerCase().includes(q),
    );
  });

  readonly table = computed(() => cubeTable(this.filtered()));
  readonly listItems = computed(() =>
    [...this.filtered()].sort((a, b) => a.name.localeCompare(b.name)),
  );

  readonly gaps = computed(() =>
    collectionGaps(this.items(), (name) => this.items().find((i) => i.name === name)?.owned ?? 0),
  );
  readonly missingNames = computed(() => new Set(this.gaps().map((g) => g.name)));
  readonly missingCopies = computed(() => this.gaps().reduce((sum, g) => sum + g.missing, 0));

  // --- Analyse ---
  readonly columnChart = computed<BarChartDatum[]>(() =>
    columnCounts(this.items())
      .filter((c) => c.count > 0)
      .map((c) => ({
        label: this.columnLabel(c.key),
        value: c.count,
        color: this.columnColor(c.key),
        symbol: 'WUBRG'.includes(c.key) || c.key === 'C' ? c.key : undefined,
      })),
  );
  private readonly analyseCards = computed(() =>
    this.items()
      .filter((i) => i.cmc !== null)
      .map((i) => ({ quantity: i.quantity, cmc: i.cmc ?? 0, typeLine: i.typeLine })),
  );
  readonly curveChart = computed(() => manaCurveChartData(manaCurve(this.analyseCards())));
  readonly typeChart = computed(() => typeChartData(typeBreakdown(this.analyseCards(), this.i18n)));
  readonly averageCmc = computed(() => {
    const spells = this.analyseCards().filter(
      (c) => !(c.typeLine ?? '').split(' // ')[0].includes('Land'),
    );
    const count = spells.reduce((s, c) => s + c.quantity, 0);
    return count ? spells.reduce((s, c) => s + c.cmc * c.quantity, 0) / count : null;
  });
  /** Wie viele 15er-Booster der Cube für einen Draft hergibt (8 Spieler à 3 Booster = 360 Karten). */
  readonly draftPlayers = computed(() => Math.floor(this.totalCards() / (PACK_SIZE * 3)));

  constructor() {
    void this.cubes.loadCubes();
    void this.collection.ensureLoaded();

    // Cube gewechselt: Karten neu laden, Ansicht zurücksetzen.
    effect(() => {
      const id = this.cubeId();
      untracked(() => {
        this.cards.set(null);
        this.selectedName.set(null);
        this.tab.set('cards');
        this.search.set('');
        this.addMessage.set(null);
      });
      if (id) void this.loadCards(id);
    });

    // Kartendaten für neue Namen nachladen - gebündelt, eine Anfrage je Schub.
    effect(() => {
      const names = (this.cards() ?? [])
        .map((c) => c.cardName)
        .filter((n) => !this.requested.has(n.toLowerCase()));
      if (names.length === 0) return;
      for (const n of names) this.requested.add(n.toLowerCase());
      void this.cardData.findCardsBulk(names).then((found) => {
        this.details.update((map) => new Map([...map, ...found]));
      });
    });
  }

  private async loadCards(id: string): Promise<void> {
    const cards = await this.cubes.loadCards(id);
    if (this.cubeId() !== id) return;
    this.cards.set(cards);
    // Ein leerer Cube startet gleich in der Kartenauswahl.
    if (cards.length === 0) this.tab.set('add');
  }

  // --- Übersicht ---------------------------------------------------------------------------

  async create(): Promise<void> {
    if (!this.newName().trim() || this.creating()) return;
    this.creating.set(true);
    const cube = await this.cubes.create(this.newName(), this.newFormat());
    this.creating.set(false);
    if (cube) {
      this.newName.set('');
      this.cubes.openCube(cube.id);
    }
  }

  // --- Cube -------------------------------------------------------------------------------

  async setCollectionOnly(value: boolean): Promise<void> {
    const cube = this.current();
    if (!cube || cube.collectionOnly === value) return;
    await this.cubes.update(cube.id, { collectionOnly: value });
    this.addMessage.set(null);
  }

  openEdit(): void {
    const cube = this.current();
    if (!cube) return;
    this.editName.set(cube.name);
    this.editDescription.set(cube.description);
    this.editFormat.set(cube.format);
    this.editOpen.set(true);
  }

  async saveEdit(): Promise<void> {
    const cube = this.current();
    if (!cube || !this.editName().trim()) return;
    await this.cubes.update(cube.id, {
      name: this.editName(),
      description: this.editDescription(),
      format: this.editFormat(),
    });
    this.editOpen.set(false);
  }

  async deleteCube(): Promise<void> {
    const cube = this.current();
    if (!cube) return;
    if (!(await this.dialog.confirm(this.i18n.t('cube.deleteConfirm', { name: cube.name }))))
      return;
    if (await this.cubes.remove(cube.id)) this.cubes.back();
  }

  /** Liste als Text ("1 Sol Ring" je Zeile) - dasselbe Format, das der Massen-Import liest. */
  async copyList(): Promise<void> {
    const text = [...(this.cards() ?? [])]
      .sort((a, b) => a.cardName.localeCompare(b.cardName))
      .map((c) => `${c.quantity} ${c.cardName}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.addMessage.set(this.i18n.t('cube.copied'));
    } catch {
      this.addMessage.set(this.i18n.t('cube.copyFailed'));
    }
  }

  // --- Hinzufügen -------------------------------------------------------------------------

  /** Plus in der Kartenauswahl: ein Exemplar dazu, im Sammlungs-Modus mit dem eigenen Druck. */
  async addCard(card: PickerCard): Promise<void> {
    const result = this.withAdded([{ name: card.name, quantity: 1, scryfallId: card.scryfallId }]);
    if (result.changed.length === 0) {
      this.addMessage.set(this.i18n.t('cube.notEnoughOwned', { name: card.name }));
      return;
    }
    this.addMessage.set(this.i18n.t('cube.added', { name: card.name }));
    await this.persist(result.changed);
  }

  /**
   * Massen-Import: eine normale Liste ("1 Sol Ring") oder CubeCobras CSV-Export. Aus dem CSV
   * kommen zusätzlich die selbst gesetzte Farbkategorie und der Druck (Set + Nummer), damit der
   * Cube so sortiert ist und so aussieht wie das Original.
   */
  async importBulk(): Promise<void> {
    if (this.bulkBusy()) return;
    const text = this.bulkText();
    const csv = parseCubeCobraCsv(text);
    let rows: {
      name: string;
      quantity: number;
      scryfallId: string | null;
      colorCategory: CubeColumnKey | null;
    }[];
    this.bulkBusy.set(true);
    if (csv) {
      const prints = await this.scryfall.printsBySetNumber(
        csv
          .filter((r) => r.set && r.collectorNumber)
          .map((r) => ({ set: r.set!, collectorNumber: r.collectorNumber! })),
      );
      rows = csv.map((r) => {
        const print = prints.get(`${r.set}/${r.collectorNumber}`.toLowerCase());
        // Nur übernehmen, wenn der Druck auch diese Karte ist - eine verrutschte Nummer soll
        // nicht den Namen austauschen. Doppelkarten stehen im Export oft nur mit der Vorderseite,
        // Secret-Lair- und Universes-Beyond-Drucke unter ihrem Alternativnamen ("Thunderjaw" ist
        // Meteor Golem) - dann gilt der echte Kartenname, das Bild bleibt der Druck.
        const key = collectionKey(r.name);
        const same =
          print && [print.name, ...print.aliases].some((n) => collectionKey(n) === key)
            ? print
            : undefined;
        return {
          name: same?.name ?? r.name,
          quantity: r.quantity,
          scryfallId: same?.id ?? null,
          colorCategory: r.colorCategory,
        };
      });
    } else {
      rows = this.deckService.parseDecklistText(text).map((p) => ({
        name: p.name,
        quantity: p.quantity,
        scryfallId: null,
        colorCategory: null,
      }));
    }
    if (rows.length === 0) {
      this.bulkBusy.set(false);
      return;
    }
    // Namen über den Nacht-Cache (mit Scryfall-Rückfall) auflösen: richtige Schreibweise,
    // Unbekanntes fällt heraus und wird mit Namen gemeldet.
    const found = await this.cardData.findCardsBulk(rows.map((r) => r.name));
    const known: typeof rows = [];
    const unknown: string[] = [];
    const missing: typeof rows = [];
    for (const r of rows) {
      const card = found.get(r.name.toLowerCase());
      if (card) known.push({ ...r, name: card.name });
      else if (r.scryfallId) known.push(r);
      else missing.push(r);
    }
    // Rückfall für Alternativnamen ("Thunderjaw" = Meteor Golem): Scryfalls exakte Namenssuche
    // kennt sie, der Nacht-Cache nicht. Einzeln und nacheinander - es sind nur wenige.
    for (const r of missing) {
      const res = await this.scryfall.fetchWithRetry(
        `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(r.name)}`,
        1,
      );
      const card = res?.ok ? await res.json() : null;
      if (card?.name) known.push({ ...r, name: card.name, scryfallId: r.scryfallId ?? card.id });
      else unknown.push(r.name);
    }
    const result = this.withAdded(known, this.bulkReplace());
    if (result.changed.length) await this.persist(result.changed);
    this.bulkBusy.set(false);
    this.bulkOpen.set(false);
    this.bulkText.set('');
    this.importUnknown.set(unknown);
    this.addMessage.set(
      this.i18n.t('cube.importResult', {
        added: result.added,
        unknown: unknown.length,
        notOwned: result.notOwned,
      }),
    );
  }

  /**
   * Rechnet Zugänge auf die Kartenliste und setzt sie sofort (beim Fehler lädt persist() neu).
   * Bei "nur Sammlung" höchstens so viele Exemplare, wie man besitzt.
   */
  private withAdded(
    adds: {
      name: string;
      quantity: number;
      scryfallId?: string | null;
      colorCategory?: CubeColumnKey | null;
    }[],
    replace = false,
  ): {
    changed: CubeCard[];
    added: number;
    notOwned: number;
  } {
    const before = this.cards() ?? [];
    const cards = new Map((replace ? [] : before).map((c) => [c.cardName.toLowerCase(), { ...c }]));
    const changed = new Map<string, CubeCard>();
    // Ersetzen: alles Bisherige zuerst als "Anzahl 0" vormerken - was im Import wieder
    // auftaucht, überschreibt den Eintrag unten.
    if (replace)
      for (const c of before) changed.set(c.cardName.toLowerCase(), { ...c, quantity: 0 });
    const owned = this.collection.ownedByName();
    let added = 0;
    let notOwned = 0;
    for (const add of adds) {
      const key = add.name.toLowerCase();
      const existing = cards.get(key);
      const ownedEntries = owned.get(collectionKey(add.name)) ?? [];
      let quantity = add.quantity;
      if (this.collectionOnly()) {
        const ownedCount = ownedEntries.reduce((sum, e) => sum + e.quantity, 0);
        const room = Math.max(0, ownedCount - (existing?.quantity ?? 0));
        notOwned += Math.max(0, quantity - room);
        quantity = Math.min(quantity, room);
      }
      if (quantity <= 0) continue;
      const card: CubeCard = existing
        ? {
            ...existing,
            quantity: Math.min(99, existing.quantity + quantity),
            scryfallId: add.scryfallId ?? existing.scryfallId,
            colorCategory: add.colorCategory ?? existing.colorCategory,
          }
        : {
            cardName: add.name,
            // Aus der Sammlung: das eigene Artwork zeigen.
            scryfallId:
              add.scryfallId ??
              (this.collectionOnly() ? (ownedEntries[0]?.scryfallId ?? null) : null),
            quantity: Math.min(99, quantity),
            addedAt: new Date().toISOString(),
            colorCategory: add.colorCategory ?? null,
          };
      cards.set(key, card);
      changed.set(key, card);
      added += quantity;
    }
    if (changed.size || replace) this.cards.set([...cards.values()]);
    return { changed: [...changed.values()], added, notOwned };
  }

  async setQuantity(item: CubeItem, quantity: number): Promise<void> {
    const card = { ...item.card, quantity };
    this.cards.update(
      (list) =>
        list?.map((c) => (c.cardName === card.cardName ? card : c)).filter((c) => c.quantity > 0) ??
        null,
    );
    await this.persist([card]);
  }

  private async persist(cards: CubeCard[]): Promise<void> {
    const id = this.cubeId();
    if (!id) return;
    const ok = await this.cubes.saveCards(id, cards);
    if (!ok) {
      this.addMessage.set(this.i18n.t('cube.saveFailed'));
      await this.loadCards(id);
      return;
    }
    const count = (this.cards() ?? []).reduce((sum, c) => sum + c.quantity, 0);
    this.cubes.cubes.update(
      (list) => list?.map((c) => (c.id === id ? { ...c, cardCount: count } : c)) ?? null,
    );
  }

  // --- Booster ----------------------------------------------------------------------------

  // --- Karte bearbeiten -------------------------------------------------------------------

  select(item: CubeItem): void {
    this.prints.set([]);
    this.selectedName.set(item.name);
  }

  closeSelected(): void {
    this.selectedName.set(null);
    this.prints.set([]);
  }

  /** Spalte von Hand setzen (null = aus Typ und Farbe rechnen) - wie CubeCobras Color Category. */
  async setCategory(item: CubeItem, category: CubeColumnKey | null): Promise<void> {
    await this.replaceCard({ ...item.card, colorCategory: category });
  }

  async setPrint(item: CubeItem, scryfallId: string): Promise<void> {
    await this.replaceCard({ ...item.card, scryfallId });
  }

  /** Alle Drucke der Karte - im Sammlungs-Modus nur die eigenen. */
  async loadPrints(item: CubeItem): Promise<void> {
    this.printsBusy.set(true);
    let prints = await this.collection.printsOf(item.name);
    if (this.collectionOnly()) {
      const own = new Set(
        (this.collection.ownedByName().get(collectionKey(item.name)) ?? []).map(
          (e) => e.scryfallId,
        ),
      );
      prints = prints.filter((p) => own.has(p.scryfallId));
    }
    this.printsBusy.set(false);
    this.prints.set(prints);
  }

  private async replaceCard(card: CubeCard): Promise<void> {
    this.cards.update(
      (list) => list?.map((c) => (c.cardName === card.cardName ? card : c)) ?? null,
    );
    await this.persist([card]);
  }

  autoCategoryOf(item: CubeItem): CubeColumnKey {
    return colorCategory({ ...item, colorCategory: null });
  }

  async setFormat(format: DeckFormat | null): Promise<void> {
    const cube = this.current();
    if (cube) await this.cubes.update(cube.id, { format });
  }

  openPreview(item: CubeItem): void {
    if (item.image) this.preview.open(item.image, item.backImage, item.name);
  }

  columnLabel(key: CubeColumnKey): string {
    return this.i18n.t(`cube.column.${key}`);
  }

  columnColor(key: CubeColumnKey): string {
    if ('WUBRG'.includes(key)) return `var(--pip-${key.toLowerCase()})`;
    if (key === 'M') return '#d4af37';
    if (key === 'H') return '#b98bd6';
    if (key === 'L') return '#a07850';
    return 'var(--pip-c)';
  }

  typeLabel(type: string): string {
    return translateSectionLabel(this.i18n, type);
  }

  /** Abschnittsname: Kartentyp oder - in Mehrfarbig/Hybrid/Ländern - die Farbkombination. */
  groupLabel(group: CubeTypeGroup<CubeItem>): string {
    if (!group.byColors) return this.typeLabel(group.type);
    if (group.type === '') return this.i18n.t('cube.column.C');
    return colorComboName(group.type.split('')) ?? colorComboLabel(this.i18n, group.type.split(''));
  }

  /** Trennlinie in der Tabelle, wo der Manawert wechselt (wie bei CubeCobra). */
  cmcBreak(group: CubeTypeGroup<CubeItem>, index: number): boolean {
    return index > 0 && group.cards[index - 1].cmc !== group.cards[index].cmc;
  }

  categoryOf(item: CubeItem): CubeColumnKey {
    return colorCategory(item);
  }
}
