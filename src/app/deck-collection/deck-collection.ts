import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { I18nService } from '../i18n.service';
import { AuthService } from '../auth.service';
import { CollectionService } from '../collection.service';
import { DeckService } from '../deck.service';
import { DeckViewerState } from '../deck-viewer-state.service';
import {
  CardCoverage,
  collectionKey,
  deckCoverage,
  printIdFromImageUrl,
  printImageUrl,
} from '../collection-coverage';
import { supabase } from '../supabase.client';
import { CardThumb } from '../ui/card-thumb/card-thumb';
import { InfoToggle } from '../ui/info-toggle/info-toggle';

/**
 * "Sammlung" in der Deck-Ansicht: welche Karten des Decks fehlen in der eigenen Sammlung, und
 * welche reichen nicht für alle eigenen Decks zusammen. Zugeklappt eine Zeile wie die
 * Matchups. Gerechnet wird in collection-coverage.ts.
 *
 * Artwork-Prüfung je Deck (decks.collection_strict_art): "egal" zählt jede Fassung der Karte,
 * "genau dieses" nur das im Deck gewählte Artwork (gleiche illustration_id, Sprache egal). Bei
 * fremden Decks gilt die Wahl nur für diesen Blick und wird nicht gespeichert.
 */
@Component({
  selector: 'app-deck-collection',
  imports: [CardThumb, InfoToggle],
  templateUrl: './deck-collection.html',
  styleUrl: './deck-collection.scss',
})
export class DeckCollection {
  readonly i18n = inject(I18nService);
  readonly auth = inject(AuthService);
  readonly collection = inject(CollectionService);
  private readonly deckService = inject(DeckService);
  private readonly state = inject(DeckViewerState);

  readonly deckId = input.required<string>();
  readonly canEdit = input(false);

  readonly expanded = signal(false);
  readonly strictArt = signal(false);
  readonly illustrations = signal<ReadonlyMap<string, string | null>>(new Map());
  readonly picking = signal(false);
  readonly pickMessage = signal<string | null>(null);
  private strictColumn = true;

  readonly coverage = computed(() =>
    deckCoverage({
      deckId: this.deckId(),
      cards: this.state.viewingDeckCards(),
      ownedByName: this.collection.ownedByName(),
      usage: this.collection.deckUsage() ?? [],
      strictArt: this.strictArt(),
      illustrations: this.illustrations(),
    }),
  );

  readonly visible = computed(
    () =>
      !!this.auth.currentUser() &&
      this.collection.available() &&
      this.collection.entries() !== null,
  );

  constructor() {
    effect(() => {
      if (!this.auth.currentUser()) return;
      void this.collection.ensureLoaded();
      void this.collection.ensureDeckUsage();
    });
    effect(() => {
      const id = this.deckId();
      this.strictArt.set(false);
      this.pickMessage.set(null);
      if (this.strictColumn) void this.loadStrict(id);
    });
    // Artworks der Deck-Karten erst nachschlagen, wenn sie gebraucht werden.
    effect(() => {
      if (this.strictArt() && this.expanded()) void this.loadIllustrations();
    });
  }

  private async loadStrict(id: string): Promise<void> {
    const { data, error } = await supabase
      .from('decks')
      .select('collection_strict_art')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      if (error.code === '42703') this.strictColumn = false;
      return;
    }
    if (this.deckId() === id) this.strictArt.set(!!data?.collection_strict_art);
  }

  async setStrict(value: boolean): Promise<void> {
    this.strictArt.set(value);
    if (!this.canEdit() || !this.strictColumn) return;
    const { error } = await supabase
      .from('decks')
      .update({ collection_strict_art: value })
      .eq('id', this.deckId());
    if (error) {
      if (error.code === '42703' || error.code === 'PGRST204') this.strictColumn = false;
      else console.error('Konnte Artwork-Prüfung nicht speichern:', error);
    }
  }

  private async loadIllustrations(): Promise<void> {
    const ids = this.state
      .viewingDeckCards()
      .map((c) => printIdFromImageUrl(c.imageUrl))
      .filter((id): id is string => !!id);
    const missing = ids.filter((id) => !this.illustrations().has(id));
    if (missing.length === 0) return;
    const found = await this.collection.illustrationsOf(missing);
    this.illustrations.update((map) => new Map([...map, ...found]));
  }

  otherDecksText(card: CardCoverage): string {
    return card.otherDecks
      .map((d) => (d.quantity > 1 ? `${d.deckName} (${d.quantity})` : d.deckName))
      .join(', ');
  }

  /**
   * Setzt bei jeder Karte, die in der Sammlung liegt, aber in einem anderen Artwork im Deck steht,
   * das Bild auf einen eigenen Druck (den mit den meisten Exemplaren). Karten, deren Artwork schon
   * in der Sammlung liegt, bleiben unangetastet.
   */
  async pickFromCollection(): Promise<void> {
    if (!this.canEdit() || this.picking()) return;
    this.picking.set(true);
    this.pickMessage.set(null);
    await this.loadIllustrations();
    const illustrations = this.illustrations();
    const owned = this.collection.ownedByName();
    let changed = 0;
    for (const card of this.state.viewingDeckCards()) {
      if (card.isToken) continue;
      const entries = owned.get(collectionKey(card.cardName));
      if (!entries?.length) continue;
      const current = printIdFromImageUrl(card.imageUrl);
      const currentIll = current ? illustrations.get(current) : null;
      if (
        current &&
        entries.some(
          (e) => e.scryfallId === current || (currentIll && e.illustrationId === currentIll),
        )
      ) {
        continue;
      }
      const best = [...entries].sort(
        (a, b) => b.quantity - a.quantity || Number(a.foil) - Number(b.foil),
      )[0];
      const imageUrl = printImageUrl(best.scryfallId);
      if (await this.deckService.updateCardImage(this.deckId(), card.cardName, imageUrl)) {
        changed++;
        const key = card.cardName.toLowerCase();
        this.state.viewingDeckCards.update((cards) =>
          cards.map((c) => (c.cardName.toLowerCase() === key ? { ...c, imageUrl } : c)),
        );
        if (best.illustrationId)
          this.illustrations.update((map) =>
            new Map(map).set(best.scryfallId, best.illustrationId),
          );
      }
    }
    this.picking.set(false);
    this.pickMessage.set(this.i18n.t('deckView.collection.picked', { count: changed }));
  }
}
