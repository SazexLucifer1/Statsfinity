import { Component, computed, effect, inject, input } from '@angular/core';
import { CardImage } from '../../card-image/card-image';
import { CardImageLookupService } from '../../card-image-lookup.service';
import { CardPreviewService } from '../../card-preview.service';

/**
 * Kleines Kartenbild zu einem Kartennamen - überall dort, wo ein Deck (Bild seines Commanders) oder
 * eine einzelne Karte nur als Name stünde (Wunsch des Users, 06.10.2026). Antippen öffnet die
 * übliche Kartenvorschau. Das Bild kommt gebündelt aus CardImageLookupService; ein schon bekanntes
 * Bild (z. B. deck_cards.image_url) lässt sich als imageUrl mitgeben und spart die Suche.
 *
 * Bei Partner-Commandern ("A + B") zeigt das Bild den ersten. Solange gesucht wird, hält ein
 * leerer Rahmen den Platz frei (kein Springen der Zeile); gibt es kein Bild, verschwindet er.
 */
@Component({
  selector: 'app-card-thumb',
  imports: [CardImage],
  templateUrl: './card-thumb.html',
  styleUrl: './card-thumb.scss',
  host: { '[class.large]': "size() === 'large'", '[class.hidden]': 'missing()' },
})
export class CardThumb {
  private readonly lookup = inject(CardImageLookupService);
  private readonly preview = inject(CardPreviewService);

  readonly name = input.required<string | null | undefined>();
  readonly imageUrl = input<string | null | undefined>(null);
  /** 'small' für Textzeilen und Listen, 'large' für Ranglisten-Zeilen. */
  readonly size = input<'small' | 'large'>('small');

  /** Erster Name bei Partnern ("A + B") - Kartenname für Suche und Vorschau. */
  readonly cardName = computed(() => (this.name() ?? '').split(' + ')[0].trim());

  private readonly entry = computed(() => {
    const name = this.cardName();
    if (!name) return null;
    return this.lookup.entries().get(CardImageLookupService.key(name));
  });

  readonly image = computed(() => this.imageUrl() || this.entry()?.imageUrl || null);
  readonly backImage = computed(() => this.entry()?.backImageUrl ?? null);
  /** Gesucht und nichts gefunden (bzw. gar kein Name) - dann nimmt der Baustein keinen Platz ein. */
  readonly missing = computed(() => !this.image() && (!this.cardName() || this.entry() === null));

  constructor() {
    effect(() => {
      const name = this.cardName();
      if (name && !this.imageUrl()) this.lookup.request(name);
    });
  }

  open(event: Event): void {
    event.stopPropagation();
    const img = this.image();
    if (img) this.preview.open(img, this.backImage(), this.cardName());
  }
}
