import { Injectable, inject, signal } from '@angular/core';
import { ScryfallService } from './scryfall.service';

export interface CardImageEntry {
  imageUrl: string | null;
  backImageUrl: string | null;
}

/**
 * Kartenbild zu einem Kartennamen, gemeinsam für ui/card-thumb. Viele Listen nennen nur einen
 * Namen (Commander eines Decks, Empfehlungen, Änderungsverlauf); statt dass jede davon ihre eigene
 * Nachlade-Logik mitbringt, sammelt dieser Service alle Anfragen eines Augenblicks und fragt sie
 * gebündelt über ScryfallService.findCardsBulk() ab - der berücksichtigt die eingestellte
 * Artwork-Sprache. Ergebnisse (auch "nicht gefunden") bleiben für die Sitzung im Speicher.
 */
@Injectable({ providedIn: 'root' })
export class CardImageLookupService {
  private readonly scryfall = inject(ScryfallService);

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
    let found: Map<string, { imageUrl?: string | null; backImageUrl?: string | null }>;
    try {
      found = await this.scryfall.findCardsBulk(names);
    } catch (error) {
      console.error('Konnte Kartenbilder nicht laden:', error);
      found = new Map();
    }
    this.entries.update((current) => {
      const next = new Map(current);
      for (const name of names) {
        const key = CardImageLookupService.key(name);
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
