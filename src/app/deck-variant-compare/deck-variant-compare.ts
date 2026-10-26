import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DeckViewerService } from '../deck-viewer.service';
import { DeckCard } from '../deck.service';
import { DeckVariantService } from '../deck-variant.service';
import { compareDeckVariants, totalQuantity, VariantEntry } from '../deck-variants';
import { CardThumb } from '../ui/card-thumb/card-thumb';

/**
 * Varianten nebeneinander bearbeiten (Wunsch des Users, 26.10.2026) - nur im Bearbeiten-Modus der
 * Deck-Ansicht und nur ab --bp-lg: Auf dem Handy ist für drei Fenster nebeneinander kein Platz.
 * Oben links die Karten nur in diesem Deck, oben rechts die nur in der Variante, unten die
 * gemeinsamen; jedes Fenster scrollt für sich.
 *
 * Verglichen wird der BEARBEITETE Stand beider Seiten - so wandert eine Karte beim Klick sofort
 * ins richtige Fenster. Dieses Deck ändert sich über dieselben Wege wie in der Kartenliste
 * (DeckEditService), die Variante über DeckVariantService.setOtherQuantity(); beides speichert
 * der normale Speichern-Knopf. Die Pfeile holen eine Karte auf die jeweils andere Seite dazu.
 */
@Component({
  selector: 'app-deck-variant-compare',
  imports: [CardThumb],
  templateUrl: './deck-variant-compare.html',
  styleUrl: './deck-variant-compare.scss',
})
export class DeckVariantCompare {
  readonly viewer = inject(DeckViewerService);
  readonly service = inject(DeckVariantService);

  /** Ein-/ausgeblendet über den Knopf „Varianten vergleichen“ in der Bearbeiten-Leiste der Deck-Ansicht. */
  readonly open = input(false);
  readonly selectedVariantId = signal<string | null>(null);

  private readonly deckId = computed(() => this.viewer.state.viewingDeck()?.id ?? null);

  readonly variants = computed(() =>
    this.service.loadedFor() === this.deckId() ? this.service.variants() : [],
  );

  readonly visible = computed(
    () => this.open() && this.service.available() && this.variants().length > 0,
  );

  readonly selectedVariant = computed(() => {
    const variants = this.variants();
    return variants.find((v) => v.id === this.selectedVariantId()) ?? variants.at(0) ?? null;
  });

  readonly comparison = computed(() => {
    const variant = this.selectedVariant();
    const other = variant ? this.service.editedOtherCards(variant.id) : undefined;
    if (!variant || !other) return null;
    return compareDeckVariants(this.viewer.state.editedDeckCards(), other);
  });

  readonly count = (entries: readonly VariantEntry[]): number => totalQuantity(entries);

  constructor() {
    effect(() => {
      const variant = this.selectedVariant();
      if (variant && this.visible())
        void untracked(() => this.service.ensureOtherCards(variant.id));
    });
  }

  /** Die Karte, wie sie gerade (mit ungespeicherten Änderungen) in diesem Deck steht. */
  private deckCard(name: string): DeckCard | undefined {
    const key = name.toLowerCase();
    return this.viewer.state.editedDeckCards().find((c) => c.cardName.toLowerCase() === key);
  }

  decrement(entry: VariantEntry): void {
    const card = this.deckCard(entry.cardName);
    if (card && !card.isCommander) this.viewer.edit.decrementCard(card);
  }

  increment(entry: VariantEntry): void {
    const card = this.deckCard(entry.cardName);
    if (card && !card.isCommander) this.viewer.edit.incrementCard(card);
  }

  /** Menge in der Variante ändern (ungespeichert, siehe DeckVariantService.pendingOther). */
  changeOther(entry: VariantEntry, delta: number): void {
    const variant = this.selectedVariant();
    if (!variant || entry.isCommander) return;
    const current = this.service.otherQuantity(variant.id, entry.cardName);
    this.service.setOtherQuantity(variant.id, entry, current + delta);
  }

  /** Karte der Variante in dieses Deck holen - liegt sie hier in der engeren Auswahl, kommt sie von dort ins Deck. */
  takeOver(entry: VariantEntry): void {
    const card = this.deckCard(entry.cardName);
    if (card?.isMaybeboard) {
      this.viewer.edit.toggleCardMaybeboard(card);
      return;
    }
    this.viewer.edit.incrementCard(
      card ?? {
        cardName: entry.cardName,
        quantity: 0,
        imageUrl: entry.imageUrl,
        typeLine: entry.typeLine,
        cmc: entry.cmc,
        isCommander: false,
        customTags: [],
        isMaybeboard: false,
        isToken: false,
        scryfallOracleId: null,
      },
    );
  }
}
