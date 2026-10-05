import { Component, computed, effect, inject, signal } from '@angular/core';
import { PercentPipe } from '@angular/common';
import { DeckViewerService } from '../deck-viewer.service';
import { GoldfishService } from '../goldfish.service';
import { ScryfallService } from '../scryfall.service';
import { CardPreviewService } from '../card-preview.service';
import { CardSuggestion, DeckSuggestionsService } from '../deck-suggestions.service';
import { DeckCheckService } from '../deck-check.service';
import {
  CheckItem,
  Influence,
  MDFC_TAPPED_WEIGHT,
  PLAY_STYLES,
  PlayStyle,
  WINCON_TARGET,
  groupWinCons,
  isWinningResult,
} from '../deck-check';
import { DeckPlayStyleService } from '../deck-play-style.service';
import { ManaSymbol } from '../ui/mana-symbol/mana-symbol';
import { Meter } from '../ui/meter/meter';
import { Icon } from '../ui/icon/icon';
import { InfoToggle } from '../ui/info-toggle/info-toggle';

/**
 * Deck-Check oben in der Deck-Analyse: Gesamtwert, Ampel je Kategorie mit Sollwert,
 * Farbquellen-Prüfung, Wahrscheinlichkeiten, Testhand und Empfehlungen aus eigenen Decks.
 * Liest alles aus der Deck-Ansicht (DeckViewerService), die Rechnung steckt in deck-check.ts.
 */
@Component({
  selector: 'app-deck-check',
  imports: [PercentPipe, ManaSymbol, Meter, Icon, InfoToggle],
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

  /** Rechnung und Zustand liegen im Service - die Beständigkeit braucht auch der Power-Wert. */
  readonly check = inject(DeckCheckService);
  readonly isCommanderFormat = this.check.isCommanderFormat;
  readonly librarySize = this.check.librarySize;
  readonly landInfo = this.check.landInfo;
  readonly cheapRampDraw = this.check.cheapRampDraw;
  readonly playStyles = this.check.playStyles;
  readonly playStylesSuggested = this.check.playStylesSuggested;
  readonly curve = this.check.curve;
  readonly items = this.check.items;
  readonly score = this.check.score;
  readonly recommendedLands60 = this.check.recommendedLands60;
  readonly colors = this.check.colors;
  readonly odds = this.check.odds;
  private readonly library = this.check.library;

  readonly effectsLoading = computed(() => this.viewer.effects.effectCategoryStats() === null);

  // --- Spielweise (decks.play_styles) ---

  private readonly playStyleService = inject(DeckPlayStyleService);
  readonly editingStyles = signal(false);
  readonly playStyleSaveAvailable = this.playStyleService.verfuegbar;

  constructor() {
    effect(() => {
      this.viewer.state.viewingDeck();
      this.editingStyles.set(false);
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

  toggleStyle(style: PlayStyle): Promise<void> {
    return this.check.toggleStyle(style);
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
