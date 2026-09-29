import { Injectable, computed, inject, signal } from '@angular/core';
import { I18nService } from './i18n.service';
import { Deck, DeckCard } from './deck.service';
import { ScryfallService } from './scryfall.service';
import { CardDataService } from './card-data.service';
import { normalizeCardName, sleep } from './array-utils';
import type { GameChangerEntry, EffectCategoryStat } from './deck-viewer.service';
import { DeckAnalysisService } from './deck-analysis.service';

/**
 * Effekt-Kategorien der Deck-Analyse (Entfernung, Rampe, ...): zuerst aus dem eigenen Kartenbestand, Scryfall nur für unbekannte Karten.
 */
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
    this.effectCategoryCountsBusy.set(false);
    this.effectCategoryProgress.set(null);
    this.effectCategoryPopup.set(null);
  }

  private readonly i18n = inject(I18nService);

  /**
   * Funktions-Kategorien (was eine Karte TUT) über Scryfalls Oracle-Tags (otag:). Getrennt von den
   * Keywords unten: Lifelink ist eine Eigenschaft, kein Effekt wie otag:lifegain.
   */
  // Gleiche Keys und Abfragen wie EFFECT_TAG_CATEGORIES, damit Filter und Kacheln einen Cache
  // teilen. query '' = lokale Quelle (LOCAL_EFFECT_FILTERS).
  readonly effectFilters: { value: string; label: string; query: string }[] = [
    { value: 'tokens', label: 'Marken erzeugen', query: 'o:create o:token' },
    { value: 'draw', label: 'Kartenziehen', query: 'otag:draw' },
    { value: 'removal', label: 'Entfernung', query: 'otag:removal' },
    {
      value: 'counterspell',
      label: 'Konter',
      query: 'otag:counterspell',
    },
    { value: 'boardwipe', label: 'Bretträumung', query: 'otag:board-wipe' },
    {
      value: 'ramp',
      label: 'Rampe',
      query: 'otag:ramp -t:land',
    },
    { value: 'lifegain', label: 'Lebenspunkte gewinnen', query: 'otag:lifegain' },
    { value: 'counters', label: '+1/+1-Zähler', query: 'o:"+1/+1 counter"' },
    { value: 'proliferate', label: 'Proliferate', query: 'keyword:proliferate' },
    { value: 'protection', label: 'Schutz gewähren', query: 'otag:protection' },
    {
      value: 'reanimate',
      label: 'Wiederbelebung',
      query: 'otag:reanimate',
    },
    { value: 'recursion', label: 'Rekursion', query: 'otag:recursion' },
    { value: 'mill', label: 'Mahlen (Mill)', query: 'otag:mill' },
    { value: 'tutor', label: 'Tutor', query: '' },
    { value: 'sacrifice', label: 'Opfern', query: 'otag:sacrifice-outlet' },
    { value: 'extraturn', label: 'Extra-Runde', query: '' },
    { value: 'extracombat', label: 'Extra-Kampfphase', query: 'otag:extra-combat' },
    { value: 'mld', label: 'Mass Land Denial', query: '' },
  ];

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
