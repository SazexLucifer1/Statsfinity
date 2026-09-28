import { Injectable, signal } from '@angular/core';
import { supabase } from './supabase.client';
import type { BracketLevel } from './bracket';
import type { StufenErgebnis } from './forge-einstufung';

/** Eine gespeicherte Einstufung aus der Forge-Simulation (forge_einstufungen, eine Zeile je Lauf). */
export interface ForgeErgebnis {
  id: string;
  erstelltAt: string;
  stufe: BracketLevel;
  simStufe: BracketLevel;
  regelMinimum: BracketLevel | null;
  sicherheit: 'sicher' | 'knapp';
  stufen: (StufenErgebnis & { siegRundeSchnitt: number | null; comboSiege?: number })[];
  unbekannteKarten: string[];
}

export type ForgeAuftragStatus = 'wartet' | 'laeuft' | 'fertig' | 'fehler';

export interface ForgeAuftrag {
  id: string;
  status: ForgeAuftragStatus;
  erstelltAt: string;
  gestartetAt: string | null;
  runUrl: string | null;
  fehler: string | null;
  /** Stand je Stufe, gemeldet nach jeder Partie (sql/forge-fortschritt-2026-09-28.sql). Leer vor dem Start. */
  fortschritt: Partial<Record<BracketLevel, ForgeFortschritt>>;
}

export interface ForgeFortschritt {
  gespielt: number;
  geplant: number;
  siege: number;
}

const AUFTRAG_SPALTEN = 'id, status, erstellt_at, gestartet_at, run_url, fehler';

/**
 * Liest Einstufungen und Aufträge der Forge-Simulation und legt Aufträge an.
 * Tabellen und Begründung: sql/forge-einstufung-2026-09-28.sql, Ablauf: scripts/forge/README.md
 *
 * Die App startet die Simulation NICHT selbst - dafür bräuchte sie einen GitHub-Schlüssel, und im
 * Browser ist nichts geheim. Sie legt einen Auftrag an, den der Workflow forge-einstufung.yml alle
 * 15 Minuten abholt. Anlegen und Lesen der Aufträge erlaubt die RLS nur Developern; die Oberfläche
 * blendet den Abschnitt für alle anderen aus.
 *
 * Kein Zustand je Deck am Service: Den Abschnitt gibt es nur in deck-detail-view, die Komponente hält
 * ihn selbst. Hier liegt nur, ob die Migration schon gelaufen ist.
 */
@Injectable({ providedIn: 'root' })
export class ForgeEinstufungService {
  /**
   * Fehlen die Tabellen noch (42P01 bzw. PGRST205 aus dem Schema-Cache von PostgREST), verschwindet
   * der Abschnitt still - gleiche Mechanik wie bei Primer und Kommentaren.
   */
  readonly verfuegbar = signal(true);

  /** Fehlt sql/forge-fortschritt-2026-09-28.sql noch (42703), wird die Spalte nicht mehr angefragt. */
  private fortschrittVerfuegbar = true;

  async laden(
    deckId: string,
  ): Promise<{ ergebnis: ForgeErgebnis | null; auftrag: ForgeAuftrag | null }> {
    const leer = { ergebnis: null, auftrag: null };
    if (!this.verfuegbar()) return leer;

    const [erg, auf0] = await Promise.all([
      supabase
        .from('forge_einstufungen')
        .select(
          'id, erstellt_at, stufe, sim_stufe, regel_minimum, sicherheit, stufen, unbekannte_karten',
        )
        .eq('deck_id', deckId)
        .order('erstellt_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      this.auftragLaden(deckId),
    ]);
    let auf = auf0;
    if (auf.error?.code === '42703' && this.fortschrittVerfuegbar) {
      this.fortschrittVerfuegbar = false;
      auf = await this.auftragLaden(deckId);
    }
    for (const e of [erg.error, auf.error]) {
      if (!e) continue;
      if (this.tabelleFehlt(e)) return leer;
      throw e;
    }

    const r = erg.data as Record<string, unknown> | null;
    const a = auf.data as Record<string, unknown> | null;
    return {
      ergebnis: r && {
        id: r['id'] as string,
        erstelltAt: r['erstellt_at'] as string,
        stufe: r['stufe'] as BracketLevel,
        simStufe: r['sim_stufe'] as BracketLevel,
        regelMinimum: (r['regel_minimum'] as BracketLevel | null) ?? null,
        sicherheit: r['sicherheit'] as 'sicher' | 'knapp',
        stufen: (r['stufen'] as ForgeErgebnis['stufen']) ?? [],
        unbekannteKarten: (r['unbekannte_karten'] as string[] | null) ?? [],
      },
      auftrag: a && {
        id: a['id'] as string,
        status: a['status'] as ForgeAuftragStatus,
        erstelltAt: a['erstellt_at'] as string,
        gestartetAt: (a['gestartet_at'] as string | null) ?? null,
        runUrl: (a['run_url'] as string | null) ?? null,
        fehler: (a['fehler'] as string | null) ?? null,
        fortschritt: (a['fortschritt'] as ForgeAuftrag['fortschritt'] | undefined) ?? {},
      },
    };
  }

  private auftragLaden(deckId: string) {
    return supabase
      .from('forge_einstufung_auftraege')
      .select(this.fortschrittVerfuegbar ? `${AUFTRAG_SPALTEN}, fortschritt` : AUFTRAG_SPALTEN)
      .eq('deck_id', deckId)
      .order('erstellt_at', { ascending: false })
      .limit(1)
      .maybeSingle();
  }

  /** Legt einen Auftrag an. Steht für das Deck schon einer offen, verhindert das ein Unique-Index. */
  async anfordern(deckId: string): Promise<void> {
    const { error } = await supabase.from('forge_einstufung_auftraege').insert({ deck_id: deckId });
    if (error) {
      if (this.tabelleFehlt(error)) return;
      throw error;
    }
  }

  private tabelleFehlt(error: { code?: string }): boolean {
    if (error.code === '42P01' || error.code === 'PGRST205') {
      this.verfuegbar.set(false);
      return true;
    }
    return false;
  }
}
