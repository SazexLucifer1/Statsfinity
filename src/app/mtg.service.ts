import { Injectable, computed, effect, signal, inject } from '@angular/core';
import { Match, MatchPlayer, Cube, GameMode, GAME_MODES, LifeLog } from './models';
import { supabase } from './supabase.client';
import { GroupService } from './group.service';
import { AuthService } from './auth.service';
import { DeckService } from './deck.service';
import { ProfileService } from './profile.service';
import { chunk } from './array-utils';
import { mapMatchRow } from './match-utils';

/** Select-Liste für die "matches"-Query, gemeinsam genutzt von loadHistory() (echte aktive Gruppe)
 * und loadMatchesForGroups() (gruppenübergreifende Auswertungen im Stats-Tab). */
const MATCH_HISTORY_SELECT = `
  id,
  played_at,
  game_mode,
  game_format,
  winner_name,
  draft_set_id,
  draft_set_code,
  draft_set_name,
  draft_set_released_at,
  tournament_match_id,
  tournament_game_number,
  counts_in_general_stats,
  is_ranked,
  started_at,
  cubes ( id, name, is_commander ),
  match_players (
    player_name,
    commander_name,
    partner_commander_name,
    team,
    is_archenemy,
    deck_id,
    placement,
    turn_order,
    decks ( name, user_id, player_id, is_precon ),
    players ( display_name )
  )
`;

/**
 * Select-Liste ohne game_format - Rückfall, solange sql/match-category-format-split-2026-09-03.sql
 * fehlt. Sonst scheitert die Abfrage und die App steht ohne Matches da (siehe fetchMatchRows()).
 */
const MATCH_HISTORY_SELECT_WITHOUT_FORMAT = MATCH_HISTORY_SELECT.replace('  game_format,\n', '');

/** Fehlt die game_format-Spalte noch? Postgres meldet 42703 ("column ... does not exist"). */
function isMissingGameFormatError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42703' || (error.message ?? '').includes('game_format');
}

/**
 * Fehlt matches.is_ranked noch (sql/ranked-gruppe-2026-09-30.sql)? Dann einmal je Sitzung ohne sie
 * laden und speichern - alle Partien gelten dann als Ranked, wie vor der Migration.
 */
let isRankedSpalteVerfuegbar = true;

function isMissingIsRankedError(error: { code?: string; message?: string } | null): boolean {
  if (!error || !isRankedSpalteVerfuegbar) return false;
  if (error.code !== '42703' && error.code !== 'PGRST204') return false;
  if (!(error.message ?? '').includes('is_ranked')) return false;
  console.warn('Spalte matches.is_ranked fehlt noch - sql/ranked-gruppe-2026-09-30.sql im Supabase-SQL-Editor ausführen. Bis dahin zählen alle Partien als Ranked.');
  isRankedSpalteVerfuegbar = false;
  return true;
}

function ohneIsRanked(select: string): string {
  const ohne = isRankedSpalteVerfuegbar ? select : select.replace('  is_ranked,\n', '');
  return ohnePartieVerlauf(ohne);
}

/**
 * Fehlen matches.started_at/life_log oder match_players.turn_order noch
 * (sql/partie-verlauf-2026-10-04.sql)? Dann einmal je Sitzung ohne sie laden und speichern -
 * Startspieler, Dauer und Lebenspunkte-Verlauf gehen dann verloren, die Partie selbst nicht.
 */
let partieVerlaufVerfuegbar = true;

function isMissingPartieVerlaufError(error: { code?: string; message?: string } | null): boolean {
  if (!error || !partieVerlaufVerfuegbar) return false;
  if (error.code !== '42703' && error.code !== 'PGRST204') return false;
  const message = error.message ?? '';
  if (!['started_at', 'life_log', 'turn_order'].some((spalte) => message.includes(spalte))) return false;
  console.warn('Spalten für den Partie-Verlauf fehlen noch - sql/partie-verlauf-2026-10-04.sql im Supabase-SQL-Editor ausführen. Bis dahin werden Startspieler, Dauer und Lebenspunkte-Verlauf nicht gespeichert.');
  partieVerlaufVerfuegbar = false;
  return true;
}

function ohnePartieVerlauf(select: string): string {
  return partieVerlaufVerfuegbar ? select : select.replace('  started_at,\n', '').replace('    turn_order,\n', '');
}

@Injectable({ providedIn: 'root' })
export class MtgService {
  private readonly groupService = inject(GroupService);
  private readonly auth = inject(AuthService);
  private readonly deckService = inject(DeckService);
  private readonly profileService = inject(ProfileService);

  readonly allPlayers = signal<string[]>([]);
  private readonly playerIdsByName = signal<Record<string, string>>({});
  /** Spielername -> verknüpfte Account-User-ID (null = noch kein Account zugeordnet). */
  readonly playerUserIds = signal<Record<string, string | null>>({});
  /** Spielername -> Profilbild-URL des verknüpften Accounts (null = kein Account/kein Bild). */
  readonly playerAvatars = signal<Record<string, string | null>>({});
  /**
   * Spielername → Lieblingscommander eines NPC-Profils (vom Host gepflegt). Geht bei der
   * Verknüpfung per Alles-oder-nichts in profiles.favorite_commanders auf (linkPlayerToUser).
   */
  readonly playerFavoriteCommanders = signal<Record<string, string[]>>({});
  // ... der Rest bleibt unverändert
  readonly history = signal<Match[]>([]);
  readonly cubes = signal<Cube[]>([]);
  /** Spielername -> gewählter Hintergrundbild-Pfad. Persistiert dauerhaft, unabhängig vom Match. */
  readonly playerBackgrounds = signal<Record<string, string>>({});

  /**
   * Spielername → (Modus → darf der Account ihn im Stats-Tab sehen?). Nicht konfiguriert = erlaubt.
   */
  readonly statVisibility = signal<Map<string, Map<GameMode, boolean>>>(new Map());

  /**
   * Modus (oder 'Alle') → Mindestspielzahl für die Ranglisten; 0 = keine. Nicht konfiguriert:
   * Default in stats-tab.ts.
   */
  readonly qualificationSettings = signal<Map<string, number>>(new Map());

  /** Der eigene Spielername (falls der eingeloggte User über einen verknüpften players-Eintrag verfügt). */
  readonly myPlayerName = computed(() => this.playerNameForUserId(this.auth.currentUser()?.id));

  /**
   * Sind für den Viewer ALLE Modi in player_stat_visibility gesperrt? Ersetzt das frühere
   * groups.stats_locked: "alles gesperrt" ist nur ein Zustand der Matrix, einzelne Zellen lassen
   * sich wieder freigeben. "Alle sperren/freigeben" setzen nur die Matrix.
   */
  readonly allModesHiddenForMe = computed(() => {
    const name = this.myPlayerName();
    if (!name) return false;
    const modes = this.statVisibility().get(name);
    if (!modes) return false;
    return GAME_MODES.every((mode) => modes.get(mode) === false);
  });

  /** players.id zu einem Spielernamen dieser Gruppe - für Features, die direkt mit der players-ID arbeiten müssen (z.B. Turniere). */
  playerIdFor(name: string): string | null {
    return this.playerIdsByName()[name] ?? null;
  }

  /** Umkehrung von playerIdFor: aktueller Spielername zu einer players.id (oder null, falls unbekannt/gelöscht). */
  playerNameForId(playerId: string): string | null {
    const entry = Object.entries(this.playerIdsByName()).find(([, id]) => id === playerId);
    return entry?.[0] ?? null;
  }

  /** Spielername zu einer verknüpften Account-User-ID dieser Gruppe, oder null ohne Zuordnung. */
  playerNameForUserId(userId: string | null | undefined): string | null {
    if (!userId) return null;
    const entry = Object.entries(this.playerUserIds()).find(([, uid]) => uid === userId);
    return entry?.[0] ?? null;
  }

  /**
   * Spielername des Deck-Besitzers per ownerId (Account) oder ownerPlayerId (virtueller Spieler) -
   * für "ausgeliehen von X".
   */
  deckOwnerName(ownerId: string | undefined, ownerPlayerId?: string): string | null {
    if (ownerPlayerId) return this.playerNameForId(ownerPlayerId);
    return this.playerNameForUserId(ownerId);
  }

  constructor() {
    effect(() => {
      const groupId = this.groupService.groupId();
      if (groupId) {
        this.loadPlayers(groupId);
        this.loadCubes(groupId);
        this.loadHistory(groupId);
        this.loadPlayerBackgrounds(groupId);
        this.loadStatVisibility(groupId);
        this.loadQualificationSettings(groupId);
      } else {
        this.clearGroupData();
      }
    });
  }

  /** Setzt alle gruppen-gebundenen Daten zurück, wenn keine Gruppe (mehr) aktiv ist. */
  private clearGroupData(): void {
    this.allPlayers.set([]);
    this.playerIdsByName.set({});
    this.playerUserIds.set({});
    this.playerAvatars.set({});
    this.history.set([]);
    this.cubes.set([]);
    this.playerBackgrounds.set({});
    this.statVisibility.set(new Map());
    this.qualificationSettings.set(new Map());
  }

  private async loadQualificationSettings(groupId: string): Promise<void> {
    const { data, error } = await supabase
      .from('group_qualification_settings')
      .select('game_mode, min_games')
      .eq('group_id', groupId);

    if (error) {
      console.error('Konnte Qualifikations-Einstellungen nicht laden:', error);
      return;
    }

    const map = new Map<string, number>();
    for (const row of data as { game_mode: string; min_games: number }[]) {
      map.set(row.game_mode, row.min_games);
    }
    this.qualificationSettings.set(map);
  }

  /** Nur für Host oder freigeschaltetes Mitglied: legt die Mindestanzahl Spiele für einen Modus (oder 'Alle' für die Aggregat-Ansicht) fest. 0 = keine Mindestspielzahl. */
  async setQualificationThreshold(mode: GameMode | 'Alle', minGames: number): Promise<boolean> {
    const groupId = this.groupService.groupId();
    if (!groupId || !this.groupService.hasPermission('stats.qualificationThreshold')) return false;

    const { error } = await supabase
      .from('group_qualification_settings')
      .upsert(
        { group_id: groupId, game_mode: mode, min_games: minGames },
        { onConflict: 'group_id,game_mode' }
      );

    if (error) {
      console.error('Konnte Qualifikations-Einstellung nicht ändern:', error);
      return false;
    }

    this.qualificationSettings.update((map) => {
      const next = new Map(map);
      next.set(mode, minGames);
      return next;
    });
    return true;
  }

  private async loadStatVisibility(groupId: string): Promise<void> {
    const { data, error } = await supabase
      .from('player_stat_visibility')
      .select('game_mode, visible, players ( display_name )')
      .eq('group_id', groupId);

    if (error) {
      console.error('Konnte Sichtbarkeits-Einstellungen nicht laden:', error);
      return;
    }

    const map = new Map<string, Map<GameMode, boolean>>();
    for (const row of data as any[]) {
      const name = row.players?.display_name;
      if (!name) continue;
      const inner = map.get(name) ?? new Map<GameMode, boolean>();
      inner.set(row.game_mode, row.visible);
      map.set(name, inner);
    }
    this.statVisibility.set(map);
  }

  /** Nur für Host oder freigeschaltetes Mitglied: legt fest, ob die Stats eines Spielers für einen bestimmten Modus für die ganze Gruppe sichtbar sind. */
  async setStatVisibility(playerName: string, mode: GameMode, visible: boolean): Promise<boolean> {
    const groupId = this.groupService.groupId();
    if (!groupId || !this.groupService.hasPermission('stats.visibility')) return false;

    const playerId = this.playerIdsByName()[playerName];
    if (!playerId) return false;

    const { error } = await supabase
      .from('player_stat_visibility')
      .upsert(
        { group_id: groupId, player_id: playerId, game_mode: mode, visible },
        { onConflict: 'group_id,player_id,game_mode' }
      );

    if (error) {
      console.error('Konnte Sichtbarkeit nicht ändern:', error);
      return false;
    }

    this.statVisibility.update((map) => {
      const next = new Map(map);
      const inner = new Map(next.get(playerName) ?? []);
      inner.set(mode, visible);
      next.set(playerName, inner);
      return next;
    });
    return true;
  }

  /** Nur für Host oder freigeschaltetes Mitglied: setzt die Sichtbarkeit eines Spielers für alle Modi auf einmal. */
  async setStatVisibilityForAllModes(playerName: string, visible: boolean): Promise<boolean> {
    const groupId = this.groupService.groupId();
    if (!groupId || !this.groupService.hasPermission('stats.visibility')) return false;

    const playerId = this.playerIdsByName()[playerName];
    if (!playerId) return false;

    const rows = GAME_MODES.map((mode) => ({
      group_id: groupId,
      player_id: playerId,
      game_mode: mode,
      visible,
    }));

    const { error } = await supabase
      .from('player_stat_visibility')
      .upsert(rows, { onConflict: 'group_id,player_id,game_mode' });

    if (error) {
      console.error('Konnte Sichtbarkeit nicht ändern:', error);
      return false;
    }

    this.statVisibility.update((map) => {
      const next = new Map(map);
      next.set(playerName, new Map(GAME_MODES.map((mode) => [mode, visible])));
      return next;
    });
    return true;
  }
  private async loadPlayerBackgrounds(groupId: string): Promise<void> {
    const { data, error } = await supabase
      .from('player_backgrounds')
      .select('background_url, players ( display_name )')
      .eq('group_id', groupId);

    if (error) {
      console.error('Konnte Hintergründe nicht laden:', error);
      return;
    }

    const map: Record<string, string> = {};
    for (const row of data as any[]) {
      const name = row.players?.display_name;
      if (name) map[name] = row.background_url;
    }
    this.playerBackgrounds.set(map);
  }

  async setPlayerBackground(name: string, backgroundUrl: string | null): Promise<void> {
    const groupId = this.groupService.groupId();
    if (!groupId) return;

    const playerId = this.playerIdsByName()[name];
    if (!playerId) return;

    if (backgroundUrl) {
      const { error } = await supabase
        .from('player_backgrounds')
        .upsert(
          { group_id: groupId, player_id: playerId, background_url: backgroundUrl },
          { onConflict: 'player_id' }
        );

      if (error) {
        console.error('Konnte Hintergrund nicht speichern:', error);
        return;
      }
    } else {
      const { error } = await supabase
        .from('player_backgrounds')
        .delete()
        .eq('group_id', groupId)
        .eq('player_id', playerId);

      if (error) {
        console.error('Konnte Hintergrund nicht löschen:', error);
        return;
      }
    }

    this.playerBackgrounds.update((all) => {
      const next = { ...all };
      if (backgroundUrl) {
        next[name] = backgroundUrl;
      } else {
        delete next[name];
      }
      return next;
    });
  }
  // --- Spieler ---
  private async loadPlayers(groupId: string): Promise<void> {
    const { data, error } = await supabase
      .from('players')
      .select('id, display_name, user_id, favorite_commanders, profiles ( avatar_url )')
      .eq('group_id', groupId)
      .order('display_name', { ascending: true });

    if (error) {
      console.error('Konnte Spieler nicht laden:', error);
      return;
    }

    this.allPlayers.set(data.map((row) => row.display_name));

    const idMap: Record<string, string> = {};
    const userIdMap: Record<string, string | null> = {};
    const avatarMap: Record<string, string | null> = {};
    const favoriteCommanderMap: Record<string, string[]> = {};
    for (const row of data as any[]) {
      idMap[row.display_name] = row.id;
      userIdMap[row.display_name] = row.user_id ?? null;
      avatarMap[row.display_name] = row.profiles?.avatar_url ?? null;
      favoriteCommanderMap[row.display_name] = row.favorite_commanders ?? [];
    }
    this.playerIdsByName.set(idMap);
    this.playerUserIds.set(userIdMap);
    this.playerAvatars.set(avatarMap);
    this.playerFavoriteCommanders.set(favoriteCommanderMap);
  }

  /** Lieblingscommander eines NPC-Profils setzen (Host), höchstens 3 wie bei Accounts. */
  async setPlayerFavoriteCommanders(name: string, commanders: string[]): Promise<boolean> {
    const groupId = this.groupService.groupId();
    const playerId = this.playerIdsByName()[name];
    if (!groupId || !playerId || !this.groupService.hasPermission('npc.favoriteCommanders')) return false;

    const trimmed = commanders.slice(0, 3);
    const { error } = await supabase
      .from('players')
      .update({ favorite_commanders: trimmed })
      .eq('id', playerId);

    if (error) {
      console.error('Konnte Lieblingscommander des NPC-Profils nicht speichern:', error);
      return false;
    }

    this.playerFavoriteCommanders.update((map) => ({ ...map, [name]: trimmed }));
    return true;
  }

  async addPlayer(name: string): Promise<boolean> {
    const trimmed = name.trim();
    if (!trimmed || this.allPlayers().some((p) => p.toLowerCase() === trimmed.toLowerCase())) {
      return false;
    }

    const groupId = this.groupService.groupId();
    if (!groupId) return false;

    const { data, error } = await supabase
      .from('players')
      .insert({ group_id: groupId, display_name: trimmed })
      .select('id, display_name')
      .single();

    if (error || !data) {
      console.error('Konnte Spieler nicht anlegen:', error);
      return false;
    }

    this.allPlayers.update((players) => [...players, trimmed]);
    this.playerIdsByName.update((map) => ({ ...map, [trimmed]: data.id }));
    return true;
  }

  async renamePlayer(oldName: string, newName: string): Promise<boolean> {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return false;
    if (this.allPlayers().some((p) => p.toLowerCase() === trimmed.toLowerCase())) return false;

    const groupId = this.groupService.groupId();
    if (!groupId) return false;

    // Umbenennen darf jeder Spieler nur bei sich selbst (eigener verknüpfter Account) - alle
    // anderen Namen bleiben dem Host vorbehalten.
    const isSelf = this.playerUserIds()[oldName] === this.auth.currentUser()?.id;
    if (!isSelf && !this.groupService.hasPermission('player.renameOthers')) return false;

    const playerId = this.playerIdsByName()[oldName];

    const { error } = await supabase
      .from('players')
      .update({ display_name: trimmed })
      .eq('group_id', groupId)
      .eq('display_name', oldName);

    if (error) {
      console.error('Konnte Spieler nicht umbenennen:', error);
      return false;
    }

    // Der Name steht auch als Text in match_players/matches (überlebt Löschungen) und muss mit
    // umbenannt werden.
    if (playerId) {
      const { error: mpError } = await supabase
        .from('match_players')
        .update({ player_name: trimmed })
        .eq('player_id', playerId);
      if (mpError) console.error('Konnte Namen in Match-Historie nicht aktualisieren:', mpError);
    }

    const { error: matchError } = await supabase
      .from('matches')
      .update({ winner_name: trimmed })
      .eq('group_id', groupId)
      .eq('winner_name', oldName);
    if (matchError) console.error('Konnte Gewinner-Namen nicht aktualisieren:', matchError);

    this.allPlayers.update((players) => players.map((p) => (p === oldName ? trimmed : p)));
    this.history.update((matches) =>
      matches.map((m) => ({
        ...m,
        winner: m.winner === oldName ? trimmed : m.winner,
        players: m.players.map((mp) => (mp.name === oldName ? { ...mp, name: trimmed } : mp)),
      }))
    );

    // Name-indizierte Zuordnungen (playerUserIds u. a.) auf den neuen Namen umschlüsseln.
    const rekey = <T,>(map: Record<string, T>): Record<string, T> => {
      if (!(oldName in map)) return map;
      const { [oldName]: value, ...rest } = map;
      return { ...rest, [trimmed]: value };
    };
    this.playerIdsByName.update(rekey);
    this.playerUserIds.update(rekey);
    this.playerAvatars.update(rekey);
    this.playerBackgrounds.update(rekey);

    return true;
  }

  /** Nur für Host oder freigeschaltetes Mitglied - Spieler löschen ist einschneidender als Umbenennen, deshalb nicht auch selbst-erlaubt. */
  async deletePlayer(name: string): Promise<void> {
    const groupId = this.groupService.groupId();
    if (!groupId || !this.groupService.hasPermission('player.delete')) return;

    // Verknüpfte Accounts auch als Gruppenmitglied entfernen - sonst bliebe die Person Mitglied mit
    // vollem Zugriff.
    const linkedUserId = this.playerUserIds()[name];

    const { error } = await supabase
      .from('players')
      .delete()
      .eq('group_id', groupId)
      .eq('display_name', name);

    if (error) {
      console.error('Konnte Spieler nicht löschen:', error);
      return;
    }

    if (linkedUserId) {
      const { error: memberError } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', linkedUserId);
      if (memberError) console.error('Konnte Gruppenmitgliedschaft nicht entfernen:', memberError);
    }

    this.allPlayers.update((players) => players.filter((p) => p !== name));
  }

  /**
   * Führt mehrere Spieler-Einträge zu einem zusammen (z. B. Excel-"Theo" und Account "Theodor"):
   * hängt Matches, Turnier-Teilnahmen, Sichtbarkeit und Hintergründe auf das Ziel um und löscht die
   * Quellen. Nicht über deletePlayer(), da die Spiele sonst beim alten Namen blieben. Nur für Host
   * oder freigeschaltete Mitglieder.
   */
  async mergePlayers(targetName: string, sourceNames: string[]): Promise<boolean> {
    const groupId = this.groupService.groupId();
    if (!groupId || sourceNames.length === 0 || !this.groupService.hasPermission('player.merge')) return false;

    const idsByName = this.playerIdsByName();
    const targetId = idsByName[targetName];
    if (!targetId) return false;

    for (const sourceName of sourceNames) {
      const sourceId = idsByName[sourceName];
      if (!sourceId || sourceId === targetId) continue;

      const { error: mpError } = await supabase
        .from('match_players')
        .update({ player_id: targetId, player_name: targetName })
        .eq('player_id', sourceId);

      if (mpError) {
        console.error('Konnte Match-Spieler nicht zusammenführen:', mpError);
        return false;
      }

      const { error: matchError } = await supabase
        .from('matches')
        .update({ winner_name: targetName })
        .eq('group_id', groupId)
        .eq('winner_name', sourceName);

      if (matchError) {
        console.error('Konnte Gewinner-Namen nicht zusammenführen:', matchError);
        return false;
      }

      if (!(await this.mergeTournamentParticipation(sourceId, targetId))) return false;

      const { error: winnerError } = await supabase
        .from('tournament_matches')
        .update({ winner_player_id: targetId })
        .eq('winner_player_id', sourceId);
      if (winnerError) {
        console.error('Konnte Turnier-Tisch-Sieger nicht zusammenführen:', winnerError);
        return false;
      }

      // Sichtbarkeit/Hintergrund sind je (Gruppe, Spieler[, Modus]) eindeutig - bei Konflikt
      // gewinnt die Einstellung des Ziels, die Quellzeilen werden gelöscht.
      const { error: visibilityError } = await supabase.from('player_stat_visibility').delete().eq('player_id', sourceId);
      if (visibilityError) console.error('Konnte Sichtbarkeits-Einstellungen des zusammengeführten Spielers nicht löschen:', visibilityError);

      const { error: backgroundError } = await supabase.from('player_backgrounds').delete().eq('player_id', sourceId);
      if (backgroundError) console.error('Konnte Hintergrund des zusammengeführten Spielers nicht löschen:', backgroundError);

      // Decks eines virtuellen Quell-Spielers VOR dem Löschen umhängen (decks.player_id hat ON
      // DELETE CASCADE).
      const { error: deckMergeError } = await supabase.from('decks').update({ player_id: targetId }).eq('player_id', sourceId);
      if (deckMergeError) {
        console.error('Konnte Decks des zusammengeführten Spielers nicht übertragen:', deckMergeError);
        return false;
      }

      const { error: deleteError } = await supabase.from('players').delete().eq('id', sourceId);

      if (deleteError) {
        console.error('Konnte doppelten Spieler nicht löschen:', deleteError);
        return false;
      }
    }

    await Promise.all([
      this.loadPlayers(groupId),
      this.loadHistory(groupId),
      this.loadStatVisibility(groupId),
      this.loadPlayerBackgrounds(groupId),
    ]);

    return true;
  }

  /**
   * Hängt Turnier-Teilnahme und Tischzuordnungen um. Nahmen beide am selben Turnier teil (Unique
   * tournament_id+player_id), bleibt die Quell-Teilnahme stehen.
   */
  private async mergeTournamentParticipation(sourceId: string, targetId: string): Promise<boolean> {
    const { data: sourceRows, error: sourceError } = await supabase
      .from('tournament_participants')
      .select('id, tournament_id')
      .eq('player_id', sourceId);
    if (sourceError) {
      console.error('Konnte Turnier-Teilnahmen nicht laden:', sourceError);
      return false;
    }
    if (!sourceRows || sourceRows.length === 0) return true;

    const { data: targetRows, error: targetError } = await supabase
      .from('tournament_participants')
      .select('tournament_id')
      .eq('player_id', targetId)
      .in(
        'tournament_id',
        sourceRows.map((r) => r.tournament_id)
      );
    if (targetError) {
      console.error('Konnte Turnier-Teilnahmen des Ziel-Spielers nicht laden:', targetError);
      return false;
    }
    const targetTournamentIds = new Set((targetRows ?? []).map((r) => r.tournament_id));
    const mergeableParticipantIds = sourceRows.filter((r) => !targetTournamentIds.has(r.tournament_id)).map((r) => r.id);

    if (mergeableParticipantIds.length > 0) {
      const { error: participantError } = await supabase
        .from('tournament_participants')
        .update({ player_id: targetId })
        .in('id', mergeableParticipantIds);
      if (participantError) {
        console.error('Konnte Turnier-Teilnahmen nicht zusammenführen:', participantError);
        return false;
      }
    }

    const { error: matchPlayerError } = await supabase
      .from('tournament_match_players')
      .update({ player_id: targetId })
      .eq('player_id', sourceId);
    if (matchPlayerError) {
      console.error('Konnte Turnier-Tisch-Zuordnungen nicht zusammenführen:', matchPlayerError);
      return false;
    }

    return true;
  }

  /**
   * Verknüpft einen accountlosen Spieler mit einem Gruppenmitglied (alte Stats gehören dann dem
   * Account). Scheitert, wenn er inzwischen verknüpft ist.
   */
  async linkPlayerToUser(playerName: string, userId: string): Promise<boolean> {
    const groupId = this.groupService.groupId();
    if (!groupId || !this.groupService.hasPermission('player.link')) return false;

    const { error } = await supabase
      .from('players')
      .update({ user_id: userId })
      .eq('group_id', groupId)
      .eq('display_name', playerName)
      .is('user_id', null);

    if (error) {
      console.error('Konnte Spieler nicht verknüpfen:', error);
      return false;
    }

    this.playerUserIds.update((map) => ({ ...map, [playerName]: userId }));

    // Decks aus der accountlosen Zeit auf den Account umhängen, sonst wären sie unsichtbar.
    const playerId = this.playerIdsByName()[playerName];
    if (playerId) {
      const { error: deckMigrateError } = await supabase
        .from('decks')
        .update({ user_id: userId, player_id: null })
        .eq('player_id', playerId);
      if (deckMigrateError) console.error('Konnte Decks nicht auf den Account übertragen:', deckMigrateError);
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('avatar_url, favorite_commanders')
      .eq('id', userId)
      .single();
    this.playerAvatars.update((map) => ({ ...map, [playerName]: profile?.avatar_url ?? null }));

    // Lieblingscommander per Alles-oder-nichts: hat der Account schon welche, bleiben sie; sonst
    // übernimmt er die NPC-Liste (die dort geleert wird). Ins Profil eines ANDEREN Accounts nur bei
    // Selbstverknüpfung oder als Developer schreiben.
    const isSelfLink = this.auth.currentUser()?.id === userId;
    const npcFavorites = this.playerFavoriteCommanders()[playerName] ?? [];
    const accountFavorites = profile?.favorite_commanders ?? [];
    if (accountFavorites.length === 0 && npcFavorites.length > 0 && (isSelfLink || this.profileService.profile()?.isDeveloper)) {
      const { error: favoriteMergeError } = await supabase
        .from('profiles')
        .update({ favorite_commanders: npcFavorites })
        .eq('id', userId);

      if (favoriteMergeError) {
        console.error('Konnte Lieblingscommander nicht auf den Account übertragen:', favoriteMergeError);
      } else if (playerId) {
        await supabase.from('players').update({ favorite_commanders: [] }).eq('id', playerId);
        this.playerFavoriteCommanders.update((map) => ({ ...map, [playerName]: [] }));

        // Ist der verknüpfte Account der eingeloggte, auch das geladene Profil-Signal auffrischen.
        if (this.auth.currentUser()?.id === userId) {
          this.profileService.profile.update((p) => (p ? { ...p, favoriteCommanders: npcFavorites } : p));
        }
      }
    }

    return true;
  }

  // --- Matches ---

  // --- Matches ---

  /** Lädt den Match-Verlauf der aktiven Gruppe neu (z.B. nach einer Namens-Reparatur außerhalb dieses Signals). */
  async refreshHistory(): Promise<void> {
    const groupId = this.groupService.groupId();
    if (groupId) await this.loadHistory(groupId);
  }

  /**
   * matches-Abfrage mit einem Wiederholungsversuch ohne game_format, falls die Spalte fehlt. null,
   * wenn beides scheitert.
   */
  private async fetchMatchRows(
    run: (select: string) => PromiseLike<{ data: any[] | null; error: any }>,
    label: string
  ): Promise<any[] | null> {
    let first = await run(ohneIsRanked(MATCH_HISTORY_SELECT));
    if (isMissingIsRankedError(first.error)) first = await run(ohneIsRanked(MATCH_HISTORY_SELECT));
    if (isMissingPartieVerlaufError(first.error)) first = await run(ohneIsRanked(MATCH_HISTORY_SELECT));
    // Erst die eine, dann die andere Spalte kann fehlen - jede schaltet sich einmal selbst ab.
    if (isMissingIsRankedError(first.error)) first = await run(ohneIsRanked(MATCH_HISTORY_SELECT));
    if (!first.error) return first.data ?? [];

    if (isMissingGameFormatError(first.error)) {
      console.warn(`${label}: Spalte game_format fehlt noch (SQL-Migration ausstehend), lade ohne sie.`);
      const retry = await run(ohneIsRanked(MATCH_HISTORY_SELECT_WITHOUT_FORMAT));
      if (!retry.error) return retry.data ?? [];
      console.error(label, retry.error);
      return null;
    }

    console.error(label, first.error);
    return null;
  }

  private async loadHistory(groupId: string): Promise<void> {
    const rows = await this.fetchMatchRows(
      (select) =>
        supabase
          .from('matches')
          .select(select)
          .eq('group_id', groupId)
          .order('played_at', { ascending: false }),
      'Konnte Matches nicht laden:'
    );
    if (!rows) return;

    this.history.set(rows.map((row: any) => mapMatchRow(row)));
  }

  /**
   * Freundesspiele (Partien ohne Gruppe), an denen ich teilgenommen oder die ich angelegt habe -
   * RLS liefert ohnehin nur diese (sql/freunde-2026-10-04.sql). Fehlt die Migration, gibt es
   * schlicht keine Zeilen mit group_id = null, die ich sehen darf.
   */
  readonly friendHistory = signal<Match[]>([]);

  /**
   * Lebenspunkte-Verlauf einer gespeicherten Partie - einzeln geladen, weil er bewusst nicht in
   * MATCH_HISTORY_SELECT steht (je Partie einige kB, gebraucht nur für die eine geöffnete Kurve).
   */
  async loadLifeLog(matchId: string): Promise<LifeLog | null> {
    if (!partieVerlaufVerfuegbar) return null;
    const { data, error } = await supabase.from('matches').select('life_log').eq('id', matchId).maybeSingle();
    if (error) {
      if (!isMissingPartieVerlaufError(error)) console.error('Konnte Lebenspunkte-Verlauf nicht laden:', error);
      return null;
    }
    const log = (data as { life_log?: LifeLog | null } | null)?.life_log;
    return log && Array.isArray(log.units) && Array.isArray(log.events) ? log : null;
  }

  async loadFriendMatches(): Promise<Match[]> {
    if (!this.auth.currentUser()) {
      this.friendHistory.set([]);
      return [];
    }
    const rows = await this.fetchMatchRows(
      (select) =>
        supabase
          .from('matches')
          .select(select)
          .is('group_id', null)
          .order('played_at', { ascending: false }),
      'Konnte Freundesspiele nicht laden:',
    );
    const matches = (rows ?? []).map((row: any) => mapMatchRow(row));
    this.friendHistory.set(matches);
    return matches;
  }

  /** Spielername eines Accounts in einer (nicht unbedingt aktiven) eigenen Gruppe, oder null. */
  async playerNameInGroup(groupId: string, userId: string): Promise<string | null> {
    const { data, error } = await supabase
      .from('players')
      .select('display_name')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('Konnte Spielernamen nicht laden:', error);
      return null;
    }
    return (data?.display_name as string | undefined) ?? null;
  }

  /**
   * Wie loadHistory() für mehrere Gruppen, gibt die Matches zurück statt history() zu ändern
   * (Stats-Tab, fremde Gruppe).
   */
  async loadMatchesForGroups(groupIds: string[]): Promise<Match[]> {
    if (groupIds.length === 0) return [];

    const rows = await this.fetchMatchRows(
      (select) =>
        supabase
          .from('matches')
          .select(select)
          .in('group_id', groupIds)
          .order('played_at', { ascending: false }),
      'Konnte gruppenübergreifende Matches nicht laden:'
    );

    return (rows ?? []).map((row: any) => mapMatchRow(row));
  }

  /**
   * Alle Partien, in denen ein Deck gespielt wurde und die ich sehen darf (RLS: eigene Gruppen und
   * Freundesspiele) - für "Gegen welche Decks" in der Deck-Ansicht.
   */
  async loadMatchesForDeck(deckId: string): Promise<Match[]> {
    const { data, error } = await supabase.from('match_players').select('match_id').eq('deck_id', deckId);
    if (error) {
      console.error('Konnte Partien des Decks nicht laden:', error);
      return [];
    }
    const ids = [...new Set(((data as { match_id: string }[] | null) ?? []).map((r) => r.match_id))];
    if (ids.length === 0) return [];
    const rows = await this.fetchMatchRows(
      (select) => supabase.from('matches').select(select).in('id', ids.slice(0, 300)),
      'Konnte Partien des Decks nicht laden:',
    );
    return (rows ?? []).map((row: any) => mapMatchRow(row));
  }

  /**
   * Alle Matches eines Accounts aus ALLEN Gruppen - für fremde Profile
   * (sql/oeffentliche-matches-2026-09-23.sql). selfName = Name im jeweiligen Match. null = Funktion
   * fehlt oder Fehler.
   */
  async loadPublicMatchesForUser(userId: string): Promise<{ match: Match; selfName: string }[] | null> {
    const { data, error } = await supabase.rpc('public_player_matches', { p_user_id: userId });
    if (error) {
      console.error('Konnte öffentliche Matches nicht laden:', error);
      return null;
    }
    return ((data as any[] | null) ?? [])
      .filter((row) => !!row.self_name)
      .map((row) => ({ match: mapMatchRow(row), selfName: row.self_name as string }));
  }

  /**
   * Ergänzt fehlende deck_ids: passt der Commander zu einem eigenen Deck des Spielers, wird
   * verknüpft. Nie bei Cube/Draft.
   */
  private async resolveAutoDeckLinks(players: MatchPlayer[], mode: GameMode): Promise<MatchPlayer[]> {
    if (mode === 'Cube' || mode === 'Draft') return players;

    const cache = new Map<string, string | null>();
    const resolved: MatchPlayer[] = [];

    for (const p of players) {
      if (p.deckId || !p.commander) {
        resolved.push(p);
        continue;
      }
      const userId = this.playerUserIds()[p.name];
      const playerId = this.playerIdFor(p.name);
      if (!userId && !playerId) {
        resolved.push(p);
        continue;
      }
      const cacheKey = `${p.name.toLowerCase()}::${p.commander.toLowerCase()}`;
      if (!cache.has(cacheKey)) {
        let deckId: string | null = null;
        if (userId) deckId = await this.deckService.findDeckIdByCommander({ kind: 'user', userId }, p.commander);
        if (!deckId && playerId) deckId = await this.deckService.findDeckIdByCommander({ kind: 'player', playerId }, p.commander);
        cache.set(cacheKey, deckId);
      }
      const deckId = cache.get(cacheKey);
      resolved.push(deckId ? { ...p, deckId } : p);
    }

    return resolved;
  }

  /** Legt ein Match an und liefert dessen ID zurück (z.B. um danach optional Platzierungen nachzutragen) - null bei Fehler. */
  async addMatch(
    match: Omit<Match, 'id' | 'date' | 'countsInGeneralStats'> & {
      tournamentMatchId?: string;
      /** Default true (normale Matches zählen immer) - siehe Match.countsInGeneralStats. */
      countsInGeneralStats?: boolean;
      /** Default true; Turnierspiele werden immer als frei gespeichert - siehe Match.isRanked. */
      isRanked?: boolean;
      /** Lebenspunkte-Verlauf aus dem Tracker (matches.life_log) - nur gespeichert, nie lokal gehalten. */
      lifeLog?: LifeLog;
      /** Nachgetragene Partie: wann sie gespielt wurde (sonst setzt die Datenbank "jetzt"). */
      playedAt?: string;
      /** Freundesspiel: Partie ohne Gruppe (sql/freunde-2026-10-04.sql), Spieler über userId. */
      friendGame?: boolean;
    }
  ): Promise<string | null> {
    const friendGame = match.friendGame === true;
    const groupId = friendGame ? null : this.groupService.groupId();
    const userId = this.auth.currentUser()?.id ?? null;
    if (!friendGame && !groupId) return null;
    if (friendGame && !userId) return null;

    // Die automatische Deck-Zuordnung sucht in der Gruppe - ein Freundesspiel hat keine.
    const players = friendGame ? match.players : await this.resolveAutoDeckLinks(match.players, match.mode);

    // Ranked ist Gruppensache; Freundesspiele zählen nie für die Elo einer Gruppe.
    const isRanked = !friendGame && !match.tournamentMatchId && (match.isRanked ?? true);

    // Schritt 1: Zeile in "matches" anlegen
    const insertMatch = () =>
      supabase
        .from('matches')
        .insert({
          ...(isRankedSpalteVerfuegbar ? { is_ranked: isRanked } : {}),
          group_id: groupId,
          game_mode: match.mode,
          game_format: match.format ?? null,
          cube_id: match.cube?.id ?? null,
          winner_name: match.winner,
          draft_set_id: match.draftSet?.id ?? null,
          draft_set_code: match.draftSet?.code ?? null,
          draft_set_name: match.draftSet?.name ?? null,
          draft_set_released_at: match.draftSet?.releasedAt ?? null,
          tournament_match_id: match.tournamentMatchId ?? null,
          counts_in_general_stats: match.countsInGeneralStats ?? true,
          ...(match.playedAt ? { played_at: match.playedAt } : {}),
          ...(friendGame ? { created_by: userId } : {}),
          ...(partieVerlaufVerfuegbar
            ? { started_at: match.startedAt ?? null, life_log: match.lifeLog ?? null }
            : {}),
        })
        .select('id, played_at')
        .single();
    // Fehlt eine der neueren Spalten, schaltet der Versuch sie ab und der nächste läuft ohne.
    let { data: matchRow, error: matchError } = await insertMatch();
    if (isMissingIsRankedError(matchError)) ({ data: matchRow, error: matchError } = await insertMatch());
    if (isMissingPartieVerlaufError(matchError)) ({ data: matchRow, error: matchError } = await insertMatch());
    if (isMissingIsRankedError(matchError)) ({ data: matchRow, error: matchError } = await insertMatch());

    if (matchError || !matchRow) {
      console.error('Konnte Match nicht anlegen:', matchError);
      return null;
    }

    // Schritt 2: Für jeden Spieler eine Zeile in "match_players" anlegen
    const playerRows = players.map((p) => ({
      match_id: matchRow.id,
      player_id: friendGame ? null : (this.playerIdsByName()[p.name] ?? null),
      ...(friendGame ? { user_id: p.userId ?? null } : {}),
      player_name: p.name,
      commander_name: p.commander ?? null,
      partner_commander_name: p.partnerCommander ?? null,
      team: p.team ?? null,
      is_archenemy: p.isArchenemy ?? false,
      deck_id: p.deckId ?? null,
      ...(partieVerlaufVerfuegbar ? { turn_order: p.turnOrder ?? null } : {}),
    }));

    let { error: playersError } = await supabase.from('match_players').insert(playerRows);
    if (isMissingPartieVerlaufError(playersError)) {
      const ohneZugreihenfolge = playerRows.map(({ turn_order: _, ...row }: Record<string, unknown>) => row);
      ({ error: playersError } = await supabase.from('match_players').insert(ohneZugreihenfolge));
    }

    if (playersError) {
      console.error('Konnte Match-Spieler nicht anlegen:', playersError);
      return null;
    }

    // Schritt 3: lokal anhängen; Deck-Namen extra nachladen (players kennt nur die deckId).
    const deckIds = [...new Set(players.map((p) => p.deckId).filter((id): id is string => !!id))];
    let deckNames: Record<string, string> = {};
    let deckOwners: Record<string, string> = {};
    let deckOwnerPlayerIds: Record<string, string> = {};
    let deckPrecons: Record<string, boolean> = {};
    if (deckIds.length > 0) {
      const { data: deckRows } = await supabase
        .from('decks')
        .select('id, name, user_id, player_id, is_precon')
        .in('id', deckIds);
      deckNames = Object.fromEntries((deckRows ?? []).map((d) => [d.id, d.name]));
      deckOwners = Object.fromEntries((deckRows ?? []).map((d) => [d.id, d.user_id]));
      deckOwnerPlayerIds = Object.fromEntries((deckRows ?? []).map((d) => [d.id, d.player_id]));
      deckPrecons = Object.fromEntries((deckRows ?? []).map((d) => [d.id, d.is_precon]));
    }

    const { lifeLog: _lifeLog, playedAt: _playedAt, friendGame: _friendGame, ...matchOhneVerlauf } = match;
    const full: Match = {
      ...matchOhneVerlauf,
      id: matchRow.id,
      date: matchRow.played_at,
      countsInGeneralStats: match.countsInGeneralStats ?? true,
      isRanked,
      players: players.map((p) => ({
        ...p,
        deckName: p.deckId ? deckNames[p.deckId] : undefined,
        deckOwnerId: p.deckId ? deckOwners[p.deckId] : undefined,
        deckOwnerPlayerId: p.deckId ? deckOwnerPlayerIds[p.deckId] : undefined,
        deckIsPrecon: p.deckId ? deckPrecons[p.deckId] : undefined,
      })),
    };
    if (friendGame) this.friendHistory.update((matches) => [full, ...matches]);
    else this.history.update((matches) => [full, ...matches]);
    return matchRow.id;
  }

  /**
   * Ranked/frei nachträglich umschalten - die Kontrolle des Gruppenleiters bzw. aller, die
   * Ergebnisse bearbeiten dürfen (match.editResult), z. B. für ein versehentlich als Ranked
   * gestartetes Spaßspiel. Turnierspiele bleiben immer frei.
   */
  async setMatchRanked(matchId: string, isRanked: boolean): Promise<void> {
    if (!this.groupService.hasPermission('match.editResult') || !isRankedSpalteVerfuegbar) return;
    const { error } = await supabase.from('matches').update({ is_ranked: isRanked }).eq('id', matchId);
    if (error) {
      if (!isMissingIsRankedError(error)) console.error('Konnte Ranked/Frei nicht speichern:', error);
      return;
    }
    this.history.update((matches) => matches.map((m) => (m.id === matchId ? { ...m, isRanked } : m)));
  }

  /** Ob Ranked/Frei gespeichert werden kann (Migration gelaufen). */
  isRankedAvailable(): boolean {
    return isRankedSpalteVerfuegbar;
  }

  /**
   * Platzierungen (1 = Sieger, ...) nachtragen - reine Zusatzinfo, winner_name bleibt unberührt.
   */
  async setPlacements(matchId: string, placements: { name: string; placement: number | null }[]): Promise<void> {
    if (!this.groupService.hasPermission('match.editResult')) return;

    for (const { name, placement } of placements) {
      const { error } = await supabase
        .from('match_players')
        .update({ placement })
        .eq('match_id', matchId)
        .eq('player_name', name);

      if (error) {
        console.error('Konnte Platzierung nicht speichern:', error);
      }
    }

    this.history.update((matches) =>
      matches.map((m) =>
        m.id !== matchId
          ? m
          : {
              ...m,
              players: m.players.map((p) => {
                const entry = placements.find((pl) => pl.name === p.name);
                return entry ? { ...p, placement: entry.placement ?? undefined } : p;
              }),
            }
      )
    );
  }

  /**
   * Commander (samt Partner/Background) nachträglich eintragen; ohne Deck-Verknüpfung wird wie beim
   * Anlegen ein passendes eigenes Deck gesucht, bestehende Verknüpfungen bleiben.
   */
  async setCommanders(
    matchId: string,
    entries: {
      name: string;
      commander: string | null;
      partnerCommander: string | null;
      /** Explizit im Deck-Picker gewähltes/geliehenes Deck - hat Vorrang vor der automatischen Namens-Zuordnung (resolveAutoDeckLinks), da hier bereits eindeutig feststeht, welches Deck gemeint ist. */
      deckId?: string;
    }[]
  ): Promise<void> {
    if (!this.groupService.hasPermission('match.editCommander')) return;

    const match = this.history().find((m) => m.id === matchId);
    if (!match) return;

    for (const entry of entries) {
      const player = match.players.find((p) => p.name === entry.name);
      let deckId = entry.deckId ?? player?.deckId;

      if (!deckId && entry.commander) {
        const [resolved] = await this.resolveAutoDeckLinks([{ name: entry.name, commander: entry.commander }], match.mode);
        deckId = resolved?.deckId;
      }

      const { error } = await supabase
        .from('match_players')
        .update({
          commander_name: entry.commander,
          partner_commander_name: entry.partnerCommander,
          ...(deckId ? { deck_id: deckId } : {}),
        })
        .eq('match_id', matchId)
        .eq('player_name', entry.name);

      if (error) {
        console.error('Konnte Commander nicht speichern:', error);
      }
    }

    await this.refreshHistory();
  }

  async deleteMatch(id: string): Promise<void> {
    const groupId = this.groupService.groupId();
    if (!groupId || !this.groupService.hasPermission('match.delete')) return;

    // Erst die zugehörigen Spieler-Zeilen löschen (wegen der Verknüpfung),
    // danach die Match-Zeile selbst.
    const { error: playersError } = await supabase
      .from('match_players')
      .delete()
      .eq('match_id', id);

    if (playersError) {
      console.error('Konnte Match-Spieler nicht löschen:', playersError);
      return;
    }

    const { error: matchError } = await supabase
      .from('matches')
      .delete()
      .eq('id', id)
      .eq('group_id', groupId);

    if (matchError) {
      console.error('Konnte Match nicht löschen:', matchError);
      return;
    }

    this.history.update((matches) => matches.filter((m) => m.id !== id));
  }

  /** Löscht alle bereits gespeicherten Einzelspiele eines Turnier-Tisches - genutzt beim manuellen Nachtragen eines Endstands (siehe TournamentService.setManualScore), das die Spiele durch neu passende Zeilen ersetzt statt sie zu addieren. */
  async deleteMatchesForTournamentTable(tournamentMatchId: string): Promise<boolean> {
    const { data: rows, error: fetchError } = await supabase
      .from('matches')
      .select('id')
      .eq('tournament_match_id', tournamentMatchId);

    if (fetchError) {
      console.error('Konnte Turnier-Spiele nicht laden:', fetchError);
      return false;
    }

    const ids = (rows ?? []).map((r) => r.id);
    if (ids.length === 0) return true;

    const { error: playersError } = await supabase.from('match_players').delete().in('match_id', ids);
    if (playersError) {
      console.error('Konnte Turnier-Spiel-Spieler nicht löschen:', playersError);
      return false;
    }

    const { error: matchError } = await supabase.from('matches').delete().in('id', ids);
    if (matchError) {
      console.error('Konnte Turnier-Spiele nicht löschen:', matchError);
      return false;
    }

    this.history.update((matches) => matches.filter((m) => !ids.includes(m.id)));
    return true;
  }

  /**
   * Setzt counts_in_general_stats für alle Spiele der Turnier-Tische - Korrektur für fälschlich
   * mitgezählte Spiele (passiv übernommene Sessions).
   */
  async setCountsInGeneralStatsForTournamentMatchIds(tournamentMatchIds: string[], value: boolean): Promise<boolean> {
    if (tournamentMatchIds.length === 0) return true;

    for (const batch of chunk(tournamentMatchIds, 150)) {
      const { error } = await supabase
        .from('matches')
        .update({ counts_in_general_stats: value })
        .in('tournament_match_id', batch);
      if (error) {
        console.error('Konnte counts_in_general_stats nicht korrigieren:', error);
        return false;
      }
    }

    this.history.update((matches) =>
      matches.map((m) => (m.tournamentMatchId && tournamentMatchIds.includes(m.tournamentMatchId) ? { ...m, countsInGeneralStats: value } : m))
    );
    return true;
  }

  /** Wie deleteMatchesForTournamentTable(), aber für mehrere Tische auf einmal - für den "Alle Turniere löschen"-Knopf im Stats-Tab (TournamentService.deleteAllTournamentsForGroup). */
  async deleteMatchesForTournamentMatchIds(tournamentMatchIds: string[]): Promise<boolean> {
    if (tournamentMatchIds.length === 0) return true;

    const { data: rows, error: fetchError } = await supabase
      .from('matches')
      .select('id')
      .in('tournament_match_id', tournamentMatchIds);

    if (fetchError) {
      console.error('Konnte Turnier-Spiele nicht laden:', fetchError);
      return false;
    }

    const ids = (rows ?? []).map((r) => r.id);
    if (ids.length === 0) return true;

    for (const batch of chunk(ids, 150)) {
      const { error: playersError } = await supabase.from('match_players').delete().in('match_id', batch);
      if (playersError) {
        console.error('Konnte Turnier-Spiel-Spieler nicht löschen:', playersError);
        return false;
      }
    }

    for (const batch of chunk(ids, 150)) {
      const { error: matchError } = await supabase.from('matches').delete().in('id', batch);
      if (matchError) {
        console.error('Konnte Turnier-Spiele nicht löschen:', matchError);
        return false;
      }
    }

    this.history.update((matches) => matches.filter((m) => !ids.includes(m.id)));
    return true;
  }

  /** Ändert nachträglich den Gewinner eines gespeicherten Matches (z.B. bei Vertippern). */
  async updateMatchWinner(id: string, winner: string): Promise<void> {
    const groupId = this.groupService.groupId();
    if (!groupId || !this.groupService.hasPermission('match.editResult')) return;

    const { error } = await supabase
      .from('matches')
      .update({ winner_name: winner })
      .eq('id', id)
      .eq('group_id', groupId);

    if (error) {
      console.error('Konnte Gewinner nicht ändern:', error);
      return;
    }

    this.history.update((matches) => matches.map((m) => (m.id === id ? { ...m, winner } : m)));
  }

  /** Ändert nachträglich, welcher Cube in einem gespeicherten Cube-Spiel verwendet wurde (z.B. bei Vertippern). */
  async updateMatchCube(id: string, cubeId: string): Promise<void> {
    const groupId = this.groupService.groupId();
    if (!groupId || !this.groupService.hasPermission('match.editCube')) return;

    const { error } = await supabase.from('matches').update({ cube_id: cubeId }).eq('id', id).eq('group_id', groupId);

    if (error) {
      console.error('Konnte Cube nicht ändern:', error);
      return;
    }

    const cube = this.cubes().find((c) => c.id === cubeId);
    if (!cube) return;

    this.history.update((matches) => matches.map((m) => (m.id === id ? { ...m, cube } : m)));
  }

  /** Hard-Reset: löscht Verlauf, alle Spieler und deren Hintergrundbilder unwiderruflich. Cubes bleiben erhalten. */
  /** Hard-Reset: löscht Verlauf, alle Spieler und deren Hintergrundbilder unwiderruflich. Cubes bleiben erhalten. */
  async resetAllData(): Promise<{ success: boolean; error?: string }> {
    const groupId = this.groupService.groupId();
    if (!groupId) return { success: false, error: 'Keine aktive Gruppe.' };
    if (!this.groupService.hasPermission('group.resetAllData')) return { success: false, error: 'Keine Berechtigung.' };

    // Schritt 1: IDs aller Matches dieser Gruppe holen.
    const { data: matchRows, error: matchesFetchError } = await supabase
      .from('matches')
      .select('id')
      .eq('group_id', groupId);

    if (matchesFetchError) {
      console.error('Reset fehlgeschlagen (Matches laden):', matchesFetchError);
      return { success: false };
    }

    const matchIds = (matchRows ?? []).map((m) => m.id);

    // Schritt 2: match_players für diese Matches löschen (in Päckchen, sonst wird die
    // Anfrage-URL bei vielen Matches - z.B. aus einem Excel-Import - zu lang).
    for (const batch of chunk(matchIds, 150)) {
      const { error: mpError } = await supabase.from('match_players').delete().in('match_id', batch);

      if (mpError) {
        console.error('Reset fehlgeschlagen (match_players):', mpError);
        return { success: false };
      }
    }

    // Schritt 3: matches selbst löschen.
    const { error: matchesError } = await supabase.from('matches').delete().eq('group_id', groupId);

    if (matchesError) {
      console.error('Reset fehlgeschlagen (matches):', matchesError);
      return { success: false };
    }

    // Schritt 4: player_backgrounds löschen.
    const { error: backgroundsError } = await supabase
      .from('player_backgrounds')
      .delete()
      .eq('group_id', groupId);

    if (backgroundsError) {
      console.error('Reset fehlgeschlagen (player_backgrounds):', backgroundsError);
      return { success: false };
    }

    // Schritt 5: players selbst löschen.
    const { error: playersError } = await supabase.from('players').delete().eq('group_id', groupId);

    if (playersError) {
      console.error('Reset fehlgeschlagen (players):', playersError);
      return { success: false };
    }

    // Schritt 6: Lokale Signale zurücksetzen.
    this.history.set([]);
    this.allPlayers.set([]);
    this.playerBackgrounds.set({});
    this.playerIdsByName.set({});

    return { success: true };
  }

  // --- Cubes ---

  private async loadCubes(groupId: string): Promise<void> {
    const { data, error } = await supabase
      .from('cubes')
      .select('id, name, is_commander')
      .eq('group_id', groupId)
      .order('name', { ascending: true });

    if (error) {
      console.error('Konnte Cubes nicht laden:', error);
      return;
    }

    this.cubes.set(
      data.map((row) => ({
        id: row.id,
        name: row.name,
        isCommander: row.is_commander,
      }))
    );
  }
  async addCube(name: string, isCommander = false): Promise<Cube | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (this.cubes().some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) return null;

    const groupId = this.groupService.groupId();
    if (!groupId) return null;

    const { data, error } = await supabase
      .from('cubes')
      .insert({ group_id: groupId, name: trimmed, is_commander: isCommander })
      .select('id, name, is_commander')
      .single();

    if (error || !data) {
      console.error('Konnte Cube nicht anlegen:', error);
      return null;
    }

    const cube: Cube = { id: data.id, name: data.name, isCommander: data.is_commander };
    this.cubes.update((cs) => [...cs, cube]);
    return cube;
  }
  async deleteCube(id: string): Promise<void> {
    const groupId = this.groupService.groupId();
    if (!groupId) return;

    // Erst Matches, die diesen Cube nutzen, "entkoppeln" (cube_id auf null setzen),
    // damit das Löschen des Cubes nicht an bestehenden Verknüpfungen scheitert.
    const { error: unlinkError } = await supabase
      .from('matches')
      .update({ cube_id: null })
      .eq('group_id', groupId)
      .eq('cube_id', id);

    if (unlinkError) {
      console.error('Konnte Cube-Verknüpfung nicht lösen:', unlinkError);
      return;
    }

    const { error } = await supabase.from('cubes').delete().eq('id', id).eq('group_id', groupId);

    if (error) {
      console.error('Konnte Cube nicht löschen:', error);
      return;
    }

    this.cubes.update((cs) => cs.filter((c) => c.id !== id));
    // Lokale Match-Historie ebenfalls bereinigen, damit die Anzeige konsistent bleibt.
    this.history.update((matches) =>
      matches.map((m) => (m.cube?.id === id ? { ...m, cube: undefined } : m))
    );
  }
}
