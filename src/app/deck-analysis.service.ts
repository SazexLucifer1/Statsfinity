import { Injectable, computed, inject, signal } from '@angular/core';
import { Deck, DeckCard } from './deck.service';
import { ScryfallService } from './scryfall.service';
import { CardDataService, SpellbookCardFlags, SpellbookTwoCardCombo } from './card-data.service';
import { BracketCard, presentCombos } from './bracket';
import { comboSteps } from './combo-finder';
import {
  CommanderSpellbookService,
  BracketEstimate,
  SPELLBOOK_BRACKET_LABELS,
} from './commander-spellbook.service';
import { normalizeCardName } from './array-utils';
import { I18nService } from './i18n.service';
import { BarChartDatum } from './ui/bar-chart/bar-chart';
import { manaCurveChartData, pipChartData, typeChartData } from './ui/bar-chart/deck-chart-data';
import {
  AnalyseKarte,
  ManaCurveBucket,
  PipCount,
  TypeBreakdownEntry,
  averageCmc,
  isLand,
  landCount,
  manaCurve,
  nonBasicLandPercent,
  pipDistribution,
  typeBreakdown,
} from './deck-analyse';
import type { GameChangerEntry, AnalysisCombo, ManaSourceCount } from './deck-viewer.service';
import { DeckViewerState } from './deck-viewer-state.service';

/**
 * Deck-Analyse der Detailansicht: Kennzahlen, Diagramme, Manaquellen, Game Changer, Tutoren, Spellbook-Markierungen, Combos und Kartenpreis.
 */
@Injectable({ providedIn: 'root' })
export class DeckAnalysisService {
  private readonly cardData = inject(CardDataService);
  private readonly commanderSpellbook = inject(CommanderSpellbookService);
  readonly i18n = inject(I18nService);
  private readonly scryfall = inject(ScryfallService);
  private readonly state = inject(DeckViewerState);

  readonly analysisBusy = signal(false);

  /** Gespeicherte Deck-Karten ohne Maybeboard/Marken - Basis für sämtliche Deck-Analysen (Kurve, Pips, Game-Changer, Tutoren, Bracket-Schätzung). */
  readonly analysisDeckCards = computed(() =>
    this.state.viewingDeckCards().filter((c) => !c.isMaybeboard && !c.isToken),
  );

  /** Nicht-Land-Karten - Basis für Manakurve, Pip-Verteilung und Game-Changer-Auswertung. */
  private readonly nonLandCards = computed(() =>
    this.analysisDeckCards().filter((c) => !isLand(c.typeLine)),
  );

  /** Analyse-Karten samt Manakosten aus den Scryfall-Zusatzdaten (siehe deck-analyse.ts). */
  private readonly analyseKarten = computed<AnalyseKarte[]>(() => {
    const details = this.state.viewingCardDetails();
    return this.analysisDeckCards().map((c) => ({
      quantity: c.quantity,
      cmc: c.cmc,
      typeLine: c.typeLine,
      manaCost: details.get(c.cardName.toLowerCase())?.manaCost,
    }));
  });

  readonly manaCurve = computed<ManaCurveBucket[]>(() => manaCurve(this.analyseKarten()));
  readonly averageCmc = computed<number | null>(() => averageCmc(this.analyseKarten()));

  /** Land-Karten (inkl. Basisländer) - Basis für Landzahl und Nichtbasis-Land-Anteil. */
  private readonly landCards = computed(() =>
    this.analysisDeckCards().filter((c) => isLand(c.typeLine)),
  );

  readonly landCount = computed(() => landCount(this.analyseKarten()));
  readonly nonBasicLandPercent = computed<number | null>(() =>
    nonBasicLandPercent(this.analyseKarten()),
  );

  // Bedingungslos getappt = "enters tapped" ohne Ausweg. Die Ausnahme trennt Schock-, Check-, Slow-
  // und Fastlands ab ("unless ...", "you may pay"). Die alte Formel "enters the battlefield tapped"
  // ist mit abgedeckt.
  private static readonly ENTERS_TAPPED_RE = /enters (?:the battlefield )?tapped/i;
  private static readonly TAPPED_AUSNAHME_RE = /unless|you may pay/i;

  /**
   * Anteil nicht bedingungslos getappter Länder (0-100), null ohne Länder - das Tempo-Maß der
   * Manabasis (Precons liegen bei 70-80 %).
   */
  readonly untappedLandPercent = computed<number | null>(() => {
    const lands = this.landCards();
    const total = lands.reduce((sum, c) => sum + c.quantity, 0);
    if (total === 0) return null;
    const details = this.state.viewingCardDetails();
    const getappt = lands
      .filter((c) => {
        const text = details.get(c.cardName.toLowerCase())?.oracleText ?? '';
        return (
          DeckAnalysisService.ENTERS_TAPPED_RE.test(text) &&
          !DeckAnalysisService.TAPPED_AUSNAHME_RE.test(text)
        );
      })
      .reduce((sum, c) => sum + c.quantity, 0);
    return Math.round(((total - getappt) / total) * 100);
  });

  readonly typeBreakdown = computed<TypeBreakdownEntry[]>(() =>
    typeBreakdown(this.analyseKarten(), this.i18n),
  );

  /** Gesamtpreis (USD, billigste Druckvariante je Karte) - null solange noch nicht geladen. */
  readonly totalDeckPrice = signal<number | null>(null);
  readonly priceBusy = signal(false);
  /**
   * Mindestens eine Preisabfrage scheiterte, die Summe ist also eine Untergrenze ("ab X €"). Karten
   * ganz ohne Preis setzen das nicht.
   */
  readonly deckPriceIncomplete = signal(false);

  // --- Diagramm-Reihen für <app-bar-chart> (Abbildung in ui/bar-chart/deck-chart-data.ts) ---
  readonly manaCurveChart = computed<BarChartDatum[]>(() => manaCurveChartData(this.manaCurve()));
  readonly pipDistributionChart = computed<BarChartDatum[]>(() =>
    pipChartData(this.pipDistribution()),
  );
  readonly typeBreakdownChart = computed<BarChartDatum[]>(() =>
    typeChartData(this.typeBreakdown()),
  );
  // Dieselbe Abbildung wie bei den Pips: gleiche Farben, gleiche Symbole, nur eine andere
  // Zählweise dahinter - deshalb bewusst pipChartData() statt einer zweiten, identischen Funktion.
  readonly manaSourceChart = computed<BarChartDatum[]>(() =>
    pipChartData(this.manaSourceDistribution()),
  );

  readonly pipDistribution = computed<PipCount[]>(() =>
    pipDistribution(this.analyseKarten(), this.i18n),
  );

  private static readonly MANA_SOURCE_COLORS: ManaSourceCount['color'][] = [
    'W',
    'U',
    'B',
    'R',
    'G',
    'C',
  ];

  /** Karten (inkl. Länder), die laut Scryfall überhaupt Mana erzeugen können - Basis der Manaquellen-Auswertung. */
  private readonly manaSourceCards = computed(() => {
    const details = this.state.viewingCardDetails();
    return this.analysisDeckCards().filter(
      (c) => (details.get(c.cardName.toLowerCase())?.producedMana?.length ?? 0) > 0,
    );
  });

  /**
   * Gegenstück zur Pip-Verteilung: welche Farben das Deck ERZEUGT (Scryfalls produced_mana).
   * Gezählt werden Karten, eine mehrfarbige Quelle zählt bei jeder Farbe.
   */
  readonly manaSourceDistribution = computed<ManaSourceCount[]>(() => {
    const details = this.state.viewingCardDetails();
    const counts: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    for (const card of this.manaSourceCards()) {
      const produced = details.get(card.cardName.toLowerCase())?.producedMana ?? [];
      for (const color of new Set(produced)) {
        if (color in counts) counts[color] += card.quantity;
      }
    }
    return DeckAnalysisService.MANA_SOURCE_COLORS.map((color) => ({
      color,
      label: this.i18n.t(`pip.${color}`),
      count: counts[color],
    }));
  });

  /** Anzahl aller Manaquellen im Deck (Karten, nicht Farben - jede Karte genau einmal). */
  readonly manaSourceCount = computed(() =>
    this.manaSourceCards().reduce((sum, c) => sum + c.quantity, 0),
  );

  /** Manaquellen, die keine Länder sind (Manasteine, Manadorks, Verzauberungen). */
  readonly nonLandManaSourceCount = computed(() =>
    this.manaSourceCards()
      .filter((c) => !(c.typeLine ?? '').includes('Land'))
      .reduce((sum, c) => sum + c.quantity, 0),
  );

  readonly gameChangerCards = computed<GameChangerEntry[]>(() => {
    const details = this.state.viewingCardDetails();
    return this.analysisDeckCards()
      .filter((c) => details.get(c.cardName.toLowerCase())?.gameChanger === true)
      .map((c) => ({ cardName: c.cardName, quantity: c.quantity }));
  });

  readonly gameChangerCount = computed(() =>
    this.gameChangerCards().reduce((sum, c) => sum + c.quantity, 0),
  );

  /**
   * Grobe Einordnung nur nach den Game-Changer-Grenzen (B1-2: keine, B3: bis 3, B4-5: beliebig) -
   * ein Richtwert, keine Einstufung.
   */
  readonly estimatedBracketHint = computed(() => {
    const count = this.gameChangerCount();
    if (count === 0) return this.i18n.t('deckViewer.bracketHint13');
    if (count <= 3) return this.i18n.t('deckViewer.bracketHintMin3');
    return this.i18n.t('deckViewer.bracketHint45');
  });

  /**
   * Kuratierte Spellbook-Markierungen (MLD, Extra-Turns, Tutoren) aus dem Nachtlauf; leer ohne
   * Migration oder vor dem ersten Lauf.
   */
  readonly spellbookCardFlags = signal<Map<string, SpellbookCardFlags>>(new Map());

  /** Rückfall-Texterkennung für Tutoren, solange spellbookCardFlags() leer ist. */
  private static readonly TUTOR_RE =
    /search(?:es)?\s+(?:your|a|their|that player'?s)\s+library\s+for/i;
  // Auch Karten, die Basisland-Arten beim Namen nennen (Farseek, Landcycling).
  private static readonly LAND_TUTOR_RE =
    /search(?:es)?\s+(?:your|a|their|that player'?s)\s+library\s+for\s+(?:up to \w+\s+)?(?:an?|the|\d+)?\s*(?:[a-z]+\s+){0,2}(?:lands?|plains|islands?|swamps?|mountains?|forests?)\b/i;

  /**
   * Tutoren außer für Länder (wie das offizielle Kriterium), aus Spellbooks kuratierter Liste; ohne
   * Liste die Textnäherung.
   */
  readonly tutorCards = computed<GameChangerEntry[]>(() => {
    const flags = this.spellbookCardFlags();
    if (flags.size > 0) {
      return this.analysisDeckCards()
        .filter((c) => flags.get(this.cardData.spellbookKey(c.cardName))?.tutor === true)
        .map((c) => ({ cardName: c.cardName, quantity: c.quantity }));
    }

    const details = this.state.viewingCardDetails();
    return this.analysisDeckCards()
      .filter((c) => {
        const text = details.get(c.cardName.toLowerCase())?.oracleText ?? '';
        return (
          DeckAnalysisService.TUTOR_RE.test(text) && !DeckAnalysisService.LAND_TUTOR_RE.test(text)
        );
      })
      .map((c) => ({ cardName: c.cardName, quantity: c.quantity }));
  });

  /**
   * MLD, Extra-Turns und Combos von Spellbooks Bracket-API (über unseren Proxy). null bei Fehler,
   * z. B. lokal ohne Pages Functions - der Rest der Analyse bleibt.
   */
  readonly bracketEstimate = signal<BracketEstimate | null>(null);
  readonly bracketEstimateBusy = signal(false);
  readonly bracketEstimateFailed = signal(false);
  readonly bracketEstimateErrorDetail = signal<string | null>(null);

  /**
   * MLD und Extra-Turns aus der gespiegelten Liste (ohne Netzwerk); vor dem ersten Nachtlauf die
   * Live-Auswertung als Rückfall.
   */
  private cardsWithFlag(
    waehle: (f: SpellbookCardFlags) => boolean,
    ausEstimate: (c: { massLandDenial: boolean; extraTurn: boolean }) => boolean,
  ): GameChangerEntry[] {
    const flags = this.spellbookCardFlags();
    if (flags.size > 0) {
      return this.analysisDeckCards()
        .filter((c) => {
          const f = flags.get(this.cardData.spellbookKey(c.cardName));
          return f ? waehle(f) : false;
        })
        .map((c) => ({ cardName: c.cardName, quantity: c.quantity }));
    }
    return (this.bracketEstimate()?.cards ?? [])
      .filter(ausEstimate)
      .map((c) => ({ cardName: c.cardName, quantity: c.quantity }));
  }

  readonly massLandDenialCards = computed<GameChangerEntry[]>(() =>
    this.cardsWithFlag(
      (f) => f.massLandDenial,
      (c) => c.massLandDenial,
    ),
  );

  readonly extraTurnCards = computed<GameChangerEntry[]>(() =>
    this.cardsWithFlag(
      (f) => f.extraTurn,
      (c) => c.extraTurn,
    ),
  );

  /**
   * Zwei-Karten-Combos aus der gespiegelten Tabelle, gefiltert aufs Deck - Grundlage der Einstufung
   * (analysisCombos bevorzugt für die Anzeige die Live-Daten).
   */
  readonly spellbookCombos = signal<SpellbookTwoCardCombo[]>([]);
  /** Spielbeendende Combos, vollständig im Deck (Urteil F), 0 solange nicht geladen. */
  readonly winningCombos = signal(0);

  /**
   * Alle Combos des Decks für die Anzeige: bevorzugt live (kennt Ergebnis und Ablauf), sonst
   * Nachtlauf. Aufgeteilt nach Anzahl der Karten, nicht nach Spellbooks Zwei-Karten-Kennzeichen
   * (das zählt den Commander nicht mit).
   */
  readonly analysisCombos = computed<AnalysisCombo[]>(() => {
    const live = this.bracketEstimate()?.combos ?? [];
    if (live.length > 0) {
      return live.map((c) => ({
        id: c.cardNames.join('+'),
        cardNames: c.cardNames,
        produces: c.produces,
        steps: comboSteps(c.description),
        extraMana: null,
        bracketLabel: null,
      }));
    }

    return this.localTwoCardCombos().map((c) => ({
      id: c.combo.id,
      cardNames: c.cards.map((card) => card.name),
      produces: [],
      steps: [],
      extraMana: c.combo.manaValueNeeded,
      bracketLabel: c.combo.bracketTag ? SPELLBOOK_BRACKET_LABELS[c.combo.bracketTag] : null,
    }));
  });

  /** Combos aus genau zwei Karten - die, die das offizielle Kriterium meint. */
  readonly twoCardComboList = computed(() =>
    this.analysisCombos().filter((c) => c.cardNames.length <= 2),
  );

  /** Alle übrigen Combos: drei oder mehr beteiligte Karten. */
  readonly moreCardComboList = computed(() =>
    this.analysisCombos().filter((c) => c.cardNames.length > 2),
  );

  /** Welche Combo-Liste das Fenster zeigt, null = zu. */
  readonly comboPopupKind = signal<'two' | 'more' | null>(null);

  readonly comboPopupCombos = computed(() =>
    this.comboPopupKind() === 'more' ? this.moreCardComboList() : this.twoCardComboList(),
  );

  openComboPopup(kind: 'two' | 'more'): void {
    this.comboPopupKind.set(kind);
  }

  closeComboPopup(): void {
    this.comboPopupKind.set(null);
  }

  /** Deckkarten in der Form der Bracket-Rechnung (auch für Combo-Liste und Combo-Finder gebraucht). */
  readonly bracketCards = computed<BracketCard[]>(() => {
    const details = this.state.viewingCardDetails();
    if (details.size === 0) return [];

    return this.analysisDeckCards().map((c) => {
      const detail = details.get(c.cardName.toLowerCase());
      return {
        name: c.cardName,
        key: this.cardData.spellbookKey(c.cardName),
        quantity: c.quantity,
        cmc: detail?.cmc ?? c.cmc ?? 0,
        gameChanger: detail?.gameChanger === true,
        isCommander: c.isCommander,
      };
    });
  });

  /**
   * Vollständig vorhandene Zwei-Karten-Combos aus dem Nachtlauf - Anzeige-Rückfall, wenn Spellbook
   * nicht erreichbar ist.
   */
  readonly localTwoCardCombos = computed(() =>
    presentCombos(this.bracketCards(), this.spellbookCombos(), this.spellbookCardFlags()),
  );

  /** Laufender/abgeschlossener Preisabruf dieser Deck-Öffnung - siehe ensureCardPricesLoaded(). */
  private pricePromise: Promise<void> | null = null;

  /** Preise neu abrufen, auch wenn sie für diese Öffnung schon geladen wurden. */
  reloadCardPrices(cards: DeckCard[]): Promise<void> {
    this.pricePromise = null;
    return this.ensureCardPricesLoaded(cards);
  }

  /** Preisabruf höchstens einmal je Öffnung (gebraucht für Bracket und Analyse-Anzeige). */
  ensureCardPricesLoaded(cards: DeckCard[]): Promise<void> {
    this.pricePromise ??= this.loadCardPrices(cards);
    return this.pricePromise;
  }

  /** Lädt den Gesamtpreis (billigste Druckvariante je Karte, siehe ScryfallService.cheapestPrices()) nach. */
  private async loadCardPrices(cards: DeckCard[]): Promise<void> {
    this.priceBusy.set(true);
    const realCards = cards.filter((c) => !c.isMaybeboard && !c.isToken);
    const names = [...new Set(realCards.map((c) => c.cardName))];
    const { prices, incomplete } = await this.scryfall.cheapestPrices(names);
    let total = 0;
    for (const card of realCards) {
      const price = prices.get(normalizeCardName(card.cardName.split(' // ')[0].trim()));
      if (price != null) total += price * card.quantity;
    }
    this.totalDeckPrice.set(total);
    this.deckPriceIncomplete.set(incomplete);
    this.priceBusy.set(false);
  }

  /** Lädt Mass-Land-Denial/Extra-Turn/Combo-Auswertung von Commander Spellbook nach (siehe bracketEstimate). */
  async loadBracketEstimate(cards: DeckCard[]): Promise<void> {
    this.bracketEstimateBusy.set(true);
    const real = cards.filter((c) => !c.isMaybeboard && !c.isToken);
    const commanders = real
      .filter((c) => c.isCommander)
      .map((c) => ({ card: c.cardName, quantity: c.quantity }));
    const main = real
      .filter((c) => !c.isCommander)
      .map((c) => ({ card: c.cardName, quantity: c.quantity }));

    const { estimate, errorDetail } = await this.commanderSpellbook.estimateBracket(
      commanders,
      main,
    );
    this.bracketEstimate.set(estimate);
    this.bracketEstimateFailed.set(estimate === null);
    this.bracketEstimateErrorDetail.set(errorDetail);
    this.bracketEstimateBusy.set(false);
  }

  /** Zustand eines geöffneten Decks verwerfen (neues Deck oder Schließen). */
  reset(): void {
    this.spellbookCombos.set([]);
    this.winningCombos.set(0);
    this.bracketEstimate.set(null);
    this.bracketEstimateBusy.set(false);
    this.bracketEstimateFailed.set(false);
    this.bracketEstimateErrorDetail.set(null);
    this.totalDeckPrice.set(null);
    this.deckPriceIncomplete.set(false);
    this.priceBusy.set(false);
    this.pricePromise = null;
  }
}
