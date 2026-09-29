import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { DeckService, Deck, DeckCard, DeckChangeEntry, DeckGameStats } from './deck.service';
import { ScryfallService, ScryfallCard, ScryfallPrinting } from './scryfall.service';
import { CardDataService, SpellbookCardFlags, SpellbookTwoCardCombo } from './card-data.service';
import {
  AUTO_BRACKET_MAX,
  BracketAnalysis,
  BracketBenchmark,
  BracketCard,
  DEFAULT_BRACKET_BENCHMARK,
  PREIS_SCHWELLE_EUR,
  TUNING_BUMP_SCHWELLE,
  analyzeBracket,
  powerRange,
  presentCombos,
} from './bracket';
import {
  ManaPart,
  comboSteps,
  fitsColorIdentity,
  groupSuggestions,
  parseManaCost,
} from './combo-finder';
import { PdfSourceCard } from './deck-pdf.service';
import {
  CommanderSpellbookService,
  BracketEstimate,
  SPELLBOOK_BRACKET_LABELS,
} from './commander-spellbook.service';
import { EdhrecService, EdhrecCardlist, EdhrecTag } from './edhrec.service';
import { normalizeCardName, sleep } from './array-utils';
import { AuthService } from './auth.service';
import { GroupService } from './group.service';
import { MtgService } from './mtg.service';
import { ProfileService } from './profile.service';
import { I18nService } from './i18n.service';
import { DeckPrimerService } from './deck-primer.service';
import { DeckSteckbriefService } from './deck-steckbrief.service';
import { COMMANDER_ARCHETYPE_FILTERS } from './commander-archetype-filters';
import {
  ColorSelection,
  EMPTY_COLOR_SELECTION,
  FILTER_COLORS,
  matchesColorSelection,
} from './color-filter-match';
import type { SteckbriefDeckinfo, SteckbriefKarte } from './deck-steckbrief/deck-steckbrief';
import { BarChartDatum } from './ui/bar-chart/bar-chart';
import { manaCurveChartData, pipChartData, typeChartData } from './ui/bar-chart/deck-chart-data';
import {
  AnalyseKarte,
  ManaCurveBucket,
  PipCount,
  TypeBreakdownEntry,
  averageCmc,
  cmcBucket,
  groupByTypeSection,
  isLand,
  landCount,
  manaCurve,
  nonBasicLandPercent,
  parseSubtypes,
  pipDistribution,
  translateSectionLabel,
  typeBreakdown,
  typeSection,
} from './deck-analyse';
import { DeckFormat, DECK_FORMATS } from './models';

/** Wie viele Deckkarten Mana dieser Farbe erzeugen können (Manaquellen-Verteilung). */
export interface ManaSourceCount {
  color: 'W' | 'U' | 'B' | 'R' | 'G' | 'C';
  label: string;
  count: number;
}

export interface GameChangerEntry {
  cardName: string;
  quantity: number;
}

/**
 * Eine Combo im Combo-Fenster, aus Spellbook-Live-Auswertung oder Nachtlauf. produces/steps fehlen
 * beim Nachtlauf, extraMana/bracketLabel gibt es nur dort.
 */
export interface AnalysisCombo {
  id: string;
  cardNames: string[];
  produces: string[];
  /**
   * Ablauf als Schritte (siehe comboSteps), jeder in Manasymbole und Text zerlegt - die
   * Beschreibungen verweisen selbst auf Schrittnummern.
   */
  steps: ManaPart[][];
  extraMana: number | null;
  bracketLabel: string | null;
}

/** Eine Karte, die das Deck noch nicht hat und neue Combos ergäbe (Eintrag des Combo-Finders). */
export interface ComboFinderSuggestion {
  /** Normalisierter Vorderseiten-Name - Schlüssel gegen die Combo-Tabelle. */
  key: string;
  /** Anzeigename in Scryfall-Schreibweise, zugleich Schlüssel für Bild und Vorschau. */
  cardName: string;
  /** Wie viele Combos diese Karte insgesamt freischaltet - kann größer sein als combos.length. */
  comboCount: number;
  /** Die Combos selbst, beliebteste zuerst. */
  combos: ComboFinderCombo[];
}

/** Eine einzelne Combo, der genau diese eine Karte fehlt. */
export interface ComboFinderCombo {
  id: string;
  /** Schon vorhandene Combo-Karten als Anzeigenamen (für das Bildraster). */
  presentCardNames: string[];
  /** Was die Combo am Ende erzeugt ("Infinite mana", ...). Leer, wenn die Quelle nichts nennt. */
  produces: string[];
  /** Ablauf als Schritte in Manasymbolen und Text ("Ablauf anzeigen"). */
  steps: ManaPart[][];
  /** Zusätzlich nötiges Mana als Symbole (wie auf der Karte), leer wenn keins. */
  extraMana: ManaPart[];
}

export interface EffectCategoryStat {
  key: string;
  labelKey: string;
  count: number;
  cards: GameChangerEntry[];
}

interface PendingCardChange {
  cardName: string;
  quantity: number;
  imageUrl: string | null;
  typeLine: string | null;
  cmc: number;
  isCommander: boolean;
}

/**
 * Zustand der Deck-Detailansicht, global statt in DeckList: Die Ansicht wird root-level gerendert,
 * damit position:fixed nicht von einem Vorfahren mit backdrop-filter eingefangen wird.
 */
/**
 * Abstand, ab dem zwei Verlaufseinträge als getrennte Bearbeitungen gelten (siehe changeLogGroups).
 */
const CHANGE_GROUP_GAP_MS = 2 * 60 * 1000;

/** Eine einzelne Bearbeitung des Decks: die Verlaufseinträge eines Speichervorgangs. */
export interface DeckChangeGroup {
  changedAt: string;
  added: DeckChangeEntry[];
  removed: DeckChangeEntry[];
  /** Summe der Kartenanzahl (nicht der Zeilen), also "3 Karten rein" statt "2 Zeilen". */
  addedCount: number;
  removedCount: number;
}

/** Welches Einzelurteil im Bracket-Kasten seinen Rechenweg zeigt (je Urteil ein eigenes ⓘ). */
export type BracketMathTopic = 'rules' | 'spellbook' | 'tuning' | 'price' | 'power';

@Injectable({ providedIn: 'root' })
export class DeckViewerService {
  private readonly deckService = inject(DeckService);
  private readonly scryfall = inject(ScryfallService);
  private readonly cardData = inject(CardDataService);
  private readonly commanderSpellbook = inject(CommanderSpellbookService);
  private readonly edhrec = inject(EdhrecService);
  private readonly profileService = inject(ProfileService);
  private readonly auth = inject(AuthService);
  private readonly groupService = inject(GroupService);
  private readonly mtg = inject(MtgService);
  readonly i18n = inject(I18nService);
  /** Öffentlich, weil die Deck-Ansicht den Reiter direkt daran ausrichtet (gibt es einen Primer? ist die Spalte da?). */
  readonly primer = inject(DeckPrimerService);
  readonly steckbriefTexte = inject(DeckSteckbriefService);

  readonly viewingDeck = signal<Deck | null>(null);

  /**
   * Die Detailansicht ist eine eigene Seite; open() legt einen History-Eintrag an, damit die
   * Zurück-Geste sie schließt (die App hat keinen Router).
   */
  private historyEntryOpen = false;
  /** Setzt close() vor dem selbst ausgelösten history.back(), damit der eigene Pop nicht doppelt schließt. */
  private ignoreNextPop = false;
  /** Scrollposition der dahinterliegenden Seite (Deckliste, Statistik, ...), um sie beim Zurückgehen wiederherzustellen. */
  private scrollBeforeOpen = 0;

  constructor() {
    window.addEventListener('popstate', () => {
      if (this.ignoreNextPop) {
        this.ignoreNextPop = false;
        return;
      }
      if (!this.historyEntryOpen) return;
      this.historyEntryOpen = false;
      if (this.viewingDeck()) this.resetViewingState();
    });
  }

  /**
   * Darf das angesehene Deck bearbeitet werden? Ja für eigene Decks und für Decks virtueller
   * Spieler, wenn der Nutzer Owner GENAU DER Gruppe dieses Spielers ist. Wichtig, weil "Profil
   * ansehen" dieselbe Detailansicht öffnet.
   */
  readonly canEditViewingDeck = computed(() => {
    const deck = this.viewingDeck();
    if (!deck) return false;
    const uid = this.auth.currentUser()?.id;
    if (deck.userId && uid && deck.userId === uid) return true;
    if (
      deck.playerId &&
      deck.groupId &&
      deck.groupId === this.groupService.groupId() &&
      this.groupService.hasPermission('deck.editOthers')
    ) {
      return true;
    }
    return false;
  });

  /**
   * Spielstatistik ausblenden, wenn der Host dem Betrachter alle Modi gesperrt hat (eigene Decks
   * und Host ausgenommen).
   */
  readonly hideViewingDeckStats = computed(() => {
    if (this.canEditViewingDeck()) return false;
    return this.mtg.allModesHiddenForMe() && !this.groupService.isOwner();
  });
  readonly viewingDeckCards = signal<DeckCard[]>([]);
  readonly viewingChangeLog = signal<DeckChangeEntry[]>([]);
  /**
   * Verlauf nach Bearbeitungen gruppiert. Nicht nach gleichem Zeitstempel: Der Neuimport schreibt
   * alles in einem insert, saveEdits() aber je Karte eine Zeile mit eigenem now(). Deshalb gehören
   * Einträge zusammen, solange höchstens CHANGE_GROUP_GAP_MS dazwischen liegen.
   */
  readonly changeLogGroups = computed<DeckChangeGroup[]>(() => {
    const groups: DeckChangeGroup[] = [];
    let previousTime: number | null = null;

    // viewingChangeLog kommt absteigend sortiert (neueste zuerst, siehe DeckService.loadChangeLog).
    for (const entry of this.viewingChangeLog()) {
      const time = new Date(entry.changedAt).getTime();
      const belongsToPrevious =
        previousTime !== null && Math.abs(previousTime - time) <= CHANGE_GROUP_GAP_MS;

      if (!belongsToPrevious) {
        groups.push({
          changedAt: entry.changedAt,
          added: [],
          removed: [],
          addedCount: 0,
          removedCount: 0,
        });
      }
      const group = groups[groups.length - 1];

      if (entry.changeType === 'added') {
        group.added.push(entry);
        group.addedCount += entry.quantity;
      } else {
        group.removed.push(entry);
        group.removedCount += entry.quantity;
      }
      previousTime = time;
    }
    return groups;
  });
  /** Zeitstempel des offenen Verlaufs-Reiters - null heißt "neuester", siehe selectedChangeGroup(). */
  readonly selectedChangeGroupKey = signal<string | null>(null);
  readonly selectedChangeGroup = computed<DeckChangeGroup | null>(() => {
    const groups = this.changeLogGroups();
    const key = this.selectedChangeGroupKey();
    return groups.find((g) => g.changedAt === key) ?? groups[0] ?? null;
  });
  /** Läuft, während für den Druck einer Bearbeitung fehlende Kartenbilder von Scryfall nachgeladen werden. */
  readonly changeGroupPrintBusy = signal(false);
  readonly viewingDeckGameStats = signal<DeckGameStats | null>(null);
  /**
   * "mine" = nur Partien, in denen der BESITZER selbst spielte (ownerPlayerIds), "all" = auch
   * verliehene. Bewusst nicht der eingeloggte Nutzer - sonst sähe man bei fremden Decks nur die
   * eigenen Leih-Partien.
   */
  readonly deckStatsScope = signal<'mine' | 'all'>('mine');
  /** Beschriftung des "mine"-Knopfs: beim eigenen Deck "Meine Spiele", sonst "Vom Besitzer". */
  readonly deckStatsScopeOwnLabel = computed(() => {
    const deck = this.viewingDeck();
    const eigenes = !!deck?.userId && deck.userId === this.auth.currentUser()?.id;
    return this.i18n.t(eigenes ? 'deckView.statsScopeMine' : 'deckView.statsScopeOwner');
  });
  readonly detailBusy = signal(false);
  readonly viewMode = signal<'text' | 'visual'>('visual');
  /**
   * Offener Reiter: Kartenliste mit Analyse, Steckbrief oder Primer. Kopf und Kommentare stehen
   * außerhalb und bleiben sichtbar.
   */
  readonly deckTab = signal<'cards' | 'steckbrief' | 'primer'>('cards');
  readonly showChangeLog = signal(false);
  readonly showDeckStatsInfo = signal(false);
  readonly showDeckAnalysis = signal(false);
  readonly showDeckAnalysisInfo = signal(false);

  // Name/Tag sind im Kopfbereich immer änderbar, ohne eigenen Dialog.
  readonly deckNameDraft = signal('');
  readonly deckTagDraft = signal<string | null>(null);
  readonly deckFormatDraft = signal<DeckFormat | null>(null);
  readonly deckFormats = DECK_FORMATS;
  readonly deckInfoSaving = signal(false);

  readonly deckInfoDirty = computed(() => {
    const deck = this.viewingDeck();
    if (!deck) return false;
    return (
      this.deckNameDraft().trim() !== deck.name ||
      this.deckTagDraft() !== deck.edhrecTag ||
      this.deckFormatDraft() !== deck.format
    );
  });

  /** Verwirft Name/Tag/Format-Entwurf und setzt auf die gespeicherten Werte zurück. */
  resetDeckInfoDraft(): void {
    const deck = this.viewingDeck();
    this.deckNameDraft.set(deck?.name ?? '');
    this.deckTagDraft.set(deck?.edhrecTag ?? null);
    this.deckFormatDraft.set(deck?.format ?? null);
  }

  async saveDeckInfo(): Promise<void> {
    const deck = this.viewingDeck();
    const name = this.deckNameDraft().trim();
    if (!deck || !name || !this.canEditViewingDeck()) return;

    this.deckInfoSaving.set(true);
    const tag = this.deckTagDraft();
    const format = this.deckFormatDraft();
    const ok = await this.deckService.updateDeckInfo(deck.id, name, tag, format);
    this.deckInfoSaving.set(false);
    if (ok) {
      this.viewingDeck.set({ ...deck, name, edhrecTag: tag, format });
      this.deckNameDraft.set(name);
    }
  }

  readonly outdatedToggleBusy = signal(false);

  /** Markiert/entmarkiert das gerade angesehene Deck als "Outdated" - solche Decks sind standardmäßig in der Deck-Liste ausgeblendet. */
  async toggleOutdated(): Promise<void> {
    const deck = this.viewingDeck();
    if (!deck || !this.canEditViewingDeck()) return;

    this.outdatedToggleBusy.set(true);
    const next = !deck.isOutdated;
    const ok = await this.deckService.setDeckOutdated(deck.id, next);
    this.outdatedToggleBusy.set(false);
    if (ok) this.viewingDeck.set({ ...deck, isOutdated: next });
  }

  /** Kartenname (lowercase) -> Scryfall-Zusatzdaten (Manakosten, Farbidentität, Game-Changer-Flag). */
  readonly viewingCardDetails = signal<Map<string, ScryfallCard>>(new Map());
  readonly analysisBusy = signal(false);

  /** Zählt bewusst KEINE Maybeboard-Karten und keine Marken mit - die stehen nur in der engeren Auswahl bzw. sind gar keine echten Deckkarten. */
  readonly viewingTotalCards = computed(() =>
    this.editedDeckCards()
      .filter((c) => !c.isMaybeboard && !c.isToken)
      .reduce((sum, c) => sum + c.quantity, 0),
  );

  /** Gespeicherte Deck-Karten ohne Maybeboard/Marken - Basis für sämtliche Deck-Analysen (Kurve, Pips, Game-Changer, Tutoren, Bracket-Schätzung). */
  private readonly analysisDeckCards = computed(() =>
    this.viewingDeckCards().filter((c) => !c.isMaybeboard && !c.isToken),
  );

  /** Nicht-Land-Karten - Basis für Manakurve, Pip-Verteilung und Game-Changer-Auswertung. */
  private readonly nonLandCards = computed(() =>
    this.analysisDeckCards().filter((c) => !isLand(c.typeLine)),
  );

  /** Analyse-Karten samt Manakosten aus den Scryfall-Zusatzdaten (siehe deck-analyse.ts). */
  private readonly analyseKarten = computed<AnalyseKarte[]>(() => {
    const details = this.viewingCardDetails();
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
  readonly nonBasicLandPercent = computed<number | null>(() => nonBasicLandPercent(this.analyseKarten()));

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
    const details = this.viewingCardDetails();
    const getappt = lands
      .filter((c) => {
        const text = details.get(c.cardName.toLowerCase())?.oracleText ?? '';
        return (
          DeckViewerService.ENTERS_TAPPED_RE.test(text) &&
          !DeckViewerService.TAPPED_AUSNAHME_RE.test(text)
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

  readonly effectCategoryCountsBusy = signal(false);

  /** Aktuell geöffnetes "Karten dieser Kategorie ansehen"-Popup (siehe effectCategoryStats) - null wenn geschlossen. */
  readonly effectCategoryPopup = signal<{ label: string; cards: GameChangerEntry[] } | null>(null);

  openEffectCategoryPopup(label: string, cards: GameChangerEntry[]): void {
    this.effectCategoryPopup.set({ label, cards });
  }

  closeEffectCategoryPopup(): void {
    this.effectCategoryPopup.set(null);
  }

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
    const details = this.viewingCardDetails();
    return this.analysisDeckCards().filter(
      (c) => (details.get(c.cardName.toLowerCase())?.producedMana?.length ?? 0) > 0,
    );
  });

  /**
   * Gegenstück zur Pip-Verteilung: welche Farben das Deck ERZEUGT (Scryfalls produced_mana).
   * Gezählt werden Karten, eine mehrfarbige Quelle zählt bei jeder Farbe.
   */
  readonly manaSourceDistribution = computed<ManaSourceCount[]>(() => {
    const details = this.viewingCardDetails();
    const counts: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    for (const card of this.manaSourceCards()) {
      const produced = details.get(card.cardName.toLowerCase())?.producedMana ?? [];
      for (const color of new Set(produced)) {
        if (color in counts) counts[color] += card.quantity;
      }
    }
    return DeckViewerService.MANA_SOURCE_COLORS.map((color) => ({
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
    const details = this.viewingCardDetails();
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

    const details = this.viewingCardDetails();
    return this.analysisDeckCards()
      .filter((c) => {
        const text = details.get(c.cardName.toLowerCase())?.oracleText ?? '';
        return DeckViewerService.TUTOR_RE.test(text) && !DeckViewerService.LAND_TUTOR_RE.test(text);
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

  // --- Combo-Finder: welche Karte würde neue Combos freischalten? (siehe src/app/combo-finder.ts) ---

  /**
   * Höchstens so viele Vorschläge: Ein Deck berührt so viele der ~108.500 Combos, dass der Rest
   * Rauschen ist. Die Gesamtzahl steht unter der Liste.
   */
  private static readonly COMBO_FINDER_MAX = 40;

  readonly comboFinderOpen = signal(false);
  readonly comboFinderBusy = signal(false);
  readonly comboFinderSuggestions = signal<ComboFinderSuggestion[]>([]);
  /** Wie viele passende Vorschläge es insgesamt gab - kann größer sein als die angezeigte Liste. */
  readonly comboFinderTotal = signal(0);
  /**
   * false = Combo-Daten fehlen noch (Migration/Nachtlauf) - getrennt von "nichts gefunden", damit
   * die Oberfläche den Grund nennt.
   */
  readonly comboFinderAvailable = signal(true);

  /**
   * Scryfall-Daten der Vorschläge. Eigenes Signal, weil viewingCardDetails nur echte Deckkarten
   * enthalten darf (Kurve, Pips, Bracket).
   */
  private readonly comboFinderCardDetails = signal<Map<string, ScryfallCard>>(new Map());

  /** Die Combo, deren Ablauf gerade als Fenster offen ist - null heißt zu. */
  readonly comboFinderDetail = signal<ComboFinderCombo | null>(null);

  openComboFinderDetail(combo: ComboFinderCombo): void {
    this.comboFinderDetail.set(combo);
  }

  closeComboFinderDetail(): void {
    this.comboFinderDetail.set(null);
  }

  /** Einmal geladen, reicht für dieses Deck - zurückgesetzt in loadCardDetails(). */
  private comboFinderLoaded = false;

  /**
   * Erlaubte Farben der Vorschläge: Farbidentität des Commanders, sonst die Vereinigung aller
   * Deckkarten. null = unbekannt, Filter aus.
   */
  private readonly comboFinderColorIdentity = computed<string[] | null>(() => {
    const vomCommander = this.deckColorIdentitySubset();
    if (vomCommander) return vomCommander;

    const details = this.viewingCardDetails();
    if (details.size === 0) return null;

    const union = new Set<string>();
    for (const card of this.analysisDeckCards()) {
      for (const farbe of details.get(card.cardName.toLowerCase())?.colorIdentity ?? [])
        union.add(farbe);
    }
    return [...union];
  });

  /**
   * Öffnet den Combo-Finder und lädt beim ersten Mal nach - erst auf Klick, weil die Suche teuer
   * ist.
   */
  async openComboFinder(): Promise<void> {
    this.comboFinderOpen.set(true);
    if (this.comboFinderLoaded || this.comboFinderBusy()) return;

    const deck = this.viewingDeck();
    if (!deck) return;

    this.comboFinderBusy.set(true);
    // Ohne die Kartendetails fehlen Schlüssel und Farbidentität - der Klick kann kommen, bevor
    // loadCardDetails() im Hintergrund fertig ist.
    await this.ensureCardDetailsLoaded();

    const cards = this.bracketCards();
    if (cards.length === 0) {
      this.comboFinderBusy.set(false);
      return;
    }

    const { rows, available } = await this.cardData.combosMissingOneCard(
      cards.map((c) => c.name),
      cards.filter((c) => c.isCommander).map((c) => c.name),
    );
    const vorschlaege = groupSuggestions(rows);
    const details = await this.cardData.cardsByNormalizedNames(vorschlaege.map((v) => v.key));

    // Zwischenzeitlich ein anderes Deck geöffnet? Dann gehören diese Vorschläge nicht mehr hierher.
    if (this.viewingDeck()?.id !== deck.id) {
      this.comboFinderBusy.set(false);
      return;
    }

    const identity = this.comboFinderColorIdentity();
    // Karten ohne Eintrag im Kartenbestand fallen raus: ohne ihre Farbidentität lässt sich nicht
    // sagen, ob sie überhaupt ins Deck dürfen, und ohne Bild wäre der Vorschlag ein nackter Name.
    const passend = vorschlaege.filter((v) => {
      const card = details.get(v.key);
      return !!card && fitsColorIdentity(card.colorIdentity, identity);
    });

    this.comboFinderAvailable.set(available);
    this.comboFinderTotal.set(passend.length);

    const gezeigt = passend.slice(0, DeckViewerService.COMBO_FINDER_MAX);
    this.comboFinderCardDetails.set(
      new Map(
        gezeigt.map((v) => {
          const card = details.get(v.key) as ScryfallCard;
          return [card.name.toLowerCase(), card];
        }),
      ),
    );

    // Die Suche kennt nur normalisierte Namen; angezeigt werden sollen die Namen, die auch in der
    // Deckliste stehen.
    const anzeigename = new Map(cards.map((c) => [c.key, c.name]));
    this.comboFinderSuggestions.set(
      gezeigt.map((v) => ({
        key: v.key,
        cardName: (details.get(v.key) as ScryfallCard).name,
        comboCount: v.comboCount,
        combos: v.combos.map((c) => ({
          id: c.comboId,
          presentCardNames: c.present.map((key) => anzeigename.get(key) ?? key),
          produces: c.produces,
          steps: comboSteps(c.description),
          // Kein Rückfall auf manaValueNeeded: "3" als {3} hieße drei generische Mana, auch wenn
          // die Combo {1}{B}{B} braucht. Geprüft an 382 Combos: die Quelle liefert immer auch die
          // Schreibweise.
          extraMana: parseManaCost(c.manaNeeded ?? ''),
        })),
      })),
    );
    this.comboFinderLoaded = true;
    this.comboFinderBusy.set(false);
  }

  closeComboFinder(): void {
    this.comboFinderOpen.set(false);
    this.comboFinderDetail.set(null);
  }

  // --- Commander-Bracket (siehe src/app/bracket.ts) ---

  /** Brackets gibt es nur im Commander - für Brawl, PDH und den Rest bleibt die Anzeige aus. */
  readonly showsBracket = computed(() => this.viewingDeck()?.format === 'Commander');

  /**
   * Automatische Einstufung. null solange Kartendetails laden - sonst käme verlässlich "Bracket 2"
   * heraus und würde zurückgeschrieben.
   */
  /** Deckkarten in der Form der Bracket-Rechnung (auch für die Combo-Liste gebraucht). */
  private readonly bracketCards = computed<BracketCard[]>(() => {
    const details = this.viewingCardDetails();
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
  /** Gemessene Schwellen aus bracket_benchmark; bis zum Laden und ohne Tabelle die Startwerte. */
  private readonly bracketBenchmark = signal<BracketBenchmark>(DEFAULT_BRACKET_BENCHMARK);

  readonly localTwoCardCombos = computed(() =>
    presentCombos(this.bracketCards(), this.spellbookCombos(), this.spellbookCardFlags()),
  );

  readonly bracketAnalysis = computed<BracketAnalysis | null>(() => {
    if (!this.showsBracket() || this.analysisBusy()) return null;

    const deck = this.viewingDeck();
    if (!deck) return null;

    const cards = this.bracketCards();
    if (cards.length === 0) return null;

    return analyzeBracket({
      cards,
      flags: this.spellbookCardFlags(),
      combos: this.spellbookCombos(),
      spellbookTag: this.bracketEstimate()?.bracketTag ?? null,
      isPrecon: deck.isPrecon,
      averageCmc: this.averageCmc(),
      untappedLandPercent: this.untappedLandPercent(),
      tutorCount: this.tutorCards().reduce((sum, c) => sum + c.quantity, 0),
      winningCombos: this.winningCombos(),
      totalCards: this.viewingTotalCards(),
      totalPrice: this.totalDeckPrice(),
      benchmark: this.bracketBenchmark(),
    });
  });

  /**
   * Angezeigte Stufe: manuell schlägt automatisch; während die Rechnung läuft, der zuletzt
   * gespeicherte Wert.
   */
  readonly effectiveBracket = computed<{ level: number; source: 'manual' | 'auto' } | null>(() => {
    const deck = this.viewingDeck();
    if (!deck || !this.showsBracket()) return null;
    if (deck.bracket != null) return { level: deck.bracket, source: 'manual' };

    const level = this.bracketAnalysis()?.bracket ?? deck.bracketAuto;
    return level != null ? { level, source: 'auto' } : null;
  });

  readonly bracketSaving = signal(false);

  /** Stufe von Hand setzen (null = automatisch). Speichert sofort, wie setArchetype(). */
  async setBracket(bracket: number | null): Promise<void> {
    const deck = this.viewingDeck();
    if (!deck || !this.canEditViewingDeck()) return;

    this.bracketSaving.set(true);
    const ok = await this.deckService.setDeckBracket(deck.id, bracket);
    this.bracketSaving.set(false);
    if (ok) this.viewingDeck.set({ ...deck, bracket });
  }

  /**
   * Schreibt das Automatik-Ergebnis zurück, damit Listen ein Abzeichen ohne Kartenliste zeigen
   * können. Als effect(), weil die Einstufung an mehreren unabhängig eintreffenden Quellen hängt;
   * der Vergleich mit dem gespeicherten Wert hält es bei einem Schreibvorgang je Öffnung.
   */
  private readonly autoBracketPersist = effect(() => {
    const deck = this.viewingDeck();
    const analysis = this.bracketAnalysis();
    if (!deck || !analysis || analysis.bracket === deck.bracketAuto) return;
    if (!this.canEditViewingDeck()) return;

    const level = analysis.bracket;
    void this.deckService.saveDeckAutoBracket(deck.id, level).then((ok) => {
      // Lokal nachziehen, sonst liefe der effect() bei der nächsten Änderung erneut an.
      if (ok)
        this.viewingDeck.update((d) => (d && d.id === deck.id ? { ...d, bracketAuto: level } : d));
    });
  });

  /** Die fünf Stufen für das Auswahlfeld, in Anzeigereihenfolge. */
  readonly bracketOptions: readonly number[] = [1, 2, 3, 4, 5];

  /** Begründung der Einstufung ein-/ausklappen. */
  readonly showBracketWhy = signal(false);

  toggleBracketWhy(): void {
    this.showBracketWhy.update((v) => !v);
  }

  /**
   * Welches Urteil als Rechenweg-Popup offen ist (null = keins). Die Zahlen erklären sich nicht
   * selbst (Skalen, Mittelung, umgekehrte Manawert-Skala), deshalb je Urteil ein ⓘ.
   */
  readonly bracketMathTopic = signal<BracketMathTopic | null>(null);

  openBracketMath(topic: BracketMathTopic): void {
    this.bracketMathTopic.set(topic);
  }

  closeBracketMath(): void {
    this.bracketMathTopic.set(null);
  }

  /** Schwelle, ab der die Feinbewertung anhebt - in Prozent, für die Erklärtexte. */
  readonly tuningBumpPercent = Math.round(TUNING_BUMP_SCHWELLE * 100);

  /** Kartenwert, ab dem mindestens Bracket 3 gilt - für die Erklärtexte. */
  readonly priceThresholdEur = PREIS_SCHWELLE_EUR;

  /** Fertige Zahlen fürs Rechenweg-Popup: Punktsumme, Teiler, Power-Spanne. */
  readonly bracketMath = computed(() => {
    const analysis = this.bracketAnalysis();
    if (!analysis) return null;
    const teile = analysis.verdicts.tuningParts;
    const [powerVon, powerBis] = powerRange(analysis.bracket);
    return {
      /** z.B. "0.00 + 0.31 + 0.00 + 0.17" - die Summanden der Mittelung, in der Reihenfolge der Liste. */
      summands: teile.map((t) => t.score.toFixed(2)).join(' + '),
      divisor: teile.length,
      powerVon,
      powerBis,
      powerSpanne: Math.round((powerBis - powerVon) * 10) / 10,
      /** true, wenn die Feinbewertung das Bracket tatsächlich um eine Stufe angehoben hat. */
      bumped: analysis.reasons.some((r) => r.key === 'tuning'),
      /** true, wenn der Kartenwert die Schwelle erreicht und damit mindestens Bracket 3 erzwingt. */
      pricePushed: analysis.reasons.some((r) => r.key === 'price'),
      /**
       * Befunde aus Schritt 1 ohne Tuning-Anhebung und ohne Kartenwert (keine offizielle Regel).
       */
      rulesReasons: analysis.reasons.filter((r) => r.key !== 'tuning' && r.key !== 'price'),
      /** Stufe nach den beiden Urteilen, aber VOR einer möglichen Anhebung durch die Feinbewertung. */
      baseBracket: Math.max(analysis.verdicts.rules, analysis.verdicts.spellbook ?? 0),
    };
  });

  /** Beschriftung "Automatisch" samt berechneter Stufe. */
  readonly bracketAutoOptionLabel = computed(() => {
    const level = this.bracketAnalysis()?.bracket ?? this.viewingDeck()?.bracketAuto;
    return level == null
      ? this.i18n.t('deckView.bracketAutoOptionPending')
      : this.i18n.t('deckView.bracketAutoOption', { level: String(level) });
  });

  /**
   * Doppelkarte mit Land auf der Rückseite, die vorne anders einsortiert wird (MDFCs wie Pathways).
   * Die Karte bleibt in ihrer Vorderseiten-Sektion, zählt aber für den "+X"-Zusatz der
   * Land-Sektion.
   */
  private isHiddenMdfcLand(card: DeckCard): boolean {
    if (typeSection(card.typeLine) === 'Land') return false;
    const backType = (card.typeLine ?? '').split(' // ')[1];
    return !!backType?.includes('Land');
  }

  /** Anzahl Karten, die zwar nicht in der Land-Sektion stehen, aber auf ihrer Rückseite ein Land sind (siehe isHiddenMdfcLand) - für den "+X"-Zusatz an der Land-Sektionsüberschrift. */
  readonly hiddenMdfcLandCount = computed(() =>
    this.editedDeckCards()
      .filter((c) => !c.isCommander && !c.isMaybeboard && !c.isToken && this.isHiddenMdfcLand(c))
      .reduce((sum, c) => sum + c.quantity, 0),
  );

  /** Interne Abschnitts-Schlüssel sind deutsch (auch Filter-Schlüssel), übersetzt wird nur die Anzeige. */
  translateLabel(label: string): string {
    return translateSectionLabel(this.i18n, label);
  }

  private static sortByCmc(a: DeckCard, b: DeckCard): number {
    return a.cmc - b.cmc || a.cardName.localeCompare(b.cardName);
  }

  /** Karten gruppiert nach Commander -> Typ, innerhalb jeder Gruppe nach Manawert sortiert. */
  readonly groupedDeckCards = computed(() => {
    const commander = this.editedDeckCards().filter((c) => c.isCommander);
    const rest = this.editedDeckCards().filter(
      (c) => !c.isCommander && !c.isMaybeboard && !c.isToken,
    );
    const maybe = this.editedDeckCards().filter((c) => !c.isCommander && c.isMaybeboard);
    const tokens = this.editedDeckCards().filter((c) => c.isToken);

    const sections: { label: string; cards: DeckCard[] }[] = [];
    if (commander.length > 0) {
      sections.push({
        label: 'Commander',
        cards: [...commander].sort(DeckViewerService.sortByCmc),
      });
    }
    sections.push(...groupByTypeSection(rest, (c) => c.typeLine, DeckViewerService.sortByCmc));
    if (maybe.length > 0) {
      sections.push({ label: 'Maybeboard', cards: [...maybe].sort(DeckViewerService.sortByCmc) });
    }
    if (tokens.length > 0) {
      sections.push({ label: 'Tokens', cards: [...tokens].sort(DeckViewerService.sortByCmc) });
    }

    return sections;
  });

  /** Ob die Kartenliste nach Kartentyp (Standard) oder nach eigenen Tags gruppiert/sortiert wird. */
  readonly cardSortMode = signal<'type' | 'tags'>('type');

  setCardSortMode(mode: 'type' | 'tags'): void {
    this.cardSortMode.set(mode);
  }

  /** Alle im Deck tatsächlich vergebenen eigenen Tags, alphabetisch - für die Tag-Auswahl beim Bearbeiten einer Karte. */
  readonly availableCustomTags = computed(() => {
    const tags = new Set<string>();
    for (const card of this.editedDeckCards()) {
      for (const t of card.customTags) tags.add(t);
    }
    return [...tags].sort((a, b) => a.localeCompare(b));
  });

  /**
   * Gruppiert nach eigenen Tags; Karten mit mehreren Tags erscheinen mehrfach, ohne Tag unter "Ohne
   * Tag".
   */
  readonly groupedDeckCardsByTag = computed(() => {
    const commander = this.editedDeckCards().filter((c) => c.isCommander);
    const rest = this.editedDeckCards().filter(
      (c) => !c.isCommander && !c.isMaybeboard && !c.isToken,
    );
    const maybe = this.editedDeckCards().filter((c) => !c.isCommander && c.isMaybeboard);
    const tokens = this.editedDeckCards().filter((c) => c.isToken);

    const groups = new Map<string, DeckCard[]>();
    const untagged: DeckCard[] = [];
    for (const card of rest) {
      if (card.customTags.length === 0) {
        untagged.push(card);
        continue;
      }
      for (const tag of card.customTags) {
        const list = groups.get(tag) ?? [];
        list.push(card);
        groups.set(tag, list);
      }
    }

    const sections: { label: string; cards: DeckCard[] }[] = [];
    if (commander.length > 0) {
      sections.push({
        label: 'Commander',
        cards: [...commander].sort(DeckViewerService.sortByCmc),
      });
    }
    for (const tag of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
      sections.push({ label: tag, cards: [...groups.get(tag)!].sort(DeckViewerService.sortByCmc) });
    }
    if (untagged.length > 0) {
      sections.push({ label: 'Ohne Tag', cards: untagged.sort(DeckViewerService.sortByCmc) });
    }
    if (maybe.length > 0) {
      sections.push({ label: 'Maybeboard', cards: [...maybe].sort(DeckViewerService.sortByCmc) });
    }
    if (tokens.length > 0) {
      sections.push({ label: 'Tokens', cards: [...tokens].sort(DeckViewerService.sortByCmc) });
    }
    return sections;
  });

  readonly cardSearchQuery = signal('');
  readonly cmcFilter = signal<'all' | number>('all');
  readonly typeFilterValue = signal<'all' | string>('all');
  readonly creatureTypeFilter = signal<'all' | string>('all');
  readonly colorFilter = signal<ColorSelection>(EMPTY_COLOR_SELECTION);
  readonly keywordFilter = signal('all');
  readonly effectFilter = signal('all');
  /** Ergebnis der letzten Effekt-Abfrage (lowercase Kartennamen) - null solange kein Effekt-Filter aktiv oder noch nicht geladen. */
  readonly effectMatchNames = signal<Set<string> | null>(null);
  readonly effectFilterBusy = signal(false);

  /** Kreaturtypen (Untertypen nach dem Gedankenstrich), die tatsächlich im Deck vorkommen - für das Filter-Dropdown. */
  readonly availableCreatureTypes = computed(() => {
    const types = new Set<string>();
    for (const card of this.viewingDeckCards()) {
      if (!(card.typeLine ?? '').includes('Creature')) continue;
      for (const t of parseSubtypes(card.typeLine)) types.add(t);
    }
    return [...types].sort((a, b) => a.localeCompare(b));
  });

  readonly availableTypeSections = computed(() => this.groupedDeckCards().map((s) => s.label));

  private cardMatchesFilters(card: DeckCard): boolean {
    const query = this.cardSearchQuery().trim().toLowerCase();
    if (query && !card.cardName.toLowerCase().includes(query)) return false;

    const cmc = this.cmcFilter();
    if (cmc !== 'all') {
      if (cmcBucket(card.cmc) !== cmc) return false;
    }

    const creatureType = this.creatureTypeFilter();
    if (
      creatureType !== 'all' &&
      !parseSubtypes(card.typeLine).includes(creatureType)
    ) {
      return false;
    }

    const colors = this.colorFilter();
    if (colors.colors.length > 0) {
      const identity =
        this.viewingCardDetails().get(card.cardName.toLowerCase())?.colorIdentity ?? [];
      if (!matchesColorSelection(identity, colors)) return false;
    }

    const keyword = this.keywordFilter();
    if (keyword !== 'all') {
      const keywords = this.viewingCardDetails().get(card.cardName.toLowerCase())?.keywords ?? [];
      if (!keywords.some((k) => k.toLowerCase() === keyword)) return false;
    }

    const effect = this.effectFilter();
    if (effect !== 'all') {
      const matches = this.effectMatchNames();
      // Vorderseiten-Name + normalisiert - genau wie classifyCards() seine Ergebnis-Keys bildet
      // (siehe loadEffectMatches()), sonst würden Doppelkarten hier nie matchen.
      if (!matches?.has(normalizeCardName(card.cardName.split(' // ')[0].trim()))) return false;
    }

    return true;
  }

  /** groupedDeckCards, gefiltert nach Suchtext/Manawert/Typ/Kreaturtyp/Farbe - leere Abschnitte fallen weg. */
  readonly filteredGroupedDeckCards = computed(() => {
    const sortMode = this.cardSortMode();
    const typeFilter = this.typeFilterValue();
    const source = sortMode === 'tags' ? this.groupedDeckCardsByTag() : this.groupedDeckCards();
    return source
      .filter(
        (section) => sortMode === 'tags' || typeFilter === 'all' || section.label === typeFilter,
      )
      .map((section) => ({
        label: section.label,
        cards: section.cards.filter((c) => this.cardMatchesFilters(c)),
      }))
      .filter((section) => section.cards.length > 0);
  });

  readonly hasActiveCardFilters = computed(
    () =>
      this.cardSearchQuery().trim() !== '' ||
      this.cmcFilter() !== 'all' ||
      this.typeFilterValue() !== 'all' ||
      this.creatureTypeFilter() !== 'all' ||
      this.colorFilter().colors.length > 0 ||
      this.keywordFilter() !== 'all' ||
      this.effectFilter() !== 'all',
  );

  resetCardFilters(): void {
    this.cardSearchQuery.set('');
    this.cmcFilter.set('all');
    this.typeFilterValue.set('all');
    this.creatureTypeFilter.set('all');
    this.colorFilter.set(EMPTY_COLOR_SELECTION);
    this.keywordFilter.set('all');
    this.effectFilter.set('all');
    this.effectMatchNames.set(null);
  }

  setEffectFilter(value: string): void {
    this.effectFilter.set(value);
    this.loadEffectMatches();
  }

  /**
   * Tutor/Extra-Runde/MLD haben keine Scryfall-Abfrage (query ''), sie nutzen dieselben lokalen
   * Quellen wie die Analyse-Kacheln, damit beide dieselben Karten zeigen.
   */
  private static readonly LOCAL_EFFECT_FILTERS = new Set(['tutor', 'extraturn', 'mld']);

  private toNormalizedNameSet(entries: GameChangerEntry[]): Set<string> {
    return new Set(entries.map((e) => normalizeCardName(e.cardName.split(' // ')[0].trim())));
  }

  /** Effekt-Kategorien sind kein Feld auf der Karte, sondern nur über eine Scryfall-Suche abfragbar - deshalb async statt wie die übrigen Filter rein lokal. */
  private async loadEffectMatches(): Promise<void> {
    const effect = this.effectFilter();
    if (DeckViewerService.LOCAL_EFFECT_FILTERS.has(effect)) {
      const entries =
        effect === 'tutor'
          ? this.tutorCards()
          : effect === 'extraturn'
            ? this.extraTurnCards()
            : this.massLandDenialCards();
      this.effectMatchNames.set(this.toNormalizedNameSet(entries));
      this.effectFilterBusy.set(false);
      return;
    }
    const tagQuery = this.effectFilters.find((f) => f.value === effect)?.query;
    if (!tagQuery) {
      this.effectMatchNames.set(null);
      return;
    }
    this.effectFilterBusy.set(true);
    const names = this.viewingDeckCards().map((c) => c.cardName);
    // classifyCards() teilt sich den Cache mit den Analyse-Kacheln - Filter und Kacheln zeigen so
    // dieselben Karten.
    const matched = await this.scryfall.classifyCards(effect, tagQuery, names);
    this.effectMatchNames.set(matched);
    this.effectFilterBusy.set(false);
  }

  // Bearbeitungsmodus: Karten hinzufügen/entfernen
  readonly editMode = signal(false);
  /** Blendet die Kronen-Buttons auf den Kartenkacheln ein/aus - standardmäßig aus, da sie sonst auf jeder einzelnen Karte stören, obwohl man sie nur selten braucht. */
  readonly showCommanderToggle = signal(false);
  readonly addCardQuery = signal('');
  readonly addCardTypeFilter = signal<'all' | string>('all');
  readonly addCardCreatureTypeFilter = signal('');
  readonly addCardColorFilter = signal<ColorSelection>(EMPTY_COLOR_SELECTION);
  readonly addCardCmcFilter = signal<'all' | number>('all');
  readonly addCardEffectFilter = signal('all');
  readonly addCardKeywordFilter = signal('all');
  /** Sortierung der Suchergebnisse - Default alphabetisch, 'cmc' sortiert nach Manawert aufsteigend. */
  readonly addCardSortMode = signal<'name' | 'cmc'>('name');
  readonly addCardResults = signal<ScryfallCard[]>([]);
  readonly addCardBusy = signal(false);
  readonly addCardMessage = signal('');
  private addCardSearchTimer: ReturnType<typeof setTimeout> | null = null;

  /** Suchergebnisse (bis 175) seitenweise statt hart abgeschnitten. */
  private static readonly ADD_CARD_PAGE_SIZE = 30;
  readonly addCardResultsPage = signal(0);

  readonly addCardResultsTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.addCardResults().length / DeckViewerService.ADD_CARD_PAGE_SIZE)),
  );

  readonly addCardResultsEffectivePage = computed(() =>
    Math.min(this.addCardResultsPage(), this.addCardResultsTotalPages() - 1),
  );

  readonly pagedAddCardResults = computed(() => {
    const start = this.addCardResultsEffectivePage() * DeckViewerService.ADD_CARD_PAGE_SIZE;
    return this.addCardResults().slice(start, start + DeckViewerService.ADD_CARD_PAGE_SIZE);
  });

  prevAddCardResultsPage(): void {
    this.addCardResultsPage.update((p) => Math.max(0, p - 1));
  }

  nextAddCardResultsPage(): void {
    this.addCardResultsPage.update((p) => Math.min(this.addCardResultsTotalPages() - 1, p + 1));
  }

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

  private static readonly TYPE_TO_SCRYFALL: Record<string, string> = {
    Planeswalker: 'planeswalker',
    Battle: 'battle',
    Kreatur: 'creature',
    'Legendäre Kreatur': 'legendary creature',
    Spontanzauber: 'instant',
    Hexerei: 'sorcery',
    Artefakt: 'artifact',
    Verzauberung: 'enchantment',
    Land: 'land',
  };

  /**
   * Farbidentität der Commander für die id<=-Beschränkung der Kartensuche; null (unbeschränkt)
   * solange unbekannt.
   */
  readonly deckColorIdentitySubset = computed<string[] | null>(() => {
    const commanders = this.viewingDeckCards().filter((c) => c.isCommander);
    if (commanders.length === 0) return null;
    const details = this.viewingCardDetails();
    const identities = commanders.map((c) => details.get(c.cardName.toLowerCase())?.colorIdentity);
    if (identities.some((i) => i === undefined)) return null;
    const union = new Set<string>();
    for (const id of identities) for (const c of id ?? []) union.add(c);
    return [...union];
  });

  /**
   * Deck-Angaben für den Steckbrief-Reiter; hier, weil sie aus vielen Quellen dieses Service
   * stammen.
   */
  readonly steckbriefDeck = computed<SteckbriefDeckinfo | null>(() => {
    const deck = this.viewingDeck();
    if (!deck) return null;
    const farben = this.deckColorIdentitySubset() ?? [];
    return {
      id: deck.id,
      name: deck.name,
      formatLabel: deck.format,
      kreaturtyp: deck.creatureType,
      // In der Reihenfolge WUBRG statt in der zufälligen Reihenfolge der Commander-Karten - so
      // stehen die Symbole wie überall sonst in der App und auf den Karten selbst.
      farben: FILTER_COLORS.filter((c) => farben.includes(c)),
      bracket: deck.bracket ?? deck.bracketAuto,
      bracketQuelle: deck.bracket ? 'manual' : 'auto',
      commander: this.viewingDeckCards()
        .filter((c) => c.isCommander)
        .map((c) => ({ name: c.cardName, imageUrl: this.resolvedCardImage(c) })),
      istPrivat: deck.isPrivate,
    };
  });

  /** Deckkarten ohne Maybeboard/Marken für die Wirkungs-Kacheln des Steckbriefs. */
  readonly steckbriefKarten = computed<SteckbriefKarte[]>(() =>
    this.viewingDeckCards()
      .filter((c) => !c.isMaybeboard && !c.isToken)
      .map((c) => ({ name: c.cardName, quantity: c.quantity })),
  );

  /**
   * Änderungen im Bearbeitungsmodus sammeln sich nur lokal, erst saveEdits() schreibt;
   * cancelEdits() verwirft sie.
   */
  readonly pendingChanges = signal<Map<string, PendingCardChange>>(new Map());
  /** Kartenname (lowercase) -> neuer Commander-Status, ebenfalls nur lokal bis saveEdits(). */
  readonly pendingCommanderChanges = signal<Map<string, boolean>>(new Map());
  /** Kartenname (lowercase) -> neuer Maybeboard-Status, ebenfalls nur lokal bis saveEdits(). */
  readonly pendingMaybeboardChanges = signal<Map<string, boolean>>(new Map());
  readonly editSaveBusy = signal(false);

  /** Kartenname (lowercase) -> gespeicherte Anzahl, als schnelle Nachschlagehilfe für Diff-Berechnungen. */
  private readonly savedQuantityByKey = computed(() => {
    const map = new Map<string, number>();
    for (const c of this.viewingDeckCards()) map.set(c.cardName.toLowerCase(), c.quantity);
    return map;
  });

  /** Kartenname (lowercase) -> gespeicherter Commander-Status, analog savedQuantityByKey. */
  private readonly savedCommanderByKey = computed(() => {
    const map = new Map<string, boolean>();
    for (const c of this.viewingDeckCards()) map.set(c.cardName.toLowerCase(), c.isCommander);
    return map;
  });

  /** Kartenname (lowercase) -> gespeicherter Maybeboard-Status, analog savedQuantityByKey. */
  private readonly savedMaybeboardByKey = computed(() => {
    const map = new Map<string, boolean>();
    for (const c of this.viewingDeckCards()) map.set(c.cardName.toLowerCase(), c.isMaybeboard);
    return map;
  });

  /** viewingDeckCards, überlagert von den noch ungespeicherten Änderungen - das, was während des Bearbeitens angezeigt wird. */
  readonly editedDeckCards = computed<DeckCard[]>(() => {
    if (!this.editMode()) return this.viewingDeckCards();

    const pending = this.pendingChanges();
    const commanderChanges = this.pendingCommanderChanges();
    const maybeboardChanges = this.pendingMaybeboardChanges();
    const result: DeckCard[] = [];
    for (const card of this.viewingDeckCards()) {
      const key = card.cardName.toLowerCase();
      const change = pending.get(key);
      const isCommander = commanderChanges.get(key) ?? card.isCommander;
      const isMaybeboard = maybeboardChanges.get(key) ?? card.isMaybeboard;
      if (!change) {
        result.push(
          isCommander === card.isCommander && isMaybeboard === card.isMaybeboard
            ? card
            : { ...card, isCommander, isMaybeboard },
        );
      } else if (change.quantity > 0) {
        result.push({ ...card, quantity: change.quantity, isCommander, isMaybeboard });
      }
    }
    const savedKeys = this.savedQuantityByKey();
    for (const change of pending.values()) {
      if (!savedKeys.has(change.cardName.toLowerCase()) && change.quantity > 0) {
        result.push({
          cardName: change.cardName,
          quantity: change.quantity,
          imageUrl: change.imageUrl,
          typeLine: change.typeLine,
          cmc: change.cmc,
          isCommander: commanderChanges.get(change.cardName.toLowerCase()) ?? false,
          isMaybeboard: maybeboardChanges.get(change.cardName.toLowerCase()) ?? false,
          isToken: false,
          scryfallOracleId: null,
          customTags: [],
        });
      }
    }
    return result;
  });

  readonly hasPendingChanges = computed(() => {
    const saved = this.savedQuantityByKey();
    for (const change of this.pendingChanges().values()) {
      if (change.quantity !== (saved.get(change.cardName.toLowerCase()) ?? 0)) return true;
    }
    const savedCommanders = this.savedCommanderByKey();
    for (const [key, isCommander] of this.pendingCommanderChanges()) {
      if (isCommander !== (savedCommanders.get(key) ?? false)) return true;
    }
    const savedMaybeboard = this.savedMaybeboardByKey();
    for (const [key, isMaybeboard] of this.pendingMaybeboardChanges()) {
      if (isMaybeboard !== (savedMaybeboard.get(key) ?? false)) return true;
    }
    return false;
  });

  /** Welche Karten in welcher Menge noch ungespeichert hinzugefügt/entfernt wurden - für die Anzeige vor dem Speichern. */
  readonly pendingChangeDetails = computed(() => {
    const saved = this.savedQuantityByKey();
    const added: GameChangerEntry[] = [];
    const removed: GameChangerEntry[] = [];
    for (const change of this.pendingChanges().values()) {
      const diff = change.quantity - (saved.get(change.cardName.toLowerCase()) ?? 0);
      if (diff > 0) added.push({ cardName: change.cardName, quantity: diff });
      else if (diff < 0) removed.push({ cardName: change.cardName, quantity: -diff });
    }
    added.sort((a, b) => a.cardName.localeCompare(b.cardName));
    removed.sort((a, b) => a.cardName.localeCompare(b.cardName));
    return { added, removed };
  });

  /** Karten, deren Commander-Status sich geändert hat (noch ungespeichert) - für die Anzeige vor dem Speichern. */
  readonly pendingCommanderChangeDetails = computed(() => {
    const saved = this.savedCommanderByKey();
    const changed: { cardName: string; isCommander: boolean }[] = [];
    for (const [key, isCommander] of this.pendingCommanderChanges()) {
      if (isCommander !== (saved.get(key) ?? false)) {
        const cardName =
          this.editedDeckCards().find((c) => c.cardName.toLowerCase() === key)?.cardName ?? key;
        changed.push({ cardName, isCommander });
      }
    }
    return changed;
  });

  /** Karten, deren Maybeboard-Status sich geändert hat (noch ungespeichert) - für die Anzeige vor dem Speichern. */
  readonly pendingMaybeboardChangeDetails = computed(() => {
    const saved = this.savedMaybeboardByKey();
    const changed: { cardName: string; isMaybeboard: boolean }[] = [];
    for (const [key, isMaybeboard] of this.pendingMaybeboardChanges()) {
      if (isMaybeboard !== (saved.get(key) ?? false)) {
        const cardName =
          this.editedDeckCards().find((c) => c.cardName.toLowerCase() === key)?.cardName ?? key;
        changed.push({ cardName, isMaybeboard });
      }
    }
    return changed;
  });

  /** Verschiebt eine Karte im Bearbeitungsmodus zwischen Hauptdeck und Maybeboard - nur lokal, bis saveEdits(). */
  toggleCardMaybeboard(card: DeckCard): void {
    if (!this.canEditViewingDeck()) return;
    this.pendingMaybeboardChanges.update((map) =>
      new Map(map).set(card.cardName.toLowerCase(), !card.isMaybeboard),
    );
  }

  readonly tokenScanBusy = signal(false);
  readonly tokenScanMessage = signal<string | null>(null);

  /**
   * Legt Marken aus Scryfalls all_parts als eigene Deckzeilen an. Dedupliziert nach oracleId statt
   * Name, weil viele verschiedene Marken gleich heißen. Schreibt direkt, nicht über pendingChanges.
   */
  async scanForTokens(): Promise<void> {
    const deck = this.viewingDeck();
    if (!deck || !this.canEditViewingDeck()) return;

    this.tokenScanBusy.set(true);
    this.tokenScanMessage.set(null);

    const details = this.viewingCardDetails();
    const existingTokens = this.viewingDeckCards().filter((c) => c.isToken);
    const existingTokenOracleIds = new Set(
      existingTokens.filter((c) => c.scryfallOracleId).map((c) => c.scryfallOracleId!),
    );
    // Ältere Marken ohne oracleId über Name+Bild zuordnen und nachfüllen, statt sie doppelt
    // anzulegen.
    const legacyTokensByNameAndImage = new Map<string, DeckCard>();
    for (const t of existingTokens) {
      if (t.scryfallOracleId) continue;
      legacyTokensByNameAndImage.set(`${t.cardName.toLowerCase()}|${t.imageUrl ?? ''}`, t);
    }

    const candidateIds = new Set<string>();
    for (const card of this.viewingDeckCards()) {
      if (card.isMaybeboard || card.isToken) continue;
      const parts = details.get(card.cardName.toLowerCase())?.allParts ?? [];
      for (const part of parts) {
        if (part.component === 'token') candidateIds.add(part.id);
      }
    }

    if (candidateIds.size === 0) {
      this.tokenScanBusy.set(false);
      this.tokenScanMessage.set(this.i18n.t('deckView.noNewTokensFound'));
      return;
    }

    const tokenCards = await this.scryfall.findCardsByIds([...candidateIds]);
    const newByOracleId = new Map<string, ScryfallCard>();
    for (const data of tokenCards.values()) {
      const oracleId = data.oracleId;
      if (!oracleId || existingTokenOracleIds.has(oracleId) || newByOracleId.has(oracleId))
        continue;
      newByOracleId.set(oracleId, data);
    }

    let added = 0;
    let backfilled = 0;
    for (const [oracleId, data] of newByOracleId) {
      const legacy = legacyTokensByNameAndImage.get(
        `${data.name.toLowerCase()}|${data.imageUrl ?? ''}`,
      );
      if (legacy) {
        const ok = await this.deckService.backfillTokenOracleId(
          deck.id,
          legacy.cardName,
          legacy.imageUrl ?? '',
          oracleId,
        );
        if (ok) backfilled++;
        continue;
      }
      const ok = await this.deckService.addTokenToDeck(deck.id, {
        name: data.name,
        imageUrl: data.imageUrl ?? null,
        typeLine: data.typeLine ?? null,
        oracleId,
      });
      if (ok) added++;
    }

    this.tokenScanBusy.set(false);
    this.tokenScanMessage.set(
      added > 0
        ? this.i18n.t('deckView.tokensFound', { count: String(added) })
        : backfilled > 0
          ? this.i18n.t('deckView.tokensBackfilled', { count: String(backfilled) })
          : this.i18n.t('deckView.noNewTokensFound'),
    );
    await this.reloadDeckCards();
  }

  // --- Archetyp/Kreaturtyp: selbst gewählte Einordnung fürs öffentliche Stöbern (unabhängig von
  // color_identity). Speichert sofort, wie toggleOutdated(). ---
  readonly archetypeOptions = COMMANDER_ARCHETYPE_FILTERS;
  readonly creatureTypeOptions = signal<string[]>([]);
  readonly creatureTypeOptionsLoading = signal(false);
  readonly archetypeSaving = signal(false);

  archetypeLabel(value: string): string {
    return this.i18n.t(`archetypeFilter.${value}`);
  }

  private async loadCreatureTypeOptions(): Promise<void> {
    this.creatureTypeOptionsLoading.set(true);
    this.creatureTypeOptions.set(await this.scryfall.creatureTypes());
    this.creatureTypeOptionsLoading.set(false);
  }

  async setArchetype(edhrecTag: string | null): Promise<void> {
    const deck = this.viewingDeck();
    if (!deck || !this.canEditViewingDeck()) return;

    this.archetypeSaving.set(true);
    const ok = await this.deckService.updateDeckArchetype(deck.id, edhrecTag, deck.creatureType);
    this.archetypeSaving.set(false);
    if (ok) {
      this.viewingDeck.set({ ...deck, edhrecTag });
      this.deckTagDraft.set(edhrecTag);
    }
  }

  async setCreatureType(creatureType: string | null): Promise<void> {
    const deck = this.viewingDeck();
    if (!deck || !this.canEditViewingDeck()) return;

    this.archetypeSaving.set(true);
    const ok = await this.deckService.updateDeckArchetype(deck.id, deck.edhrecTag, creatureType);
    this.archetypeSaving.set(false);
    if (ok) this.viewingDeck.set({ ...deck, creatureType });
  }

  readonly commanderMarkError = signal<string | null>(null);

  /**
   * Grobe Prüfung, ob eine Karte Commander sein kann (für die Krone): legendäre Kreaturen, "can be
   * your commander" und Backgrounds.
   */
  isCommanderEligible(card: DeckCard): boolean {
    const typeLine = card.typeLine ?? '';
    if (typeLine.includes('Legendary') && typeLine.includes('Creature')) return true;
    if (typeLine.includes('Background')) return true;
    const oracleText = this.viewingCardDetails().get(card.cardName.toLowerCase())?.oracleText ?? '';
    return oracleText.includes('can be your commander');
  }

  /**
   * Erlaubtes Commander-Paar: Partner (inkl. "Partner with", "Friends forever"), Choose a
   * Background + Background, Doctor's companion + Time Lord Doctor.
   */
  private canBeSecondCommander(existing: DeckCard, candidate: DeckCard): boolean {
    const details = this.viewingCardDetails();
    const existingKw = details.get(existing.cardName.toLowerCase())?.keywords ?? [];
    const candidateKw = details.get(candidate.cardName.toLowerCase())?.keywords ?? [];
    const existingType = existing.typeLine ?? '';
    const candidateType = candidate.typeLine ?? '';

    if (existingKw.includes('Partner') && candidateKw.includes('Partner')) return true;
    if (existingKw.includes('Choose a background') && candidateType.includes('Background'))
      return true;
    if (candidateKw.includes('Choose a background') && existingType.includes('Background'))
      return true;
    if (existingKw.includes("Doctor's companion") && candidateType.includes('Time Lord Doctor'))
      return true;
    if (candidateKw.includes("Doctor's companion") && existingType.includes('Time Lord Doctor'))
      return true;

    return false;
  }

  /**
   * Commander-Markierung umschalten (lokal bis saveEdits()). Ein zweiter nur als gültiges Paar, ein
   * dritter nie.
   */
  toggleCommanderMark(card: DeckCard): void {
    if (!this.canEditViewingDeck()) return;
    this.commanderMarkError.set(null);

    if (card.isCommander) {
      this.pendingCommanderChanges.update((map) =>
        new Map(map).set(card.cardName.toLowerCase(), false),
      );
      return;
    }

    const currentCommanders = this.editedDeckCards().filter((c) => c.isCommander);
    if (currentCommanders.length >= 2) {
      this.commanderMarkError.set(this.i18n.t('deckViewer.msg.maxTwoCommanders'));
      return;
    }
    if (currentCommanders.length === 1) {
      const existing = currentCommanders[0];
      if (!this.canBeSecondCommander(existing, card)) {
        this.commanderMarkError.set(
          this.i18n.t('deckViewer.msg.secondCommanderInvalid', {
            existing: existing.cardName,
            card: card.cardName,
          }),
        );
        return;
      }
    }

    this.pendingCommanderChanges.update((map) =>
      new Map(map).set(card.cardName.toLowerCase(), true),
    );
  }

  // Artwork/Edition einer Karte wechseln (Bearbeitungsmodus)
  readonly artworkPickerCard = signal<DeckCard | null>(null);
  readonly artworkOptions = signal<ScryfallPrinting[]>([]);
  readonly artworkPickerBusy = signal(false);
  readonly artworkPickerError = signal<string | null>(null);

  async openArtworkPicker(card: DeckCard): Promise<void> {
    if (!this.canEditViewingDeck()) return;
    this.artworkPickerCard.set(card);
    this.artworkOptions.set([]);
    this.artworkPickerError.set(null);
    this.artworkPickerBusy.set(true);
    const printings = await this.scryfall.getPrintings(card.cardName, {
      isToken: card.isToken,
      oracleId: card.scryfallOracleId,
    });
    this.artworkPickerBusy.set(false);
    if (printings.length === 0) {
      this.artworkPickerError.set(this.i18n.t('deckViewer.msg.noMoreEditionsFound'));
    }
    this.artworkOptions.set(printings);
  }

  closeArtworkPicker(): void {
    this.artworkPickerCard.set(null);
    this.artworkOptions.set([]);
    this.tagEditorCard.set(null);
    this.tagEditorNewTag.set('');
    this.artworkPickerError.set(null);
  }

  /** Schreibt das gewählte Artwork direkt in die DB (unabhängig vom Bearbeitungsmodus-Speichern-Button, wie Name/Tag im Kopfbereich). */
  async selectArtwork(imageUrl: string): Promise<void> {
    const deck = this.viewingDeck();
    const card = this.artworkPickerCard();
    if (!deck || !card || !this.canEditViewingDeck()) return;

    this.artworkPickerBusy.set(true);
    const ok = await this.deckService.updateCardImage(deck.id, card.cardName, imageUrl);
    this.artworkPickerBusy.set(false);

    if (!ok) {
      this.artworkPickerError.set(this.i18n.t('deckViewer.msg.imageSaveFailed'));
      return;
    }

    const key = card.cardName.toLowerCase();
    this.viewingDeckCards.update((cards) =>
      cards.map((c) => (c.cardName.toLowerCase() === key ? { ...c, imageUrl } : c)),
    );
    // Rückmeldung, weil das Artwork sofort gespeichert wird.
    this.addCardMessage.set(this.i18n.t('deckViewer.msg.artworkSaved', { name: card.cardName }));
    this.closeArtworkPicker();
  }

  /** Eigenes Bild statt einer Scryfall-Edition hochladen und direkt als Artwork setzen. */
  async uploadCustomArtwork(file: File): Promise<void> {
    const uid = this.auth.currentUser()?.id;
    if (!uid || !this.canEditViewingDeck()) return;

    this.artworkPickerBusy.set(true);
    this.artworkPickerError.set(null);
    const url = await this.deckService.uploadCustomCardArt(uid, file);
    this.artworkPickerBusy.set(false);

    if (!url) {
      this.artworkPickerError.set(this.i18n.t('deckViewer.msg.uploadFailed'));
      return;
    }
    await this.selectArtwork(url);
  }

  // eigene Sortier-Tags einer Karte bearbeiten (Bearbeitungsmodus)
  readonly tagEditorCard = signal<DeckCard | null>(null);
  readonly tagEditorNewTag = signal('');
  readonly tagEditorBusy = signal(false);

  openTagEditor(card: DeckCard): void {
    if (!this.canEditViewingDeck()) return;
    this.tagEditorCard.set(card);
    this.tagEditorNewTag.set('');
  }

  closeTagEditor(): void {
    this.tagEditorCard.set(null);
    this.tagEditorNewTag.set('');
  }

  setTagEditorNewTag(value: string): void {
    this.tagEditorNewTag.set(value);
  }

  /** Fügt einen Tag zur Karte hinzu, falls sie ihn noch nicht hat, oder entfernt ihn wieder - speichert sofort. */
  async toggleCardTag(tag: string): Promise<void> {
    const deck = this.viewingDeck();
    const card = this.tagEditorCard();
    const trimmed = tag.trim();
    if (!deck || !card || !trimmed || !this.canEditViewingDeck()) return;

    const next = card.customTags.includes(trimmed)
      ? card.customTags.filter((t) => t !== trimmed)
      : [...card.customTags, trimmed];

    this.tagEditorBusy.set(true);
    const ok = await this.deckService.setCardTags(deck.id, card.cardName, next);
    this.tagEditorBusy.set(false);
    if (!ok) return;

    const key = card.cardName.toLowerCase();
    this.viewingDeckCards.update((cards) =>
      cards.map((c) => (c.cardName.toLowerCase() === key ? { ...c, customTags: next } : c)),
    );
    this.tagEditorCard.set({ ...card, customTags: next });
  }

  /** Legt einen komplett neuen Tag an (kommt noch bei keiner Karte im Deck vor) und weist ihn direkt der aktuellen Karte zu. */
  async addNewTagToCard(): Promise<void> {
    const value = this.tagEditorNewTag().trim();
    if (!value) return;
    await this.toggleCardTag(value);
    this.tagEditorNewTag.set('');
  }

  toggleEditMode(): void {
    if (this.editMode() || !this.canEditViewingDeck()) return; // Verlassen geht nur bewusst über saveEdits()/cancelEdits()
    this.editMode.set(true);
    this.showCommanderToggle.set(false);
    if (this.creatureTypeOptions().length === 0) this.loadCreatureTypeOptions();
    this.artworkPickerCard.set(null);
    this.artworkOptions.set([]);
    this.tagEditorCard.set(null);
    this.tagEditorNewTag.set('');
    this.pendingChanges.set(new Map());
    this.pendingCommanderChanges.set(new Map());
    this.pendingMaybeboardChanges.set(new Map());
    this.commanderMarkError.set(null);
    this.tokenScanMessage.set(null);
    this.tokenScanBusy.set(false);
    this.addCardQuery.set('');
    this.addCardTypeFilter.set('all');
    this.addCardCreatureTypeFilter.set('');
    this.addCardColorFilter.set(EMPTY_COLOR_SELECTION);
    this.addCardCmcFilter.set('all');
    this.addCardEffectFilter.set('all');
    this.addCardKeywordFilter.set('all');
    this.addCardSortMode.set('name');
    this.addCardToMaybeboard.set(false);
    this.addCardResults.set([]);
    this.addCardResultsPage.set(0);
    this.addCardMessage.set('');
    this.addCardMode.set('search');
    this.edhrecLists.set(null);
    this.edhrecCardDetails.set(new Map());
    this.edhrecCategoryImagesBusy.set(new Set());
    this.edhrecBrowseTagActive.set(false);
    this.edhrecBrowseTag.set(null);
    this.edhrecAvailableTags.set([]);
    this.edhrecTagsBusy.set(false);
    // Auslöser, damit die Auto-Load-Effekte oben garantiert neu laden, selbst wenn sich der
    // Commander-Name dabei textlich nicht ändert (siehe Kommentar bei edhrecRefreshTick).
    this.edhrecRefreshTick.update((v) => v + 1);
    this.edhrecBusy.set(false);
    this.edhrecFailed.set(false);
  }

  private setPendingQuantity(card: DeckCard, quantity: number): void {
    this.pendingChanges.update((map) => {
      const next = new Map(map);
      next.set(card.cardName.toLowerCase(), {
        cardName: card.cardName,
        quantity: Math.max(0, quantity),
        imageUrl: card.imageUrl,
        typeLine: card.typeLine,
        cmc: card.cmc,
        isCommander: card.isCommander,
      });
      return next;
    });
  }

  /**
   * Nur die Vorderseite eines Doppelkarten-Namens, kleingeschrieben - EDHREC nennt nur eine Seite,
   * Scryfall "A // B".
   */
  private static frontFaceKey(name: string): string {
    return name.split(' // ')[0].trim().toLowerCase();
  }

  /** Kurzes grünes/rotes Aufleuchten des zuletzt geklickten +/--Buttons als Klick-Feedback. */
  readonly flashState = signal<{ key: string; type: 'add' | 'remove' } | null>(null);
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  private triggerFlash(cardName: string, type: 'add' | 'remove'): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashState.set({ key: cardName.toLowerCase(), type });
    this.flashTimer = setTimeout(() => this.flashState.set(null), 400);
  }

  isFlashing(cardName: string, type: 'add' | 'remove'): boolean {
    const state = this.flashState();
    if (!state || state.type !== type) return false;
    return DeckViewerService.frontFaceKey(state.key) === DeckViewerService.frontFaceKey(cardName);
  }

  /** Rückseite von Doppelkarten im Suchergebnis zeigen (nur Anzeige). */
  private readonly flippedAddCardKeys = signal<Set<string>>(new Set());

  isAddCardFlipped(cardName: string): boolean {
    return this.flippedAddCardKeys().has(DeckViewerService.frontFaceKey(cardName));
  }

  toggleAddCardFlip(cardName: string): void {
    const key = DeckViewerService.frontFaceKey(cardName);
    this.flippedAddCardKeys.update((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Wie flippedAddCardKeys, aber für Karten im Deck; wird bei open()/close() zurückgesetzt. */
  private readonly flippedDeckCardKeys = signal<Set<string>>(new Set());

  isDeckCardFlipped(cardName: string): boolean {
    return this.flippedDeckCardKeys().has(DeckViewerService.frontFaceKey(cardName));
  }

  toggleDeckCardFlip(cardName: string): void {
    const key = DeckViewerService.frontFaceKey(cardName);
    this.flippedDeckCardKeys.update((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** card.quantity ist hier bereits der aktuell angezeigte (ggf. schon angepasste) Stand aus editedDeckCards(). */
  incrementCard(card: DeckCard): void {
    this.setPendingQuantity(card, card.quantity + 1);
    this.triggerFlash(card.cardName, 'add');
  }

  decrementCard(card: DeckCard): void {
    this.setPendingQuantity(card, card.quantity - 1);
    this.triggerFlash(card.cardName, 'remove');
  }

  async saveEdits(): Promise<void> {
    const deck = this.viewingDeck();
    if (!deck || !this.canEditViewingDeck()) return;
    this.editSaveBusy.set(true);

    const saved = this.savedQuantityByKey();
    const maybeboardChanges = this.pendingMaybeboardChanges();
    for (const change of this.pendingChanges().values()) {
      const key = change.cardName.toLowerCase();
      const savedQty = saved.get(key) ?? 0;
      const diff = change.quantity - savedQty;
      if (diff === 0) continue;

      if (diff > 0) {
        await this.deckService.addCardToDeck(
          deck.id,
          {
            name: change.cardName,
            imageUrl: change.imageUrl ?? undefined,
            typeLine: change.typeLine ?? undefined,
            cmc: change.cmc,
          },
          diff,
          maybeboardChanges.get(key) ?? false,
        );
      } else {
        await this.deckService.removeCardFromDeck(deck.id, change.cardName, -diff);
      }
    }

    const savedCommanders = this.savedCommanderByKey();
    let commanderChanged = false;
    for (const [key, isCommander] of this.pendingCommanderChanges()) {
      if (isCommander === (savedCommanders.get(key) ?? false)) continue;
      const cardName =
        this.editedDeckCards().find((c) => c.cardName.toLowerCase() === key)?.cardName ?? key;
      await this.deckService.setCardCommanderFlag(deck.id, cardName, isCommander);
      commanderChanged = true;
    }

    // Farb-Metadaten fürs öffentliche Stöbern nur bei geänderten Commandern nachpflegen (Daten aus
    // viewingCardDetails, kein Netzwerk). commander_types bleibt unangetastet - das setzt der
    // Nutzer selbst.
    if (commanderChanged) {
      const commanderCards = this.editedDeckCards()
        .filter((c) => c.isCommander)
        .map((c) => this.viewingCardDetails().get(c.cardName.toLowerCase()))
        .filter((c): c is ScryfallCard => c !== undefined);

      const colorIdentity = [
        ...new Set(commanderCards.flatMap((c) => c.colorIdentity ?? [])),
      ].sort();
      await this.deckService.updateDeckCommanderMetadata(deck.id, colorIdentity);
    }

    // Setzt den Maybeboard-Status auch für Karten, die nur verschoben wurden (für neue Karten
    // doppelt, harmlos).
    const savedMaybeboard = this.savedMaybeboardByKey();
    for (const [key, isMaybeboard] of maybeboardChanges) {
      if (isMaybeboard === (savedMaybeboard.get(key) ?? false)) continue;
      const cardName =
        this.editedDeckCards().find((c) => c.cardName.toLowerCase() === key)?.cardName ?? key;
      await this.deckService.setCardMaybeboardFlag(deck.id, cardName, isMaybeboard);
    }

    this.pendingChanges.set(new Map());
    this.pendingCommanderChanges.set(new Map());
    this.pendingMaybeboardChanges.set(new Map());
    this.commanderMarkError.set(null);
    this.tokenScanMessage.set(null);
    this.tokenScanBusy.set(false);
    this.editMode.set(false);
    this.showCommanderToggle.set(false);
    this.artworkPickerCard.set(null);
    this.artworkOptions.set([]);
    this.tagEditorCard.set(null);
    this.tagEditorNewTag.set('');
    this.addCardMode.set('search');
    await this.reloadDeckCards();
    this.editSaveBusy.set(false);
  }

  cancelEdits(): void {
    this.pendingChanges.set(new Map());
    this.pendingCommanderChanges.set(new Map());
    this.pendingMaybeboardChanges.set(new Map());
    this.commanderMarkError.set(null);
    this.tokenScanMessage.set(null);
    this.tokenScanBusy.set(false);
    this.editMode.set(false);
    this.showCommanderToggle.set(false);
    this.artworkPickerCard.set(null);
    this.artworkOptions.set([]);
    this.tagEditorCard.set(null);
    this.tagEditorNewTag.set('');
    this.addCardQuery.set('');
    this.addCardResults.set([]);
    this.addCardResultsPage.set(0);
    this.addCardMessage.set('');
    this.addCardMode.set('search');
  }

  onAddCardSearchInput(value: string): void {
    this.addCardQuery.set(value);
    this.triggerAddCardSearch();
  }

  onAddCardCreatureTypeInput(value: string): void {
    this.addCardCreatureTypeFilter.set(value);
    this.triggerAddCardSearch();
  }

  setAddCardTypeFilter(value: 'all' | string): void {
    this.addCardTypeFilter.set(value);
    this.triggerAddCardSearch();
  }

  setAddCardColorFilter(value: ColorSelection): void {
    this.addCardColorFilter.set(value);
    this.triggerAddCardSearch();
  }

  setAddCardCmcFilter(value: 'all' | number): void {
    this.addCardCmcFilter.set(value);
    this.triggerAddCardSearch();
  }

  setAddCardEffectFilter(value: string): void {
    this.addCardEffectFilter.set(value);
    this.triggerAddCardSearch();
  }

  setAddCardKeywordFilter(value: string): void {
    this.addCardKeywordFilter.set(value);
    this.triggerAddCardSearch();
  }

  setAddCardSortMode(value: 'name' | 'cmc'): void {
    this.addCardSortMode.set(value);
    this.triggerAddCardSearch();
  }

  private triggerAddCardSearch(): void {
    if (this.addCardSearchTimer) clearTimeout(this.addCardSearchTimer);
    const query = this.addCardQuery();
    const type = this.addCardTypeFilter();
    const creatureType = this.addCardCreatureTypeFilter();
    const colors = this.addCardColorFilter();
    const cmc = this.addCardCmcFilter();
    const effect = this.addCardEffectFilter();
    const keyword = this.addCardKeywordFilter();

    if (
      !query.trim() &&
      type === 'all' &&
      !creatureType.trim() &&
      colors.colors.length === 0 &&
      cmc === 'all' &&
      effect === 'all' &&
      keyword === 'all'
    ) {
      this.addCardResults.set([]);
      this.addCardResultsPage.set(0);
      return;
    }

    this.addCardSearchTimer = setTimeout(async () => {
      this.addCardBusy.set(true);
      const results = await this.scryfall.searchCards(query, {
        type:
          type === 'all'
            ? undefined
            : (DeckViewerService.TYPE_TO_SCRYFALL[type] ?? type.toLowerCase()),
        creatureType: creatureType.trim() || undefined,
        colors,
        cmc: cmc === 'all' ? null : cmc,
        effectQuery:
          effect === 'all' ? undefined : this.effectFilters.find((f) => f.value === effect)?.query,
        keyword: keyword === 'all' ? undefined : keyword,
        colorIdentitySubset: this.deckColorIdentitySubset(),
        order: this.addCardSortMode(),
        // Das Format aus dem Bearbeiten-Feld, nicht das gespeicherte: wer es gerade umstellt,
        // sucht schon für das neue.
        format: this.deckFormatDraft(),
      });
      this.addCardResults.set(results);
      this.addCardResultsPage.set(0);
      this.addCardBusy.set(false);
    }, 300);
  }

  /** Ziel für die nächste per addCard()/addEdhrecCard() hinzugefügte Karte - Deck oder Maybeboard, umschaltbar über den Chip im "Karte hinzufügen"-Panel. */
  readonly addCardToMaybeboard = signal(false);

  toggleAddCardToMaybeboard(toMaybeboard: boolean): void {
    this.addCardToMaybeboard.set(toMaybeboard);
  }

  /**
   * Karte nur lokal zu pendingChanges hinzufügen. addCardToMaybeboard() gilt nur für neue Karten.
   */
  addCard(card: ScryfallCard): void {
    if (!this.canEditViewingDeck()) return;
    const key = card.name.toLowerCase();
    const currentQty =
      this.editedDeckCards().find((c) => c.cardName.toLowerCase() === key)?.quantity ?? 0;
    const existingInDeck = this.viewingDeckCards().find((c) => c.cardName.toLowerCase() === key);

    this.pendingChanges.update((map) => {
      const next = new Map(map);
      next.set(key, {
        cardName: card.name,
        quantity: currentQty + 1,
        imageUrl: card.imageUrl ?? existingInDeck?.imageUrl ?? null,
        typeLine: card.typeLine ?? existingInDeck?.typeLine ?? null,
        cmc: card.cmc ?? existingInDeck?.cmc ?? 0,
        isCommander: existingInDeck?.isCommander ?? false,
      });
      return next;
    });
    if (!existingInDeck) {
      this.pendingMaybeboardChanges.update((map) =>
        new Map(map).set(key, this.addCardToMaybeboard()),
      );
    }
    // Sofort in viewingCardDetails übernehmen, damit z. B. die Partner-Prüfung auch ungespeicherte
    // Karten kennt.
    this.viewingCardDetails.update((map) => new Map(map).set(key, card));
    this.addCardMessage.set(this.i18n.t('deckViewer.msg.cardAdded', { name: card.name }));
    this.triggerFlash(card.name, 'add');
  }

  // EDHREC-Vorschläge im Add-Karten-Panel
  readonly addCardMode = signal<'search' | 'edhrec'>('search');

  /** EDHREC-Vorschläge und -Tags nur für Alpha-Tester (siehe ProfileService.isAlphaTester). */
  readonly edhrecEnabled = computed(() => this.profileService.isAlphaTester());
  readonly edhrecLists = signal<EdhrecCardlist[] | null>(null);
  readonly edhrecBusy = signal(false);
  readonly edhrecFailed = signal(false);
  /** Kartenname (lowercase) -> Scryfall-Daten (Bild, Typenzeile) für alle EDHREC-Vorschläge, damit man die Karte ansehen kann. */
  readonly edhrecCardDetails = signal<Map<string, ScryfallCard>>(new Map());
  /**
   * Alle markierten Commander (0-2) aus editedDeckCards(), damit eine ungespeicherte Markierung
   * sofort neue Vorschläge lädt.
   */
  readonly edhrecCommanderNames = computed(
    () =>
      this.editedDeckCards()
        .filter((c) => c.isCommander)
        .map((c) => c.cardName),
    // Inhaltlicher Vergleich, sonst lädt edhrecListsAutoLoad bei jeder Kartenänderung neu
    // (sichtbarer Scroll-Sprung).
    { equal: (a, b) => a.length === b.length && a.every((name, i) => name === b[i]) },
  );
  /** Anzeige-Name für die EDHREC-Hinweistexte - bei einem Paar beide Namen kombiniert. */
  readonly edhrecCommanderName = computed(() => {
    const names = this.edhrecCommanderNames();
    return names.length ? names.join(' & ') : null;
  });
  /** Beim Deck-Anlegen gewählter EDHREC-Theme-Tag (z.B. "ramp") - kombiniert die Vorschläge mit dem Commander statt nur Commander allein. */
  readonly edhrecTagSlug = computed(() => this.viewingDeck()?.edhrecTag ?? null);

  // Tag-Wechsel nur zum Stöbern, ändert nicht den gespeicherten Deck-Tag.
  readonly edhrecBrowseTagActive = signal(false);
  readonly edhrecBrowseTag = signal<string | null>(null);
  readonly edhrecAvailableTags = signal<EdhrecTag[]>([]);
  readonly edhrecTagsBusy = signal(false);

  /** Der gerade tatsächlich für die Vorschläge verwendete Tag - Browse-Override hat Vorrang vor dem gespeicherten Deck-Tag. */
  readonly effectiveEdhrecTag = computed(() =>
    this.edhrecBrowseTagActive() ? this.edhrecBrowseTag() : this.edhrecTagSlug(),
  );

  /** Grob lesbarer Name aus dem Tag-Slug, ohne extra Netzwerk-Anfrage (z.B. "group-hug" -> "Group Hug"). */
  readonly edhrecTagLabel = computed(() => {
    const slug = this.effectiveEdhrecTag();
    if (!slug) return null;
    return slug
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  });

  setAddCardMode(mode: 'search' | 'edhrec'): void {
    this.addCardMode.set(mode);
  }

  /**
   * Auslöser-Zähler: wird bei jedem Reset der EDHREC-Anzeige erhöht, damit die Auto-Load-Effekte
   * sicher neu laufen (ein nicht-reaktives Feld tat das nicht).
   */
  private readonly edhrecRefreshTick = signal(0);

  /** Lädt EDHREC-Vorschläge neu, sobald der Tab offen ist und sich der Commander ändert. */
  private readonly edhrecListsAutoLoad = effect(() => {
    const mode = this.addCardMode();
    const commanders = this.edhrecCommanderNames();
    this.edhrecRefreshTick();
    if (mode !== 'edhrec') return;
    if (!this.edhrecEnabled()) {
      // Z.B. abgemeldet, während der EDHREC-Modus offen war - zurück zur normalen Suche.
      this.addCardMode.set('search');
      return;
    }
    this.edhrecLists.set(null);
    this.edhrecFailed.set(false);
    this.edhrecBrowseTagActive.set(false);
    this.edhrecBrowseTag.set(null);
    if (commanders.length === 0) {
      this.edhrecFailed.set(true);
      return;
    }
    this.loadEdhrecRecommendations();
  });

  /** Lädt die EDHREC-Tags bei Commander-Wechsel (auch für die Tag-Auswahl im Kopf). */
  private readonly edhrecTagsAutoLoad = effect(() => {
    const commanders = this.edhrecCommanderNames();
    this.edhrecRefreshTick();
    this.edhrecAvailableTags.set([]);
    if (commanders.length === 0 || !this.edhrecEnabled()) return;
    this.loadEdhrecAvailableTags(commanders);
  });

  /** Wechselt die angezeigten Vorschläge testweise auf einen anderen Tag - nur für diese Sitzung, nicht gespeichert. */
  setEdhrecBrowseTag(slug: string | null): void {
    this.edhrecBrowseTagActive.set(true);
    this.edhrecBrowseTag.set(slug);
    this.edhrecLists.set(null);
    this.edhrecFailed.set(false);
    this.loadEdhrecRecommendations();
  }

  /** Zurück zum dauerhaft im Deck gespeicherten Tag. */
  resetEdhrecBrowseTag(): void {
    if (!this.edhrecBrowseTagActive()) return;
    this.edhrecBrowseTagActive.set(false);
    this.edhrecBrowseTag.set(null);
    this.edhrecLists.set(null);
    this.edhrecFailed.set(false);
    this.loadEdhrecRecommendations();
  }

  private async loadEdhrecAvailableTags(commanders: string[]): Promise<void> {
    this.edhrecTagsBusy.set(true);
    const tags = await this.edhrec.getCommanderTags(commanders);
    this.edhrecTagsBusy.set(false);

    let list = tags ?? [];
    // Gespeicherten Tag immer anbieten, auch wenn EDHREC ihn umbenannt hat.
    const keepTag = this.deckTagDraft() ?? this.viewingDeck()?.edhrecTag ?? null;
    if (keepTag && !list.some((t) => t.slug === keepTag)) {
      list = [{ slug: keepTag, value: keepTag, count: 0 }, ...list];
    }
    this.edhrecAvailableTags.set(list);
  }

  private async loadEdhrecRecommendations(): Promise<void> {
    const commanders = this.edhrecCommanderNames();
    if (commanders.length === 0) {
      this.edhrecFailed.set(true);
      return;
    }
    this.edhrecBusy.set(true);
    this.edhrecFailed.set(false);
    const tag = this.effectiveEdhrecTag();
    let lists = await this.edhrec.getCommanderRecommendations(commanders, tag);
    if (lists === null && tag) {
      // Commander(-Paar)+Tag-Kombo evtl. nicht verfügbar (zu seltene Kombination) - auf reine
      // Commander-Vorschläge zurückfallen statt gar nichts anzuzeigen.
      lists = await this.edhrec.getCommanderRecommendations(commanders);
    }
    if (lists === null && commanders.length > 1) {
      // EDHREC hat evtl. keine eigene Seite für diese konkrete Partner-/Background-Kombi - auf den
      // ersten Commander allein zurückfallen statt gar nichts anzuzeigen.
      lists = await this.edhrec.getCommanderRecommendations([commanders[0]], tag);
      if (lists === null && tag) {
        lists = await this.edhrec.getCommanderRecommendations([commanders[0]]);
      }
    }
    this.edhrecLists.set(lists);
    this.edhrecFailed.set(lists === null);
    this.edhrecBusy.set(false);
    // Bilder lädt erst loadEdhrecCategoryImages() beim Aufklappen einer Kategorie - alle ~300 auf
    // einmal machten den Tab langsam.
  }

  readonly edhrecCategoryImagesBusy = signal<Set<string>>(new Set());

  /** Lädt Bilder nur für die Karten EINER Kategorie nach, sobald sie aufgeklappt wird - bereits geladene Karten werden übersprungen. */
  async loadEdhrecCategoryImages(tag: string, cardNames: string[]): Promise<void> {
    const known = this.edhrecCardDetails();
    const missing = cardNames.filter((n) => !known.has(n.toLowerCase()));
    if (missing.length === 0) return;

    this.edhrecCategoryImagesBusy.update((set) => new Set(set).add(tag));
    const found = await this.cardData.findCardsBulk(missing);
    this.edhrecCardDetails.update((current) => new Map([...current, ...found]));
    this.edhrecCategoryImagesBusy.update((set) => {
      const next = new Set(set);
      next.delete(tag);
      return next;
    });
  }

  isEdhrecCategoryImagesBusy(tag: string): boolean {
    return this.edhrecCategoryImagesBusy().has(tag);
  }

  edhrecCardImage(cardName: string): string | null {
    return this.edhrecCardDetails().get(cardName.toLowerCase())?.imageUrl ?? null;
  }

  edhrecCardBackImage(cardName: string): string | null {
    return this.edhrecCardDetails().get(cardName.toLowerCase())?.backImageUrl ?? null;
  }

  isCardInDeck(cardName: string): boolean {
    const target = DeckViewerService.frontFaceKey(cardName);
    return this.editedDeckCards().some(
      (c) => DeckViewerService.frontFaceKey(c.cardName) === target,
    );
  }

  /** Kartenbild, mit Rückfall auf die Scryfall-Daten, falls deck_cards.image_url fehlt. */
  resolvedCardImage(card: DeckCard): string | null {
    return (
      card.imageUrl ?? this.viewingCardDetails().get(card.cardName.toLowerCase())?.imageUrl ?? null
    );
  }

  /**
   * Rückseite einer Doppelkarte im Deck, nur aus viewingCardDetails (deck_cards speichert ein
   * Bild).
   */
  resolvedCardBackImage(card: DeckCard): string | null {
    return this.viewingCardDetails().get(card.cardName.toLowerCase())?.backImageUrl ?? null;
  }

  /**
   * Bild für den PDF-Export: immer das gewählte Artwork, unverändert. Ein Umschreiben auf Scryfalls
   * png-URL ließ alle Bilder scheitern; recompressForPrint() gleicht die Größe an.
   */
  resolvedCardPrintImage(card: DeckCard): string | null {
    return this.resolvedCardImage(card);
  }

  /** Rückseiten-Druckvariante, siehe resolvedCardPrintImage(). */
  resolvedCardBackPrintImage(card: DeckCard): string | null {
    return this.resolvedCardBackImage(card);
  }

  /**
   * Kartenname für die große Vorschau aus den Analyse-Listen (Combo-Karten sind nicht immer
   * DeckCards).
   */
  readonly previewCardName = signal<string | null>(null);

  openCardPreview(name: string): void {
    this.previewCardName.set(name);
  }

  closeCardPreview(): void {
    this.previewCardName.set(null);
  }

  /**
   * Bild-URLs zu einem Kartennamen aus den geladenen Kartendetails; null = unbekannt, der Aufrufer
   * zeigt den Namen.
   */
  cardImageUrlFor(name: string): string | null {
    return this.cardDetailFor(name)?.imageUrl ?? null;
  }

  cardBackImageUrlFor(name: string): string | null {
    return this.cardDetailFor(name)?.backImageUrl ?? null;
  }

  /** Erst im Deck, dann bei den Combo-Finder-Vorschlägen nachsehen. */
  private cardDetailFor(name: string): ScryfallCard | undefined {
    const key = name.toLowerCase();
    return this.viewingCardDetails().get(key) ?? this.comboFinderCardDetails().get(key);
  }

  previewCardImageUrl(): string | null {
    const name = this.previewCardName();
    return name ? this.cardImageUrlFor(name) : null;
  }

  previewCardBackImageUrl(): string | null {
    const name = this.previewCardName();
    return name ? this.cardBackImageUrlFor(name) : null;
  }

  /** Löst den EDHREC-Kartennamen zu vollen Scryfall-Daten auf (EDHREC selbst liefert nur Name+Statistik) und staged ihn wie addCard(). */
  async addEdhrecCard(cardName: string): Promise<void> {
    this.addCardBusy.set(true);
    const found = await this.cardData.findCard(cardName);
    this.addCardBusy.set(false);
    if (!found) {
      this.addCardMessage.set(this.i18n.t('deckViewer.msg.notFoundOnScryfall', { name: cardName }));
      return;
    }
    this.addCard(found);
  }

  private async reloadDeckCards(): Promise<void> {
    const deck = this.viewingDeck();
    if (!deck) return;
    const [cards, log] = await Promise.all([
      this.deckService.loadDeckCards(deck.id),
      this.deckService.loadChangeLog(deck.id),
    ]);
    this.viewingDeckCards.set(cards);
    this.viewingChangeLog.set(log);
    this.cardDetailsPromise = this.loadCardDetails(cards);
    this.loadBracketEstimate(cards);
    this.loadPriceForBracket(cards);
  }

  /** Löst den Besitzer eines Decks auf seine players.id über alle Gruppen hinweg auf - für die "Meine Spiele"-Filterung in getDeckStats(). */
  private async ownerPlayerIds(deck: Deck): Promise<string[]> {
    if (deck.playerId) return [deck.playerId];
    if (!deck.userId) return [];
    return this.deckService.resolvePlayerIds({ kind: 'user', userId: deck.userId });
  }

  /**
   * Spielstatistik für den Umfang. Besitzer ohne Spieler-Eintrag hat nie gespielt - eine leere
   * Liste hieße sonst "kein Filter".
   */
  private async deckStatsFor(deck: Deck, scope: 'mine' | 'all'): Promise<DeckGameStats> {
    if (scope === 'all') return this.deckService.getDeckStats(deck.id);
    const pilots = await this.ownerPlayerIds(deck);
    if (pilots.length === 0) return { games: 0, wins: 0, winRate: 0 };
    return this.deckService.getDeckStats(deck.id, pilots);
  }

  async open(deck: Deck): Promise<void> {
    // History-Eintrag nur beim ersten Öffnen (open() lädt auch neu).
    if (!this.historyEntryOpen) {
      this.historyEntryOpen = true;
      history.pushState({ ...history.state, deckDetail: true }, '');
      // Die Detailansicht ersetzt jetzt den Tab-Inhalt im selben Dokument - ohne das hier bliebe
      // die Scrollposition der Deckliste stehen und das Deck öffnete sich mitten im Inhalt.
      this.scrollBeforeOpen = window.scrollY;
      window.scrollTo({ top: 0 });
    }
    this.viewingDeck.set(deck);
    this.deckNameDraft.set(deck.name);
    this.deckTagDraft.set(deck.edhrecTag);
    this.deckFormatDraft.set(deck.format);
    this.deckInfoSaving.set(false);
    this.detailBusy.set(true);
    this.showChangeLog.set(false);
    this.selectedChangeGroupKey.set(null);
    // Jedes Deck beginnt bei der Kartenliste - der Primer des vorigen Decks stünde sonst kurz
    // unter dem neuen Namen.
    this.deckTab.set('cards');
    // Bewusst ohne await: Der Primer hängt an keiner anderen Ladeoperation, und ob es ihn gibt,
    // entscheidet nur darüber, ob Fremde den Reiter überhaupt sehen (siehe DeckPrimerService).
    this.primer.load(deck.id);
    // Dasselbe für die zwei Sätze des Steckbriefs - sie hängen an derselben decks-Zeile.
    this.steckbriefTexte.load(deck.id);
    this.showDeckStatsInfo.set(false);
    this.showDeckAnalysis.set(false);
    // Wie die anderen Info-Klappen daneben: eingeklappt starten. Blieb die Begründung offen,
    // stünde beim nächsten Deck sofort eine seitenlange Erklärung über der Kartenliste.
    this.showBracketWhy.set(false);
    this.bracketMathTopic.set(null);
    this.resetCardFilters();
    this.effectFilterBusy.set(false);
    this.editMode.set(false);
    this.showCommanderToggle.set(false);
    this.artworkPickerCard.set(null);
    this.artworkOptions.set([]);
    this.tagEditorCard.set(null);
    this.tagEditorNewTag.set('');
    this.pendingChanges.set(new Map());
    this.pendingCommanderChanges.set(new Map());
    this.pendingMaybeboardChanges.set(new Map());
    this.commanderMarkError.set(null);
    this.tokenScanMessage.set(null);
    this.tokenScanBusy.set(false);
    this.flashState.set(null);
    this.addCardResults.set([]);
    this.addCardResultsPage.set(0);
    this.addCardMessage.set('');
    this.addCardMode.set('search');
    this.edhrecRefreshTick.update((v) => v + 1);
    this.edhrecLists.set(null);
    this.edhrecCardDetails.set(new Map());
    this.edhrecCategoryImagesBusy.set(new Set());
    this.edhrecBrowseTagActive.set(false);
    this.edhrecBrowseTag.set(null);
    this.edhrecAvailableTags.set([]);
    this.edhrecTagsBusy.set(false);
    this.edhrecBusy.set(false);
    this.edhrecFailed.set(false);
    this.showDeckAnalysisInfo.set(false);
    this.viewingCardDetails.set(new Map());
    this.flippedDeckCardKeys.set(new Set());
    this.spellbookCombos.set([]);
    this.winningCombos.set(0);
    this.bracketEstimate.set(null);
    this.bracketEstimateFailed.set(false);
    this.bracketEstimateErrorDetail.set(null);
    this.viewMode.set('visual');
    this.cardSortMode.set('type');
    this.totalDeckPrice.set(null);
    this.deckPriceIncomplete.set(false);
    this.tagBasedEffectStats.set(null);
    this.effectCategoryPopup.set(null);
    this.deckStatsScope.set('mine');

    const [cards, log, gameStats] = await Promise.all([
      this.deckService.loadDeckCards(deck.id),
      this.deckService.loadChangeLog(deck.id),
      this.deckStatsFor(deck, 'mine'),
    ]);

    this.viewingDeckCards.set(cards);
    this.viewingChangeLog.set(log);
    this.viewingDeckGameStats.set(gameStats);
    this.detailBusy.set(false);

    this.cardDetailsPromise = this.loadCardDetails(cards);
    this.loadBracketEstimate(cards);
    this.loadPriceForBracket(cards);
    this.analysisExtrasLoaded = false;
  }

  /** Schaltet die Spiel-Statistik-Kacheln zwischen "Partien des Besitzers" und "alle Partien mit diesem Deck" um. */
  async setDeckStatsScope(scope: 'mine' | 'all'): Promise<void> {
    const deck = this.viewingDeck();
    if (!deck || this.deckStatsScope() === scope) return;
    this.deckStatsScope.set(scope);
    this.viewingDeckGameStats.set(await this.deckStatsFor(deck, scope));
  }

  /** Laufender loadCardDetails()-Aufruf, falls einer läuft - siehe ensureCardDetailsLoaded(). */
  private cardDetailsPromise: Promise<void> | null = null;

  /** Lädt Manakosten/Farbidentität/Game-Changer-Flag/Oracle-Text nach - unabhängig vom Kartenbild-Laden, da für die Deck-Analyse (Kurve/Pips/Tutoren) benötigt. */
  private async loadCardDetails(cards: DeckCard[]): Promise<void> {
    this.analysisBusy.set(true);
    // Hier statt in open(), damit die Vorschläge auch nach einer Bearbeitung neu gerechnet werden.
    this.comboFinderLoaded = false;
    this.comboFinderOpen.set(false);
    this.comboFinderDetail.set(null);
    this.comboFinderSuggestions.set([]);
    this.comboFinderTotal.set(0);
    this.comboFinderAvailable.set(true);
    this.comboFinderCardDetails.set(new Map());
    const names = [...new Set(cards.map((c) => c.cardName))];
    // Markierungen und Combos parallel, damit sie die Kartendetails nicht verzögern.
    const commanderNames = cards.filter((c) => c.isCommander).map((c) => c.cardName);
    const [found, flags, combos, gewinnCombos, benchmark] = await Promise.all([
      this.cardData.findCardsBulk(names),
      this.cardData.spellbookCardFlags(),
      this.cardData.twoCardCombosFor(names),
      this.cardData.winningCombosIn(names, commanderNames),
      this.cardData.bracketBenchmark(),
    ]);
    this.bracketBenchmark.set(benchmark);
    this.viewingCardDetails.set(found);
    this.spellbookCardFlags.set(flags);
    this.spellbookCombos.set(combos);
    this.winningCombos.set(gewinnCombos);
    this.analysisBusy.set(false);
  }

  /**
   * Wartet auf laufende Scryfall-Zusatzdaten (Rückseiten) - für den PDF-Export direkt nach dem
   * Öffnen.
   */
  async ensureCardDetailsLoaded(): Promise<void> {
    if (this.cardDetailsPromise) await this.cardDetailsPromise;
  }

  /**
   * Preis schon beim Öffnen laden, aber nur bei Commander-Decks (Kriterium fürs Bracket); sonst
   * erst beim Aufklappen der Analyse. Ohne await - bracketAnalysis rechnet sich nach.
   */
  private loadPriceForBracket(cards: DeckCard[]): void {
    if (this.showsBracket()) void this.ensureCardPricesLoaded(cards);
  }

  /** Laufender/abgeschlossener Preisabruf dieser Deck-Öffnung - siehe ensureCardPricesLoaded(). */
  private pricePromise: Promise<void> | null = null;

  /** Preisabruf höchstens einmal je Öffnung (gebraucht für Bracket und Analyse-Anzeige). */
  private ensureCardPricesLoaded(cards: DeckCard[]): Promise<void> {
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

  /**
   * Die 12 Effekt-Kategorien per Scryfall-Tag/Text (Tutor/Extra-Runde/MLD laufen lokal). Ramp ohne
   * Länder.
   *
   * Keine Unter-Tags aufzählen: otag: ist hierarchisch, Unter-Tags matchen das Eltern-Tag (geprüft,
   * Trefferzahlen gleich). Die Aufzählung machte die Abfrage nur länger und drückte die Namen je
   * Anfrage im Rückfallpfad (800 Zeichen). Die ODER-Listen in commander-archetype-filters.ts sind
   * etwas anderes und bleiben.
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
        count: countOf(this.tutorCards()),
        cards: this.tutorCards(),
      },
      {
        key: 'extraturn',
        labelKey: 'deckView.extraTurnsTitle',
        count: countOf(this.extraTurnCards()),
        cards: this.extraTurnCards(),
      },
      {
        key: 'mld',
        labelKey: 'deckView.massLandDenialTitle',
        count: countOf(this.massLandDenialCards()),
        cards: this.massLandDenialCards(),
      },
    ];
  });

  /**
   * Klassifiziert das Deck in die 12 Tag-Kategorien aus dem eigenen Bestand (CardDataService,
   * Nachtlauf) - zwei Abfragen statt früher ~100 Scryfall-Suchen. Scryfall bleibt Rückfall für
   * unbekannte Karten (frische Spoiler) und bei DB-Ausfall.
   */
  private async loadEffectCategoryCounts(cards: DeckCard[]): Promise<void> {
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

    const categories = DeckViewerService.EFFECT_TAG_CATEGORIES;
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

  /** Lädt Mass-Land-Denial/Extra-Turn/Combo-Auswertung von Commander Spellbook nach (siehe bracketEstimate). */
  private async loadBracketEstimate(cards: DeckCard[]): Promise<void> {
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

  close(): void {
    // Ohne offene Ansicht nichts tun - sonst würde ein Aufruf ins Leere die gespeicherte
    // Scrollposition wiederherstellen und die Seite darunter grundlos verschieben.
    if (!this.viewingDeck() && !this.historyEntryOpen) return;
    if (this.historyEntryOpen) {
      this.historyEntryOpen = false;
      this.ignoreNextPop = true;
      history.back();
    }
    this.resetViewingState();
  }

  /** Der eigentliche Aufräum-Teil von close() - ohne History, damit ihn auch der popstate-Handler nutzen kann. */
  private resetViewingState(): void {
    // Erst nach dem Neuaufbau der darunterliegenden Ansicht scrollen, sonst ist die Seite dafür
    // noch zu kurz.
    const scrollBack = this.scrollBeforeOpen;
    setTimeout(() => window.scrollTo({ top: scrollBack }));
    this.viewingDeck.set(null);
    this.deckTab.set('cards');
    this.primer.zuruecksetzen();
    this.steckbriefTexte.zuruecksetzen();
    this.deckNameDraft.set('');
    this.deckTagDraft.set(null);
    this.deckInfoSaving.set(false);
    this.viewingDeckCards.set([]);
    this.viewingChangeLog.set([]);
    this.viewingDeckGameStats.set(null);
    this.deckStatsScope.set('mine');
    this.viewingCardDetails.set(new Map());
    this.flippedDeckCardKeys.set(new Set());
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
    this.tagBasedEffectStats.set(null);
    this.effectCategoryCountsBusy.set(false);
    this.effectCategoryProgress.set(null);
    this.effectCategoryPopup.set(null);
    this.analysisExtrasLoaded = false;
    this.editMode.set(false);
    this.showCommanderToggle.set(false);
    this.artworkPickerCard.set(null);
    this.artworkOptions.set([]);
    this.tagEditorCard.set(null);
    this.tagEditorNewTag.set('');
    this.pendingChanges.set(new Map());
    this.pendingCommanderChanges.set(new Map());
    this.pendingMaybeboardChanges.set(new Map());
    this.commanderMarkError.set(null);
    this.tokenScanMessage.set(null);
    this.tokenScanBusy.set(false);
    this.flashState.set(null);
    this.addCardResults.set([]);
    this.addCardResultsPage.set(0);
    this.addCardMessage.set('');
    this.addCardMode.set('search');
    this.edhrecRefreshTick.update((v) => v + 1);
    this.edhrecLists.set(null);
    this.edhrecCardDetails.set(new Map());
    this.edhrecCategoryImagesBusy.set(new Set());
    this.edhrecBrowseTagActive.set(false);
    this.edhrecBrowseTag.set(null);
    this.edhrecAvailableTags.set([]);
    this.edhrecTagsBusy.set(false);
    this.edhrecBusy.set(false);
    this.edhrecFailed.set(false);
  }

  toggleChangeLog(): void {
    this.showChangeLog.update((v) => !v);
  }

  selectChangeGroup(changedAt: string): void {
    this.selectedChangeGroupKey.set(changedAt);
  }

  /**
   * Die in einer Bearbeitung hinzugefügten Karten als PDF-Druckliste; fehlende Bilder (Karte schon
   * wieder raus) über Scryfall nachladen.
   */
  async addedCardsForPrint(group: DeckChangeGroup): Promise<PdfSourceCard[]> {
    this.changeGroupPrintBusy.set(true);
    try {
      await this.ensureCardDetailsLoaded();
      const inDeck = new Map(this.viewingDeckCards().map((c) => [c.cardName.toLowerCase(), c]));

      const cards: PdfSourceCard[] = group.added.map((entry) => {
        const card = inDeck.get(entry.cardName.toLowerCase());
        return {
          cardName: entry.cardName,
          quantity: entry.quantity,
          imageUrl: card ? this.resolvedCardPrintImage(card) : null,
          backImageUrl: card ? this.resolvedCardBackPrintImage(card) : null,
          isToken: card?.isToken,
          oracleId: card?.scryfallOracleId,
        };
      });

      const missing = cards.filter((c) => !c.imageUrl).map((c) => c.cardName);
      if (missing.length === 0) return cards;

      const found = await this.cardData.findCardsBulk(missing);
      return cards.map((c) => {
        if (c.imageUrl) return c;
        const scryfallCard = found.get(c.cardName.toLowerCase());
        return {
          ...c,
          imageUrl: scryfallCard?.imageUrl ?? null,
          backImageUrl: scryfallCard?.backImageUrl ?? null,
        };
      });
    } finally {
      this.changeGroupPrintBusy.set(false);
    }
  }

  toggleDeckStatsInfo(): void {
    this.showDeckStatsInfo.update((v) => !v);
  }

  /**
   * Ob Preis/Effekt-Kategorien schon angestoßen sind - erst beim ersten Aufklappen der Analyse, um
   * Scryfall-Anfragen und Rate-Limit-Konkurrenz zu sparen.
   */
  private analysisExtrasLoaded = false;

  toggleDeckAnalysis(): void {
    this.showDeckAnalysis.update((v) => !v);
    if (this.showDeckAnalysis() && !this.analysisExtrasLoaded) {
      this.analysisExtrasLoaded = true;
      const cards = this.viewingDeckCards();
      // Nacheinander statt parallel - sonst konkurrieren beide direkt beim Aufklappen um Scryfalls
      // Rate-Limit. Preis zuerst, da meist deutlich schneller fertig als die 12 Effekt-Kategorien.
      (async () => {
        await this.ensureCardPricesLoaded(cards);
        await this.loadEffectCategoryCounts(cards);
      })();
    }
  }

  toggleDeckAnalysisInfo(): void {
    this.showDeckAnalysisInfo.update((v) => !v);
  }

  readonly reanalyzeBusy = signal(false);

  /**
   * Lädt die komplette Analyse für den aktuellen Kartenbestand neu (Änderungen wirken sich nicht
   * automatisch aus).
   */
  async reanalyzeDeck(): Promise<void> {
    if (!this.viewingDeck()) return;
    this.reanalyzeBusy.set(true);
    const cards = this.viewingDeckCards();
    this.pricePromise = null;
    this.cardDetailsPromise = this.loadCardDetails(cards);
    this.loadBracketEstimate(cards);
    // Nacheinander statt parallel - siehe toggleDeckAnalysis().
    await this.ensureCardPricesLoaded(cards);
    await this.loadEffectCategoryCounts(cards);
    this.reanalyzeBusy.set(false);
  }
}
