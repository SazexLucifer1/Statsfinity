import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { DeckViewerState } from './deck-viewer-state.service';
import { DeckAnalysisService } from './deck-analysis.service';
import { DeckEffectsService } from './deck-effects.service';
import { DeckPlayStyleService } from './deck-play-style.service';
import { regelFuer } from './deck-regeln';
import { isLand } from './deck-analyse';
import {
  CheckItem,
  PlayStyle,
  colorRequirements,
  consistencyParts,
  consistencyScore,
  curveStyle,
  deckCheckItems,
  deckHealthScore,
  deckOdds,
  effectiveLands,
  recommendedLands60,
} from './deck-check';

/**
 * Zustand des Deck-Checks für das geöffnete Deck. Ein Service statt Komponenten-Zustand, weil die
 * Beständigkeit auch in den Power-Wert fließt (DeckBracketService) - und der steht oben im Deck,
 * auch wenn die Analyse mit dem Deck-Check zugeklappt ist.
 *
 * Abhängigkeiten nur Richtung State/Analysis/Effects, nie zur Fassade DeckViewerService.
 */
@Injectable({ providedIn: 'root' })
export class DeckCheckService {
  private readonly state = inject(DeckViewerState);
  private readonly analysis = inject(DeckAnalysisService);
  private readonly effects = inject(DeckEffectsService);
  private readonly playStyleService = inject(DeckPlayStyleService);

  private readonly regel = computed(() => regelFuer(this.state.viewingDeck()?.format));
  /** 99-Karten-Formate (Commander, PDH, Historic Brawl) - die Karsten-Zahlen gelten je Deckgröße. */
  readonly isCommanderFormat = computed(() => this.regel()?.min === 100);

  readonly library = computed(() =>
    this.analysis.analysisDeckCards().filter((c) => !c.isCommander),
  );
  readonly librarySize = computed(() => this.library().reduce((s, c) => s + c.quantity, 0));

  private effectCount(key: string): number | null {
    const stats = this.effects.effectCategoryStats();
    if (!stats) return null;
    return stats.find((s) => s.key === key)?.count ?? 0;
  }

  /**
   * Länder voll, doppelseitige Karten mit Land-Rückseite voll, wenn das Land ungetappt kommen
   * kann, sonst 0,38 (Rückseiten-Text aus den Kartendaten).
   */
  readonly landInfo = computed(() => {
    const details = this.state.viewingCardDetails();
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
    const stats = this.effects.effectCategoryStats();
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

  readonly playStyles = signal<PlayStyle[]>([]);
  /** true = aus dem Archetyp des Decks vorgeschlagen, noch nicht vom Besitzer bestätigt. */
  readonly playStylesSuggested = signal(false);
  /** false, bis die gespeicherte Spielweise geladen ist - so lange wartet der Power-Wert. */
  readonly playStylesLoaded = signal(false);
  readonly curve = computed(() => curveStyle(this.analysis.averageCmc()));

  constructor() {
    effect(() => {
      const deck = this.state.viewingDeck();
      this.playStyles.set([]);
      this.playStylesSuggested.set(false);
      this.playStylesLoaded.set(false);
      if (!deck) return;
      this.playStyleService.load(deck.id).then((styles) => {
        if (this.state.viewingDeck()?.id !== deck.id) return;
        if (styles) {
          this.playStyles.set(styles);
        } else {
          // Noch nie festgelegt: aus dem Archetyp des Decks vorschlagen, soweit er passt.
          const fromTag = (['control', 'combo', 'landfall'] as const).find(
            (s) => s === deck.edhrecTag,
          );
          if (fromTag) {
            this.playStyles.set([fromTag]);
            this.playStylesSuggested.set(true);
          }
        }
        this.playStylesLoaded.set(true);
      });
    });
  }

  async toggleStyle(style: PlayStyle): Promise<void> {
    const next = this.playStyles().includes(style)
      ? this.playStyles().filter((s) => s !== style)
      : [...this.playStyles(), style];
    this.playStyles.set(next);
    this.playStylesSuggested.set(false);
    const deck = this.state.viewingDeck();
    if (deck && this.state.canEditViewingDeck()) await this.playStyleService.save(deck.id, next);
  }

  // --- Ampel, Farbquellen, Wahrscheinlichkeiten ---

  readonly checkInput = computed(() => ({
    isCommanderFormat: this.isCommanderFormat(),
    lands: this.landInfo().value,
    cheapRampDraw: this.cheapRampDraw(),
    playStyles: this.playStyles(),
    averageCmc: this.analysis.averageCmc(),
    ramp: this.effectCount('ramp'),
    draw: this.effectCount('draw'),
    removal: this.effectCount('removal'),
    boardwipe: this.effectCount('boardwipe'),
  }));

  readonly items = computed<CheckItem[]>(() => deckCheckItems(this.checkInput()));
  readonly score = computed(() => deckHealthScore(this.items()));
  /** Nur 60-Karten-Formate: Länder nach Karsten. */
  readonly recommendedLands60 = computed(() =>
    recommendedLands60(this.analysis.averageCmc(), this.cheapRampDraw()),
  );

  readonly colors = computed(() => {
    const details = this.state.viewingCardDetails();
    const cards = this.library()
      .filter((c) => !isLand(c.typeLine))
      .map((c) => ({
        name: c.cardName,
        cmc: c.cmc,
        manaCost: details.get(c.cardName.toLowerCase())?.manaCost,
      }));
    const sources: Record<string, number> = {};
    for (const s of this.analysis.manaSourceDistribution()) sources[s.color] = s.count;
    return colorRequirements(cards, sources, this.isCommanderFormat());
  });

  readonly odds = computed(() => {
    const size = this.librarySize();
    if (size < 40) return null;
    const input = this.checkInput();
    // Wahrscheinlichkeiten brauchen ganze Karten - anteilige Länder abrunden.
    return deckOdds(size, Math.floor(input.lands), input.ramp, input.draw);
  });

  // --- Beständigkeit: Teil des Power-Werts (combinedTuning() in bracket.ts) ---

  readonly consistencyParts = computed(() => {
    const input = this.checkInput();
    return consistencyParts({
      librarySize: this.librarySize(),
      lands: input.lands,
      ramp: input.ramp,
      draw: input.draw,
      colors: this.colors(),
      healthScore: this.score(),
    });
  });

  readonly consistency = computed(() => consistencyScore(this.consistencyParts()));

  /**
   * true, sobald alles da ist, was die Beständigkeit braucht (Wirkungs-Kategorien, Spielweise).
   * Bis dahin hält DeckBracketService die Einstufung zurück - sonst sprängen Power-Wert und
   * gespeichertes Bracket, sobald die Kategorien nachgeladen sind.
   */
  readonly consistencyReady = computed(
    () => !this.effects.effectCategoryCountsBusy() && this.playStylesLoaded(),
  );
}
