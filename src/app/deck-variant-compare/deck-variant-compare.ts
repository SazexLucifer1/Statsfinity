import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
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
 * Verglichen wird der BEARBEITETE Stand dieses Decks (editedDeckCards) mit dem gespeicherten der
 * Variante - so wandert eine Karte beim Klick sofort ins richtige Fenster. Geändert wird nur
 * dieses Deck, über dieselben Wege wie in der Kartenliste (DeckEditService), gespeichert mit dem
 * normalen Speichern-Knopf.
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

  readonly expanded = signal(false);
  readonly selectedVariantId = signal<string | null>(null);
  readonly wide = signal(false);

  private readonly deckId = computed(() => this.viewer.state.viewingDeck()?.id ?? null);

  readonly variants = computed(() =>
    this.service.loadedFor() === this.deckId() ? this.service.variants() : [],
  );

  readonly visible = computed(
    () => this.wide() && this.service.available() && this.variants().length > 0,
  );

  readonly selectedVariant = computed(() => {
    const variants = this.variants();
    return variants.find((v) => v.id === this.selectedVariantId()) ?? variants.at(0) ?? null;
  });

  readonly comparison = computed(() => {
    const variant = this.selectedVariant();
    const other = variant ? this.service.otherCards().get(variant.id) : undefined;
    if (!variant || !other) return null;
    return compareDeckVariants(this.viewer.state.editedDeckCards(), other);
  });

  readonly count = (entries: readonly VariantEntry[]): number => totalQuantity(entries);

  constructor() {
    const px = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--bp-lg'),
    );
    const query = window.matchMedia(`(min-width: ${px || 1000}px)`);
    this.wide.set(query.matches);
    query.addEventListener('change', (e) => this.wide.set(e.matches));

    effect(() => {
      const variant = this.selectedVariant();
      if (variant && this.expanded())
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
