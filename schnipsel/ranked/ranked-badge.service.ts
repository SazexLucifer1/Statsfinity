import { Injectable, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { GroupService } from './group.service';
import { MtgService } from './mtg.service';
import { seasonResults } from './elo';
import { DeckFormat, GameMode } from './models';

export interface RankedBadge {
  id: string;
  groupName: string;
  mode: GameMode;
  format: DeckFormat | null;
  lp: number;
  seasonStartedAt: string | null;
  seasonEndedAt: string;
}

const FEHLT = new Set(['42P01', 'PGRST205', '42703']);

/**
 * Ranked-Saisons (sql/ranked-saison-2026-10-06.sql): Neustart der Wertung und dauerhafte
 * Saison-Abzeichen im Profil. Die Elo selbst wird weiter nur gerechnet (elo.ts) - gespeichert
 * wird allein das Endergebnis einer beendeten Saison, weil es nach dem Neustart nicht mehr aus
 * den Partien folgt. Fehlt die Migration, verschwinden Knöpfe und Abzeichen still.
 */
@Injectable({ providedIn: 'root' })
export class RankedBadgeService {
  private readonly auth = inject(AuthService);
  private readonly groups = inject(GroupService);
  private readonly mtg = inject(MtgService);

  readonly verfuegbar = signal(true);

  async badgesFor(userId: string): Promise<RankedBadge[]> {
    if (!this.verfuegbar()) return [];
    const { data, error } = await supabase
      .from('ranked_badges')
      .select('id, group_name, mode, format, lp, season_started_at, season_ended_at')
      .eq('user_id', userId)
      .order('season_ended_at', { ascending: false });
    if (error) {
      if (FEHLT.has(error.code ?? '')) this.verfuegbar.set(false);
      else console.error('Konnte Saison-Abzeichen nicht laden:', error);
      return [];
    }
    return ((data as any[] | null) ?? []).map((r) => ({
      id: r.id,
      groupName: r.group_name,
      mode: r.mode,
      format: r.format ?? null,
      lp: r.lp,
      seasonStartedAt: r.season_started_at ?? null,
      seasonEndedAt: r.season_ended_at,
    }));
  }

  /**
   * Saison beenden (nur Gruppenleiter): Endstand je Wertung als Abzeichen für jeden Spieler mit
   * Konto und fertiger Einstufung, danach Neustart. Spieler ohne Konto (NPCs) bekommen keins -
   * es gibt kein Profil, in dem es stehen könnte. Gibt die Zahl der Abzeichen zurück, null bei
   * einem Fehler (dann wird auch nicht neu gestartet).
   */
  async endSeason(groupId: string, groupName: string): Promise<number | null> {
    if (!this.auth.currentUser()) return null;
    const matches =
      groupId === this.groups.groupId()
        ? this.mtg.history()
        : await this.mtg.loadMatchesForGroups([groupId]);
    const season = this.groups.seasonMatches(matches, groupId);

    const { data: players, error: playersError } = await supabase
      .from('players')
      .select('display_name, user_id')
      .eq('group_id', groupId)
      .not('user_id', 'is', null);
    if (playersError) {
      console.error('Konnte Spieler der Gruppe nicht laden:', playersError);
      return null;
    }
    const userByName = new Map(
      ((players as { display_name: string; user_id: string }[] | null) ?? []).map((p) => [
        p.display_name,
        p.user_id,
      ]),
    );

    const seasonStart = this.groups.rankedSince(groupId);
    const rows = seasonResults(season)
      .filter((r) => userByName.has(r.name))
      .map((r) => ({
        user_id: userByName.get(r.name)!,
        group_id: groupId,
        group_name: groupName,
        mode: r.mode,
        format: r.format,
        lp: r.lp,
        season_started_at: seasonStart,
        created_by: this.auth.currentUser()!.id,
      }));

    if (rows.length > 0) {
      const { error } = await supabase.from('ranked_badges').insert(rows);
      if (error) {
        if (FEHLT.has(error.code ?? '')) this.verfuegbar.set(false);
        console.error('Konnte Saison-Abzeichen nicht speichern:', error);
        return null;
      }
    }
    return (await this.groups.startNewRankedSeason(groupId)) ? rows.length : null;
  }
}
