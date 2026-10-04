import { Injectable, signal } from '@angular/core';
import { supabase } from './supabase.client';

export interface CardSuggestion {
  cardName: string;
  /** In so vielen anderen öffentlichen Decks mit demselben Commander. */
  deckCount: number;
  /** So viele Vergleichsdecks gibt es insgesamt. */
  totalDecks: number;
}

/**
 * Kartenempfehlungen aus den eigenen öffentlichen Decks mit demselben Commander
 * (sql/deck-empfehlungen-2026-10-04.sql) - der EDHREC-freie Weg zu "was spielen andere?".
 * Fehlt die Funktion, schaltet sich alles beim ersten PGRST202/42883 still ab.
 */
@Injectable({ providedIn: 'root' })
export class DeckSuggestionsService {
  readonly verfuegbar = signal(true);

  async load(deckId: string, limit = 20): Promise<CardSuggestion[]> {
    if (!this.verfuegbar()) return [];
    const { data, error } = await supabase.rpc('deck_card_suggestions_checked', { p_deck_id: deckId, p_limit: limit });
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') {
        console.warn('deck_card_suggestions_checked() fehlt noch - sql/deck-empfehlungen-2026-10-04.sql ausführen.');
        this.verfuegbar.set(false);
      } else {
        console.error('Konnte Kartenempfehlungen nicht laden:', error);
      }
      return [];
    }
    return ((data ?? []) as { card_name: string; deck_count: number; total_decks: number }[]).map((r) => ({
      cardName: r.card_name,
      deckCount: r.deck_count,
      totalDecks: r.total_decks,
    }));
  }
}
