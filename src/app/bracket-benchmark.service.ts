import { Injectable, signal } from '@angular/core';
import { supabase } from './supabase.client';
import type { BracketLevel } from './bracket';
import type { BenchmarkDeck, BenchmarkErgebnis, MerkmalKey } from './bracket-benchmark';

/** Ein gespeicherter Stand (bracket_benchmark_staende). */
export interface BenchmarkStand {
  id: string;
  erstelltAt: string;
  ergebnis: BenchmarkErgebnis;
}

/** Spalten der SQL-Funktion -> Merkmal in der App. */
const SPALTEN: Record<MerkmalKey, string> = {
  gameChanger: 'game_changer',
  tutoren: 'tutoren',
  combos: 'combos',
  laender: 'laender',
  rampe: 'rampe',
  interaktion: 'interaktion',
  mld: 'mld',
  extrazuege: 'extrazuege',
  avgCmc: 'avg_cmc',
};

/**
 * Lädt die Merkmale der eigenen Decks (nur Developer, sql/bracket-benchmark-eigen-2026-09-29.sql)
 * und liest/schreibt gespeicherte Stände. Die Rechnung selbst steht in bracket-benchmark.ts.
 */
@Injectable({ providedIn: 'root' })
export class BracketBenchmarkService {
  /** Fehlt die Migration noch, verschwindet der Abschnitt still (Funktion oder Tabelle unbekannt). */
  readonly verfuegbar = signal(true);

  async decks(): Promise<BenchmarkDeck[]> {
    const { data, error } = await supabase.rpc('bracket_benchmark_merkmale');
    if (error) {
      if (this.fehlt(error)) return [];
      throw error;
    }
    return ((data ?? []) as Record<string, unknown>[]).map((z) => ({
      bracket: z['bracket'] as BracketLevel,
      werte: Object.fromEntries(
        Object.entries(SPALTEN).map(([m, spalte]) => [
          m,
          z[spalte] == null ? null : Number(z[spalte]),
        ]),
      ) as BenchmarkDeck['werte'],
    }));
  }

  async staende(): Promise<BenchmarkStand[]> {
    const { data, error } = await supabase
      .from('bracket_benchmark_staende')
      .select('id, erstellt_at, ergebnis')
      .order('erstellt_at', { ascending: false })
      .limit(20);
    if (error) {
      if (this.fehlt(error)) return [];
      throw error;
    }
    return ((data ?? []) as Record<string, unknown>[]).map((z) => ({
      id: z['id'] as string,
      erstelltAt: z['erstellt_at'] as string,
      ergebnis: z['ergebnis'] as BenchmarkErgebnis,
    }));
  }

  async speichern(ergebnis: BenchmarkErgebnis): Promise<void> {
    const { error } = await supabase.from('bracket_benchmark_staende').insert({ ergebnis });
    if (error && !this.fehlt(error)) throw error;
  }

  async loeschen(id: string): Promise<void> {
    const { error } = await supabase.from('bracket_benchmark_staende').delete().eq('id', id);
    if (error && !this.fehlt(error)) throw error;
  }

  private fehlt(error: { code?: string }): boolean {
    if (['PGRST202', '42883', '42P01', 'PGRST205'].includes(error.code ?? '')) {
      this.verfuegbar.set(false);
      return true;
    }
    return false;
  }
}
