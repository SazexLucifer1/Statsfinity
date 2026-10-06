import { Injectable, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { DialogService } from './dialog.service';
import { I18nService } from './i18n.service';

/**
 * Deck-Versionen (decks.version, sql/partie-ergebnis-deck-version-2026-10-06.sql): eine laufende
 * Nummer je Deck. Jede gespeicherte Partie merkt sich die damals aktuelle Version (Trigger auf
 * match_players), die Deck-Ansicht vergleicht daraus die Versionen (deck-performance/).
 *
 * Eine neue Version entsteht nie von selbst, sondern nur, wenn der Besitzer nach dem Speichern
 * einer geänderten Kartenliste "Neue Version" wählt (Wunsch des Users, 06.10.2026) - automatisch
 * je Speichern gäbe es bei jedem Basteln Dutzende Versionen mit je ein, zwei Partien. Gefragt wird
 * nur, wenn die aktuelle Version schon Partien hat: ohne Partien gehört die Änderung schlicht noch
 * zur aktuellen Version.
 *
 * Fehlt die Migration, schaltet sich das beim ersten 42703/PGRST204 still ab.
 */
@Injectable({ providedIn: 'root' })
export class DeckVersionService {
  private readonly dialog = inject(DialogService);
  private readonly i18n = inject(I18nService);

  private verfuegbar = true;
  /** Deck, zu dem `current` gehört - eine überholte Antwort darf kein anderes Deck überschreiben. */
  readonly deckId = signal<string | null>(null);
  /** Aktuelle Version des geöffneten Decks, null = unbekannt bzw. Migration fehlt. */
  readonly current = signal<number | null>(null);

  private istFehlendeSpalte(error: { code?: string; message?: string } | null): boolean {
    if (!error) return false;
    if (error.code !== '42703' && error.code !== 'PGRST204') return false;
    if (!/version/.test(error.message ?? '')) return false;
    console.warn(
      'Spalte decks.version fehlt noch - sql/partie-ergebnis-deck-version-2026-10-06.sql im Supabase-SQL-Editor ausführen. Bis dahin gibt es keine Deck-Versionen.',
    );
    this.verfuegbar = false;
    return true;
  }

  async load(deckId: string): Promise<void> {
    this.deckId.set(deckId);
    this.current.set(null);
    if (!this.verfuegbar) return;
    const { data, error } = await supabase
      .from('decks')
      .select('version')
      .eq('id', deckId)
      .maybeSingle();
    if (error) {
      if (!this.istFehlendeSpalte(error)) console.error('Konnte Deck-Version nicht laden:', error);
      return;
    }
    if (this.deckId() !== deckId) return;
    this.current.set((data as { version?: number } | null)?.version ?? null);
  }

  /**
   * Nach dem Speichern einer geänderten Kartenliste: fragen, ob das als neue Version zählt, und
   * bei Ja die Nummer hochzählen. Ohne Partien in der aktuellen Version wird nicht gefragt.
   */
  async askAfterSave(deckId: string): Promise<void> {
    if (!this.verfuegbar) return;
    if (this.deckId() !== deckId || this.current() === null) await this.load(deckId);
    const current = this.current();
    if (current === null) return;

    const { count, error } = await supabase
      .from('match_players')
      .select('match_id', { count: 'exact', head: true })
      .eq('deck_id', deckId)
      .eq('deck_version', current);
    if (error) {
      if (!this.istFehlendeSpalte(error))
        console.error('Konnte Partien der Deck-Version nicht zählen:', error);
      return;
    }
    if (!count) return;

    const next = current + 1;
    const choice = await this.dialog.choose(
      this.i18n.t('deckView.version.ask', { next, current }),
      [
        { key: 'new', label: this.i18n.t('deckView.version.new', { next }), variant: 'primary' },
        { key: 'same', label: this.i18n.t('deckView.version.same', { current }) },
      ],
    );
    if (choice !== 'new') return;

    // Nur hochzählen, wenn in der Zwischenzeit niemand anderes hochgezählt hat.
    const { data, error: updateError } = await supabase
      .from('decks')
      .update({ version: next })
      .eq('id', deckId)
      .eq('version', current)
      .select('version');
    if (updateError) {
      if (!this.istFehlendeSpalte(updateError))
        console.error('Konnte neue Deck-Version nicht speichern:', updateError);
      return;
    }
    if ((data ?? []).length === 0) {
      await this.load(deckId);
      return;
    }
    if (this.deckId() === deckId) this.current.set(next);
  }
}
