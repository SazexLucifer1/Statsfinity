import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { DeckService, Deck, DeckCard, DeckChangeEntry, DeckGameStats } from './deck.service';
import { ScryfallService, ScryfallCard, ScryfallPrinting } from './scryfall.service';
import { CardDataService, SpellbookCardFlags, SpellbookTwoCardCombo } from './card-data.service';
import {
  AUTO_BRACKET_MAX,
  BracketAnalysis,
  BracketCard,
  TUNING_BUMP_SCHWELLE,
  analyzeBracket,
  powerRange,
  presentCombos,
} from './bracket';
import { comboSteps, fitsColorIdentity, groupSuggestions } from './combo-finder';
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
import { I18nService } from './i18n.service';
import { COMMANDER_ARCHETYPE_FILTERS } from './commander-archetype-filters';
import { ColorSelection, EMPTY_COLOR_SELECTION, matchesColorSelection } from './color-filter-match';
import { BarChartDatum } from './ui/bar-chart/bar-chart';
import {
  manaCurveChartData,
  pipChartData,
  typeChartData,
} from './ui/bar-chart/deck-chart-data';
import { DeckFormat, DECK_FORMATS } from './models';

export interface ManaCurveBucket {
  label: string;
  count: number;
}

export interface PipCount {
  color: 'W' | 'U' | 'B' | 'R' | 'G';
  label: string;
  count: number;
}

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
 * Eine Zwei-Karten-Combo, wie das Combo-Fenster sie zeigt - aus der Live-Auswertung von Commander
 * Spellbook oder aus dem nächtlichen Abgleich zusammengeführt (siehe analysisCombos). produces und
 * description sind leer, wenn die Combo aus dem Nachtlauf stammt; extraMana und bracketLabel sind
 * umgekehrt nur dort bekannt.
 */
export interface AnalysisCombo {
  id: string;
  cardNames: string[];
  produces: string[];
  /**
   * Der Ablauf als einzelne Schritte. Spellbook liefert ihn als einen Text mit einem
   * Zeilenumbruch je Schritt; aufgeteilt ist er als nummerierte Liste zu lesen, und die
   * Beschreibungen verweisen selbst auf Schrittnummern ("Repeat from step 4").
   */
  steps: string[];
  extraMana: number | null;
  bracketLabel: string | null;
}

/**
 * Eine Karte, die das Deck noch NICHT hat und die dort neue Combos ergäbe - ein Eintrag des
 * Combo-Finders, fertig für die Anzeige.
 */
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
  /**
   * Die Karten der Combo, die schon im Deck liegen - als Anzeigenamen, damit sie im Karten-Raster
   * mit Bild erscheinen können.
   */
  presentCardNames: string[];
  /** Was die Combo am Ende erzeugt ("Infinite mana", ...). Leer, wenn die Quelle nichts nennt. */
  produces: string[];
  /** Der Ablauf als nummerierbare Schritte - Grundlage des "Ablauf anzeigen"-Fensters. */
  steps: string[];
  /** Zusätzlich nötiges Mana, um die Combo abzuschließen. */
  extraMana: number | null;
}

export interface TypeBreakdownEntry {
  type: string;
  label: string;
  count: number;
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
 * Hält den Zustand der Deck-Detail-Vollbildansicht global (statt lokal in DeckList), damit die
 * Ansicht als eigene, root-level gerenderte Komponente existieren kann (analog IngameTracker in
 * app.html) - nur so lässt sich echtes position:fixed über den ganzen Viewport erreichen, ohne von
 * einem `.glass-card`-Vorfahren mit backdrop-filter eingefangen zu werden (backdrop-filter/filter/
 * transform auf einem Ahnen macht diesen zum Containing Block für fixed-Kinder).
 */
/**
 * Zeitlicher Abstand, ab dem zwei aufeinanderfolgende Verlaufseinträge als zwei getrennte
 * Bearbeitungen gelten - siehe DeckViewerService.changeLogGroups().
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

/**
 * Welches der vier Einzelurteile im Bracket-Kasten gerade seinen Rechenweg zeigt. Jedes Urteil hat
 * sein eigenes ⓘ direkt neben der Zahl - vorher stand die ganze Kette in einem einzigen Popup.
 */
export type BracketMathTopic = 'rules' | 'spellbook' | 'tuning' | 'power';

@Injectable({ providedIn: 'root' })
export class DeckViewerService {
  private readonly deckService = inject(DeckService);
  private readonly scryfall = inject(ScryfallService);
  private readonly cardData = inject(CardDataService);
  private readonly commanderSpellbook = inject(CommanderSpellbookService);
  private readonly edhrec = inject(EdhrecService);
  private readonly auth = inject(AuthService);
  private readonly groupService = inject(GroupService);
  private readonly mtg = inject(MtgService);
  readonly i18n = inject(I18nService);

  readonly viewingDeck = signal<Deck | null>(null);

  /**
   * Die Deck-Detailansicht ist kein Popup mehr, sondern eine eigene Seite im Inhaltsbereich
   * (siehe app.html). Damit sie sich auch mit der Zurück-Geste/-Taste des Browsers schließen
   * lässt - die App hat bewusst keinen Router und damit keine echten URLs - legt open() einen
   * zusätzlichen History-Eintrag an, den close() wieder entfernt.
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
   * Ob das gerade angesehene Deck bearbeitet werden darf - entweder weil es dem eingeloggten User
   * selbst gehört, oder weil es einem virtuellen Spieler ohne Account gehört UND der eingeloggte
   * User der Admin ("owner") von GENAU DER GRUPPE ist, in der dieser Spieler steckt (nicht
   * irgendeiner beliebigen anderen Gruppe, die er zufällig auch leitet). Alle Bearbeiten-Aktionen
   * (Karten hinzufügen/entfernen, Commander markieren, Name/Tag ändern, neu einfügen) sind sonst
   * gesperrt. Wichtig für "Profil ansehen" bei anderen Usern: die Deckliste dort ist zwar
   * readonlyMode (kein Stift/Löschen-Button) für Nicht-Admins, aber "Ansehen" öffnet dieselbe
   * Detailansicht wie bei eigenen Decks - ohne diesen Check ließe sich darüber trotzdem fremde
   * Decks bearbeiten.
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

  /** Ob die Spiel-Statistiken (Gespielt/Siege/Winrate) des gerade angesehenen Decks ausgeblendet
   * werden müssen, weil der Host dem eingeloggten Viewer in der Sichtbarkeits-Matrix alle Modi
   * gesperrt hat - eigene Decks und der Host sind ausgenommen. */
  readonly hideViewingDeckStats = computed(() => {
    if (this.canEditViewingDeck()) return false;
    return this.mtg.allModesHiddenForMe() && !this.groupService.isOwner();
  });
  readonly viewingDeckCards = signal<DeckCard[]>([]);
  readonly viewingChangeLog = signal<DeckChangeEntry[]>([]);
  /**
   * Verlauf nach Bearbeitungen gruppiert statt als eine lange Liste einzelner Zeilen.
   *
   * Nicht nach exakt gleichem Zeitstempel: Nur der Listen-Neuimport (DeckService.saveDeck)
   * schreibt alle Änderungen in EINEM insert und damit mit identischem changed_at. Der normale
   * Bearbeiten-Speichern-Weg (saveEdits -> addCardToDeck/removeCardFromDeck) schreibt dagegen pro
   * Karte eine eigene Zeile, jede mit ihrem eigenen now() - Millisekunden bis wenige Sekunden
   * auseinander. Exakte Gleichheit würde einen einzigen Speichervorgang deshalb in lauter
   * Ein-Karten-Reiter zerlegen. Stattdessen gehören aufeinanderfolgende Einträge zusammen, solange
   * zwischen ihnen höchstens CHANGE_GROUP_GAP_MS liegen - das fasst beide Schreibwege korrekt
   * zusammen und trennt zwei wirklich getrennte Bearbeitungen weiterhin.
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
        groups.push({ changedAt: entry.changedAt, added: [], removed: [], addedCount: 0, removedCount: 0 });
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
  /** "mine" = nur Partien, in denen der eingeloggte Nutzer selbst Pilot war (nicht zwingend Deck-Besitzer, siehe resolveMyPlayerIds()). */
  readonly deckStatsScope = signal<'mine' | 'all'>('mine');
  readonly detailBusy = signal(false);
  readonly viewMode = signal<'text' | 'visual'>('visual');
  readonly showChangeLog = signal(false);
  readonly showDeckStatsInfo = signal(false);
  readonly showDeckAnalysis = signal(false);
  readonly showDeckAnalysisInfo = signal(false);

  // NEU - Name/Tag sind immer (nicht nur im Bearbeitungsmodus) im Kopfbereich der Detailansicht
  // änderbar, damit dafür kein separater Dialog mehr nötig ist (siehe deck-list.ts, der frühere
  // Stift-Button wurde entfernt).
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
      .reduce((sum, c) => sum + c.quantity, 0)
  );

  /** Gespeicherte Deck-Karten ohne Maybeboard/Marken - Basis für sämtliche Deck-Analysen (Kurve, Pips, Game-Changer, Tutoren, Bracket-Schätzung). */
  private readonly analysisDeckCards = computed(() =>
    this.viewingDeckCards().filter((c) => !c.isMaybeboard && !c.isToken)
  );

  /** Nicht-Land-Karten - Basis für Manakurve, Pip-Verteilung und Game-Changer-Auswertung. */
  private readonly nonLandCards = computed(() =>
    this.analysisDeckCards().filter((c) => !(c.typeLine ?? '').includes('Land'))
  );

  readonly manaCurve = computed<ManaCurveBucket[]>(() => {
    const buckets = [0, 1, 2, 3, 4, 5, 6].map((cmc) => ({ label: `${cmc}`, count: 0 }));
    const sevenPlus = { label: '7+', count: 0 };
    for (const card of this.nonLandCards()) {
      const bucket = card.cmc >= 7 ? sevenPlus : buckets[Math.min(6, Math.max(0, Math.round(card.cmc)))];
      bucket.count += card.quantity;
    }
    return [...buckets, sevenPlus];
  });

  /** Durchschnittliche Manakosten ohne Länder (die würden mit ihren 0 Manakosten den Schnitt künstlich nach unten verfälschen). */
  readonly averageCmc = computed<number | null>(() => {
    const cards = this.nonLandCards();
    const totalQty = cards.reduce((sum, c) => sum + c.quantity, 0);
    if (totalQty === 0) return null;
    const totalCmc = cards.reduce((sum, c) => sum + c.cmc * c.quantity, 0);
    return totalCmc / totalQty;
  });

  /** Land-Karten (inkl. Basisländer) - Basis für Landzahl und Nichtbasis-Land-Anteil. */
  private readonly landCards = computed(() =>
    this.analysisDeckCards().filter((c) => (c.typeLine ?? '').includes('Land'))
  );

  readonly landCount = computed(() => this.landCards().reduce((sum, c) => sum + c.quantity, 0));

  /** Anteil Nichtbasisländer an allen Ländern (0-100), null ohne Länder im Deck. */
  readonly nonBasicLandPercent = computed<number | null>(() => {
    const lands = this.landCards();
    const total = lands.reduce((sum, c) => sum + c.quantity, 0);
    if (total === 0) return null;
    const nonBasic = lands
      .filter((c) => !(c.typeLine ?? '').includes('Basic'))
      .reduce((sum, c) => sum + c.quantity, 0);
    return Math.round((nonBasic / total) * 100);
  });

  // Ein Land kommt bedingungslos getappt, wenn sein Regeltext "enters tapped" sagt und die Karte
  // keinen Ausweg anbietet. Die Ausnahmen trennen genau die Premium-Länder ab, die formal denselben
  // Satz tragen: Schockländer ("unless you pay 2 life"), Check- und Slowlands ("unless you control
  // ...") und Fastlands ("unless you control two or fewer other lands"). Die alte Scryfall-Formel
  // "enters the battlefield tapped" ist mit abgedeckt, falls einzelne Karten noch nicht auf die
  // neue Schablone umgestellt sind.
  private static readonly ENTERS_TAPPED_RE = /enters (?:the battlefield )?tapped/i;
  private static readonly TAPPED_AUSNAHME_RE = /unless|you may pay/i;

  /**
   * Anteil Länder, die nicht bedingungslos getappt ins Spiel kommen (0-100), null ohne Länder.
   *
   * Das ist das Tempo-Maß der Manabasis - nicht der Nichtbasis-Anteil: Ein Precon steckt voller
   * Guildgates, Triomes und Tempel, also Nichtbasisländern, die das Deck gerade langsam machen.
   * Gemessen an echten Decks liegen Precons hier bei 70-80 %.
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

  /**
   * Genau eine Kategorie pro Karte (nach fester Priorität, mehrfachtypige Karten wie "Artifact
   * Creature" landen bei der spielrelevanteren Kategorie) - Summe der Balken ergibt so immer die
   * Gesamtkartenzahl, anders als eine Mehrfachzählung über alle Typen einer Karte.
   */
  private static readonly TYPE_PRIORITY: { type: string; test: RegExp }[] = [
    { type: 'creature', test: /Creature/ },
    { type: 'planeswalker', test: /Planeswalker/ },
    { type: 'battle', test: /Battle/ },
    { type: 'land', test: /Land/ },
    { type: 'artifact', test: /Artifact/ },
    { type: 'enchantment', test: /Enchantment/ },
    { type: 'instant', test: /Instant/ },
    { type: 'sorcery', test: /Sorcery/ },
  ];

  readonly typeBreakdown = computed<TypeBreakdownEntry[]>(() => {
    const counts: Record<string, number> = {};
    for (const t of DeckViewerService.TYPE_PRIORITY) counts[t.type] = 0;

    for (const card of this.analysisDeckCards()) {
      const typeLine = card.typeLine ?? '';
      const match = DeckViewerService.TYPE_PRIORITY.find((t) => t.test.test(typeLine));
      if (match) counts[match.type] += card.quantity;
    }

    return DeckViewerService.TYPE_PRIORITY.map((t) => ({
      type: t.type,
      label: this.i18n.t(`deckView.type.${t.type}`),
      count: counts[t.type],
    }));
  });

  /** Gesamtpreis (USD, billigste Druckvariante je Karte) - null solange noch nicht geladen. */
  readonly totalDeckPrice = signal<number | null>(null);
  readonly priceBusy = signal(false);
  /**
   * Ob mindestens eine Preisabfrage gescheitert ist und die Summe deshalb zu niedrig steht - dann
   * zeigt die Kachel "ab X €" statt "X €". Bewusst KEIN Fehlerhinweis: Die Zahl ist nicht falsch,
   * sie ist nur eine Untergrenze, und genau das sagt "ab". Nicht gesetzt, wenn eine Karte
   * schlicht keinen Preis hat - das ist der Normalfall (siehe ScryfallService.cheapestPrices()).
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

  // --- Fertige Diagramm-Reihen für <app-bar-chart> ---
  //
  // Die Abbildung selbst liegt in ui/bar-chart/deck-chart-data.ts, weil precon-browser und
  // public-deck-browser dieselben drei Diagramme aus eigenen Signalen speisen. Vorher hatte jede
  // der drei Komponenten eigene curveBarHeight/pipBarWidth/typeBarWidth-Methoden mit identischem
  // Rumpf - dreimal dieselbe Skalierungsformel.
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

  private static readonly PIP_COLORS: PipCount['color'][] = ['W', 'U', 'B', 'R', 'G'];

  readonly pipDistribution = computed<PipCount[]>(() => {
    const details = this.viewingCardDetails();
    const counts: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const card of this.nonLandCards()) {
      const manaCost = details.get(card.cardName.toLowerCase())?.manaCost;
      if (!manaCost) continue;
      const symbols = manaCost.match(/\{([^}]+)\}/g) ?? [];
      for (const symbol of symbols) {
        const parts = symbol.slice(1, -1).split('/');
        for (const part of parts) {
          if (part in counts) counts[part] += card.quantity;
        }
      }
    }
    return DeckViewerService.PIP_COLORS.map((color) => ({
      color,
      label: this.i18n.t(`pip.${color}`),
      count: counts[color],
    }));
  });

  private static readonly MANA_SOURCE_COLORS: ManaSourceCount['color'][] = ['W', 'U', 'B', 'R', 'G', 'C'];

  /** Karten (inkl. Länder), die laut Scryfall überhaupt Mana erzeugen können - Basis der Manaquellen-Auswertung. */
  private readonly manaSourceCards = computed(() => {
    const details = this.viewingCardDetails();
    return this.analysisDeckCards().filter(
      (c) => (details.get(c.cardName.toLowerCase())?.producedMana?.length ?? 0) > 0,
    );
  });

  /**
   * Gegenstück zur Pip-Verteilung: nicht was das Deck an Mana *kostet*, sondern was es an Mana
   * *erzeugt*. Gezählt werden Karten (mit ihrer Anzahl), nicht Manasymbole - eine Karte, die
   * mehrere Farben erzeugen kann (Triom, Sol-Ring-artige Länder, "Mana jeder Farbe"), zählt
   * deshalb bei jeder dieser Farben mit; die Balkensumme ist entsprechend größer als die Zahl der
   * Manaquellen. Grundlage ist Scryfalls produced_mana, das Länder, Manasteine und Manadorks
   * gleichermaßen abdeckt.
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
    this.gameChangerCards().reduce((sum, c) => sum + c.quantity, 0)
  );

  /**
   * Grobe Einordnung ausschließlich anhand der offiziellen Game-Changer-Grenzwerte
   * (Bracket 1-2: keine, Bracket 3: bis zu 3, Bracket 4-5: unbegrenzt). Ergänzt durch die
   * Commander-Spellbook-Auswertung (Mass Land Denial, Extra-Turns, Combos) weiter unten -
   * Tutor-Dichte lässt sich damit immer noch nicht scharf gewichten, deshalb bleibt das ein
   * Richtwert statt einer verbindlichen Einstufung.
   */
  readonly estimatedBracketHint = computed(() => {
    const count = this.gameChangerCount();
    if (count === 0) return this.i18n.t('deckViewer.bracketHint13');
    if (count <= 3) return this.i18n.t('deckViewer.bracketHintMin3');
    return this.i18n.t('deckViewer.bracketHint45');
  });

  /**
   * Kuratierte Kartenmarkierungen von Commander Spellbook (Mass Land Denial, Extra-Turns,
   * Tutoren), gespiegelt vom Nachtlauf - siehe CardDataService.spellbookCardFlags(). Leer, solange
   * die Migration nicht ausgeführt oder der erste Lauf nicht durch ist.
   */
  readonly spellbookCardFlags = signal<Map<string, SpellbookCardFlags>>(new Map());

  /**
   * Rückfall-Erkennung für Tutoren, solange spellbookCardFlags() noch leer ist. Reine
   * Texterkennung im Oracle-Text und damit nur eine Näherung ("search your library for ...") -
   * genau deshalb hat die kuratierte Liste sie abgelöst. Sie steht hier nur noch, damit die
   * Tutoren-Anzeige zwischen Merge und erstem Nachtlauf nicht kommentarlos leer bleibt.
   */
  private static readonly TUTOR_RE =
    /search(?:es)?\s+(?:your|a|their|that player'?s)\s+library\s+for/i;
  // Erfasst neben "... for a land card" auch Karten, die eine Basisland-Art direkt beim Namen
  // nennen statt "land" zu schreiben (z.B. Farseek: "... for a Plains, Island, Swamp, or
  // Mountain card"; Landcycling-Karten: "... for a Forest card").
  private static readonly LAND_TUTOR_RE =
    /search(?:es)?\s+(?:your|a|their|that player'?s)\s+library\s+for\s+(?:up to \w+\s+)?(?:an?|the|\d+)?\s*(?:[a-z]+\s+){0,2}(?:lands?|plains|islands?|swamps?|mountains?|forests?)\b/i;

  /**
   * Tutoren (außer für Länder, wie im offiziellen Bracket-Kriterium).
   *
   * Quelle ist Commander Spellbooks kuratierte Liste, die der Nachtlauf spiegelt - das offizielle
   * Kriterium meint genau diese Auswahl, und Scryfall hat dafür kein eigenes Flag (anders als bei
   * Game Changers). Solange die Liste noch nicht da ist, greift die Textnäherung von oben, damit
   * die Anzeige nicht still leer läuft.
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
   * Mass Land Denial, Extra-Turns und Zwei-Karten-Combos kommen von Commander Spellbooks
   * Bracket-API (über unseren eigenen Server-Proxy, siehe commander-spellbook.service.ts) - das
   * ist die einzige praktikable Quelle dafür, eine reine Kartenlisten-Heuristik wäre hier zu
   * unzuverlässig. Bleibt null, wenn der Aufruf fehlschlägt (z.B. lokale Entwicklung ohne
   * Cloudflare Pages Functions, oder Commander Spellbook nicht erreichbar) - die übrige Analyse
   * bleibt davon unberührt.
   */
  readonly bracketEstimate = signal<BracketEstimate | null>(null);
  readonly bracketEstimateBusy = signal(false);
  readonly bracketEstimateFailed = signal(false);
  readonly bracketEstimateErrorDetail = signal<string | null>(null);

  /**
   * Mass Land Denial und Extra-Turn-Karten kommen aus der gespiegelten, kuratierten Liste - damit
   * sind sie ohne Netzwerkaufruf verfügbar und stehen auch dann, wenn Commander Spellbook gerade
   * nicht erreichbar ist. Solange der Nachtlauf noch nichts geliefert hat, greift die bisherige
   * Live-Auswertung als Rückfall.
   */
  private cardsWithFlag(
    waehle: (f: SpellbookCardFlags) => boolean,
    ausEstimate: (c: { massLandDenial: boolean; extraTurn: boolean }) => boolean
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
      (c) => c.massLandDenial
    )
  );

  readonly extraTurnCards = computed<GameChangerEntry[]>(() =>
    this.cardsWithFlag(
      (f) => f.extraTurn,
      (c) => c.extraTurn
    )
  );

  /**
   * Zwei-Karten-Combos aus der gespiegelten Tabelle, gefiltert auf die Karten dieses Decks.
   * Grundlage der Bracket-Einstufung (siehe bracketAnalysis) - bewusst getrennt von
   * analysisCombos(), das für die Anzeige die Live-Auswertung bevorzugt, weil dort auch steht,
   * WAS eine Combo erzeugt.
   */
  readonly spellbookCombos = signal<SpellbookTwoCardCombo[]>([]);

  /**
   * ALLE im Deck gefundenen Combos für die Anzeige, aus beiden Quellen auf eine Form gebracht:
   * bevorzugt die Live-Auswertung (die als einzige weiß, WAS eine Combo erzeugt und wie sie
   * abläuft), sonst die Paare aus dem Nachtlauf.
   *
   * Bewusst ohne Spellbooks Zwei-Karten-Kennzeichen vorgefiltert: das zählt eine Combo auch dann
   * als "arguably two-card", wenn eine der drei Karten der Commander ist - unter der Überschrift
   * "Zwei-Karten-Combos" standen dadurch Combos mit drei Karten. Die Aufteilung macht jetzt
   * schlicht die Anzahl der beteiligten Karten (siehe twoCardComboList/moreCardComboList).
   */
  readonly analysisCombos = computed<AnalysisCombo[]>(() => {
    const live = this.bracketEstimate()?.combos ?? [];
    if (live.length > 0) {
      return live.map((c) => ({
        id: c.cardNames.join('+'),
        cardNames: c.cardNames,
        produces: c.produces,
        steps: c.description
          .split('\n')
          .map((step) => step.trim())
          .filter(Boolean),
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
    this.analysisCombos().filter((c) => c.cardNames.length <= 2)
  );

  /** Alle übrigen Combos: drei oder mehr beteiligte Karten. */
  readonly moreCardComboList = computed(() =>
    this.analysisCombos().filter((c) => c.cardNames.length > 2)
  );

  /**
   * Welche der beiden Combo-Listen das Fenster gerade zeigt - null heißt zu. Die Combos stehen
   * nicht mehr ausgeklappt in der Analyse, dort steht nur noch ihre Anzahl.
   */
  readonly comboPopupKind = signal<'two' | 'more' | null>(null);

  readonly comboPopupCombos = computed(() =>
    this.comboPopupKind() === 'more' ? this.moreCardComboList() : this.twoCardComboList()
  );

  openComboPopup(kind: 'two' | 'more'): void {
    this.comboPopupKind.set(kind);
  }

  closeComboPopup(): void {
    this.comboPopupKind.set(null);
  }

  // --- Combo-Finder: welche Karte würde neue Combos freischalten? (siehe src/app/combo-finder.ts) ---

  /**
   * Höchstens so viele Vorschläge werden angezeigt.
   *
   * Nicht als Sparmaßnahme, sondern weil eine ungekürzte Liste nutzlos wäre: Ein
   * durchschnittliches Commander-Deck berührt so viele der rund 108.500 Combos, dass leicht
   * dreistellig viele Karten "irgendeine" Combo ergäben. Die Suche sortiert das Beste nach vorn
   * (meiste Combos, dann Beliebtheit); alles dahinter ist Rauschen. Die Gesamtzahl steht trotzdem
   * unter der Liste, damit die Kürzung sichtbar ist.
   */
  private static readonly COMBO_FINDER_MAX = 40;

  readonly comboFinderOpen = signal(false);
  readonly comboFinderBusy = signal(false);
  readonly comboFinderSuggestions = signal<ComboFinderSuggestion[]>([]);
  /** Wie viele passende Vorschläge es insgesamt gab - kann größer sein als die angezeigte Liste. */
  readonly comboFinderTotal = signal(0);
  /**
   * false = die Combo-Daten stehen noch gar nicht bereit (Migration nicht ausgeführt oder
   * Nachtlauf noch nicht gelaufen). Bewusst getrennt von "nichts gefunden": die Oberfläche sagt
   * dann, woran es liegt, statt fälschlich zu behaupten, es gäbe keine Vorschläge.
   */
  readonly comboFinderAvailable = signal(true);

  /**
   * Scryfall-Daten der vorgeschlagenen Karten, Schlüssel wie viewingCardDetails (Name in
   * Kleinschreibung). Bewusst eine eigene Signalgröße statt eines Zusatzeintrags in
   * viewingCardDetails: dort stehen ausschließlich Karten, die wirklich im Deck liegen, und
   * genau darauf verlassen sich Manakurve, Pip-Verteilung und Bracket-Rechnung.
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
   * Die Farben, in denen ein Vorschlag liegen darf.
   *
   * Erste Wahl ist die Farbidentität des Commanders - das ist im Commander die Regel, an der eine
   * Karte im Deck erlaubt ist oder nicht. Ohne gesetzten Commander (andere Formate, unvollständig
   * gepflegtes Deck) bleibt als Näherung die Vereinigung der Farbidentitäten aller Deckkarten:
   * schwächer, aber immer noch die Antwort auf "welche Farben spielt dieses Deck eigentlich".
   * null heißt "noch nicht bekannt" und schaltet die Filterung ganz ab (siehe fitsColorIdentity).
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
   * Öffnet den Combo-Finder und lädt beim ersten Mal seine Daten nach.
   *
   * Bewusst erst auf Klick statt beim Öffnen des Decks: die Suche geht über 350.000 Kartenzeilen
   * und zieht danach noch die Kartendaten aller Vorschläge nach. Wer ein Deck nur anschaut, soll
   * das nicht bezahlen.
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
          extraMana: c.manaValueNeeded,
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
   * Die automatische Einstufung des gerade offenen Decks.
   *
   * null, solange die Kartendetails noch laden: ohne sie wären weder Game Changer noch Manabeträge
   * bekannt, und das Ergebnis wäre verlässlich "Bracket 2" - was dann auch noch zurückgeschrieben
   * würde. Lieber kurz "wird berechnet" anzeigen als eine falsche Zahl festschreiben.
   */
  /**
   * Die Deck-Karten in der Form, die die Bracket-Rechnung braucht. Eigener computed, weil außer der
   * Einstufung selbst auch die Combo-Liste in der Analyse-Sektion darauf zugreift.
   */
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
   * Die im Deck vollständig vorhandenen Zwei-Karten-Combos aus der gespiegelten Tabelle.
   *
   * Deckt in der Analyse-Sektion den Fall ab, dass Commander Spellbook gerade nicht erreichbar ist:
   * dann fehlt zwar die Angabe, WAS eine Combo erzeugt, aber welche Combos im Deck stecken, wissen
   * wir aus dem Nachtlauf trotzdem.
   */
  readonly localTwoCardCombos = computed(() =>
    presentCombos(this.bracketCards(), this.spellbookCombos(), this.spellbookCardFlags())
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
      totalCards: this.viewingTotalCards(),
    });
  });

  /**
   * Was tatsächlich angezeigt wird: die selbst gewählte Stufe schlägt immer die Automatik. Ist
   * noch nichts gewählt, gilt die frisch gerechnete Einstufung - und solange die noch läuft, der
   * beim letzten Öffnen gespeicherte Wert, damit das Abzeichen nicht kurz verschwindet.
   */
  readonly effectiveBracket = computed<{ level: number; source: 'manual' | 'auto' } | null>(() => {
    const deck = this.viewingDeck();
    if (!deck || !this.showsBracket()) return null;
    if (deck.bracket != null) return { level: deck.bracket, source: 'manual' };

    const level = this.bracketAnalysis()?.bracket ?? deck.bracketAuto;
    return level != null ? { level, source: 'auto' } : null;
  });

  readonly bracketSaving = signal(false);

  /**
   * Setzt die Stufe von Hand. null = wieder automatisch bestimmen.
   *
   * Speichert sofort statt über einen Entwurf mit Speichern-Knopf - gleiche Begründung wie bei
   * setArchetype(): es ist ein einzelner Wert aus einer festen Auswahl, ein zweiter Klick zum
   * Bestätigen wäre reine Reibung.
   */
  async setBracket(bracket: number | null): Promise<void> {
    const deck = this.viewingDeck();
    if (!deck || !this.canEditViewingDeck()) return;

    this.bracketSaving.set(true);
    const ok = await this.deckService.setDeckBracket(deck.id, bracket);
    this.bracketSaving.set(false);
    if (ok) this.viewingDeck.set({ ...deck, bracket });
  }

  /**
   * Schreibt das Ergebnis der Automatik zurück, sobald es sich geändert hat.
   *
   * Nötig, damit Deck-Liste und Match-Auswahl ein Abzeichen zeigen können, ohne für jedes Deck die
   * Kartenliste nachzuladen. Bewusst an einen effect() gehängt statt an das Ende einer Ladefunktion:
   * die Einstufung hängt an mehreren unabhängig eintreffenden Quellen (Kartendetails, Markierungen,
   * Combos, Live-Zweitmeinung), und erst wenn die letzte davon da ist, steht der endgültige Wert.
   * Der Vergleich mit dem gespeicherten Wert sorgt dafür, dass daraus trotzdem höchstens ein
   * Schreibvorgang je Deck-Öffnung wird.
   */
  private readonly autoBracketPersist = effect(() => {
    const deck = this.viewingDeck();
    const analysis = this.bracketAnalysis();
    if (!deck || !analysis || analysis.bracket === deck.bracketAuto) return;
    if (!this.canEditViewingDeck()) return;

    const level = analysis.bracket;
    void this.deckService.saveDeckAutoBracket(deck.id, level).then((ok) => {
      // Lokal nachziehen, sonst liefe der effect() bei der nächsten Änderung erneut an.
      if (ok) this.viewingDeck.update((d) => (d && d.id === deck.id ? { ...d, bracketAuto: level } : d));
    });
  });

  /** Die fünf Stufen für das Auswahlfeld, in Anzeigereihenfolge. */
  readonly bracketOptions: readonly number[] = [1, 2, 3, 4, 5];

  /** Höchste Stufe, die die Automatik von sich aus vergibt - für den Hinweistext am Auswahlfeld. */
  readonly autoBracketMax = AUTO_BRACKET_MAX;

  /** Begründung der Einstufung ein-/ausklappen. */
  readonly showBracketWhy = signal(false);

  toggleBracketWhy(): void {
    this.showBracketWhy.update((v) => !v);
  }

  /**
   * Welches Einzelurteil gerade als Rechenweg-Popup offen ist - null heißt: keins.
   *
   * Die Zahlen der Einstufung erklären sich nicht von selbst: dass "Skala 70 → 95" heißt "70 gibt
   * 0 Punkte, 95 gibt 1 Punkt", dass die vier Messgrößen gemittelt werden, dass beim Manawert die
   * Skala absichtlich rückwärts läuft - nichts davon steht im Kasten. Jedes Urteil bekommt deshalb
   * ein ⓘ, das genau seine Rechnung vorrechnet, statt wie früher alle vier in einem einzigen,
   * seitenlangen Popup zu bündeln.
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

  /**
   * Was das Popup an fertigen Zahlen braucht und die Vorlage nicht selbst ausrechnen soll: die
   * Punkte als ausgeschriebene Summe, deren Teiler, und die Power-Spanne des Brackets samt Breite.
   * Alles Übrige steht schon in bracketAnalysis().
   */
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
      /** Die Befunde aus Schritt 1 - ohne die Anhebung, die im Popup als eigener Schritt 3 steht. */
      rulesReasons: analysis.reasons.filter((r) => r.key !== 'tuning'),
      /** Stufe nach den beiden Urteilen, aber VOR einer möglichen Anhebung durch die Feinbewertung. */
      baseBracket: Math.max(analysis.verdicts.rules, analysis.verdicts.spellbook ?? 0),
    };
  });

  /**
   * Beschriftung des "Automatisch"-Eintrags im Auswahlfeld. Zeigt die berechnete Stufe gleich mit
   * an, damit beim Aufklappen sichtbar ist, wogegen man sich entscheidet.
   */
  readonly bracketAutoOptionLabel = computed(() => {
    const level = this.bracketAnalysis()?.bracket ?? this.viewingDeck()?.bracketAuto;
    return level == null
      ? this.i18n.t('deckView.bracketAutoOptionPending')
      : this.i18n.t('deckView.bracketAutoOption', { level: String(level) });
  });

  /** Reihenfolge der Typ-Abschnitte (Commander steht immer separat ganz vorn). */
  private static readonly TYPE_ORDER: { label: string; test: (typeLine: string) => boolean }[] = [
    { label: 'Planeswalker', test: (t) => t.includes('Planeswalker') },
    { label: 'Battle', test: (t) => t.includes('Battle') },
    { label: 'Kreatur', test: (t) => t.includes('Creature') },
    { label: 'Spontanzauber', test: (t) => t.includes('Instant') },
    { label: 'Hexerei', test: (t) => t.includes('Sorcery') },
    { label: 'Artefakt', test: (t) => t.includes('Artifact') },
    { label: 'Verzauberung', test: (t) => t.includes('Enchantment') },
    { label: 'Land', test: (t) => t.includes('Land') },
  ];

  private categoryFor(card: DeckCard): string {
    const type = card.typeLine ?? '';
    return DeckViewerService.TYPE_ORDER.find((c) => c.test(type))?.label ?? 'Sonstiges';
  }

  /**
   * True bei Doppelkarten (Transform/Modal-DFC), deren VORDERSEITE woanders einsortiert wird (meist
   * Spontanzauber/Hexerei bei den "ZNR-Pathway"-artigen MDFCs), deren RÜCKSEITE aber ein Land ist -
   * typeLine ist bei Scryfall für solche Karten immer "Vorderseite // Rückseite" kombiniert. Die
   * Einsortierung selbst bleibt bewusst bei der Vorderseite (categoryFor prüft der Reihe nach, Land
   * steht dort zuletzt), sonst würde z.B. eine hauptsächlich als Spontanzauber gespielte Karte in der
   * Land-Sektion landen - nur die Land-ANZAHL soll diese verstecken Länder trotzdem mitzählen.
   */
  private isHiddenMdfcLand(card: DeckCard): boolean {
    if (this.categoryFor(card) === 'Land') return false;
    const backType = (card.typeLine ?? '').split(' // ')[1];
    return !!backType?.includes('Land');
  }

  /** Anzahl Karten, die zwar nicht in der Land-Sektion stehen, aber auf ihrer Rückseite ein Land sind (siehe isHiddenMdfcLand) - für den "+X"-Zusatz an der Land-Sektionsüberschrift. */
  readonly hiddenMdfcLandCount = computed(() =>
    this.editedDeckCards()
      .filter((c) => !c.isCommander && !c.isMaybeboard && !c.isToken && this.isHiddenMdfcLand(c))
      .reduce((sum, c) => sum + c.quantity, 0)
  );

  /**
   * Übersetzt einen internen Sektions-/Typ-Label-Schlüssel (z.B. "Kreatur", "Sonstiges", "Ohne
   * Tag") für die Anzeige - die Labels selbst bleiben intern immer deutsch, da sie zugleich als
   * Gruppierungs-/Filter-Schlüssel dienen (categoryFor, typeFilterValue, TYPE_TO_SCRYFALL). Nur
   * diese Anzeige-Übersetzung ist sprachabhängig.
   */
  private static readonly LABEL_KEYS: Record<string, string> = {
    Planeswalker: 'deckViewer.type.Planeswalker',
    Battle: 'deckViewer.type.Battle',
    Kreatur: 'deckViewer.type.Kreatur',
    'Legendäre Kreatur': 'deckViewer.type.LegendaereKreatur',
    Spontanzauber: 'deckViewer.type.Spontanzauber',
    Hexerei: 'deckViewer.type.Hexerei',
    Artefakt: 'deckViewer.type.Artefakt',
    Verzauberung: 'deckViewer.type.Verzauberung',
    Land: 'deckViewer.type.Land',
    Commander: 'deckViewer.type.Commander',
    Sonstiges: 'deckViewer.type.Sonstiges',
    'Ohne Tag': 'deckViewer.type.OhneTag',
    Maybeboard: 'deckViewer.type.Maybeboard',
    Tokens: 'deckViewer.type.Tokens',
  };

  translateLabel(label: string): string {
    const key = DeckViewerService.LABEL_KEYS[label];
    return key ? this.i18n.t(key) : label;
  }

  private static sortByCmc(a: DeckCard, b: DeckCard): number {
    return a.cmc - b.cmc || a.cardName.localeCompare(b.cardName);
  }

  /** Karten gruppiert nach Commander -> Typ, innerhalb jeder Gruppe nach Manawert sortiert. */
  readonly groupedDeckCards = computed(() => {
    const commander = this.editedDeckCards().filter((c) => c.isCommander);
    const rest = this.editedDeckCards().filter((c) => !c.isCommander && !c.isMaybeboard && !c.isToken);
    const maybe = this.editedDeckCards().filter((c) => !c.isCommander && c.isMaybeboard);
    const tokens = this.editedDeckCards().filter((c) => c.isToken);

    const groups = new Map<string, DeckCard[]>();
    for (const card of rest) {
      const category = this.categoryFor(card);
      const list = groups.get(category) ?? [];
      list.push(card);
      groups.set(category, list);
    }

    const sections: { label: string; cards: DeckCard[] }[] = [];
    if (commander.length > 0) {
      sections.push({ label: 'Commander', cards: [...commander].sort(DeckViewerService.sortByCmc) });
    }
    for (const { label } of DeckViewerService.TYPE_ORDER) {
      const cards = groups.get(label);
      if (cards?.length) sections.push({ label, cards: [...cards].sort(DeckViewerService.sortByCmc) });
    }
    const other = groups.get('Sonstiges');
    if (other?.length) {
      sections.push({ label: 'Sonstiges', cards: [...other].sort(DeckViewerService.sortByCmc) });
    }
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
   * Karten gruppiert nach eigenem Tag statt Kartentyp - eine Karte mit mehreren Tags erscheint in
   * mehreren Sektionen (bewusst so gewünscht, im Gegensatz zur Typ-Gruppierung wo jede Karte nur in
   * einer Sektion landet). Karten ganz ohne Tag landen gesammelt in "Ohne Tag".
   */
  readonly groupedDeckCardsByTag = computed(() => {
    const commander = this.editedDeckCards().filter((c) => c.isCommander);
    const rest = this.editedDeckCards().filter((c) => !c.isCommander && !c.isMaybeboard && !c.isToken);
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
      sections.push({ label: 'Commander', cards: [...commander].sort(DeckViewerService.sortByCmc) });
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

  // NEU
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
      for (const t of DeckViewerService.parseSubtypes(card.typeLine)) types.add(t);
    }
    return [...types].sort((a, b) => a.localeCompare(b));
  });

  readonly availableTypeSections = computed(() => this.groupedDeckCards().map((s) => s.label));

  private static parseSubtypes(typeLine: string | null): string[] {
    const parts = (typeLine ?? '').split('—');
    if (parts.length < 2) return [];
    return parts[1].trim().split(/\s+/).filter(Boolean);
  }

  private cardMatchesFilters(card: DeckCard): boolean {
    const query = this.cardSearchQuery().trim().toLowerCase();
    if (query && !card.cardName.toLowerCase().includes(query)) return false;

    const cmc = this.cmcFilter();
    if (cmc !== 'all') {
      const bucket = card.cmc >= 7 ? 7 : Math.round(card.cmc);
      if (bucket !== cmc) return false;
    }

    const creatureType = this.creatureTypeFilter();
    if (creatureType !== 'all' && !DeckViewerService.parseSubtypes(card.typeLine).includes(creatureType)) {
      return false;
    }

    const colors = this.colorFilter();
    if (colors.colors.length > 0) {
      const identity = this.viewingCardDetails().get(card.cardName.toLowerCase())?.colorIdentity ?? [];
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
      .filter((section) => sortMode === 'tags' || typeFilter === 'all' || section.label === typeFilter)
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
      this.effectFilter() !== 'all'
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
   * Tutor/Extra-Runde/Mass Land Denial haben keine Scryfall-Abfrage in effectFilters (query: '') -
   * sie laufen wie in effectCategoryStats über die zuverlässigeren, lokal längst vorhandenen Quellen
   * (Texterkennung bzw. Commander-Spellbook, siehe tutorCards()/extraTurnCards()/
   * massLandDenialCards()), damit Filter und Analyse-Kacheln für dieselbe Kategorie dieselben Karten
   * zeigen statt zweier unabhängig ermittelter (und potenziell abweichender) Ergebnisse.
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
        effect === 'tutor' ? this.tutorCards() : effect === 'extraturn' ? this.extraTurnCards() : this.massLandDenialCards();
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
    // classifyCards() statt der alten filterNamesByQuery() - teilt sich den dauerhaften
    // localStorage-Cache mit den Analyse-Kacheln (effectCategoryStats, siehe dort) und hat alle
    // Bugfixes aus der Verifikationsrunde (DFC-Namens-Split, längenbasiertes Chunking, korrekte
    // 404-Behandlung) - die alte Methode hatte keinen davon und lieferte deshalb bei jedem Öffnen
    // potenziell andere Ergebnisse als die Analyse.
    const matched = await this.scryfall.classifyCards(effect, tagQuery, names);
    this.effectMatchNames.set(matched);
    this.effectFilterBusy.set(false);
  }

  // NEU - Bearbeitungsmodus: Karten hinzufügen/entfernen
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

  /**
   * Suchergebnisse können deutlich mehr als eine Bildschirmseite füllen (Scryfall liefert bis zu
   * 175 Treffer) - werden hier seitenweise angezeigt, statt wie vorher hart bei 30 abgeschnitten
   * zu werden (dann waren weitere Treffer schlicht unsichtbar, ohne Möglichkeit weiterzublättern).
   */
  private static readonly ADD_CARD_PAGE_SIZE = 30;
  readonly addCardResultsPage = signal(0);

  readonly addCardResultsTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.addCardResults().length / DeckViewerService.ADD_CARD_PAGE_SIZE))
  );

  readonly addCardResultsEffectivePage = computed(() =>
    Math.min(this.addCardResultsPage(), this.addCardResultsTotalPages() - 1)
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
   * Funktions-Kategorien (was eine Karte TUT) über Scryfalls community-gepflegte Oracle-Tags
   * (otag:) - viel zuverlässiger als eine eigene Texterkennung. Bewusst getrennt von den
   * Fähigkeits-Keywords unten (keywordFilters): Lifelink z.B. ist eine feste Eigenschaft der
   * Karte, kein Effekt wie "Lebenspunkte gewinnen" (otag:lifegain, eigene Kategorie). "Marken
   * erzeugen" nutzt mangels passendem Tag eine Oracle-Text-Näherung.
   */
  // Abfragen 1:1 aus EFFECT_TAG_CATEGORIES übernommen (siehe dort) - dieselben Kategorie-Keys +
  // Abfragen sorgen dafür, dass sich Filter und Analyse-Kacheln denselben persistenten Cache teilen
  // und für dieselbe Kategorie immer dieselben Karten zeigen. query: '' = lokale Quelle statt
  // Scryfall-Abfrage (siehe LOCAL_EFFECT_FILTERS/loadEffectMatches()).
  readonly effectFilters: { value: string; label: string; query: string }[] = [
    { value: 'tokens', label: 'Marken erzeugen', query: 'o:create o:token' },
    { value: 'draw', label: 'Kartenziehen', query: 'otag:draw' },
    { value: 'removal', label: 'Entfernung', query: 'otag:removal' },
    {
      value: 'counterspell',
      label: 'Konter',
      query:
        'otag:counterspell',
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
      query:
        'otag:reanimate',
    },
    { value: 'recursion', label: 'Rekursion', query: 'otag:recursion' },
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
   * Farbidentität des/der Commander (für die "id<="-Teilmengen-Beschränkung der Add-Karten-Suche,
   * damit nur wirklich regelkonform ins Deck passende Karten vorgeschlagen werden). null, solange
   * die Scryfall-Zusatzdaten (viewingCardDetails) noch nicht geladen sind oder kein Commander
   * gesetzt ist - dann bleibt die Suche unbeschränkt.
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
   * Änderungen im Bearbeitungsmodus (Karten hinzufügen/entfernen, Anzahl anpassen) werden NUR
   * lokal in pendingChanges gesammelt - erst saveEdits() schreibt sie in die Datenbank. So
   * verwirft cancelEdits() (oder Schließen der Ansicht/App ohne zu speichern) sie einfach wieder,
   * ohne dass vorher irgendetwas gespeichert wurde.
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
            : { ...card, isCommander, isMaybeboard }
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
    this.pendingMaybeboardChanges.update((map) => new Map(map).set(card.cardName.toLowerCase(), !card.isMaybeboard));
  }

  readonly tokenScanBusy = signal(false);
  readonly tokenScanMessage = signal<string | null>(null);

  /**
   * Durchsucht alle "echten" Deckkarten (kein Maybeboard, keine bereits vorhandenen Marken) nach
   * Scryfalls all_parts-Feld auf component "token" und legt neu gefundene Marken als eigene Zeilen
   * im Deck an. Dedupliziert bewusst NICHT nach Namen, sondern nach Scryfalls oracleId (erst nach
   * dem Nachladen der vollen Kartendaten bekannt) - viele VERSCHIEDENE Marken teilen sich denselben
   * schlichten Namen (z.B. rote/blaue/schwarze "Wizard"-Marken mit unterschiedlichen Werten je nach
   * erzeugender Karte), eine Namens-Dedupe würde diese fälschlich zu einer einzigen Zeile
   * zusammenwerfen. Schreibt direkt (nicht über pendingChanges), da es eine eigenständige Aktion
   * ist statt einer einzelnen Karten-Bearbeitung.
   */
  async scanForTokens(): Promise<void> {
    const deck = this.viewingDeck();
    if (!deck || !this.canEditViewingDeck()) return;

    this.tokenScanBusy.set(true);
    this.tokenScanMessage.set(null);

    const details = this.viewingCardDetails();
    const existingTokens = this.viewingDeckCards().filter((c) => c.isToken);
    const existingTokenOracleIds = new Set(
      existingTokens.filter((c) => c.scryfallOracleId).map((c) => c.scryfallOracleId!)
    );
    // Vor diesem Fix gescannte Marken haben noch keine oracleId - über Name+Bild lassen sie sich
    // trotzdem der richtigen neu gefundenen Marke zuordnen, um sie nachträglich zu befüllen statt
    // eine doppelte Zeile für dieselbe Marke anzulegen.
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
      if (!oracleId || existingTokenOracleIds.has(oracleId) || newByOracleId.has(oracleId)) continue;
      newByOracleId.set(oracleId, data);
    }

    let added = 0;
    let backfilled = 0;
    for (const [oracleId, data] of newByOracleId) {
      const legacy = legacyTokensByNameAndImage.get(`${data.name.toLowerCase()}|${data.imageUrl ?? ''}`);
      if (legacy) {
        const ok = await this.deckService.backfillTokenOracleId(deck.id, legacy.cardName, legacy.imageUrl ?? '', oracleId);
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
          : this.i18n.t('deckView.noNewTokensFound')
    );
    await this.reloadDeckCards();
  }

  // --- Archetyp/Kreaturtyp: vom Spieler selbst gewählte Einordnung (siehe DeckService.updateDeckArchetype())
  // fürs Filtern im öffentlichen Decks-Suchreiter - unabhängig von der automatisch aus der
  // Commander-Farbidentität gepflegten color_identity-Spalte. Speichert (wie toggleOutdated()) sofort
  // bei Auswahl, ohne eigenen Save/Discard-Schritt, da es sich um zwei einzelne, unabhängig
  // wählbare Werte handelt statt einer zusammenhängenden Änderung wie beim Karten-Editor.
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
   * Grobe Prüfung, ob eine Karte überhaupt als Commander infrage kommt - blendet die Krone auf
   * offensichtlich ungeeigneten Karten (Zaubersprüche, normale Kreaturen, Länder, ...) aus, statt
   * sie auf jeder einzelnen Karte anzuzeigen. Legendäre Kreaturen sind der Regelfall, manche
   * Planeswalker/Sagas haben zusätzlich explizit "can be your commander" im Kartentext stehen.
   * Background-Karten zählen ebenfalls dazu - die wandern bei "Choose a background" mit in die
   * Kommandozone und sind damit genauso markierbar (siehe canBeSecondCommander()).
   */
  isCommanderEligible(card: DeckCard): boolean {
    const typeLine = card.typeLine ?? '';
    if (typeLine.includes('Legendary') && typeLine.includes('Creature')) return true;
    if (typeLine.includes('Background')) return true;
    const oracleText = this.viewingCardDetails().get(card.cardName.toLowerCase())?.oracleText ?? '';
    return oracleText.includes('can be your commander');
  }

  /**
   * Prüft, ob zwei Karten zusammen als Commander-Paar erlaubt wären: Partner (inkl. "Partner
   * with" und "Friends forever" - Scryfall führt beide unter dem Keyword "Partner"), "Choose a
   * Background" + eine Background-Karte, oder Doctor Who "Doctor's companion" + ein Time Lord
   * Doctor.
   */
  private canBeSecondCommander(existing: DeckCard, candidate: DeckCard): boolean {
    const details = this.viewingCardDetails();
    const existingKw = details.get(existing.cardName.toLowerCase())?.keywords ?? [];
    const candidateKw = details.get(candidate.cardName.toLowerCase())?.keywords ?? [];
    const existingType = existing.typeLine ?? '';
    const candidateType = candidate.typeLine ?? '';

    if (existingKw.includes('Partner') && candidateKw.includes('Partner')) return true;
    if (existingKw.includes('Choose a background') && candidateType.includes('Background')) return true;
    if (candidateKw.includes('Choose a background') && existingType.includes('Background')) return true;
    if (existingKw.includes("Doctor's companion") && candidateType.includes('Time Lord Doctor')) return true;
    if (candidateKw.includes("Doctor's companion") && existingType.includes('Time Lord Doctor')) return true;

    return false;
  }

  /**
   * Markiert/entmarkiert eine Karte im Bearbeitungsmodus als Commander - nur lokal, bis
   * saveEdits(). Entmarkieren geht immer; ein zweiter Commander nur, wenn er mit dem
   * bestehenden zusammen als Partner/Background/Doctor's companion gültig wäre, ein dritter
   * gar nicht.
   */
  toggleCommanderMark(card: DeckCard): void {
    if (!this.canEditViewingDeck()) return;
    this.commanderMarkError.set(null);

    if (card.isCommander) {
      this.pendingCommanderChanges.update((map) => new Map(map).set(card.cardName.toLowerCase(), false));
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
          })
        );
        return;
      }
    }

    this.pendingCommanderChanges.update((map) => new Map(map).set(card.cardName.toLowerCase(), true));
  }

  // NEU - Artwork/Edition einer Karte wechseln (Bearbeitungsmodus)
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
      cards.map((c) => (c.cardName.toLowerCase() === key ? { ...c, imageUrl } : c))
    );
    // Kurze Rückmeldung, da das Artwork sofort gespeichert wird (unabhängig vom
    // Speichern-Button für Karten hinzufügen/entfernen) - ohne die dachte man leicht, es sei noch
    // nicht gespeichert.
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

  // NEU - eigene Sortier-Tags einer Karte bearbeiten (Bearbeitungsmodus)
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
      cards.map((c) => (c.cardName.toLowerCase() === key ? { ...c, customTags: next } : c))
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
   * Nur die Vorderseite eines Doppelkarten-Namens ("Barkchannel Pathway // Tidechannel Pathway" ->
   * "barkchannel pathway") - EDHREC listet MDFCs/Transform-Karten nur mit dem Namen einer Seite,
   * während Scryfalls aufgelöster Kartenname immer den vollen "A // B"-Kombi-Namen führt. Ohne
   * diese Normalisierung erkennt weder das Klick-Feedback noch "schon im Deck" eine gerade erst
   * hinzugefügte Doppelkarte wieder (siehe isFlashing/isCardInDeck).
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

  /**
   * Zeigt für Doppelkarten (Transform/Modal-DFC) im "Karte hinzufügen"-Suchergebnis wahlweise die
   * Rückseite (siehe ScryfallCard.backImageUrl) - rein lokaler Anzeige-Zustand, nichts wird
   * gespeichert. Betrifft nur die Suchergebnis-Vorschau vor dem Hinzufügen; einmal im Deck landet
   * ohnehin nur ein einzelnes Bild in deck_cards.image_url.
   */
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

  /**
   * Wie flippedAddCardKeys, aber für Karten, die bereits im geöffneten Deck stecken (eigenes,
   * unabhängiges Signal - ein Flip im Suchergebnis soll die Anzeige im Deck selbst nicht
   * beeinflussen und umgekehrt). Wird beim Öffnen/Schließen eines Decks zurückgesetzt (siehe
   * open()/close()), sonst bliebe ein Flip-Zustand fälschlich bestehen, falls ein anderes Deck
   * zufällig eine gleichnamige Karte enthält.
   */
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
          maybeboardChanges.get(key) ?? false
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

    // Farb-Metadaten für den öffentlichen Decks-Suchreiter nachpflegen (siehe
    // sql/public-deck-browse-2026-08-26.sql) - nur wenn sich die Commander-Markierung tatsächlich
    // geändert hat, sonst unnötiger Schreibzugriff bei jedem Speichern. editedDeckCards() spiegelt
    // an dieser Stelle noch den fertig gemergten Zustand wider (pendingCommanderChanges wird erst
    // unten zurückgesetzt). viewingCardDetails() liefert die schon geladenen ScryfallCard-Daten
    // (colorIdentity) der Commander-Karten - kein zusätzlicher Netzwerk-Call nötig. Der Kreaturtyp
    // (commander_types) wird HIER bewusst nicht mehr angefasst - das ist seit dem Archetyp-/
    // Kreaturtyp-Dropdown im Bearbeiten-Modus ein eigenständiges, rein manuelles Feld (siehe
    // setArchetype()/setCreatureType() unten), das nicht bei jedem Commander-Wechsel überschrieben
    // werden soll.
    if (commanderChanged) {
      const commanderCards = this.editedDeckCards()
        .filter((c) => c.isCommander)
        .map((c) => this.viewingCardDetails().get(c.cardName.toLowerCase()))
        .filter((c): c is ScryfallCard => c !== undefined);

      const colorIdentity = [...new Set(commanderCards.flatMap((c) => c.colorIdentity ?? []))].sort();
      await this.deckService.updateDeckCommanderMetadata(deck.id, colorIdentity);
    }

    // Für Karten, die im selben Speichervorgang brandneu hinzugefügt wurden, wurde der
    // Maybeboard-Status oben schon beim Insert gesetzt (addCardToDeck) - dieser Lauf setzt ihn hier
    // nochmal auf denselben Wert (harmlos) und deckt zusätzlich bereits vorhandene Karten ab, die
    // nur verschoben wurden, ohne dass sich ihre Menge geändert hat (kein Eintrag in pendingChanges).
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
        type: type === 'all' ? undefined : DeckViewerService.TYPE_TO_SCRYFALL[type] ?? type.toLowerCase(),
        creatureType: creatureType.trim() || undefined,
        colors,
        cmc: cmc === 'all' ? null : cmc,
        effectQuery: effect === 'all' ? undefined : this.effectFilters.find((f) => f.value === effect)?.query,
        keyword: keyword === 'all' ? undefined : keyword,
        colorIdentitySubset: this.deckColorIdentitySubset(),
        order: this.addCardSortMode(),
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
   * Fügt eine Karte aus den Suchergebnissen/EDHREC-Vorschlägen nur lokal zu pendingChanges hinzu -
   * noch nicht gespeichert. addCardToMaybeboard() entscheidet nur bei komplett NEUEN Karten, ob sie
   * ins Maybeboard statt direkt ins Deck wandern - bei bereits vorhandenen Karten (nur Menge erhöht)
   * bleibt ihr bisheriger Maybeboard-Status unangetastet.
   */
  addCard(card: ScryfallCard): void {
    if (!this.canEditViewingDeck()) return;
    const key = card.name.toLowerCase();
    const currentQty = this.editedDeckCards().find((c) => c.cardName.toLowerCase() === key)?.quantity ?? 0;
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
      this.pendingMaybeboardChanges.update((map) => new Map(map).set(key, this.addCardToMaybeboard()));
    }
    // Direkt mit in viewingCardDetails übernehmen, damit z.B. die Partner-Prüfung beim
    // Commander-Markieren auch für gerade erst (noch ungespeichert) hinzugefügte Karten
    // funktioniert, ohne auf den nächsten vollen Reload zu warten.
    this.viewingCardDetails.update((map) => new Map(map).set(key, card));
    this.addCardMessage.set(this.i18n.t('deckViewer.msg.cardAdded', { name: card.name }));
    this.triggerFlash(card.name, 'add');
  }

  // NEU - EDHREC-Vorschläge im Add-Karten-Panel
  readonly addCardMode = signal<'search' | 'edhrec'>('search');
  readonly edhrecLists = signal<EdhrecCardlist[] | null>(null);
  readonly edhrecBusy = signal(false);
  readonly edhrecFailed = signal(false);
  /** Kartenname (lowercase) -> Scryfall-Daten (Bild, Typenzeile) für alle EDHREC-Vorschläge, damit man die Karte ansehen kann. */
  readonly edhrecCardDetails = signal<Map<string, ScryfallCard>>(new Map());
  /**
   * Alle markierten Commander (0-2, z.B. Partner- oder Background-Paar). Liest bewusst aus
   * editedDeckCards() (nicht viewingDeckCards()), damit eine noch ungespeicherte Krone-Markierung
   * im Bearbeitungsmodus sofort neue Vorschläge/Tags nachlädt, ohne erst Speichern + neu öffnen
   * zu erfordern.
   */
  readonly edhrecCommanderNames = computed(
    () =>
      this.editedDeckCards()
        .filter((c) => c.isCommander)
        .map((c) => c.cardName),
    // Ohne inhaltlichen Vergleich liefert .filter()/.map() bei JEDER Änderung von editedDeckCards()
    // (also auch beim Hinzufügen einer ganz normalen, nicht-Commander-Karte) ein neues Array-Objekt.
    // edhrecListsAutoLoad() unten reagiert darauf, obwohl sich die Commander gar nicht geändert
    // haben - setzt dabei edhrecLists() auf null und lädt neu, was die gesamte Vorschlagsliste kurz
    // kollabieren und wieder aufklappen lässt (sichtbar als Scroll-Sprung beim Karten-Hinzufügen aus
    // den Vorschlägen, abhängig davon, wie lange der Netzwerk-Reload dauert).
    { equal: (a, b) => a.length === b.length && a.every((name, i) => name === b[i]) }
  );
  /** Anzeige-Name für die EDHREC-Hinweistexte - bei einem Paar beide Namen kombiniert. */
  readonly edhrecCommanderName = computed(() => {
    const names = this.edhrecCommanderNames();
    return names.length ? names.join(' & ') : null;
  });
  /** Beim Deck-Anlegen gewählter EDHREC-Theme-Tag (z.B. "ramp") - kombiniert die Vorschläge mit dem Commander statt nur Commander allein. */
  readonly edhrecTagSlug = computed(() => this.viewingDeck()?.edhrecTag ?? null);

  // Temporärer Tag-Wechsel nur zum Durchstöbern anderer Vorschlagslisten - ändert NICHT den
  // dauerhaft gespeicherten Deck-Tag, nur was gerade angezeigt wird. Setzt sich beim erneuten
  // Öffnen des Decks/Bearbeitungsmodus automatisch zurück auf den gespeicherten Tag.
  readonly edhrecBrowseTagActive = signal(false);
  readonly edhrecBrowseTag = signal<string | null>(null);
  readonly edhrecAvailableTags = signal<EdhrecTag[]>([]);
  readonly edhrecTagsBusy = signal(false);

  /** Der gerade tatsächlich für die Vorschläge verwendete Tag - Browse-Override hat Vorrang vor dem gespeicherten Deck-Tag. */
  readonly effectiveEdhrecTag = computed(() =>
    this.edhrecBrowseTagActive() ? this.edhrecBrowseTag() : this.edhrecTagSlug()
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
   * Reiner Auslöser-Zähler (kein echter Zustand) - wird bei jedem Reset der EDHREC-Anzeige
   * (open()/close()/toggleEditMode()) hochgezählt, damit die beiden Auto-Load-Effekte unten
   * GARANTIERT neu auswerten, auch wenn sich der Commander-Name dabei textlich nicht geändert hat.
   * Vorherige Version verglich stattdessen mit einem einfachen (nicht-reaktiven) Klassenfeld - das
   * hat effect() nie zum Neu-Laufen gebracht, wenn NUR dieses Feld von außen zurückgesetzt wurde,
   * ohne dass sich ein tatsächlich gelesenes Signal änderte. Ergebnis war eine dauerhaft leere
   * EDHREC-Anzeige nach Speichern + erneutem Bearbeiten.
   */
  private readonly edhrecRefreshTick = signal(0);

  /**
   * Lädt EDHREC-Vorschläge automatisch (neu), sobald der EDHREC-Tab offen ist und sich der (ggf.
   * noch ungespeicherte) Commander ändert - deckt sowohl das erste Öffnen des Tabs als auch eine
   * Krone-Markierung währenddessen einheitlich ab.
   */
  private readonly edhrecListsAutoLoad = effect(() => {
    const mode = this.addCardMode();
    const commanders = this.edhrecCommanderNames();
    this.edhrecRefreshTick();
    if (mode !== 'edhrec') return;
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

  /**
   * Lädt die verfügbaren EDHREC-Tags unabhängig vom EDHREC-Tab, sobald sich der Commander ändert -
   * wird auch für die immer sichtbare Tag-Auswahl im Kopfbereich der Detailansicht gebraucht.
   */
  private readonly edhrecTagsAutoLoad = effect(() => {
    const commanders = this.edhrecCommanderNames();
    this.edhrecRefreshTick();
    this.edhrecAvailableTags.set([]);
    if (commanders.length === 0) return;
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
    // Aktuell gespeicherten/im Entwurf stehenden Tag immer als Option anbieten, auch falls er in
    // der frisch geladenen Liste fehlen sollte (z.B. EDHREC hat ihn seither umbenannt) - sonst
    // würde die Kopfbereich-Auswahl unsichtbar auf "nichts ausgewählt" zurückfallen.
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
    // Bilder werden bewusst NICHT hier für alle ~300 Vorschläge auf einmal geladen - das machte
    // das Öffnen des EDHREC-Tabs spürbar langsam, obwohl die meisten Kategorien eingeklappt bleiben
    // und ihre Bilder nie zu sehen sind. Stattdessen holt loadEdhrecCategoryImages() sie erst,
    // wenn eine Kategorie tatsächlich aufgeklappt wird (siehe toggleEdhrecCategory im Component).
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
    return this.editedDeckCards().some((c) => DeckViewerService.frontFaceKey(c.cardName) === target);
  }

  /**
   * Bild einer Deck-Karte - fällt auf die frisch geladenen Scryfall-Zusatzdaten zurück, falls in
   * deck_cards.image_url nichts (mehr) gespeichert ist (z.B. weil der Bild-Lookup beim ursprünglichen
   * Anlegen fehlschlug). Heilt die Anzeige dadurch von selbst, ohne die Datenbank zu reparieren.
   */
  resolvedCardImage(card: DeckCard): string | null {
    return card.imageUrl ?? this.viewingCardDetails().get(card.cardName.toLowerCase())?.imageUrl ?? null;
  }

  /**
   * Rückseite einer Doppelkarte (Transform/Modal-DFC), die schon im Deck steckt - deck_cards
   * speichert nur ein einziges Bild, die Rückseite kommt deshalb ausschließlich aus den ohnehin
   * geladenen Scryfall-Zusatzdaten (viewingCardDetails), nie aus der DB.
   */
  resolvedCardBackImage(card: DeckCard): string | null {
    return this.viewingCardDetails().get(card.cardName.toLowerCase())?.backImageUrl ?? null;
  }

  /**
   * Druckvariante für den PDF-Export - nutzt IMMER das für die Karte tatsächlich
   * hinterlegte/ausgewählte Artwork (resolvedCardImage()), unverändert. Ein früherer Versuch,
   * die URL selbst auf eine höher aufgelöste Scryfall-Variante umzuschreiben (Pfadsegment
   * .../normal/... -> .../png/...), beruhte auf einer nicht verifizierten Annahme über Scryfalls
   * CDN-URL-Struktur und hat in der Praxis dazu geführt, dass ALLE Kartenbilder beim Export
   * fehlschlugen (vermutlich weil die geratene png-URL nicht existierte und der anschließende
   * Rückfall-Versuch die Anfragenzahl verdoppelt und offenbar ein Rate-Limit ausgelöst hat) -
   * deshalb bewusst wieder auf die normale, zuverlässig funktionierende Auflösung zurückgestuft.
   * recompressForPrint() (deck-pdf.service.ts) sorgt trotzdem für eine für den Druck passend
   * zugeschnittene, gleichmäßige Bildgröße.
   */
  resolvedCardPrintImage(card: DeckCard): string | null {
    return this.resolvedCardImage(card);
  }

  /** Rückseiten-Druckvariante, siehe resolvedCardPrintImage(). */
  resolvedCardBackPrintImage(card: DeckCard): string | null {
    return this.resolvedCardBackImage(card);
  }

  /**
   * Kartenname, der gerade groß angezeigt wird - für die Analyse-Listen (Game Changer, Tutoren,
   * Mass Land Denial, Extra-Turns, Combos), die bislang nur reiner Text ohne Kartenbild waren.
   * Nur der Name statt eines DeckCard-Objekts, weil Combo-Karten nicht zwingend selbst schon als
   * DeckCard vorliegen (viewingCardDetails wird trotzdem für das ganze Deck geladen und reicht
   * als Bildquelle).
   */
  readonly previewCardName = signal<string | null>(null);

  openCardPreview(name: string): void {
    this.previewCardName.set(name);
  }

  closeCardPreview(): void {
    this.previewCardName.set(null);
  }

  /**
   * Bild-URLs zu einem bloßen Kartennamen aus den ohnehin geladenen Kartendetails des Decks.
   *
   * Die Analyse-Abschnitte zeigen ihre Karten als kleine Vorschaubilder statt als Textlinks; sie
   * kennen aber - genau wie die große Vorschau - nur den Namen, weil Combo-Karten nicht zwingend
   * als DeckCard vorliegen. null heißt "kein Bild bekannt", der Aufrufer zeigt dann wie überall
   * sonst den Namen als Platzhalter.
   */
  cardImageUrlFor(name: string): string | null {
    return this.cardDetailFor(name)?.imageUrl ?? null;
  }

  cardBackImageUrlFor(name: string): string | null {
    return this.cardDetailFor(name)?.backImageUrl ?? null;
  }

  /**
   * Erst im Deck nachsehen, dann bei den Combo-Finder-Vorschlägen: deren Karten liegen
   * naturgemäß NICHT im Deck (das ist ja der Punkt), sollen aber dasselbe Vorschaubild und
   * dieselbe Großansicht bekommen wie jede andere Karte der Analyse.
   */
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
  }

  /** Cache für resolveMyPlayerIds() - ändert sich innerhalb einer Login-Session praktisch nie. */
  private myPlayerIds: string[] | null = null;

  /** Löst den eingeloggten Nutzer auf seine players.id über alle Gruppen hinweg auf - für die "Meine Spiele"-Filterung in getDeckStats(). */
  private async resolveMyPlayerIds(): Promise<string[]> {
    if (this.myPlayerIds) return this.myPlayerIds;
    const userId = this.auth.currentUser()?.id;
    if (!userId) return [];
    this.myPlayerIds = await this.deckService.resolvePlayerIds({ kind: 'user', userId });
    return this.myPlayerIds;
  }

  async open(deck: Deck): Promise<void> {
    // Nur beim erstmaligen Öffnen einen History-Eintrag anlegen: open() wird auch zum Neuladen
    // desselben Decks aufgerufen (z.B. nach dem Neu-Einfügen der Liste), sonst stapelten sich
    // mehrere Einträge und man müsste mehrfach zurück.
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

    const [cards, log, myPlayerIds] = await Promise.all([
      this.deckService.loadDeckCards(deck.id),
      this.deckService.loadChangeLog(deck.id),
      this.resolveMyPlayerIds(),
    ]);
    const gameStats = await this.deckService.getDeckStats(deck.id, myPlayerIds);

    this.viewingDeckCards.set(cards);
    this.viewingChangeLog.set(log);
    this.viewingDeckGameStats.set(gameStats);
    this.detailBusy.set(false);

    this.cardDetailsPromise = this.loadCardDetails(cards);
    this.loadBracketEstimate(cards);
    this.analysisExtrasLoaded = false;
  }

  /** Schaltet die Spiel-Statistik-Kacheln zwischen "nur meine Partien" und "alle Partien mit diesem Deck" um. */
  async setDeckStatsScope(scope: 'mine' | 'all'): Promise<void> {
    const deck = this.viewingDeck();
    if (!deck || this.deckStatsScope() === scope) return;
    this.deckStatsScope.set(scope);
    const pilotPlayerIds = scope === 'mine' ? await this.resolveMyPlayerIds() : undefined;
    this.viewingDeckGameStats.set(await this.deckService.getDeckStats(deck.id, pilotPlayerIds));
  }

  /** Laufender loadCardDetails()-Aufruf, falls einer läuft - siehe ensureCardDetailsLoaded(). */
  private cardDetailsPromise: Promise<void> | null = null;

  /** Lädt Manakosten/Farbidentität/Game-Changer-Flag/Oracle-Text nach - unabhängig vom Kartenbild-Laden, da für die Deck-Analyse (Kurve/Pips/Tutoren) benötigt. */
  private async loadCardDetails(cards: DeckCard[]): Promise<void> {
    this.analysisBusy.set(true);
    // Hier statt in open(), damit die Vorschläge auch nach einer Deck-Bearbeitung neu gerechnet
    // werden (reloadDeckCards() ruft ebenfalls hier herein) - sonst stünde nach dem Einfügen der
    // vorgeschlagenen Karte immer noch der Vorschlag, sie einzufügen.
    this.comboFinderLoaded = false;
    this.comboFinderOpen.set(false);
    this.comboFinderDetail.set(null);
    this.comboFinderSuggestions.set([]);
    this.comboFinderTotal.set(0);
    this.comboFinderAvailable.set(true);
    this.comboFinderCardDetails.set(new Map());
    const names = [...new Set(cards.map((c) => c.cardName))];
    // Parallel: Markierungen (eine kleine Abfrage, danach je Sitzung zwischengespeichert) und
    // Combos sind die Grundlage der Bracket-Einstufung und sollen die Kartendetails nicht
    // verzögern.
    const [found, flags, combos] = await Promise.all([
      this.cardData.findCardsBulk(names),
      this.cardData.spellbookCardFlags(),
      this.cardData.twoCardCombosFor(names),
    ]);
    this.viewingCardDetails.set(found);
    this.spellbookCardFlags.set(flags);
    this.spellbookCombos.set(combos);
    this.analysisBusy.set(false);
  }

  /**
   * Wartet, falls gerade noch Scryfall-Zusatzdaten (u.a. Rückseiten-Bilder) nachgeladen werden -
   * für den PDF-Export, der sonst Rückseiten verpassen würde, wenn direkt nach dem Öffnen eines
   * Decks exportiert wird, bevor loadCardDetails() im Hintergrund fertig ist.
   */
  async ensureCardDetailsLoaded(): Promise<void> {
    if (this.cardDetailsPromise) await this.cardDetailsPromise;
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
   * Die 12 Effekt-Kategorien, die sich nur über eine Scryfall-Tag-/Text-Suche ermitteln lassen (im
   * Gegensatz zu Tutor/Extra-Runde/Mass Land Denial, die bereits über andere, zuverlässigere Wege
   * geladen werden - siehe effectCategoryStats). Ramp schließt Länder explizit aus (-t:land).
   *
   * KEINE Unter-Tags aufzählen. Konter, Rampe und Wiederbelebung führten früher alle bekannten
   * Unter-Tags einzeln auf ("otag:counterspell or otag:counterspell-noncreature or ..."), weil
   * Scryfalls Tagger Dovin's Veto seinerzeit nur als "counterspell-noncreature" führte. Das gilt
   * nicht mehr: Scryfalls otag:-Suche ist hierarchisch, jede Karte mit einem Unter-Tag matcht auch
   * das Eltern-Tag. Nachgeprüft, jeweils null Treffer:
   *
   *   (otag:counterspell-noncreature or ... or otag:counterspell-free) -otag:counterspell
   *   (otag:reanimate-creature or ... or otag:reanimate-permanent)     -otag:reanimate
   *   (otag:land-ramp or otag:extra-land or otag:play-additional-land) -otag:ramp
   *
   * Dovin's Veto selbst ist inzwischen ebenfalls unter "otag:counterspell" zu finden. Die
   * Trefferzahlen sind vor und nach dem Kürzen identisch (546 / 1064 / 2166). Die Aufzählung
   * brachte also nichts, machte die Abfrage aber 349 Zeichen lang - und presste damit im
   * Rückfallpfad (filterNamesByQueryChecked(), 800-Zeichen-Limit) unnötig wenige Kartennamen in
   * jede Anfrage.
   *
   * NICHT zu verwechseln mit den ODER-Listen in commander-archetype-filters.ts: Die fassen
   * VERSCHIEDENE Tags zu einem Archetyp zusammen (z.B. blink or flicker) und duerfen nicht
   * gekuerzt werden.
   */
  // NEU - Verifikationsrunde: nur eine Kategorie gleichzeitig neu aktiv, bis sie über mehrere
  // Wiederholungen hinweg stabil und korrekt ist (siehe Plan), danach die nächste einkommentieren.
  // Bereits verifiziert: Konter, Rampe, Entfernung, Kartenziehen, Bretträumung, Marken,
  // Lebenspunkte gewinnen, +1/+1-Zähler, Proliferate, Wiederbelebung, Opferung.
  // Aktuell in Prüfung (letzte der 12): Extra-Kampfphase.
  private static readonly EFFECT_TAG_CATEGORIES: { key: string; labelKey: string; query: string }[] = [
    {
      key: 'removal',
      labelKey: 'deckView.removalTile',
      query: 'otag:removal',
    },
    {
      key: 'counterspell',
      labelKey: 'deckView.counterspellTile',
      query:
        'otag:counterspell',
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
      // Oracle-Text-Näherung statt Tagger-Tag, wie schon bei "Marken erzeugen": Das früher
      // hier genutzte "otag:gives-1-1-counters" existiert bei Scryfall NICHT MEHR und lieferte
      // null Treffer - die Kachel stand dadurch dauerhaft auf 0, ohne dass irgendwo ein Fehler
      // sichtbar war. "otag:counters-matter" ist kein Ersatz: das ist die Payoff-Kategorie und
      // verfehlt geprüft sogar Cathars' Crusade. Die Oracle-Suche trifft dagegen alle
      // gegengeprüften Marken-Karten (Cathars' Crusade, Hardened Scales, Rishkar, Ozolith) und
      // schließt Sol Ring/Lightning Bolt korrekt aus. Sie hängt zudem an Scryfalls eigenem
      // Kartentext statt an einem Community-Tag, das wieder verschwinden kann.
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
      // Oberkategorie + bekannte Unter-Tags (wie bei Konter) - Scryfalls Tagger rollt Karten, die
      // nur mit einem spezifischeren Unter-Tag getaggt sind, nicht automatisch in die Oberkategorie
      // hoch (recherchiert, siehe reanimate-creature/-artifact/-enchantment/-planeswalker).
      query:
        'otag:reanimate',
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
   * Alle 15 Effekt-Kategorien für die Anzeige - die 12 Scryfall-Tag-Kategorien plus Tutor/
   * Extra-Runde/Mass Land Denial, die bereits über zuverlässigere, längst geladene Quellen laufen
   * (lokale Texterkennung bzw. Commander-Spellbook-Daten, siehe tutorCards()/extraTurnCards()/
   * massLandDenialCards()). Als computed() statt einmaligem Snapshot, damit sich die drei
   * wiederverwendeten Kategorien automatisch aktualisieren, sobald ihre - unabhängig ladenden -
   * Datenquellen fertig sind (die liefen zum Zeitpunkt von loadEffectCategoryCounts() oft noch).
   */
  readonly effectCategoryStats = computed<EffectCategoryStat[] | null>(() => {
    const tagStats = this.tagBasedEffectStats();
    if (!tagStats) return null;
    const countOf = (entries: GameChangerEntry[]) => entries.reduce((sum, c) => sum + c.quantity, 0);
    return [
      ...tagStats,
      { key: 'tutor', labelKey: 'deckView.tutorsTitle', count: countOf(this.tutorCards()), cards: this.tutorCards() },
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
   * Klassifiziert das Deck in die 12 Scryfall-Tag-Kategorien nach - jetzt aus dem eigenen
   * Kartenbestand (CardDataService, gefüllt vom nächtlichen Abgleich) statt live bei Scryfall.
   *
   * Vorher lief hier eine Schleife über alle 12 Kategorien, jede über classifyCards() in Chunks von
   * ~15 Kartennamen mit 300 ms Zwangspause - bei kaltem Cache rund 100 aufeinander folgende
   * Suchanfragen und damit etwa eine Minute Wartezeit, und das auf jedem Gerät erneut, weil der
   * Cache im localStorage liegt. Jetzt sind es zwei Datenbankabfragen.
   *
   * Der Weg über Scryfall bleibt als Rückfallebene erhalten, aber nur noch für Karten, die der
   * Abgleich nicht kennt - also frische Spoiler, die seit dem letzten Nachtlauf erschienen sind.
   * Fällt die Datenbank ganz aus, gilt jede Karte als unbekannt und es läuft exakt das alte
   * Verhalten: dann ist die App so langsam wie vorher, aber nicht kaputt.
   */
  private async loadEffectCategoryCounts(cards: DeckCard[]): Promise<void> {
    this.effectCategoryCountsBusy.set(true);
    const names = [...new Set(cards.filter((c) => !c.isMaybeboard && !c.isToken).map((c) => c.cardName))];

    // Vorderseiten-Name für den Abgleich - sowohl der Abgleich als auch classifyCards()
    // klassifizieren Doppelkarten unter ihrem Vorderseiten-Namen, der volle Deck-Kartenname
    // ("A // B") würde hier nie matchen.
    const entriesFromMatched = (matched: Set<string>): GameChangerEntry[] =>
      cards
        .filter((c) => !c.isMaybeboard && !c.isToken && matched.has(normalizeCardName(c.cardName.split(' // ')[0].trim())))
        .map((c) => ({ cardName: c.cardName, quantity: c.quantity }));
    const countOf = (entries: GameChangerEntry[]) => entries.reduce((sum, c) => sum + c.quantity, 0);

    const categories = DeckViewerService.EFFECT_TAG_CATEGORIES;
    const [ausDatenbank, bekannt] = await Promise.all([
      this.cardData.effectCategories(names),
      this.cardData.knownCardNames(names),
    ]);
    const matchedByKey = new Map<string, Set<string>>(
      categories.map((category) => [category.key, new Set(ausDatenbank.get(category.key) ?? [])])
    );

    // Nur Karten, die der Abgleich noch nicht kennt, gehen überhaupt noch ins Netz. Das ist im
    // Normalfall eine leere Liste - dann bleibt die ganze Schleife samt Pausen einfach aus.
    const unbekannt = names.filter((name) => !bekannt.has(normalizeCardName(name.split(' // ')[0].trim())));
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
        return { key: category.key, labelKey: category.labelKey, count: countOf(entries), cards: entries };
      })
    );
    this.effectCategoryCountsBusy.set(false);
    this.effectCategoryProgress.set(null);
  }

  /** Lädt Mass-Land-Denial/Extra-Turn/Combo-Auswertung von Commander Spellbook nach (siehe bracketEstimate). */
  private async loadBracketEstimate(cards: DeckCard[]): Promise<void> {
    this.bracketEstimateBusy.set(true);
    const real = cards.filter((c) => !c.isMaybeboard && !c.isToken);
    const commanders = real.filter((c) => c.isCommander).map((c) => ({ card: c.cardName, quantity: c.quantity }));
    const main = real.filter((c) => !c.isCommander).map((c) => ({ card: c.cardName, quantity: c.quantity }));

    const { estimate, errorDetail } = await this.commanderSpellbook.estimateBracket(commanders, main);
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
    this.bracketEstimate.set(null);
    this.bracketEstimateBusy.set(false);
    this.bracketEstimateFailed.set(false);
    this.bracketEstimateErrorDetail.set(null);
    this.totalDeckPrice.set(null);
    this.deckPriceIncomplete.set(false);
    this.priceBusy.set(false);
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
   * Die in EINER Bearbeitung hinzugefügten Karten als Druckliste für den PDF-Export. Karten, die
   * inzwischen wieder aus dem Deck geflogen sind, haben kein Bild mehr im Deck - für die wird es
   * über den Kartennamen bei Scryfall nachgeladen, sonst wären genau die alten Bearbeitungen (der
   * eigentliche Zweck der Reiter) nicht druckbar.
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
   * Ob Preis/Effekt-Kategorien für das aktuell offene Deck schon (angestoßen) geladen wurden - erst
   * beim ersten Aufklappen der Analyse-Sektion, siehe toggleDeckAnalysis(). Verhindert unnötige
   * Scryfall-Anfragen für den (häufigen) Fall, dass die Analyse nie aufgeklappt wird, UND vermeidet,
   * dass diese Anfragen mit den beim Deck-Öffnen ohnehin schon laufenden (Kartendetails, Bracket-
   * Schätzung) um Scryfalls Rate-Limit konkurrieren.
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
        await this.loadCardPrices(cards);
        await this.loadEffectCategoryCounts(cards);
      })();
    }
  }

  toggleDeckAnalysisInfo(): void {
    this.showDeckAnalysisInfo.update((v) => !v);
  }

  readonly reanalyzeBusy = signal(false);

  /**
   * Lädt die komplette Deck-Analyse (Kartendetails/Manakurve, Bracket-Schätzung, Preis, Effekt-
   * Kategorien) für den aktuellen Kartenbestand neu - nötig, weil sich Karten +/- oder ein
   * Reimport NICHT automatisch auf die Analyse auswirken (die lädt sonst nur einmalig beim
   * Öffnen des Decks bzw. ersten Aufklappen der Sektion, siehe open()/toggleDeckAnalysis()).
   */
  async reanalyzeDeck(): Promise<void> {
    if (!this.viewingDeck()) return;
    this.reanalyzeBusy.set(true);
    const cards = this.viewingDeckCards();
    this.cardDetailsPromise = this.loadCardDetails(cards);
    this.loadBracketEstimate(cards);
    // Nacheinander statt parallel - siehe toggleDeckAnalysis().
    await this.loadCardPrices(cards);
    await this.loadEffectCategoryCounts(cards);
    this.reanalyzeBusy.set(false);
  }
}
