import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase.client';

/** Realtime-Filter mit `in` sind auf 100 Werte begrenzt. */
const MAX_IN_FILTER = 100;

/** Mehrere Änderungen kurz hintereinander (ein Speichervorgang schreibt mehrere Zeilen) → ein Nachladen. */
const DEBOUNCE_MS = 250;

/**
 * Hört per Supabase Realtime auf Änderungen an den Turnier-Tabellen und meldet sie gebündelt.
 *
 * Zwei Kanäle: der Gruppenkanal erfährt von neuen/geänderten/gelöschten Turnieren, der
 * Turnierkanal von Teilnehmern, Runden, Tischen und Spielständen des aktiven Turniers. Was sich
 * geändert hat, lädt der Aufrufer selbst nach - die Ereignisse sind nur der Anstoß.
 *
 * Braucht sql/turnier-realtime-2026-09-29.sql; ohne kommen keine Ereignisse und nur der
 * Sicherheits-Poll des Aufrufers hält den Stand aktuell.
 */
export class TournamentRealtime {
  private groupChannel: RealtimeChannel | null = null;
  private groupKey = '';
  private tournamentChannel: RealtimeChannel | null = null;
  private tournamentKey = '';
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onChange: () => void,
    private readonly onConnection: (connected: boolean) => void,
  ) {}

  /** Gruppenkanal auf diese Gruppe setzen (null = keiner). Gleiche Gruppe: nichts tun. */
  watchGroup(groupId: string | null, activeTournamentId: () => string | null): void {
    if ((groupId ?? '') === this.groupKey) return;
    this.removeGroupChannel();
    this.groupKey = groupId ?? '';
    if (!groupId) return;

    this.groupChannel = supabase
      .channel(`tournaments:${groupId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'tournaments',
          filter: `group_id=eq.${groupId}`,
        },
        () => this.changed(),
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'tournaments',
          filter: `group_id=eq.${groupId}`,
        },
        () => this.changed(),
      )
      // DELETE lässt sich nicht filtern und trägt nur die ID - reicht, um das aktive zu erkennen.
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'tournaments' },
        (payload) => {
          if ((payload.old as { id?: string })?.id === activeTournamentId()) this.changed();
        },
      )
      .subscribe((status) => this.onConnection(status === 'SUBSCRIBED'));
  }

  /** Turnierkanal auf dieses Turnier und seine Tische setzen (null = keiner). */
  watchTournament(tournamentId: string | null, matchIds: readonly string[]): void {
    const ids = [...matchIds].sort().slice(0, MAX_IN_FILTER);
    const key = tournamentId ? `${tournamentId}|${ids.join(',')}` : '';
    if (key === this.tournamentKey) return;
    this.removeTournamentChannel();
    this.tournamentKey = key;
    if (!tournamentId) return;

    const byTournament = `tournament_id=eq.${tournamentId}`;
    let channel = supabase.channel(`tournament:${tournamentId}`);
    for (const table of ['tournament_participants', 'tournament_rounds', 'tournament_matches']) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: byTournament },
        () => this.changed(),
      );
    }
    // Spielstände (games_won) stehen nur an den Tisch-Teilnehmern, die kein tournament_id haben.
    if (ids.length > 0) {
      channel = channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournament_match_players',
          filter: `tournament_match_id=in.(${ids.join(',')})`,
        },
        () => this.changed(),
      );
    }
    this.tournamentChannel = channel.subscribe();
  }

  stop(): void {
    this.removeGroupChannel();
    this.removeTournamentChannel();
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  private changed(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.onChange();
    }, DEBOUNCE_MS);
  }

  private removeGroupChannel(): void {
    if (this.groupChannel) void supabase.removeChannel(this.groupChannel);
    this.groupChannel = null;
    this.groupKey = '';
    this.onConnection(false);
  }

  private removeTournamentChannel(): void {
    if (this.tournamentChannel) void supabase.removeChannel(this.tournamentChannel);
    this.tournamentChannel = null;
    this.tournamentKey = '';
  }
}
