import { Injectable, effect, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { DeckFormat } from './models';

/**
 * Cube-Builder: eigene Cubes mit Kartenliste (Wunsch des Users, 17.10.2026, Vorbild CubeCobra).
 * Tabellen und Begründung der schlanken Form: sql/cubes-2026-10-17.sql. Nicht die Gruppen-Cubes
 * aus MtgService.cubes() - die sind nur Namen fürs Erfassen einer Partie.
 *
 * Angezeigt in cube-view/ als eigene Seite wie die Sammlung. Fehlt die Migration, schaltet sich
 * alles beim ersten 42P01/PGRST205 still ab (`available`).
 */

export interface CubeSummary {
  id: string;
  name: string;
  description: string;
  collectionOnly: boolean;
  /** Format des Cubes; null = freier Modus (sql/cube-format-2026-10-19.sql). */
  format: DeckFormat | null;
  cardCount: number;
  updatedAt: string;
}

export interface CubeCard {
  cardName: string;
  /** Gewählter Druck fürs Bild; null = Standardbild. */
  scryfallId: string | null;
  quantity: number;
  addedAt: string;
}

function isMissingMigration(error: { code?: string } | null): boolean {
  return !!error && ['42P01', 'PGRST205', 'PGRST200'].includes(error.code ?? '');
}

function toSummary(row: any): CubeSummary {
  const cards = (row.cube_list_cards as { quantity: number }[] | null) ?? [];
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    collectionOnly: !!row.collection_only,
    format: (row.format as DeckFormat | null) ?? null,
    cardCount: cards.reduce((sum, c) => sum + (c.quantity ?? 1), 0),
    updatedAt: row.updated_at,
  };
}

@Injectable({ providedIn: 'root' })
export class CubeService {
  private readonly auth = inject(AuthService);

  readonly available = signal(true);
  /** Eigene Cubes; null = noch nicht geladen. */
  readonly cubes = signal<CubeSummary[] | null>(null);

  /** Offene Seite: null = zu, `cubeId` null = die Übersicht der eigenen Cubes. */
  readonly view = signal<{ cubeId: string | null } | null>(null);

  constructor() {
    // Bei Kontowechsel die Cubes des vorigen Kontos sofort vergessen.
    let uidBefore: string | null = null;
    effect(() => {
      const uid = this.auth.currentUser()?.id ?? null;
      if (uid === uidBefore) return;
      uidBefore = uid;
      this.cubes.set(null);
      this.view.set(null);
    });
  }

  openList(): void {
    this.view.set({ cubeId: null });
  }

  openCube(cubeId: string): void {
    this.view.set({ cubeId });
  }

  /** Aus einem Cube zurück zur Übersicht, aus der Übersicht ganz zu. */
  back(): void {
    this.view.set(this.view()?.cubeId ? { cubeId: null } : null);
  }

  /** false, solange sql/cube-format-2026-10-19.sql fehlt - dann gibt es keine Formatwahl. */
  readonly formatAvailable = signal(true);

  private columns(): string {
    return `id, name, description, collection_only, updated_at${this.formatAvailable() ? ', format' : ''}`;
  }

  async loadCubes(): Promise<CubeSummary[]> {
    const uid = this.auth.currentUser()?.id;
    if (!uid || !this.available()) return [];
    let { data, error } = await supabase
      .from('cube_lists')
      .select(`${this.columns()}, cube_list_cards(quantity)`)
      .eq('user_id', uid)
      .order('updated_at', { ascending: false });
    if (error?.code === '42703' && this.formatAvailable()) {
      this.formatAvailable.set(false);
      return this.loadCubes();
    }
    if (error) {
      if (isMissingMigration(error)) this.available.set(false);
      else console.error('Konnte Cubes nicht laden:', error);
      return [];
    }
    const list = (data ?? []).map(toSummary);
    this.cubes.set(list);
    return list;
  }

  async create(name: string, format: DeckFormat | null = null): Promise<CubeSummary | null> {
    const trimmed = name.trim().slice(0, 80);
    if (!trimmed || !this.auth.currentUser()) return null;
    const row: Record<string, unknown> = { name: trimmed };
    if (this.formatAvailable()) row['format'] = format;
    const { data, error } = await supabase
      .from('cube_lists')
      .insert(row)
      .select(this.columns())
      .single();
    if (error) {
      if (isMissingMigration(error)) this.available.set(false);
      console.error('Konnte Cube nicht anlegen:', error);
      return null;
    }
    const cube = toSummary(data);
    this.cubes.update((list) => [cube, ...(list ?? [])]);
    return cube;
  }

  async update(
    id: string,
    patch: Partial<Pick<CubeSummary, 'name' | 'description' | 'collectionOnly' | 'format'>>,
  ): Promise<boolean> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) row['name'] = patch.name.trim().slice(0, 80);
    if (patch.description !== undefined) row['description'] = patch.description.slice(0, 2000);
    if (patch.collectionOnly !== undefined) row['collection_only'] = patch.collectionOnly;
    if (patch.format !== undefined && this.formatAvailable()) row['format'] = patch.format;
    const { error } = await supabase.from('cube_lists').update(row).eq('id', id);
    if (error) {
      console.error('Konnte Cube nicht speichern:', error);
      return false;
    }
    this.cubes.update((list) => list?.map((c) => (c.id === id ? { ...c, ...patch } : c)) ?? null);
    return true;
  }

  async remove(id: string): Promise<boolean> {
    const { error } = await supabase.from('cube_lists').delete().eq('id', id);
    if (error) {
      console.error('Konnte Cube nicht löschen:', error);
      return false;
    }
    this.cubes.update((list) => list?.filter((c) => c.id !== id) ?? null);
    return true;
  }

  async loadCards(cubeId: string): Promise<CubeCard[]> {
    const all: CubeCard[] = [];
    // In Seiten zu 1000 - so viele liefert PostgREST höchstens auf einmal.
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('cube_list_cards')
        .select('card_name, scryfall_id, quantity, added_at')
        .eq('cube_id', cubeId)
        .order('card_name')
        .range(from, from + 999);
      if (error) {
        console.error('Konnte Cube-Karten nicht laden:', error);
        return all;
      }
      all.push(
        ...(data ?? []).map((r) => ({
          cardName: r.card_name,
          scryfallId: r.scryfall_id ?? null,
          quantity: r.quantity,
          addedAt: r.added_at,
        })),
      );
      if (!data || data.length < 1000) return all;
    }
  }

  /** Schreibt Karten mit ihrer neuen Anzahl (upsert); Anzahl 0 nimmt sie heraus. */
  async saveCards(
    cubeId: string,
    cards: Pick<CubeCard, 'cardName' | 'scryfallId' | 'quantity'>[],
  ): Promise<boolean> {
    const keep = cards.filter((c) => c.quantity > 0);
    const drop = cards.filter((c) => c.quantity <= 0).map((c) => c.cardName);
    if (keep.length) {
      const { error } = await supabase.from('cube_list_cards').upsert(
        keep.map((c) => ({
          cube_id: cubeId,
          card_name: c.cardName,
          scryfall_id: c.scryfallId,
          quantity: Math.min(99, c.quantity),
        })),
      );
      if (error) {
        console.error('Konnte Cube-Karten nicht speichern:', error);
        return false;
      }
    }
    if (drop.length) {
      const { error } = await supabase
        .from('cube_list_cards')
        .delete()
        .eq('cube_id', cubeId)
        .in('card_name', drop);
      if (error) {
        console.error('Konnte Cube-Karten nicht entfernen:', error);
        return false;
      }
    }
    // Damit der zuletzt bearbeitete Cube in der Übersicht oben steht.
    await supabase
      .from('cube_lists')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', cubeId);
    return true;
  }
}
