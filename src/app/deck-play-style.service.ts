import { Injectable, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { PLAY_STYLES, PlayStyle } from './deck-check';

/**
 * Spielweisen eines Decks (decks.play_styles, sql/deck-spielweise-2026-10-05.sql) - steuern die
 * Zielwerte im Deck-Check. Fehlt die Spalte, schaltet sich das Speichern beim ersten
 * 42703/PGRST204 still ab; die Auswahl wirkt dann nur bis zum Neuladen.
 */
@Injectable({ providedIn: 'root' })
export class DeckPlayStyleService {
  readonly verfuegbar = signal(true);

  /** null = noch nie festgelegt (dann darf der Deck-Check einen Vorschlag machen). */
  async load(deckId: string): Promise<PlayStyle[] | null> {
    if (!this.verfuegbar()) return null;
    const { data, error } = await supabase
      .from('decks')
      .select('play_styles')
      .eq('id', deckId)
      .maybeSingle();
    if (error) {
      if (!this.spalteFehlt(error)) console.error('Konnte Spielweise nicht laden:', error);
      return null;
    }
    const raw = (data as { play_styles?: string[] | null } | null)?.play_styles;
    // "cedh" hieß bis 06.10.2026 so, gemeint war schon immer das Fast Mana (weniger Länder).
    return raw
      ? raw
          .map((s) => (s === 'cedh' ? 'fastMana' : s))
          .filter((s): s is PlayStyle => (PLAY_STYLES as readonly string[]).includes(s))
      : null;
  }

  async save(deckId: string, styles: readonly PlayStyle[]): Promise<boolean> {
    if (!this.verfuegbar()) return false;
    // Wie beim Primer: updated_at bleibt stehen.
    const { error } = await supabase
      .from('decks')
      .update({ play_styles: [...styles] })
      .eq('id', deckId);
    if (error) {
      if (!this.spalteFehlt(error)) console.error('Konnte Spielweise nicht speichern:', error);
      return false;
    }
    return true;
  }

  private spalteFehlt(error: { code?: string; message?: string }): boolean {
    if (error.code !== '42703' && error.code !== 'PGRST204') return false;
    if (!(error.message ?? '').includes('play_styles')) return false;
    console.warn(
      'Spalte decks.play_styles fehlt noch - sql/deck-spielweise-2026-10-05.sql ausführen.',
    );
    this.verfuegbar.set(false);
    return true;
  }
}
