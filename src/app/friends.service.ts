import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';

/**
 * Freunde (sql/freunde-2026-10-04.sql): Anfragen, Freundesliste, Profilsuche, Neuigkeiten,
 * Bilanz gegen einen Account und die Gesamtbilanz für die Freunde-Rangliste. Freundesspiele
 * selbst (Partien ohne Gruppe) laufen über MtgService/GameSessionService.
 *
 * Fehlt die Migration, schaltet sich alles beim ersten "Funktion/Tabelle fehlt" still ab
 * (PGRST202/42883/42P01/PGRST205) - der Freunde-Abschnitt verschwindet dann.
 */
export interface Friendship {
  otherId: string;
  displayName: string;
  avatarUrl: string | null;
  status: 'pending' | 'accepted';
  /** true = der andere hat MICH gefragt. */
  incoming: boolean;
}

export interface ProfileHit {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface FriendActivity {
  kind: 'match' | 'deck';
  happenedAt: string;
  friendId: string;
  friendName: string;
  matchId: string | null;
  gameMode: string | null;
  gameFormat: string | null;
  won: boolean | null;
  playerCount: number | null;
  deckId: string | null;
  deckName: string | null;
  commander: string | null;
}

export interface FriendOverall {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  games: number;
  wins: number;
}

const FEHLT = new Set(['PGRST202', '42883', '42P01', 'PGRST205']);

@Injectable({ providedIn: 'root' })
export class FriendsService {
  private readonly auth = inject(AuthService);

  readonly verfuegbar = signal(true);
  readonly friendships = signal<Friendship[]>([]);
  readonly loaded = signal(false);

  readonly friends = computed(() => this.friendships().filter((f) => f.status === 'accepted'));
  readonly incoming = computed(() => this.friendships().filter((f) => f.status === 'pending' && f.incoming));
  readonly outgoing = computed(() => this.friendships().filter((f) => f.status === 'pending' && !f.incoming));

  constructor() {
    // Beim Login laden, beim Logout leeren - wie das Postfach.
    effect(() => {
      const user = this.auth.currentUser();
      if (user) this.refresh();
      else {
        this.friendships.set([]);
        this.loaded.set(false);
      }
    });
  }

  private fehlt(error: { code?: string } | null): boolean {
    if (!error || !FEHLT.has(error.code ?? '')) return false;
    console.warn('Freunde-Funktionen fehlen noch - sql/freunde-2026-10-04.sql ausführen.');
    this.verfuegbar.set(false);
    return true;
  }

  async refresh(): Promise<void> {
    if (!this.verfuegbar() || !this.auth.currentUser()) return;
    const { data, error } = await supabase.rpc('my_friendships');
    if (error) {
      if (!this.fehlt(error)) console.error('Konnte Freunde nicht laden:', error);
      return;
    }
    this.friendships.set(
      ((data ?? []) as any[]).map((r) => ({
        otherId: r.other_id,
        displayName: r.display_name ?? '?',
        avatarUrl: r.avatar_url ?? null,
        status: r.status,
        incoming: !!r.incoming,
      })),
    );
    this.loaded.set(true);
  }

  statusWith(userId: string): 'none' | 'friends' | 'incoming' | 'outgoing' {
    const f = this.friendships().find((x) => x.otherId === userId);
    if (!f) return 'none';
    if (f.status === 'accepted') return 'friends';
    return f.incoming ? 'incoming' : 'outgoing';
  }

  async request(userId: string): Promise<boolean> {
    const me = this.auth.currentUser()?.id;
    if (!me || me === userId) return false;
    // Hat der andere mich schon gefragt, ist "anfragen" in Wahrheit "annehmen".
    if (this.statusWith(userId) === 'incoming') return this.accept(userId);
    const { error } = await supabase.from('friendships').insert({ requester: me, addressee: userId });
    if (error && error.code !== '23505') {
      if (!this.fehlt(error)) console.error('Konnte Freundschaftsanfrage nicht senden:', error);
      return false;
    }
    await this.refresh();
    return true;
  }

  async accept(userId: string): Promise<boolean> {
    const me = this.auth.currentUser()?.id;
    if (!me) return false;
    const { error } = await supabase
      .from('friendships')
      .update({ status: 'accepted', accepted_at: new Date().toISOString() })
      .eq('requester', userId)
      .eq('addressee', me);
    if (error) {
      if (!this.fehlt(error)) console.error('Konnte Anfrage nicht annehmen:', error);
      return false;
    }
    await this.refresh();
    return true;
  }

  /** Ablehnen, zurückziehen oder entfreunden - es gibt je Paar nur eine Zeile. */
  async remove(userId: string): Promise<boolean> {
    const me = this.auth.currentUser()?.id;
    if (!me) return false;
    const { error } = await supabase
      .from('friendships')
      .delete()
      .or(`and(requester.eq.${me},addressee.eq.${userId}),and(requester.eq.${userId},addressee.eq.${me})`);
    if (error) {
      if (!this.fehlt(error)) console.error('Konnte Freundschaft nicht entfernen:', error);
      return false;
    }
    await this.refresh();
    return true;
  }

  async search(query: string): Promise<ProfileHit[]> {
    if (query.trim().length < 2 || !this.verfuegbar()) return [];
    const { data, error } = await supabase.rpc('search_profiles', { p_query: query.trim() });
    if (error) {
      if (!this.fehlt(error)) console.error('Profilsuche fehlgeschlagen:', error);
      return [];
    }
    return ((data ?? []) as any[]).map((r) => ({ id: r.id, displayName: r.display_name ?? '?', avatarUrl: r.avatar_url ?? null }));
  }

  async activity(limit = 30): Promise<FriendActivity[]> {
    if (!this.verfuegbar()) return [];
    const { data, error } = await supabase.rpc('friend_activity', { p_limit: limit });
    if (error) {
      if (!this.fehlt(error)) console.error('Konnte Neuigkeiten nicht laden:', error);
      return [];
    }
    return ((data ?? []) as any[]).map((r) => ({
      kind: r.kind,
      happenedAt: r.happened_at,
      friendId: r.friend_id,
      friendName: r.friend_name ?? '?',
      matchId: r.match_id,
      gameMode: r.game_mode,
      gameFormat: r.game_format,
      won: r.won,
      playerCount: r.player_count,
      deckId: r.deck_id,
      deckName: r.deck_name,
      commander: r.commander,
    }));
  }

  async headToHead(userId: string): Promise<{ games: number; myWins: number; theirWins: number } | null> {
    if (!this.verfuegbar() || !this.auth.currentUser()) return null;
    const { data, error } = await supabase.rpc('head_to_head', { p_other: userId });
    if (error) {
      if (!this.fehlt(error)) console.error('Konnte Bilanz nicht laden:', error);
      return null;
    }
    const row = ((data ?? []) as any[])[0];
    return row ? { games: row.games, myWins: row.my_wins, theirWins: row.their_wins } : null;
  }

  async overallStats(): Promise<FriendOverall[]> {
    if (!this.verfuegbar()) return [];
    const { data, error } = await supabase.rpc('friends_overall_stats');
    if (error) {
      if (!this.fehlt(error)) console.error('Konnte Freunde-Rangliste nicht laden:', error);
      return [];
    }
    return ((data ?? []) as any[]).map((r) => ({
      userId: r.user_id,
      displayName: r.display_name ?? '?',
      avatarUrl: r.avatar_url ?? null,
      games: r.games,
      wins: r.wins,
    }));
  }
}
