import { Injectable, inject, signal } from '@angular/core';
import { CardDataService } from './card-data.service';

export interface CardImageEntry {
  imageUrl: string | null;
  backImageUrl: string | null;
}

/**
 * Kartenbild zu einem Kartennamen, gemeinsam für ui/card-thumb. Viele Listen nennen nur einen
 * Namen (Commander eines Decks, Empfehlungen, Änderungsverlauf); statt dass jede davon ihre eigene
 * Nachlade-Logik mitbringt, sammelt dieser Service alle Anfragen eines Augenblicks und fragt sie
 * gebündelt über CardDataService.findCardsBulk() ab (Datenbank-Cache, Rest live bei Scryfall) - das
 * berücksichtigt die eingestellte Artwork-Sprache. Ergebnisse (auch "nicht gefunden") bleiben für
 * die Sitzung im Speicher, gescheiterte Abfragen nicht.
 */
@Injectable({ providedIn: 'root' })
export class CardImageLookupService {
  private readonly cardData = inject(CardDataService);

  /** Kleingeschriebener Name -> Bild; null = gesucht und nicht gefunden. */
  readonly entries = signal<ReadonlyMap<string, CardImageEntry | null>>(new Map());
  private readonly pending = new Set<string>();
  private readonly requested = new Set<string>();
  private scheduled = false;

  static key(name: string): string {
    return name.trim().toLowerCase();
  }

  /** Bild zu einem Namen anfordern; lädt höchstens einmal je Sitzung. */
  request(name: string): void {
    const key = CardImageLookupService.key(name);
    if (!key || this.requested.has(key)) return;
    this.requested.add(key);
    this.pending.add(name.trim());
    if (this.scheduled) return;
    this.scheduled = true;
    // Ein Takt Verzögerung, damit eine ganze Liste in einer Anfrage landet statt einer je Zeile.
    setTimeout(() => void this.flush(), 0);
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    const names = [...this.pending];
    this.pending.clear();
    if (names.length === 0) return;
    // Erst der nächtliche Karten-Cache in der eigenen Datenbank, nur was dort fehlt live bei Scryfall
    // (CardDataService.findCardsBulk) - vorher ging jede Liste direkt an Scryfall, und wenn Scryfall
    // nach vielen Anfragen drosselte, blieben die Bilder für die ganze Sitzung weg.
    let found: Map<string, { imageUrl?: string | null; backImageUrl?: string | null }>;
    const failed = new Set<string>();
    try {
      found = await this.cardData.findCardsBulk(names, failed);
    } catch (error) {
      console.error('Konnte Kartenbilder nicht laden:', error);
      found = new Map();
      for (const name of names) failed.add(name);
    }
    // Gescheiterte Abfragen nicht als "kein Bild" merken - beim nächsten Anzeigen erneut versuchen.
    for (const name of failed) this.requested.delete(CardImageLookupService.key(name));
    const failedKeys = new Set([...failed].map((n) => CardImageLookupService.key(n)));
    this.entries.update((current) => {
      const next = new Map(current);
      for (const name of names) {
        const key = CardImageLookupService.key(name);
        if (failedKeys.has(key)) continue;
        const card = found.get(key);
        next.set(
          key,
          card?.imageUrl
            ? { imageUrl: card.imageUrl, backImageUrl: card.backImageUrl ?? null }
            : null,
        );
      }
      return next;
    });
  }
}
