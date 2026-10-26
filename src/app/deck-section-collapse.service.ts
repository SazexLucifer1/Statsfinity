import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'statsfinity.collapsedDeckSections';

/**
 * Eingeklappte Bereiche der Kartenliste (Kreaturen, Spontanzauber, Maybeboard …) - Wunsch des
 * Users, 26.10.2026. Gilt für beide Deck-Ansichten (deck-detail-view, auch im Bearbeiten-Modus,
 * und public-deck-browser) und über Decks hinweg: Wer das Maybeboard zuklappt, will es meist bei
 * jedem Deck zu haben. Gemerkt wird der Abschnitts-Schlüssel (section.label), nicht die
 * übersetzte Überschrift - sonst ginge die Wahl beim Sprachwechsel verloren. Nur im Browser
 * gespeichert, eine reine Bequemlichkeit.
 */
@Injectable({ providedIn: 'root' })
export class DeckSectionCollapseService {
  readonly collapsed = signal<ReadonlySet<string>>(this.read());

  isCollapsed(label: string): boolean {
    return this.collapsed().has(label);
  }

  toggle(label: string): void {
    const next = new Set(this.collapsed());
    if (next.has(label)) next.delete(label);
    else next.add(label);
    this.collapsed.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // Privates Fenster o. Ä. - dann gilt die Wahl eben nur bis zum Neuladen.
    }
  }

  private read(): ReadonlySet<string> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
    } catch {
      return new Set();
    }
  }
}
