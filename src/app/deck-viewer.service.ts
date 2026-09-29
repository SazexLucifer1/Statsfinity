import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { DeckService, Deck, DeckCard, DeckChangeEntry, DeckGameStats } from './deck.service';
import { ScryfallService, ScryfallCard } from './scryfall.service';
import { CardDataService } from './card-data.service';
import { ManaPart, comboSteps } from './combo-finder';
import { PdfSourceCard } from './deck-pdf.service';
import { normalizeCardName } from './array-utils';
import { AuthService } from './auth.service';
import { GroupService } from './group.service';
import { MtgService } from './mtg.service';
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
import {
  cmcBucket,
  groupByTypeSection,
  parseSubtypes,
  translateSectionLabel,
  typeSection,
} from './deck-analyse';
import { DECK_FORMATS } from './models';
import { DeckViewerState } from './deck-viewer-state.service';
import { DeckAnalysisService } from './deck-analysis.service';
import { DeckBracketService } from './deck-bracket.service';
import { DeckComboFinderService } from './deck-combo-finder.service';
import { DeckEffectsService } from './deck-effects.service';
import { DeckEdhrecService } from './deck-edhrec.service';
import { DeckEditService } from './deck-edit.service';

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

export interface PendingCardChange {
  cardName: string;
  quantity: number;
  imageUrl: string | null;
  typeLine: string | null;
  cmc: number;
  isCommander: boolean;
}

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

/**
 * Deck-Detailansicht: Öffnen/Schließen, Kopf, Verlauf, Kartenliste und Bearbeiten. Global statt in
 * DeckList, weil die Ansicht root-level gerendert wird (position:fixed würde sonst von einem
 * Vorfahren mit backdrop-filter eingefangen). Fachliche Teile liegen in eigenen Services, siehe
 * state/analysis/bracket/comboFinder/effects/edhrecPanel.
 */
@Injectable({ providedIn: 'root' })
export class DeckViewerService {
  private readonly deckService = inject(DeckService);
  private readonly scryfall = inject(ScryfallService);
  private readonly cardData = inject(CardDataService);
  private readonly auth = inject(AuthService);
  private readonly groupService = inject(GroupService);
  private readonly mtg = inject(MtgService);
  readonly i18n = inject(I18nService);
  /** Öffentlich, weil die Deck-Ansicht den Reiter direkt daran ausrichtet (gibt es einen Primer? ist die Spalte da?). */
  readonly primer = inject(DeckPrimerService);
  readonly steckbriefTexte = inject(DeckSteckbriefService);
  // Fachliche Teile der Deck-Ansicht, in Vorlagen als viewer.bracket.… usw. erreichbar.
  readonly state = inject(DeckViewerState);
  readonly analysis = inject(DeckAnalysisService);
  readonly bracket = inject(DeckBracketService);
  readonly comboFinder = inject(DeckComboFinderService);
  readonly effects = inject(DeckEffectsService);
  readonly edhrecPanel = inject(DeckEdhrecService);
  readonly edit = inject(DeckEditService);

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
      if (this.state.viewingDeck()) this.resetViewingState();
    });
  }

  /**
   * Spielstatistik ausblenden, wenn der Host dem Betrachter alle Modi gesperrt hat (eigene Decks
   * und Host ausgenommen).
   */
  readonly hideViewingDeckStats = computed(() => {
    if (this.state.canEditViewingDeck()) return false;
    return this.mtg.allModesHiddenForMe() && !this.groupService.isOwner();
  });
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
    const deck = this.state.viewingDeck();
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
  readonly deckFormats = DECK_FORMATS;
  readonly deckInfoSaving = signal(false);

  readonly deckInfoDirty = computed(() => {
    const deck = this.state.viewingDeck();
    if (!deck) return false;
    return (
      this.deckNameDraft().trim() !== deck.name ||
      this.state.deckTagDraft() !== deck.edhrecTag ||
      this.state.deckFormatDraft() !== deck.format
    );
  });

  /** Verwirft Name/Tag/Format-Entwurf und setzt auf die gespeicherten Werte zurück. */
  resetDeckInfoDraft(): void {
    const deck = this.state.viewingDeck();
    this.deckNameDraft.set(deck?.name ?? '');
    this.state.deckTagDraft.set(deck?.edhrecTag ?? null);
    this.state.deckFormatDraft.set(deck?.format ?? null);
  }

  async saveDeckInfo(): Promise<void> {
    const deck = this.state.viewingDeck();
    const name = this.deckNameDraft().trim();
    if (!deck || !name || !this.state.canEditViewingDeck()) return;

    this.deckInfoSaving.set(true);
    const tag = this.state.deckTagDraft();
    const format = this.state.deckFormatDraft();
    const ok = await this.deckService.updateDeckInfo(deck.id, name, tag, format);
    this.deckInfoSaving.set(false);
    if (ok) {
      this.state.viewingDeck.set({ ...deck, name, edhrecTag: tag, format });
      this.deckNameDraft.set(name);
    }
  }

  readonly outdatedToggleBusy = signal(false);

  /** Markiert/entmarkiert das gerade angesehene Deck als "Outdated" - solche Decks sind standardmäßig in der Deck-Liste ausgeblendet. */
  async toggleOutdated(): Promise<void> {
    const deck = this.state.viewingDeck();
    if (!deck || !this.state.canEditViewingDeck()) return;

    this.outdatedToggleBusy.set(true);
    const next = !deck.isOutdated;
    const ok = await this.deckService.setDeckOutdated(deck.id, next);
    this.outdatedToggleBusy.set(false);
    if (ok) this.state.viewingDeck.set({ ...deck, isOutdated: next });
  }

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
    this.state
      .editedDeckCards()
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
    const commander = this.state.editedDeckCards().filter((c) => c.isCommander);
    const rest = this.state
      .editedDeckCards()
      .filter((c) => !c.isCommander && !c.isMaybeboard && !c.isToken);
    const maybe = this.state.editedDeckCards().filter((c) => !c.isCommander && c.isMaybeboard);
    const tokens = this.state.editedDeckCards().filter((c) => c.isToken);

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
    for (const card of this.state.editedDeckCards()) {
      for (const t of card.customTags) tags.add(t);
    }
    return [...tags].sort((a, b) => a.localeCompare(b));
  });

  /**
   * Gruppiert nach eigenen Tags; Karten mit mehreren Tags erscheinen mehrfach, ohne Tag unter "Ohne
   * Tag".
   */
  readonly groupedDeckCardsByTag = computed(() => {
    const commander = this.state.editedDeckCards().filter((c) => c.isCommander);
    const rest = this.state
      .editedDeckCards()
      .filter((c) => !c.isCommander && !c.isMaybeboard && !c.isToken);
    const maybe = this.state.editedDeckCards().filter((c) => !c.isCommander && c.isMaybeboard);
    const tokens = this.state.editedDeckCards().filter((c) => c.isToken);

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
    for (const card of this.state.viewingDeckCards()) {
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
    if (creatureType !== 'all' && !parseSubtypes(card.typeLine).includes(creatureType)) {
      return false;
    }

    const colors = this.colorFilter();
    if (colors.colors.length > 0) {
      const identity =
        this.state.viewingCardDetails().get(card.cardName.toLowerCase())?.colorIdentity ?? [];
      if (!matchesColorSelection(identity, colors)) return false;
    }

    const keyword = this.keywordFilter();
    if (keyword !== 'all') {
      const keywords =
        this.state.viewingCardDetails().get(card.cardName.toLowerCase())?.keywords ?? [];
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
          ? this.analysis.tutorCards()
          : effect === 'extraturn'
            ? this.analysis.extraTurnCards()
            : this.analysis.massLandDenialCards();
      this.effectMatchNames.set(this.toNormalizedNameSet(entries));
      this.effectFilterBusy.set(false);
      return;
    }
    const tagQuery = this.effects.effectFilters.find((f) => f.value === effect)?.query;
    if (!tagQuery) {
      this.effectMatchNames.set(null);
      return;
    }
    this.effectFilterBusy.set(true);
    const names = this.state.viewingDeckCards().map((c) => c.cardName);
    // classifyCards() teilt sich den Cache mit den Analyse-Kacheln - Filter und Kacheln zeigen so
    // dieselben Karten.
    const matched = await this.scryfall.classifyCards(effect, tagQuery, names);
    this.effectMatchNames.set(matched);
    this.effectFilterBusy.set(false);
  }

  /**
   * Deck-Angaben für den Steckbrief-Reiter; hier, weil sie aus vielen Quellen dieses Service
   * stammen.
   */
  readonly steckbriefDeck = computed<SteckbriefDeckinfo | null>(() => {
    const deck = this.state.viewingDeck();
    if (!deck) return null;
    const farben = this.state.deckColorIdentitySubset() ?? [];
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
      commander: this.state
        .viewingDeckCards()
        .filter((c) => c.isCommander)
        .map((c) => ({ name: c.cardName, imageUrl: this.resolvedCardImage(c) })),
      istPrivat: deck.isPrivate,
    };
  });

  /** Deckkarten ohne Maybeboard/Marken für die Wirkungs-Kacheln des Steckbriefs. */
  readonly steckbriefKarten = computed<SteckbriefKarte[]>(() =>
    this.state
      .viewingDeckCards()
      .filter((c) => !c.isMaybeboard && !c.isToken)
      .map((c) => ({ name: c.cardName, quantity: c.quantity })),
  );

  /**
   * Legt Marken aus Scryfalls all_parts als eigene Deckzeilen an. Dedupliziert nach oracleId statt
   * Name, weil viele verschiedene Marken gleich heißen. Schreibt direkt, nicht über pendingChanges.
   */
  async scanForTokens(): Promise<void> {
    const deck = this.state.viewingDeck();
    if (!deck || !this.state.canEditViewingDeck()) return;

    this.edit.tokenScanBusy.set(true);
    this.edit.tokenScanMessage.set(null);

    const details = this.state.viewingCardDetails();
    const existingTokens = this.state.viewingDeckCards().filter((c) => c.isToken);
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
    for (const card of this.state.viewingDeckCards()) {
      if (card.isMaybeboard || card.isToken) continue;
      const parts = details.get(card.cardName.toLowerCase())?.allParts ?? [];
      for (const part of parts) {
        if (part.component === 'token') candidateIds.add(part.id);
      }
    }

    if (candidateIds.size === 0) {
      this.edit.tokenScanBusy.set(false);
      this.edit.tokenScanMessage.set(this.i18n.t('deckView.noNewTokensFound'));
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

    this.edit.tokenScanBusy.set(false);
    this.edit.tokenScanMessage.set(
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
    const deck = this.state.viewingDeck();
    if (!deck || !this.state.canEditViewingDeck()) return;

    this.archetypeSaving.set(true);
    const ok = await this.deckService.updateDeckArchetype(deck.id, edhrecTag, deck.creatureType);
    this.archetypeSaving.set(false);
    if (ok) {
      this.state.viewingDeck.set({ ...deck, edhrecTag });
      this.state.deckTagDraft.set(edhrecTag);
    }
  }

  async setCreatureType(creatureType: string | null): Promise<void> {
    const deck = this.state.viewingDeck();
    if (!deck || !this.state.canEditViewingDeck()) return;

    this.archetypeSaving.set(true);
    const ok = await this.deckService.updateDeckArchetype(deck.id, deck.edhrecTag, creatureType);
    this.archetypeSaving.set(false);
    if (ok) this.state.viewingDeck.set({ ...deck, creatureType });
  }

  toggleEditMode(): void {
    if (this.state.editMode() || !this.state.canEditViewingDeck()) return; // Verlassen geht nur bewusst über saveEdits()/cancelEdits()
    this.state.editMode.set(true);
    this.edit.reset();
    if (this.creatureTypeOptions().length === 0) this.loadCreatureTypeOptions();
    this.state.discardPendingChanges();
    this.edhrecPanel.reset();
  }

  /** Wie flippedAddCardKeys, aber für Karten im Deck; wird bei open()/close() zurückgesetzt. */
  private readonly flippedDeckCardKeys = signal<Set<string>>(new Set());

  isDeckCardFlipped(cardName: string): boolean {
    return this.flippedDeckCardKeys().has(DeckViewerState.frontFaceKey(cardName));
  }

  toggleDeckCardFlip(cardName: string): void {
    const key = DeckViewerState.frontFaceKey(cardName);
    this.flippedDeckCardKeys.update((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async saveEdits(): Promise<void> {
    const deck = this.state.viewingDeck();
    if (!deck || !this.state.canEditViewingDeck()) return;
    this.edit.editSaveBusy.set(true);

    const saved = this.state.savedQuantityByKey();
    const maybeboardChanges = this.state.pendingMaybeboardChanges();
    for (const change of this.state.pendingChanges().values()) {
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

    const savedCommanders = this.state.savedCommanderByKey();
    let commanderChanged = false;
    for (const [key, isCommander] of this.state.pendingCommanderChanges()) {
      if (isCommander === (savedCommanders.get(key) ?? false)) continue;
      const cardName =
        this.state.editedDeckCards().find((c) => c.cardName.toLowerCase() === key)?.cardName ?? key;
      await this.deckService.setCardCommanderFlag(deck.id, cardName, isCommander);
      commanderChanged = true;
    }

    // Farb-Metadaten fürs öffentliche Stöbern nur bei geänderten Commandern nachpflegen (Daten aus
    // viewingCardDetails, kein Netzwerk). commander_types bleibt unangetastet - das setzt der
    // Nutzer selbst.
    if (commanderChanged) {
      const commanderCards = this.state
        .editedDeckCards()
        .filter((c) => c.isCommander)
        .map((c) => this.state.viewingCardDetails().get(c.cardName.toLowerCase()))
        .filter((c): c is ScryfallCard => c !== undefined);

      const colorIdentity = [
        ...new Set(commanderCards.flatMap((c) => c.colorIdentity ?? [])),
      ].sort();
      await this.deckService.updateDeckCommanderMetadata(deck.id, colorIdentity);
    }

    // Setzt den Maybeboard-Status auch für Karten, die nur verschoben wurden (für neue Karten
    // doppelt, harmlos).
    const savedMaybeboard = this.state.savedMaybeboardByKey();
    for (const [key, isMaybeboard] of maybeboardChanges) {
      if (isMaybeboard === (savedMaybeboard.get(key) ?? false)) continue;
      const cardName =
        this.state.editedDeckCards().find((c) => c.cardName.toLowerCase() === key)?.cardName ?? key;
      await this.deckService.setCardMaybeboardFlag(deck.id, cardName, isMaybeboard);
    }

    this.state.discardPendingChanges();
    this.edit.reset();
    this.state.editMode.set(false);
    this.edhrecPanel.addCardMode.set('search');
    await this.reloadDeckCards();
    this.edit.editSaveBusy.set(false);
  }

  cancelEdits(): void {
    this.state.discardPendingChanges();
    this.edit.reset();
    this.state.editMode.set(false);
    this.edhrecPanel.addCardMode.set('search');
  }

  /** Kartenbild, mit Rückfall auf die Scryfall-Daten, falls deck_cards.image_url fehlt. */
  resolvedCardImage(card: DeckCard): string | null {
    return (
      card.imageUrl ??
      this.state.viewingCardDetails().get(card.cardName.toLowerCase())?.imageUrl ??
      null
    );
  }

  /**
   * Rückseite einer Doppelkarte im Deck, nur aus viewingCardDetails (deck_cards speichert ein
   * Bild).
   */
  resolvedCardBackImage(card: DeckCard): string | null {
    return this.state.viewingCardDetails().get(card.cardName.toLowerCase())?.backImageUrl ?? null;
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
    return (
      this.state.viewingCardDetails().get(key) ?? this.comboFinder.comboFinderCardDetails().get(key)
    );
  }

  previewCardImageUrl(): string | null {
    const name = this.previewCardName();
    return name ? this.cardImageUrlFor(name) : null;
  }

  previewCardBackImageUrl(): string | null {
    const name = this.previewCardName();
    return name ? this.cardBackImageUrlFor(name) : null;
  }

  private async reloadDeckCards(): Promise<void> {
    const deck = this.state.viewingDeck();
    if (!deck) return;
    const [cards, log] = await Promise.all([
      this.deckService.loadDeckCards(deck.id),
      this.deckService.loadChangeLog(deck.id),
    ]);
    this.state.viewingDeckCards.set(cards);
    this.viewingChangeLog.set(log);
    this.state.cardDetailsPromise = this.loadCardDetails(cards);
    this.analysis.loadBracketEstimate(cards);
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
    this.state.viewingDeck.set(deck);
    this.deckNameDraft.set(deck.name);
    this.state.deckTagDraft.set(deck.edhrecTag);
    this.state.deckFormatDraft.set(deck.format);
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
    this.bracket.reset();
    this.resetCardFilters();
    this.effectFilterBusy.set(false);
    this.state.editMode.set(false);
    this.edit.reset();
    this.state.discardPendingChanges();
    this.edhrecPanel.reset();
    this.showDeckAnalysisInfo.set(false);
    this.state.viewingCardDetails.set(new Map());
    this.flippedDeckCardKeys.set(new Set());
    this.analysis.reset();
    this.viewMode.set('visual');
    this.cardSortMode.set('type');
    this.effects.reset();
    this.deckStatsScope.set('mine');

    const [cards, log, gameStats] = await Promise.all([
      this.deckService.loadDeckCards(deck.id),
      this.deckService.loadChangeLog(deck.id),
      this.deckStatsFor(deck, 'mine'),
    ]);

    this.state.viewingDeckCards.set(cards);
    this.viewingChangeLog.set(log);
    this.viewingDeckGameStats.set(gameStats);
    this.detailBusy.set(false);

    this.state.cardDetailsPromise = this.loadCardDetails(cards);
    this.analysis.loadBracketEstimate(cards);
    this.loadPriceForBracket(cards);
    this.analysisExtrasLoaded = false;
  }

  /** Schaltet die Spiel-Statistik-Kacheln zwischen "Partien des Besitzers" und "alle Partien mit diesem Deck" um. */
  async setDeckStatsScope(scope: 'mine' | 'all'): Promise<void> {
    const deck = this.state.viewingDeck();
    if (!deck || this.deckStatsScope() === scope) return;
    this.deckStatsScope.set(scope);
    this.viewingDeckGameStats.set(await this.deckStatsFor(deck, scope));
  }

  /** Lädt Manakosten/Farbidentität/Game-Changer-Flag/Oracle-Text nach - unabhängig vom Kartenbild-Laden, da für die Deck-Analyse (Kurve/Pips/Tutoren) benötigt. */
  private async loadCardDetails(cards: DeckCard[]): Promise<void> {
    this.analysis.analysisBusy.set(true);
    // Hier statt in open(), damit die Vorschläge auch nach einer Bearbeitung neu gerechnet werden.
    this.comboFinder.reset();
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
    this.bracket.bracketBenchmark.set(benchmark);
    this.state.viewingCardDetails.set(found);
    this.analysis.spellbookCardFlags.set(flags);
    this.analysis.spellbookCombos.set(combos);
    this.analysis.winningCombos.set(gewinnCombos);
    this.analysis.analysisBusy.set(false);
  }

  /**
   * Preis schon beim Öffnen laden, aber nur bei Commander-Decks (Kriterium fürs Bracket); sonst
   * erst beim Aufklappen der Analyse. Ohne await - bracketAnalysis rechnet sich nach.
   */
  private loadPriceForBracket(cards: DeckCard[]): void {
    if (this.bracket.showsBracket()) void this.analysis.ensureCardPricesLoaded(cards);
  }

  close(): void {
    // Ohne offene Ansicht nichts tun - sonst würde ein Aufruf ins Leere die gespeicherte
    // Scrollposition wiederherstellen und die Seite darunter grundlos verschieben.
    if (!this.state.viewingDeck() && !this.historyEntryOpen) return;
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
    this.state.viewingDeck.set(null);
    this.deckTab.set('cards');
    this.primer.zuruecksetzen();
    this.steckbriefTexte.zuruecksetzen();
    this.deckNameDraft.set('');
    this.state.deckTagDraft.set(null);
    this.deckInfoSaving.set(false);
    this.state.viewingDeckCards.set([]);
    this.viewingChangeLog.set([]);
    this.viewingDeckGameStats.set(null);
    this.deckStatsScope.set('mine');
    this.state.viewingCardDetails.set(new Map());
    this.flippedDeckCardKeys.set(new Set());
    this.analysis.reset();
    this.effects.reset();
    this.analysisExtrasLoaded = false;
    this.state.editMode.set(false);
    this.edit.reset();
    this.state.discardPendingChanges();
    this.edhrecPanel.reset();
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
      await this.state.ensureCardDetailsLoaded();
      const inDeck = new Map(
        this.state.viewingDeckCards().map((c) => [c.cardName.toLowerCase(), c]),
      );

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
      const cards = this.state.viewingDeckCards();
      // Nacheinander statt parallel - sonst konkurrieren beide direkt beim Aufklappen um Scryfalls
      // Rate-Limit. Preis zuerst, da meist deutlich schneller fertig als die 12 Effekt-Kategorien.
      (async () => {
        await this.analysis.ensureCardPricesLoaded(cards);
        await this.effects.loadEffectCategoryCounts(cards);
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
    if (!this.state.viewingDeck()) return;
    this.reanalyzeBusy.set(true);
    const cards = this.state.viewingDeckCards();
    this.state.cardDetailsPromise = this.loadCardDetails(cards);
    this.analysis.loadBracketEstimate(cards);
    // Nacheinander statt parallel - siehe toggleDeckAnalysis().
    await this.analysis.reloadCardPrices(cards);
    await this.effects.loadEffectCategoryCounts(cards);
    this.reanalyzeBusy.set(false);
  }
}
