import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';

/** Eine gemerkte Commander-Idee, optional mit Partner (Partner, Background, Doctor …). */
export interface CommanderIdea {
  id: string;
  commander: string;
  partner: string | null;
  note: string;
  position: number;
}

/**
 * Commander-Ideen: private Merkliste je Konto (sql/commander-ideen-2026-10-22.sql). Eigene Seite
 * wie Sammlung und Cubes (commander-ideas-view/, `view`), hinzufügen auch aus der Kartenvorschau.
 * Fehlt die Migration, schaltet sich alles beim ersten Fehler still ab (`available`).
 */
@Injectable({ providedIn: 'root' })
export class CommanderIdeasService {
  private readonly auth = inject(AuthService);

  readonly available = signal(true);
  readonly ideas = signal<CommanderIdea[] | null>(null);
  readonly view = signal(false);
  private loadedFor: string | null = null;
  private loading: Promise<void> | null = null;

  /** Kleingeschriebene Commander-Namen, die schon allein (ohne Partner) gemerkt sind. */
  readonly savedNames = computed(
    () =>
      new Set((this.ideas() ?? []).filter((i) => !i.partner).map((i) => i.commander.toLowerCase())),
  );

  constructor() {
    effect(() => {
      const uid = this.auth.currentUser()?.id ?? null;
      if (uid !== this.loadedFor) {
        this.ideas.set(null);
        this.loadedFor = null;
        this.view.set(false);
      }
    });
  }

  openView(): void {
    this.view.set(true);
    void this.ensureLoaded();
  }

  closeView(): void {
    this.view.set(false);
  }

  ensureLoaded(): Promise<void> {
    const uid = this.auth.currentUser()?.id;
    if (!uid || !this.available() || this.loadedFor === uid) return Promise.resolve();
    this.loading ??= (async () => {
      const { data, error } = await supabase
        .from('commander_ideas')
        .select('id, commander, partner, note, position')
        .eq('user_id', uid)
        .order('position')
        .order('created_at', { ascending: false });
      this.loading = null;
      if (error) {
        this.disableOnMissing(error);
        return;
      }
      this.loadedFor = uid;
      this.ideas.set((data ?? []) as CommanderIdea[]);
    })();
    return this.loading;
  }

  /** Neue Idee ganz oben. false = gab es schon oder Speichern fehlgeschlagen. */
  async add(commander: string, partner: string | null = null): Promise<boolean> {
    await this.ensureLoaded();
    const list = this.ideas();
    if (!list) return false;
    const same = (i: CommanderIdea) =>
      i.commander.toLowerCase() === commander.toLowerCase() &&
      (i.partner ?? '').toLowerCase() === (partner ?? '').toLowerCase();
    if (list.some(same)) return false;
    const position = list.length ? Math.min(...list.map((i) => i.position)) - 1 : 0;
    const { data, error } = await supabase
      .from('commander_ideas')
      .insert({ commander, partner, position })
      .select('id, commander, partner, note, position')
      .single();
    if (error || !data) {
      if (error) this.disableOnMissing(error);
      return false;
    }
    this.ideas.set([data as CommanderIdea, ...list]);
    return true;
  }

  async remove(id: string): Promise<void> {
    const { error } = await supabase.from('commander_ideas').delete().eq('id', id);
    if (!error) this.ideas.update((list) => (list ?? []).filter((i) => i.id !== id));
  }

  async update(
    id: string,
    patch: Partial<Pick<CommanderIdea, 'note' | 'partner'>>,
  ): Promise<boolean> {
    const { error } = await supabase.from('commander_ideas').update(patch).eq('id', id);
    if (error) return false;
    this.ideas.update((list) => (list ?? []).map((i) => (i.id === id ? { ...i, ...patch } : i)));
    return true;
  }

  /** Eine Idee um einen Platz nach oben (-1) oder unten (+1). */
  async move(id: string, direction: -1 | 1): Promise<void> {
    const before = this.ideas() ?? [];
    const list = [...before];
    const index = list.findIndex((i) => i.id === id);
    const other = index + direction;
    if (index < 0 || other < 0 || other >= list.length) return;
    [list[index], list[other]] = [list[other], list[index]];
    // Neu durchzählen statt nur zwei Werte zu tauschen: ältere Zeilen können gleiche Positionen haben.
    const oldPosition = new Map(before.map((i) => [i.id, i.position]));
    const renumbered = list.map((i, n) => ({ ...i, position: n }));
    this.ideas.set(renumbered);
    await Promise.all(
      renumbered
        .filter((i) => oldPosition.get(i.id) !== i.position)
        .map((i) =>
          supabase.from('commander_ideas').update({ position: i.position }).eq('id', i.id),
        ),
    );
  }

  private disableOnMissing(error: { code?: string }): void {
    if (['42P01', 'PGRST205', 'PGRST202'].includes(error.code ?? '')) this.available.set(false);
  }
}
