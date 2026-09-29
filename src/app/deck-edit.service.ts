import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { DeckService, Deck, DeckCard } from './deck.service';
import { ScryfallService, ScryfallCard, ScryfallPrinting } from './scryfall.service';
import { CardDataService } from './card-data.service';
import { AuthService } from './auth.service';
import { I18nService } from './i18n.service';
import { ColorSelection, EMPTY_COLOR_SELECTION } from './color-filter-match';
import { DeckViewerState } from './deck-viewer-state.service';
import { DeckEffectsService } from './deck-effects.service';
import type { GameChangerEntry } from './deck-viewer.service';

/**
 * Bearbeitungsmodus der Deck-Ansicht: Karten suchen und hinzufügen, Mengen, Commander-Markierung, Artwork, eigene Tags und Marken. Gespeichert wird über DeckViewerService.saveEdits().
 */
@Injectable({ providedIn: 'root' })
export class DeckEditService {
  private readonly auth = inject(AuthService);
  private readonly cardData = inject(CardDataService);
  private readonly deckService = inject(DeckService);
  private readonly effects = inject(DeckEffectsService);
  private readonly i18n = inject(I18nService);
  private readonly scryfall = inject(ScryfallService);
  private readonly state = inject(DeckViewerState);

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
    Math.max(1, Math.ceil(this.addCardResults().length / DeckEditService.ADD_CARD_PAGE_SIZE)),
  );

  readonly addCardResultsEffectivePage = computed(() =>
    Math.min(this.addCardResultsPage(), this.addCardResultsTotalPages() - 1),
  );

  readonly pagedAddCardResults = computed(() => {
    const start = this.addCardResultsEffectivePage() * DeckEditService.ADD_CARD_PAGE_SIZE;
    return this.addCardResults().slice(start, start + DeckEditService.ADD_CARD_PAGE_SIZE);
  });

  prevAddCardResultsPage(): void {
    this.addCardResultsPage.update((p) => Math.max(0, p - 1));
  }

  nextAddCardResultsPage(): void {
    this.addCardResultsPage.update((p) => Math.min(this.addCardResultsTotalPages() - 1, p + 1));
  }

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

  readonly editSaveBusy = signal(false);

  readonly hasPendingChanges = computed(() => {
    const saved = this.state.savedQuantityByKey();
    for (const change of this.state.pendingChanges().values()) {
      if (change.quantity !== (saved.get(change.cardName.toLowerCase()) ?? 0)) return true;
    }
    const savedCommanders = this.state.savedCommanderByKey();
    for (const [key, isCommander] of this.state.pendingCommanderChanges()) {
      if (isCommander !== (savedCommanders.get(key) ?? false)) return true;
    }
    const savedMaybeboard = this.state.savedMaybeboardByKey();
    for (const [key, isMaybeboard] of this.state.pendingMaybeboardChanges()) {
      if (isMaybeboard !== (savedMaybeboard.get(key) ?? false)) return true;
    }
    return false;
  });

  /** Welche Karten in welcher Menge noch ungespeichert hinzugefügt/entfernt wurden - für die Anzeige vor dem Speichern. */
  readonly pendingChangeDetails = computed(() => {
    const saved = this.state.savedQuantityByKey();
    const added: GameChangerEntry[] = [];
    const removed: GameChangerEntry[] = [];
    for (const change of this.state.pendingChanges().values()) {
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
    const saved = this.state.savedCommanderByKey();
    const changed: { cardName: string; isCommander: boolean }[] = [];
    for (const [key, isCommander] of this.state.pendingCommanderChanges()) {
      if (isCommander !== (saved.get(key) ?? false)) {
        const cardName =
          this.state.editedDeckCards().find((c) => c.cardName.toLowerCase() === key)?.cardName ??
          key;
        changed.push({ cardName, isCommander });
      }
    }
    return changed;
  });

  /** Karten, deren Maybeboard-Status sich geändert hat (noch ungespeichert) - für die Anzeige vor dem Speichern. */
  readonly pendingMaybeboardChangeDetails = computed(() => {
    const saved = this.state.savedMaybeboardByKey();
    const changed: { cardName: string; isMaybeboard: boolean }[] = [];
    for (const [key, isMaybeboard] of this.state.pendingMaybeboardChanges()) {
      if (isMaybeboard !== (saved.get(key) ?? false)) {
        const cardName =
          this.state.editedDeckCards().find((c) => c.cardName.toLowerCase() === key)?.cardName ??
          key;
        changed.push({ cardName, isMaybeboard });
      }
    }
    return changed;
  });

  /** Verschiebt eine Karte im Bearbeitungsmodus zwischen Hauptdeck und Maybeboard - nur lokal, bis saveEdits(). */
  toggleCardMaybeboard(card: DeckCard): void {
    if (!this.state.canEditViewingDeck()) return;
    this.state.pendingMaybeboardChanges.update((map) =>
      new Map(map).set(card.cardName.toLowerCase(), !card.isMaybeboard),
    );
  }

  readonly tokenScanBusy = signal(false);
  readonly tokenScanMessage = signal<string | null>(null);

  readonly commanderMarkError = signal<string | null>(null);

  /**
   * Grobe Prüfung, ob eine Karte Commander sein kann (für die Krone): legendäre Kreaturen, "can be
   * your commander" und Backgrounds.
   */
  isCommanderEligible(card: DeckCard): boolean {
    const typeLine = card.typeLine ?? '';
    if (typeLine.includes('Legendary') && typeLine.includes('Creature')) return true;
    if (typeLine.includes('Background')) return true;
    const oracleText =
      this.state.viewingCardDetails().get(card.cardName.toLowerCase())?.oracleText ?? '';
    return oracleText.includes('can be your commander');
  }

  /**
   * Erlaubtes Commander-Paar: Partner (inkl. "Partner with", "Friends forever"), Choose a
   * Background + Background, Doctor's companion + Time Lord Doctor.
   */
  private canBeSecondCommander(existing: DeckCard, candidate: DeckCard): boolean {
    const details = this.state.viewingCardDetails();
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
    if (!this.state.canEditViewingDeck()) return;
    this.commanderMarkError.set(null);

    if (card.isCommander) {
      this.state.pendingCommanderChanges.update((map) =>
        new Map(map).set(card.cardName.toLowerCase(), false),
      );
      return;
    }

    const currentCommanders = this.state.editedDeckCards().filter((c) => c.isCommander);
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

    this.state.pendingCommanderChanges.update((map) =>
      new Map(map).set(card.cardName.toLowerCase(), true),
    );
  }

  // Artwork/Edition einer Karte wechseln (Bearbeitungsmodus)
  readonly artworkPickerCard = signal<DeckCard | null>(null);
  readonly artworkOptions = signal<ScryfallPrinting[]>([]);
  readonly artworkPickerBusy = signal(false);
  readonly artworkPickerError = signal<string | null>(null);

  async openArtworkPicker(card: DeckCard): Promise<void> {
    if (!this.state.canEditViewingDeck()) return;
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
    const deck = this.state.viewingDeck();
    const card = this.artworkPickerCard();
    if (!deck || !card || !this.state.canEditViewingDeck()) return;

    this.artworkPickerBusy.set(true);
    const ok = await this.deckService.updateCardImage(deck.id, card.cardName, imageUrl);
    this.artworkPickerBusy.set(false);

    if (!ok) {
      this.artworkPickerError.set(this.i18n.t('deckViewer.msg.imageSaveFailed'));
      return;
    }

    const key = card.cardName.toLowerCase();
    this.state.viewingDeckCards.update((cards) =>
      cards.map((c) => (c.cardName.toLowerCase() === key ? { ...c, imageUrl } : c)),
    );
    // Rückmeldung, weil das Artwork sofort gespeichert wird.
    this.addCardMessage.set(this.i18n.t('deckViewer.msg.artworkSaved', { name: card.cardName }));
    this.closeArtworkPicker();
  }

  /** Eigenes Bild statt einer Scryfall-Edition hochladen und direkt als Artwork setzen. */
  async uploadCustomArtwork(file: File): Promise<void> {
    const uid = this.auth.currentUser()?.id;
    if (!uid || !this.state.canEditViewingDeck()) return;

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
    if (!this.state.canEditViewingDeck()) return;
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
    const deck = this.state.viewingDeck();
    const card = this.tagEditorCard();
    const trimmed = tag.trim();
    if (!deck || !card || !trimmed || !this.state.canEditViewingDeck()) return;

    const next = card.customTags.includes(trimmed)
      ? card.customTags.filter((t) => t !== trimmed)
      : [...card.customTags, trimmed];

    this.tagEditorBusy.set(true);
    const ok = await this.deckService.setCardTags(deck.id, card.cardName, next);
    this.tagEditorBusy.set(false);
    if (!ok) return;

    const key = card.cardName.toLowerCase();
    this.state.viewingDeckCards.update((cards) =>
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

  private setPendingQuantity(card: DeckCard, quantity: number): void {
    this.state.pendingChanges.update((map) => {
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
    return DeckViewerState.frontFaceKey(state.key) === DeckViewerState.frontFaceKey(cardName);
  }

  /** Rückseite von Doppelkarten im Suchergebnis zeigen (nur Anzeige). */
  private readonly flippedAddCardKeys = signal<Set<string>>(new Set());

  isAddCardFlipped(cardName: string): boolean {
    return this.flippedAddCardKeys().has(DeckViewerState.frontFaceKey(cardName));
  }

  toggleAddCardFlip(cardName: string): void {
    const key = DeckViewerState.frontFaceKey(cardName);
    this.flippedAddCardKeys.update((set) => {
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
            : (DeckEditService.TYPE_TO_SCRYFALL[type] ?? type.toLowerCase()),
        creatureType: creatureType.trim() || undefined,
        colors,
        cmc: cmc === 'all' ? null : cmc,
        effectQuery:
          effect === 'all'
            ? undefined
            : this.effects.effectFilters.find((f) => f.value === effect)?.query,
        keyword: keyword === 'all' ? undefined : keyword,
        colorIdentitySubset: this.state.deckColorIdentitySubset(),
        order: this.addCardSortMode(),
        // Das Format aus dem Bearbeiten-Feld, nicht das gespeicherte: wer es gerade umstellt,
        // sucht schon für das neue.
        format: this.state.deckFormatDraft(),
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
    if (!this.state.canEditViewingDeck()) return;
    const key = card.name.toLowerCase();
    const currentQty =
      this.state.editedDeckCards().find((c) => c.cardName.toLowerCase() === key)?.quantity ?? 0;
    const existingInDeck = this.state
      .viewingDeckCards()
      .find((c) => c.cardName.toLowerCase() === key);

    this.state.pendingChanges.update((map) => {
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
      this.state.pendingMaybeboardChanges.update((map) =>
        new Map(map).set(key, this.addCardToMaybeboard()),
      );
    }
    // Sofort in viewingCardDetails übernehmen, damit z. B. die Partner-Prüfung auch ungespeicherte
    // Karten kennt.
    this.state.viewingCardDetails.update((map) => new Map(map).set(key, card));
    this.addCardMessage.set(this.i18n.t('deckViewer.msg.cardAdded', { name: card.name }));
    this.triggerFlash(card.name, 'add');
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

  /** Bearbeitungs-Zustand verwerfen (Wechsel in/aus dem Bearbeitungsmodus, anderes Deck). */
  reset(): void {
    this.showCommanderToggle.set(false);
    this.artworkPickerCard.set(null);
    this.artworkOptions.set([]);
    this.tagEditorCard.set(null);
    this.tagEditorNewTag.set('');
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
    this.flashState.set(null);
  }
}
