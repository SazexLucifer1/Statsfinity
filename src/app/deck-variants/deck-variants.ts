import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { I18nService } from '../i18n.service';
import { AuthService } from '../auth.service';
import { CardDataService } from '../card-data.service';
import { DeckPdfService, PdfSourceCard } from '../deck-pdf.service';
import { DeckVariantService } from '../deck-variant.service';
import { compareDeckVariants, totalQuantity, VariantEntry } from '../deck-variants';
import { CardThumb } from '../ui/card-thumb/card-thumb';
import { InfoToggle } from '../ui/info-toggle/info-toggle';

type VariantList = 'common' | 'onlyThis' | 'onlyOther';

/**
 * "Varianten" in beiden Deck-Ansichten (deck-detail-view und public-deck-browser): andere
 * Fassungen desselben Decks verknüpfen und vergleichen - in beiden, nur hier, nur in der Variante.
 * Zugeklappt eine Zeile wie Sammlung und Matchups. Jede Liste lässt sich als PDF drucken (der
 * normale PDF-Export, nur mit dieser Liste) - für die markierten Tauschkarten.
 */
@Component({
  selector: 'app-deck-variants',
  imports: [CardThumb, InfoToggle],
  templateUrl: './deck-variants.html',
  styleUrl: './deck-variants.scss',
})
export class DeckVariants {
  readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthService);
  private readonly cardData = inject(CardDataService);
  private readonly pdf = inject(DeckPdfService);
  readonly service = inject(DeckVariantService);

  readonly deckId = input.required<string>();
  readonly deckName = input.required<string>();
  /** Account des Besitzers - nur er verknüpft und löst. */
  readonly ownerUserId = input<string | null>(null);

  readonly expanded = signal(false);
  readonly selectedVariantId = signal<string | null>(null);
  readonly list = signal<VariantList>('onlyThis');
  readonly linkTarget = signal<string>('');
  readonly pdfBusy = signal(false);

  readonly isOwner = computed(() => {
    const owner = this.ownerUserId();
    return !!owner && this.auth.currentUser()?.id === owner;
  });

  readonly visible = computed(
    () =>
      this.service.available() &&
      (this.service.variants().length > 0 ||
        (this.isOwner() && this.service.candidates().length > 0)),
  );

  readonly selectedVariant = computed(() => {
    const variants = this.service.variants();
    return variants.find((v) => v.id === this.selectedVariantId()) ?? variants.at(0) ?? null;
  });

  readonly comparison = computed(() => {
    const variant = this.selectedVariant();
    const other = variant ? this.service.otherCards().get(variant.id) : undefined;
    if (!variant || !other) return null;
    return compareDeckVariants(this.service.thisCards(), other);
  });

  readonly entries = computed<VariantEntry[]>(() => this.comparison()?.[this.list()] ?? []);

  readonly count = (list: VariantList): number => totalQuantity(this.comparison()?.[list] ?? []);

  constructor() {
    effect(() => {
      const id = this.deckId();
      const owner = this.ownerUserId();
      // Die Anmeldung mitlesen: Wer sich einloggt, ist danach womöglich der Besitzer.
      this.auth.currentUser();
      untracked(() => {
        this.selectedVariantId.set(null);
        this.linkTarget.set('');
        void this.service.load(id, owner);
      });
    });
    effect(() => {
      const variant = this.selectedVariant();
      if (variant && this.expanded())
        void untracked(() => this.service.ensureOtherCards(variant.id));
    });
  }

  listLabel(list: VariantList): string {
    const other = this.selectedVariant()?.name ?? '';
    const key =
      list === 'common'
        ? 'deckView.variants.common'
        : list === 'onlyThis'
          ? 'deckView.variants.onlyThis'
          : 'deckView.variants.onlyOther';
    return this.i18n.t(key, { count: this.count(list), name: other });
  }

  async link(): Promise<void> {
    const target = this.linkTarget();
    const owner = this.ownerUserId();
    if (!target || !owner) return;
    await this.service.link(this.deckId(), target, owner);
    this.selectedVariantId.set(target);
    this.linkTarget.set('');
    this.expanded.set(true);
  }

  async unlink(): Promise<void> {
    const owner = this.ownerUserId();
    if (!owner) return;
    await this.service.unlink(this.deckId(), owner);
  }

  /** Die gerade gezeigte Liste über den normalen PDF-Export drucken - Rückseiten von Doppelkarten inklusive. */
  async printList(): Promise<void> {
    const entries = this.entries();
    if (entries.length === 0) return;
    this.pdfBusy.set(true);
    try {
      const doubleFaced = entries
        .filter((e) => (e.typeLine ?? '').includes('//'))
        .map((e) => e.cardName);
      const details =
        doubleFaced.length > 0 ? await this.cardData.findCardsBulk(doubleFaced) : new Map();
      const cards: PdfSourceCard[] = entries.map((e) => {
        const back = details.get(e.cardName.toLowerCase())?.backImageUrl ?? null;
        // Gewählter Druck einer Doppelkarte: die Rückseite liegt unter /back/ statt /front/
        // (dieselbe Regel wie DeckViewerService.resolvedCardBackImage()).
        const backImageUrl =
          back && e.imageUrl?.includes('cards.scryfall.io/') && e.imageUrl.includes('/front/')
            ? e.imageUrl.replace('/front/', '/back/')
            : back;
        return { cardName: e.cardName, quantity: e.quantity, imageUrl: e.imageUrl, backImageUrl };
      });
      this.pdf.open(`${this.deckName()} - ${this.listLabel(this.list())}`, cards);
      // Tauschkarten braucht man in jedem Exemplar (2× Island heißt zwei Karten), nicht nur ein Bild.
      this.pdf.copiesMode.set('all');
    } finally {
      this.pdfBusy.set(false);
    }
  }
}
