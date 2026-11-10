import { Injectable, computed, inject, signal } from '@angular/core';
import { I18nService } from './i18n.service';
import { Deck, DeckCard } from './deck.service';
import { ScryfallService } from './scryfall.service';
import { CardDataService } from './card-data.service';
import { normalizeCardName, sleep } from './array-utils';
import type { GameChangerEntry, EffectCategoryStat } from './deck-viewer.service';
import { DeckAnalysisService } from './deck-analysis.service';
import { ALL_EFFECT_FILTERS, CardEffectFilter } from './card-effect-filters';
import { supabase } from './supabase.client';

/**
 * Effekt-Kategorien der Deck-Analyse (Entfernung, Rampe, ...): zuerst aus dem eigenen Kartenbestand, Scryfall nur für unbekannte Karten.
 */
/** Abfrage je Effekt-Schlüssel (nur Kategorien mit Scryfall-Abfrage). */
const CARD_EFFECT_QUERY = new Map(
  ALL_EFFECT_FILTERS.filter((f) => f.query).map((f) => [f.value, f.query] as const),
);

@Injectable({ providedIn: 'root' })
export class DeckEffectsService {
  private readonly cardData = inject(CardDataService);
  private readonly scryfall = inject(ScryfallService);
  private readonly analysis = inject(DeckAnalysisService);

  readonly effectCategoryCountsBusy = signal(false);

  /** Aktuell geöffnetes "Karten dieser Kategorie ansehen"-Popup (siehe effectCategoryStats) - null wenn geschlossen. */
  readonly effectCategoryPopup = signal<{ label: string; cards: GameChangerEntry[] } | null>(null);

  openEffectCategoryPopup(label: string, cards: GameChangerEntry[]): void {
    this.effectCategoryPopup.set({ label, cards });
  }

  closeEffectCategoryPopup(): void {
    this.effectCategoryPopup.set(null);
  }

  /**
   * Die 12 Effekt-Kategorien per Scryfall-Tag/Text (Tutor/Extra-Runde/MLD laufen lokal). Ramp ohne
   * Länder.
   *
   * Keine Unter-Tags aufzählen: otag: ist hierarchisch, Unter-Tags matchen das Eltern-Tag (geprüft,
   * Trefferzahlen gleich). Die Aufzählung machte die Abfrage nur länger und drückte die Namen je
   * Anfrage im Rückfallpfad (800 Zeichen).
   */
  private static readonly EFFECT_TAG_CATEGORIES: {
    key: string;
    labelKey: string;
    query: string;
  }[] = [
    {
      key: 'removal',
      labelKey: 'deckView.removalTile',
      query: 'otag:removal',
    },
    {
      key: 'counterspell',
      labelKey: 'deckView.counterspellTile',
      query: 'otag:counterspell',
    },
    {
      key: 'boardwipe',
      labelKey: 'deckView.boardwipeTile',
      query: 'otag:board-wipe',
    },
    {
      key: 'ramp',
      labelKey: 'deckView.rampTile',
      query: 'otag:ramp -t:land',
    },
    {
      key: 'draw',
      labelKey: 'deckView.drawTile',
      query: 'otag:draw',
    },
    {
      key: 'tokens',
      labelKey: 'deckView.tokensTile',
      // "o:create o:token" statt "create a" - sonst würden Formulierungen wie "create two" oder
      // "create X" (mehrere/variable Marken-Anzahl) am Wort "a" vorbei nicht gefunden.
      query: 'o:create o:token',
    },
    {
      key: 'lifegain',
      labelKey: 'deckView.lifegainTile',
      query: 'otag:lifegain',
    },
    {
      key: 'counters',
      labelKey: 'deckView.countersTile',
      // Oracle-Text statt Tag: otag:gives-1-1-counters gibt es nicht mehr (Kachel stand still auf
      // 0), otag:counters-matter ist die Payoff-Kategorie. Die Textsuche trifft die geprüften
      // Karten und hängt nicht an einem Community-Tag.
      query: 'o:"+1/+1 counter"',
    },
    {
      key: 'proliferate',
      labelKey: 'deckView.proliferateTile',
      query: 'keyword:proliferate',
    },
    {
      key: 'reanimate',
      labelKey: 'deckView.reanimateTile',
      query: 'otag:reanimate',
    },
    {
      key: 'sacrifice',
      labelKey: 'deckView.sacrificeTile',
      query: 'otag:sacrifice-outlet',
    },
    {
      key: 'extracombat',
      labelKey: 'deckView.extraCombatTile',
      query: 'otag:extra-combat',
    },
  ];

  /** Nur die 12 per Scryfall-Tag ermittelten Kategorien (async geladen, gecacht - siehe classifyCards()). */
  private readonly tagBasedEffectStats = signal<EffectCategoryStat[] | null>(null);

  /** Fortschritt beim erstmaligen (kalten) Durchlauf der 12 Scryfall-Tag-Kategorien - null wenn nicht am Laden. */
  readonly effectCategoryProgress = signal<{ done: number; total: number } | null>(null);

  /**
   * Alle 15 Kategorien: 12 per Scryfall-Tag plus Tutor/Extra-Runde/MLD aus lokalen Quellen.
   * computed, damit die lokalen Kategorien nachziehen, sobald ihre Daten da sind.
   */
  readonly effectCategoryStats = computed<EffectCategoryStat[] | null>(() => {
    const tagStats = this.tagBasedEffectStats();
    if (!tagStats) return null;
    const countOf = (entries: GameChangerEntry[]) =>
      entries.reduce((sum, c) => sum + c.quantity, 0);
    return [
      ...tagStats,
      {
        key: 'tutor',
        labelKey: 'deckView.tutorsTitle',
        count: countOf(this.analysis.tutorCards()),
        cards: this.analysis.tutorCards(),
      },
      {
        key: 'extraturn',
        labelKey: 'deckView.extraTurnsTitle',
        count: countOf(this.analysis.extraTurnCards()),
        cards: this.analysis.extraTurnCards(),
      },
      {
        key: 'mld',
        labelKey: 'deckView.massLandDenialTitle',
        count: countOf(this.analysis.massLandDenialCards()),
        cards: this.analysis.massLandDenialCards(),
      },
    ];
  });

  /**
   * Klassifiziert das Deck in die 12 Tag-Kategorien aus dem eigenen Bestand (CardDataService,
   * Nachtlauf) - zwei Abfragen statt früher ~100 Scryfall-Suchen. Scryfall bleibt Rückfall für
   * unbekannte Karten (frische Spoiler) und bei DB-Ausfall.
   */
  async loadEffectCategoryCounts(cards: DeckCard[]): Promise<void> {
    this.tileCards = cards;
    void this.loadCustomTileCounts();
    this.effectCategoryCountsBusy.set(true);
    const names = [
      ...new Set(cards.filter((c) => !c.isMaybeboard && !c.isToken).map((c) => c.cardName)),
    ];

    // Doppelkarten werden unter ihrem Vorderseiten-Namen klassifiziert.
    const entriesFromMatched = (matched: Set<string>): GameChangerEntry[] =>
      cards
        .filter(
          (c) =>
            !c.isMaybeboard &&
            !c.isToken &&
            matched.has(normalizeCardName(c.cardName.split(' // ')[0].trim())),
        )
        .map((c) => ({ cardName: c.cardName, quantity: c.quantity }));
    const countOf = (entries: GameChangerEntry[]) =>
      entries.reduce((sum, c) => sum + c.quantity, 0);

    const categories = DeckEffectsService.EFFECT_TAG_CATEGORIES;
    const [ausDatenbank, bekannt] = await Promise.all([
      this.cardData.effectCategories(names),
      this.cardData.knownCardNames(names),
    ]);
    const matchedByKey = new Map<string, Set<string>>(
      categories.map((category) => [category.key, new Set(ausDatenbank.get(category.key) ?? [])]),
    );

    // Nur Karten, die der Abgleich noch nicht kennt, gehen überhaupt noch ins Netz. Das ist im
    // Normalfall eine leere Liste - dann bleibt die ganze Schleife samt Pausen einfach aus.
    const unbekannt = names.filter(
      (name) => !bekannt.has(normalizeCardName(name.split(' // ')[0].trim())),
    );
    if (unbekannt.length > 0) {
      for (let i = 0; i < categories.length; i++) {
        if (i > 0) await sleep(300); // Wie bisher: vermeidet Bursts gegen Scryfalls Rate-Limit.
        const category = categories[i];
        const frisch = await this.scryfall.classifyCards(category.key, category.query, unbekannt);
        for (const name of frisch) matchedByKey.get(category.key)!.add(name);
        this.effectCategoryProgress.set({ done: i + 1, total: categories.length });
      }
    }

    this.tagBasedEffectStats.set(
      categories.map((category) => {
        const entries = entriesFromMatched(matchedByKey.get(category.key)!);
        return {
          key: category.key,
          labelKey: category.labelKey,
          count: countOf(entries),
          cards: entries,
        };
      }),
    );
    this.effectCategoryCountsBusy.set(false);
    this.effectCategoryProgress.set(null);
  }

  reset(): void {
    this.tagBasedEffectStats.set(null);
    this.customTiles.set(null);
    this.customTileStats.set(new Map());
    this.customTileRun++;
    this.tileLoadRun++;
    this.tileCards = [];
    this.effectCategoryCountsBusy.set(false);
    this.effectCategoryProgress.set(null);
    this.effectCategoryPopup.set(null);
  }

  // --- Eigene Kacheln je Deck (Wunsch des Users, 05.11.2026) ---------------------------------
  //
  // Standard bleiben die 15 Kacheln oben. Der Besitzer kann je Deck eine eigene Auswahl aus
  // allen Effekt-Tags festlegen (decks.effect_tiles, sql/deck-effekt-kacheln-2026-11-05.sql,
  // null = Standard). Das ändert NUR die Anzeige: Deck-Check und Power-Wert lesen weiter
  // effectCategoryStats() mit den Standard-Kategorien.

  /** Spalte vorhanden? Fehlt die Migration, verschwindet der Knopf beim ersten 42703/PGRST204. */
  readonly tilesAvailable = signal(true);
  /** Gespeicherte Auswahl des geöffneten Decks - null = Standard-Kacheln. */
  readonly customTiles = signal<string[] | null>(null);
  /** Zahlen der gewählten Kacheln, die nicht zu den Standard-Kacheln gehören. */
  private readonly customTileStats = signal<Map<string, EffectCategoryStat>>(new Map());
  private tileCards: DeckCard[] = [];
  private customTileRun = 0;
  /** Eigener Zähler fürs Laden der Auswahl - das Zählen erhöht customTileRun ständig. */
  private tileLoadRun = 0;

  /** Schlüssel der Standard-Kacheln, in ihrer Reihenfolge. */
  readonly defaultTileKeys = computed(() => [
    ...DeckEffectsService.EFFECT_TAG_CATEGORIES.map((c) => c.key),
    'tutor',
    'extraturn',
    'mld',
  ]);

  /**
   * Was die Analyse als Kacheln zeigt: ohne eigene Auswahl die Standard-Kacheln, sonst die
   * gewählten - Standard-Kacheln in ihrer gewohnten Reihenfolge vorn, die übrigen in der
   * Reihenfolge der Tag-Liste. Eine noch ladende Kachel hat count null.
   */
  readonly displayedEffectStats = computed<
    (EffectCategoryStat | { key: string; labelKey: string; count: null; cards: [] })[] | null
  >(() => {
    const base = this.effectCategoryStats();
    const chosen = this.customTiles();
    if (!base || !chosen) return base;
    const extra = this.customTileStats();
    const order = [...this.defaultTileKeys(), ...ALL_EFFECT_FILTERS.map((f) => f.value)];
    return [...new Set(order)]
      .filter((key) => chosen.includes(key))
      .map(
        (key) =>
          base.find((b) => b.key === key) ??
          extra.get(key) ?? { key, labelKey: `effectFilter.${key}`, count: null, cards: [] },
      );
  });

  /** Gespeicherte Auswahl laden; die Zahlen dazu folgen, sobald die Karten da sind. */
  async loadTiles(deckId: string): Promise<void> {
    if (!this.tilesAvailable()) return;
    const run = this.tileLoadRun;
    const { data, error } = await supabase
      .from('decks')
      .select('effect_tiles')
      .eq('id', deckId)
      .maybeSingle();
    if (run !== this.tileLoadRun) return;
    if (error) {
      if (!this.tileColumnMissing(error))
        console.error('Konnte Effekt-Kacheln nicht laden:', error);
      return;
    }
    const raw = (data as { effect_tiles?: string[] | null } | null)?.effect_tiles ?? null;
    const known = new Set(ALL_EFFECT_FILTERS.map((f) => f.value));
    const keys = raw?.filter((k) => known.has(k)) ?? null;
    this.customTiles.set(keys && keys.length ? keys : null);
    void this.loadCustomTileCounts();
  }

  /**
   * Neue Auswahl speichern (nur der Besitzer, das Update-Recht entscheidet). Leer oder gleich
   * dem Standard = null, damit spätere Änderungen am Standard auch hier ankommen.
   */
  async saveTiles(deckId: string, keys: readonly string[]): Promise<void> {
    const defaults = this.defaultTileKeys();
    const isDefault =
      keys.length === 0 ||
      (keys.length === defaults.length && defaults.every((k) => keys.includes(k)));
    const value = isDefault ? null : [...keys];
    this.customTiles.set(value);
    void this.loadCustomTileCounts();
    if (!this.tilesAvailable()) return;
    // Wie bei Primer und Spielweise: updated_at bleibt stehen.
    const { error } = await supabase.from('decks').update({ effect_tiles: value }).eq('id', deckId);
    if (error && !this.tileColumnMissing(error))
      console.error('Konnte Effekt-Kacheln nicht speichern:', error);
  }

  /**
   * Zählt die gewählten Kacheln außerhalb des Standards - wie die Standard-Kacheln aus dem
   * Nacht-Cache (`scryfall_card_effects` enthält alle Kategorien aus card-effect-filters.ts),
   * Scryfall nur für Karten, die der Cache nicht kennt. Vorher lief jede Kachel live über
   * Scryfall, je Kachel mehrere Anfragen nacheinander: bei gedrosselten Anfragen blieben die
   * Kacheln dauerhaft bei "…" stehen (Rückmeldung des Users, 10.11.2026).
   */
  private async loadCustomTileCounts(): Promise<void> {
    const run = ++this.customTileRun;
    const chosen = this.customTiles();
    const cards = this.tileCards;
    if (!chosen || cards.length === 0) return;
    const defaults = new Set(this.defaultTileKeys());
    const keys = chosen.filter((key) => !defaults.has(key) && CARD_EFFECT_QUERY.has(key));
    if (keys.length === 0) return;
    const counted = cards.filter((c) => !c.isMaybeboard && !c.isToken);
    const names = [...new Set(counted.map((c) => c.cardName))];
    const frontKey = (name: string) => normalizeCardName(name.split(' // ')[0].trim());

    const [ausDatenbank, bekannt] = await Promise.all([
      this.cardData.effectCategories(names),
      this.cardData.knownCardNames(names),
    ]);
    if (run !== this.customTileRun) return;
    const matchedByKey = new Map(
      keys.map((key) => [key, new Set(ausDatenbank.get(key) ?? [])] as const),
    );

    const statFor = (key: string): EffectCategoryStat => {
      const matched = matchedByKey.get(key)!;
      const entries = counted
        .filter((c) => matched.has(frontKey(c.cardName)))
        .map((c) => ({ cardName: c.cardName, quantity: c.quantity }));
      return {
        key,
        labelKey: `effectFilter.${key}`,
        count: entries.reduce((sum, c) => sum + c.quantity, 0),
        cards: entries,
      };
    };
    const publish = () => this.customTileStats.set(new Map(keys.map((key) => [key, statFor(key)])));
    publish();

    // Nur Karten, die der Abgleich nicht kennt (frische Spoiler), gehen noch an Scryfall - im
    // Normalfall keine. Die Zahlen oben stehen dann schon und werden nur nachgebessert.
    const unbekannt = names.filter((name) => !bekannt.has(frontKey(name)));
    if (unbekannt.length === 0) return;
    for (const key of keys) {
      const frisch = await this.scryfall.classifyCards(key, CARD_EFFECT_QUERY.get(key)!, unbekannt);
      if (run !== this.customTileRun) return;
      for (const name of frisch) matchedByKey.get(key)!.add(name);
      publish();
    }
  }

  private tileColumnMissing(error: { code?: string; message?: string }): boolean {
    if (error.code !== '42703' && error.code !== 'PGRST204') return false;
    if (!(error.message ?? '').includes('effect_tiles')) return false;
    console.warn(
      'Spalte decks.effect_tiles fehlt noch - sql/deck-effekt-kacheln-2026-11-05.sql ausführen.',
    );
    this.tilesAvailable.set(false);
    return true;
  }

  private readonly i18n = inject(I18nService);

  /**
   * Funktions-Kategorien (was eine Karte TUT) über Scryfalls Oracle-Tags (otag:). Getrennt von den
   * Keywords unten: Lifelink ist eine Eigenschaft, kein Effekt wie otag:lifegain.
   */
  // Gleiche Keys und Abfragen wie EFFECT_TAG_CATEGORIES, damit Filter und Kacheln einen Cache
  // teilen. query '' = lokale Quelle (tutor/extraturn/mld). Liste in card-effect-filters.ts.
  readonly effectFilters: readonly CardEffectFilter[] = ALL_EFFECT_FILTERS;

  effectFilterLabel(value: string): string {
    return this.i18n.t(`effectFilter.${value}`);
  }

  keywordFilterLabel(value: string): string {
    return this.i18n.t(`keywordFilter.${value}`);
  }

  /** Fähigkeits-Keywords (feste Eigenschaft der Karte, nicht Tagger-Tags, sondern echte Scryfall-Keyword-Abfragen). */
  readonly keywordFilters: { value: string; label: string }[] = [
    { value: 'lifelink', label: 'Lifelink' },
    { value: 'deathtouch', label: 'Deathtouch' },
    { value: 'flying', label: 'Flugfähigkeit' },
    { value: 'trample', label: 'Trample' },
    { value: 'vigilance', label: 'Wachsamkeit' },
    { value: 'haste', label: 'Eile' },
    { value: 'hexproof', label: 'Hexenschutz' },
    { value: 'indestructible', label: 'Unzerstörbar' },
    { value: 'menace', label: 'Bedrohlich' },
    { value: 'reach', label: 'Reichweite' },
    { value: 'first strike', label: 'Erstschlag' },
    { value: 'double strike', label: 'Doppelschlag' },
    { value: 'ward', label: 'Ward' },
    { value: 'flash', label: 'Blitzschnelle' },
    { value: 'defender', label: 'Verteidiger' },
  ];
}
