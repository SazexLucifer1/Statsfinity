import { Injectable, computed, inject, signal } from '@angular/core';
import { DeckFormat } from './models';
import { Deck, DeckCard } from './deck.service';
import { ScryfallCard } from './scryfall.service';
import { AuthService } from './auth.service';
import { GroupService } from './group.service';
import type { PendingCardChange } from './deck-viewer.service';

/**
 * Gemeinsamer Zustand der Deck-Ansicht: geöffnetes Deck, Karten, Kartendetails und die noch ungespeicherten Änderungen des Bearbeitungsmodus. Alle Deck-Ansicht-Services bauen darauf auf.
 */
@Injectable({ providedIn: 'root' })
export class DeckViewerState {
  private readonly auth = inject(AuthService);
  private readonly groupService = inject(GroupService);

  readonly viewingDeck = signal<Deck | null>(null);

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

  readonly viewingDeckCards = signal<DeckCard[]>([]);
  readonly deckTagDraft = signal<string | null>(null);
  /** Kartenname (lowercase) -> Scryfall-Zusatzdaten (Manakosten, Farbidentität, Game-Changer-Flag). */
  readonly viewingCardDetails = signal<Map<string, ScryfallCard>>(new Map());
  /** Zählt bewusst KEINE Maybeboard-Karten und keine Marken mit - die stehen nur in der engeren Auswahl bzw. sind gar keine echten Deckkarten. */
  readonly viewingTotalCards = computed(() =>
    this.editedDeckCards()
      .filter((c) => !c.isMaybeboard && !c.isToken)
      .reduce((sum, c) => sum + c.quantity, 0),
  );

  // Bearbeitungsmodus: Karten hinzufügen/entfernen
  readonly editMode = signal(false);
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
   * Änderungen im Bearbeitungsmodus sammeln sich nur lokal, erst saveEdits() schreibt;
   * cancelEdits() verwirft sie.
   */
  readonly pendingChanges = signal<Map<string, PendingCardChange>>(new Map());
  /** Kartenname (lowercase) -> neuer Commander-Status, ebenfalls nur lokal bis saveEdits(). */
  readonly pendingCommanderChanges = signal<Map<string, boolean>>(new Map());
  /** Kartenname (lowercase) -> neuer Maybeboard-Status, ebenfalls nur lokal bis saveEdits(). */
  readonly pendingMaybeboardChanges = signal<Map<string, boolean>>(new Map());
  /** Kartenname (lowercase) -> gespeicherte Anzahl, als schnelle Nachschlagehilfe für Diff-Berechnungen. */
  readonly savedQuantityByKey = computed(() => {
    const map = new Map<string, number>();
    for (const c of this.viewingDeckCards()) map.set(c.cardName.toLowerCase(), c.quantity);
    return map;
  });

  /** Kartenname (lowercase) -> gespeicherter Commander-Status, analog savedQuantityByKey. */
  readonly savedCommanderByKey = computed(() => {
    const map = new Map<string, boolean>();
    for (const c of this.viewingDeckCards()) map.set(c.cardName.toLowerCase(), c.isCommander);
    return map;
  });

  /** Kartenname (lowercase) -> gespeicherter Maybeboard-Status, analog savedQuantityByKey. */
  readonly savedMaybeboardByKey = computed(() => {
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

  /**
   * Nur die Vorderseite eines Doppelkarten-Namens, kleingeschrieben - EDHREC nennt nur eine Seite,
   * Scryfall "A // B".
   */
  static frontFaceKey(name: string): string {
    return name.split(' // ')[0].trim().toLowerCase();
  }

  /** Laufender loadCardDetails()-Aufruf, falls einer läuft - siehe ensureCardDetailsLoaded(). */
  cardDetailsPromise: Promise<void> | null = null;

  /**
   * Wartet auf laufende Scryfall-Zusatzdaten (Rückseiten) - für den PDF-Export direkt nach dem
   * Öffnen.
   */
  async ensureCardDetailsLoaded(): Promise<void> {
    if (this.cardDetailsPromise) await this.cardDetailsPromise;
  }

  /** Verwirft alle ungespeicherten Änderungen des Bearbeitungsmodus. */
  discardPendingChanges(): void {
    this.pendingChanges.set(new Map());
    this.pendingCommanderChanges.set(new Map());
    this.pendingMaybeboardChanges.set(new Map());
  }

  readonly deckFormatDraft = signal<DeckFormat | null>(null);

  /** Steckt die Karte (Vorderseite, samt ungespeicherter Änderungen) schon im Deck? */
  isCardInDeck(cardName: string): boolean {
    const target = DeckViewerState.frontFaceKey(cardName);
    return this.editedDeckCards().some((c) => DeckViewerState.frontFaceKey(c.cardName) === target);
  }
}
