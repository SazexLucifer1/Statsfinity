import { Component, computed, effect, inject, signal } from '@angular/core';
import { PercentPipe } from '@angular/common';
import { DeckViewerService } from '../deck-viewer.service';
import { GoldfishService } from '../goldfish.service';
import { ScryfallService } from '../scryfall.service';
import { CardPreviewService } from '../card-preview.service';
import { CardSuggestion, DeckSuggestionsService } from '../deck-suggestions.service';
import { regelFuer } from '../deck-regeln';
import { isLand } from '../deck-analyse';
import {
  CheckItem,
  Influence,
  MDFC_TAPPED_WEIGHT,
  PLAY_STYLES,
  PlayStyle,
  WINCON_TARGET,
  curveStyle,
  effectiveLands,
  colorRequirements,
  deckCheckItems,
  deckHealthScore,
  deckOdds,
  groupWinCons,
  isWinningResult,
  recommendedLands60,
} from '../deck-check';
import { DeckPlayStyleService } from '../deck-play-style.service';
import { ManaSymbol } from '../ui/mana-symbol/mana-symbol';
import { Meter } from '../ui/meter/meter';
import { Icon } from '../ui/icon/icon';

/**
 * Deck-Check oben in der Deck-Analyse: Gesamtwert, Ampel je Kategorie mit Sollwert,
 * Farbquellen-Prüfung, Wahrscheinlichkeiten, Testhand und Empfehlungen aus eigenen Decks.
 * Liest alles aus der Deck-Ansicht (DeckViewerService), die Rechnung steckt in deck-check.ts.
 */
@Component({
  selector: 'app-deck-check',
  imports: [PercentPipe, ManaSymbol, Meter, Icon],
  templateUrl: './deck-check.html',
  styleUrl: './deck-check.scss',
})
export class DeckCheck {
  readonly viewer = inject(DeckViewerService);
  private readonly goldfish = inject(GoldfishService);
  private readonly scryfall = inject(ScryfallService);
  private readonly cardPreview = inject(CardPreviewService);
  readonly suggestionsService = inject(DeckSuggestionsService);
  readonly i18n = this.viewer.i18n;

  /**
   * Quellen der Richtwerte - wer "Frank Karsten" liest, soll nachsehen können, wer das ist und
   * woher die Zahl kommt. Niederländischer Magic-Profi (Hall of Fame) und Mathematiker; seine
   * Artikel zu Länderzahl und Farbquellen sind in der Community der Standard.
   */
  readonly MDFC_TAPPED_WEIGHT = MDFC_TAPPED_WEIGHT;
  readonly WINCON_TARGET = WINCON_TARGET;
  readonly PLAY_STYLES = PLAY_STYLES;
  readonly karstenWiki =
    'https://en.wikipedia.org/wiki/Frank_Karsten_(Magic:_The_Gathering_player)';
  readonly karstenLands =
    'https://www.tcgplayer.com/content/article/How-Many-Lands-Do-You-Need-in-Your-Deck-An-Updated-Analysis/cd1c1a24-d439-4a8e-b369-b936edb0b38a/';

  private readonly regel = computed(() => regelFuer(this.viewer.state.viewingDeck()?.format));
  /** 99-Karten-Formate (Commander, PDH, Historic Brawl) - die Karsten-Zahlen gelten je Deckgröße. */
  readonly isCommanderFormat = computed(() => this.regel()?.min === 100);

  private readonly library = computed(() =>
    this.viewer.analysis.analysisDeckCards().filter((c) => !c.isCommander),
  );
  readonly librarySize = computed(() => this.library().reduce((s, c) => s + c.quantity, 0));

  private effectCount(key: string): number | null {
    const stats = this.viewer.effects.effectCategoryStats();
    if (!stats) return null;
    return stats.find((s) => s.key === key)?.count ?? 0;
  }

  readonly effectsLoading = computed(() => this.viewer.effects.effectCategoryStats() === null);

  /**
   * Länder voll, doppelseitige Karten mit Land-Rückseite voll, wenn das Land ungetappt kommen
   * kann, sonst 0,38 (Rückseiten-Text aus den Kartendaten).
   */
  readonly landInfo = computed(() => {
    const details = this.viewer.state.viewingCardDetails();
    return effectiveLands(
      this.library().map((c) => ({
        typeLine: c.typeLine,
        quantity: c.quantity,
        backOracleText: details.get(c.cardName.toLowerCase())?.backOracleText,
      })),
    );
  });

  /**
   * Rampe- und Draw-Karten mit Manawert ≤ 2, jede Karte einmal (eine Karte kann in beiden
   * Kategorien stehen). null, solange die Kategorien noch laden.
   */
  readonly cheapRampDraw = computed<number | null>(() => {
    const stats = this.viewer.effects.effectCategoryStats();
    if (!stats) return null;
    const names = new Set(
      stats
        .filter((s) => s.key === 'ramp' || s.key === 'draw')
        .flatMap((s) => s.cards.map((c) => c.cardName)),
    );
    return this.library()
      .filter((c) => names.has(c.cardName) && c.cmc <= 2)
      .reduce((sum, c) => sum + c.quantity, 0);
  });

  // --- Spielweise (decks.play_styles) ---

  private readonly playStyleService = inject(DeckPlayStyleService);
  readonly playStyles = signal<PlayStyle[]>([]);
  /** true = aus dem Archetyp des Decks vorgeschlagen, noch nicht vom Besitzer bestätigt. */
  readonly playStylesSuggested = signal(false);
  readonly editingStyles = signal(false);
  readonly playStyleSaveAvailable = this.playStyleService.verfuegbar;
  readonly curve = computed(() => curveStyle(this.viewer.analysis.averageCmc()));

  constructor() {
    effect(() => {
      const deck = this.viewer.state.viewingDeck();
      this.playStyles.set([]);
      this.playStylesSuggested.set(false);
      this.editingStyles.set(false);
      if (!deck) return;
      this.playStyleService.load(deck.id).then((styles) => {
        if (this.viewer.state.viewingDeck()?.id !== deck.id) return;
        if (styles) {
          this.playStyles.set(styles);
          return;
        }
        // Noch nie festgelegt: aus dem Archetyp des Decks vorschlagen, soweit er passt.
        const fromTag = (['control', 'combo', 'landfall'] as const).find(
          (s) => s === deck.edhrecTag,
        );
        if (fromTag) {
          this.playStyles.set([fromTag]);
          this.playStylesSuggested.set(true);
        }
      });
    });
    effect(() => {
      const deck = this.viewer.state.viewingDeck();
      this.suggestions.set([]);
      this.suggestionsLoaded.set(false);
      if (!deck) return;
      this.suggestionsService.load(deck.id).then((list) => {
        if (this.viewer.state.viewingDeck()?.id !== deck.id) return;
        this.suggestions.set(list);
        this.suggestionsLoaded.set(true);
      });
    });
  }

  async toggleStyle(style: PlayStyle): Promise<void> {
    const next = this.playStyles().includes(style)
      ? this.playStyles().filter((s) => s !== style)
      : [...this.playStyles(), style];
    this.playStyles.set(next);
    this.playStylesSuggested.set(false);
    const deck = this.viewer.state.viewingDeck();
    if (deck && this.viewer.state.canEditViewingDeck())
      await this.playStyleService.save(deck.id, next);
  }

  influenceLabel(i: Influence): string {
    return this.i18n.t('deckView.style.' + i);
  }

  /** "Control: eher mehr" bzw. "Aggro, niedrige Kurve: eher weniger". */
  influenceText(item: CheckItem): string {
    const parts: string[] = [];
    if (item.more.length)
      parts.push(
        this.i18n.t('deckView.check.styleMore', {
          styles: item.more.map((i) => this.influenceLabel(i)).join(', '),
        }),
      );
    if (item.fewer.length)
      parts.push(
        this.i18n.t('deckView.check.styleFewer', {
          styles: item.fewer.map((i) => this.influenceLabel(i)).join(', '),
        }),
      );
    return parts.join(' · ');
  }

  // --- Win Cons: Ziel aus der Tabelle, gefunden werden nur Combos aus Commander Spellbook ---

  readonly foundCombos = computed(() => this.viewer.analysis.analysisCombos());
  /** Spielbeendende Combos nach ihrem Ergebnis - nur, wenn Spellbook die Ergebnisse geliefert hat. */
  private readonly winningComboList = computed(() =>
    this.foundCombos().filter((c) => c.produces.some(isWinningResult)),
  );
  /** Varianten derselben Combo zählen als eine Win Con. */
  readonly winCons = computed(() => groupWinCons(this.winningComboList()));
  /**
   * Ohne Ergebnisse (Rückfall auf den Nachtlauf, Zwei-Karten-Combos ohne "produces") bleibt nur
   * die Zahl aus der Datenbank.
   */
  readonly winningComboCount = computed(() =>
    this.foundCombos().some((c) => c.produces.length > 0)
      ? this.winningComboList().length
      : this.viewer.analysis.winningCombos(),
  );

  // --- Downloads der Richtwerte-Tabelle (public/richtwerte/) ---
  readonly benchmarkFile = computed(() =>
    this.i18n.lang() === 'de'
      ? 'richtwerte/statsfinity-deckbau-richtwerte-de.xlsx'
      : 'richtwerte/statsfinity-deckbuilding-benchmarks-en.xlsx',
  );

  private readonly checkInput = computed(() => ({
    isCommanderFormat: this.isCommanderFormat(),
    lands: this.landInfo().value,
    cheapRampDraw: this.cheapRampDraw(),
    playStyles: this.playStyles(),
    averageCmc: this.viewer.analysis.averageCmc(),
    ramp: this.effectCount('ramp'),
    draw: this.effectCount('draw'),
    removal: this.effectCount('removal'),
    boardwipe: this.effectCount('boardwipe'),
  }));

  readonly items = computed<CheckItem[]>(() => deckCheckItems(this.checkInput()));
  readonly score = computed(() => deckHealthScore(this.items()));
  /** Nur 60-Karten-Formate: Länder nach Karsten. */
  readonly recommendedLands60 = computed(() =>
    recommendedLands60(this.viewer.analysis.averageCmc(), this.cheapRampDraw()),
  );

  readonly colors = computed(() => {
    const details = this.viewer.state.viewingCardDetails();
    const cards = this.library()
      .filter((c) => !isLand(c.typeLine))
      .map((c) => ({
        name: c.cardName,
        cmc: c.cmc,
        manaCost: details.get(c.cardName.toLowerCase())?.manaCost,
      }));
    const sources: Record<string, number> = {};
    for (const s of this.viewer.analysis.manaSourceDistribution()) sources[s.color] = s.count;
    return colorRequirements(cards, sources, this.isCommanderFormat());
  });

  /** Kartenbild je Name (klein geschrieben) aus der geladenen Deckliste. */
  private readonly imagesByName = computed(() => {
    const details = this.viewer.state.viewingCardDetails();
    const map = new Map<string, string>();
    for (const c of this.library()) {
      const key = c.cardName.toLowerCase();
      const url = c.imageUrl ?? details.get(key)?.imageUrl;
      if (url) map.set(key, url);
    }
    return map;
  });

  cardImage(name: string): string | null {
    return this.imagesByName().get(name.toLowerCase()) ?? null;
  }

  /** "Venat, Heart of Hydaelyn // Hydaelyn, …" -> nur die Vorderseite. */
  frontName(name: string): string {
    return name.split(' // ')[0];
  }

  /** "{1}{W}{W}" -> ["1", "W", "W"]; bei doppelseitigen Karten nur die Vorderseite. */
  costSymbols(cost: string): string[] {
    return [...cost.split(' // ')[0].matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  }

  readonly odds = computed(() => {
    const size = this.librarySize();
    if (size < 40) return null;
    const input = this.checkInput();
    // Wahrscheinlichkeiten brauchen ganze Karten - anteilige Länder abrunden.
    return deckOdds(size, Math.floor(input.lands), input.ramp, input.draw);
  });

  // --- Empfehlungen aus eigenen Decks ---
  readonly suggestions = signal<CardSuggestion[]>([]);
  readonly suggestionsLoaded = signal(false);

  /** Zahl in der App-Sprache ("36,4" bzw. "36.4"). */
  num(value: number, digits = 1): string {
    return value.toLocaleString(this.i18n.lang() === 'de' ? 'de-DE' : 'en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    });
  }

  itemLabel(item: CheckItem): string {
    return this.i18n.t(`deckView.check.${item.key}`);
  }

  levelLabel(level: string): string {
    return this.i18n.t(`deckView.check.level.${level}`);
  }

  /** Was zu tun ist, in einem Satz. */
  advice(item: CheckItem): string {
    if (item.level === 'good') return this.i18n.t('deckView.check.adviceOk');
    // Gemessen am Zielwert (Mitte der Spanne, verschoben durch die Spielweise).
    const diff = Math.abs(item.value - item.target);
    return this.i18n.t(
      item.value < item.target ? 'deckView.check.adviceMore' : 'deckView.check.adviceLess',
      // Mit anteiligen Ländern kann die Lücke gebrochen sein - ganze Karten aufrunden.
      { count: Math.ceil(diff) },
    );
  }

  openTestHand(): void {
    const deck = this.viewer.state.viewingDeck();
    if (deck) this.goldfish.open(deck);
  }

  async previewCard(name: string): Promise<void> {
    const card = await this.scryfall.findCard(name);
    if (card?.imageUrl) this.cardPreview.open(card.imageUrl, card.backImageUrl, card.name);
  }
}
