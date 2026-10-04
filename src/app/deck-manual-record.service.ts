import { Injectable, signal } from '@angular/core';
import { supabase } from './supabase.client';

/** Nachgetragene Bilanz eines Decks (decks.manual_record, sql/deck-nachgetragene-bilanz-2026-10-04.sql). */
export interface ManualRecord {
  wins: number;
  losses: number;
  draws: number;
}

/**
 * Liest und schreibt die nachgetragene Bilanz. Bewusst keine erfundenen Partien - siehe den Kopf
 * der Migration. Fehlt die Spalte noch, schaltet sich alles beim ersten 42703/PGRST204 still ab.
 */
@Injectable({ providedIn: 'root' })
export class DeckManualRecordService {
  readonly verfuegbar = signal(true);

  async load(deckId: string): Promise<ManualRecord | null> {
    if (!this.verfuegbar()) return null;
    const { data, error } = await supabase
      .from('decks')
      .select('manual_record')
      .eq('id', deckId)
      .maybeSingle();
    if (error) {
      if (!this.spalteFehlt(error))
        console.error('Konnte nachgetragene Bilanz nicht laden:', error);
      return null;
    }
    return normalize((data as { manual_record?: unknown } | null)?.manual_record);
  }

  /** null oder alles 0 löscht die Bilanz. */
  async save(deckId: string, record: ManualRecord | null): Promise<boolean> {
    if (!this.verfuegbar()) return false;
    const value =
      record && record.wins + record.losses + record.draws > 0 ? normalize(record) : null;
    // Wie beim Primer: updated_at bleibt stehen - eine Bilanz von früher hebt das Deck nicht an
    // die Spitze der nach Datum sortierten Listen.
    const { error } = await supabase
      .from('decks')
      .update({ manual_record: value })
      .eq('id', deckId);
    if (error) {
      if (!this.spalteFehlt(error))
        console.error('Konnte nachgetragene Bilanz nicht speichern:', error);
      return false;
    }
    return true;
  }

  private spalteFehlt(error: { code?: string; message?: string }): boolean {
    if (error.code !== '42703' && error.code !== 'PGRST204') return false;
    if (!(error.message ?? '').includes('manual_record')) return false;
    console.warn(
      'Spalte decks.manual_record fehlt noch - sql/deck-nachgetragene-bilanz-2026-10-04.sql ausführen.',
    );
    this.verfuegbar.set(false);
    return true;
  }
}

function normalize(value: unknown): ManualRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const n = (x: unknown) => Math.max(0, Math.min(9999, Math.round(Number(x) || 0)));
  const record = { wins: n(v['wins']), losses: n(v['losses']), draws: n(v['draws']) };
  return record.wins + record.losses + record.draws > 0 ? record : null;
}
