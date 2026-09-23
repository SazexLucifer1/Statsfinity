import { Injectable, computed, effect, signal, inject } from '@angular/core';
import { Match, MatchPlayer, Cube, GameMode, GAME_MODES } from './models';
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
  cubes ( id, name, is_commander ),
  match_players (
    player_name,
    commander_name,
    partner_commander_name,
    team,
    is_archenemy,
    deck_id,
    placement,
    decks ( name, user_id, player_id, is_precon ),
    players ( display_name )
  )
`;

/**
 * Dieselbe Select-Liste ohne game_format - Rückfallebene, solange
 * sql/match-category-format-split-2026-09-03.sql noch nicht im Supabase-Editor ausgeführt wurde.
 * Eine Abfrage auf eine nicht existierende Spalte lässt Postgres komplett scheitern, und da
 * loadHistory() bei einem Fehler das history-Signal unangetastet lässt, stand dann die gesamte App
 * ohne einen einzigen Match da (Verlauf UND Statistik) - siehe fetchMatchRows().
 */
const MATCH_HISTORY_SELECT_WITHOUT_FORMAT = MATCH_HISTORY_SELECT.replace('  game_format,\n', '');

/** Fehlt die game_format-Spalte noch? Postgres meldet 42703 ("column ... does not exist"). */
function isMissingGameFormatError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42703' || (error.message ?? '').includes('game_format');
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
  /** Spielername -> Lieblingscommander eines accountlosen NPC-Profils (players.favorite_commanders,
   * vom Host gepflegt - siehe setPlayerFavoriteCommanders). Sobald der Spieler verknüpft wird, geht
   * dieses Feld per Alles-oder-nichts-Regel in profiles.favorite_commanders auf (siehe
   * linkPlayerToUser) und wird hier wieder geleert. */
  readonly playerFavoriteCommanders = signal<Record<string, string[]>>({});
  // ... der Rest bleibt unverändert
  readonly history = signal<Match[]>([]);
  readonly cubes = signal<Cube[]>([]);
  /** Spielername -> gewählter Hintergrundbild-Pfad. Persistiert dauerhaft, unabhängig vom Match. */
  readonly playerBackgrounds = signal<Record<string, string>>({});

  /**
   * Spielername (= Account) -> (Modus -> darf dieser Account den Modus im Stats-Tab sehen?).
   * Nicht konfigurierte Modi fehlen in der inneren Map (Default: Zugriff erlaubt) - siehe
   * canViewMode in stats-tab.ts.
   */
  readonly statVisibility = signal<Map<string, Map<GameMode, boolean>>>(new Map());

  /**
   * Modus (oder 'Alle' für die Aggregat-Ansicht) -> Mindestanzahl Spiele, ab der ein Eintrag
   * in den Ranglisten (Spieler/Decks/Commander) für diesen Modus erscheint. 0 = keine
   * Mindestspielzahl. Nicht konfigurierte Modi fehlen (Default: siehe stats-tab.ts).
   */
  readonly qualificationSettings = signal<Map<string, number>>(new Map());

  /** Der eigene Spielername (falls der eingeloggte User über einen verknüpften players-Eintrag verfügt). */
  readonly myPlayerName = computed(() => this.playerNameForUserId(this.auth.currentUser()?.id));

  /**
   * Ob für den eingeloggten Account (den Viewer) ALLE Modi in der Sichtbarkeits-Matrix
   * (player_stat_visibility) gesperrt sind - ersetzt das frühere separate groups.stats_locked-
   * Flag. Statt eines zweiten, unabhängigen Schalters (der die Matrix beim Nachjustieren einzelner
   * Zellen komplett übersteuert hätte) ist "alles gesperrt" jetzt einfach der Zustand, in dem die
   * Matrix für diese Person überall auf false steht - der Host kann eine einzelne Zelle wieder
   * freigeben und das wirkt sich sofort aus, ohne dass irgendwas das noch überschreibt. "Alle
   * sperren"/"Alle freigeben" im Gruppen-Tab sind nur noch Komfort-Buttons, die diese Matrix in
   * einem Rutsch für alle Spieler setzen, keine eigene Datenquelle mehr.
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
   * Spielername des Deck-Besitzers zu ownerId (Account-User-ID, für account-gebundene Decks) oder
   * ownerPlayerId (players.id, für Decks eines accountlosen/virtuellen Spielers) - für
   * "ausgeliehen von X"-Anzeigen im Match-Verlauf und in den Statistiken.
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

  /**
   * Setzt die Lieblingscommander eines NPC-Profils (accountloser Spieler) - vom Host in
   * group-tab.ts gepflegt, analog zu profiles.favorite_commanders bei echten Accounts. Maximal 3,
   * gleiche Regel wie ProfileService.updateFavoriteCommanders.
   */
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

    // Der Name ist zusätzlich als Text direkt in match_players/matches gespeichert (siehe
    // player_name/winner_name - überlebt so eine spätere Spieler-Löschung), muss beim Umbenennen
    // also explizit mitgezogen werden, sonst zeigen alte Matches weiterhin den alten Namen.
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

    // Die Account-Verknüpfung (playerUserIds u.a.) ist name-indiziert - ohne dieses Umschlüsseln
    // würde sie unter dem alten Namen "hängen bleiben" und wirkt dann bis zum nächsten Neuladen
    // wie verloren (z.B. Avatar/Sichtbarkeit unter dem neuen Namen nicht mehr auffindbar).
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

    // Falls der Spieler mit einem echten Account verknüpft ist, muss diese Person auch als
    // Gruppenmitglied entfernt werden - sonst löscht dieser Aufruf nur die Stat-Tracking-Identität
    // (players-Zeile), die Person bleibt aber vollwertiges Mitglied (sieht die Gruppe weiterhin
    // unter "Meine Gruppen", hat weiterhin Zugriff auf alle Gruppendaten).
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
   * Führt mehrere Spieler-Einträge zu einem zusammen (z.B. wenn ein per Excel-Import angelegter
   * Name wie "Theo"/"Theos" in Wahrheit derselbe Mensch ist wie der später beigetretene Account
   * "Theodor", oder ein doppelt angelegter Account wie "Jakob"/"Jakob2"). Hängt ALLE Datensätze der
   * Quell-Spieler auf den Ziel-Spieler um (Matches, Turnier-Teilnahmen/-Tische, Sichtbarkeits- und
   * Hintergrund-Einstellungen), die Quell-Spieler-Einträge werden danach gelöscht. Bewusst NICHT
   * über deletePlayer(), da dort die Spiele beim gelöschten (Alt-)Namen verbleiben würden statt zum
   * Ziel-Spieler zu wandern.
   */
  /** Nur für Host oder freigeschaltetes Mitglied - hängt fremde Match-/Turnier-Historie um, darf kein normales Mitglied auslösen können. */
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

      // Sichtbarkeits-/Hintergrund-Einstellungen sind reine Kosmetik pro Spieler-Identität und je
      // Spalte (group_id, player_id[, game_mode]) eindeutig - ein blindes Umschreiben auf targetId
      // würde bei bereits vorhandenen Ziel-Einträgen die Unique-Constraint verletzen. Da die
      // verschwindende Quell-Identität ohnehin aufhört zu existieren, gewinnt einfach die bereits
      // für targetId gesetzte Einstellung (falls vorhanden); die Quell-Zeilen werden schlicht mit
      // gelöscht statt fehlschlagend zusammengeführt.
      const { error: visibilityError } = await supabase.from('player_stat_visibility').delete().eq('player_id', sourceId);
      if (visibilityError) console.error('Konnte Sichtbarkeits-Einstellungen des zusammengeführten Spielers nicht löschen:', visibilityError);

      const { error: backgroundError } = await supabase.from('player_backgrounds').delete().eq('player_id', sourceId);
      if (backgroundError) console.error('Konnte Hintergrund des zusammengeführten Spielers nicht löschen:', backgroundError);

      // Decks eines virtuellen (accountlosen) Quell-Spielers müssen VOR dem Löschen der
      // players-Zeile auf den Ziel-Spieler umgehängt werden - decks.player_id hat inzwischen
      // ON DELETE CASCADE, ohne dieses Umhängen würden sie beim Löschen sonst mit verschwinden.
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
   * Hängt Turnier-Teilnahme (tournament_participants) und Tisch-Zuordnungen
   * (tournament_match_players) eines Quell-Spielers auf den Ziel-Spieler um. Für Turniere, an denen
   * BEIDE bereits als eigene Teilnehmer-Zeile hängen (ein in der Praxis kaum vorkommender Fall -
   * zwei getrennte Kader-Einträge, die in DEMSELBEN Turnier gegeneinander/nebeneinander gespielt
   * haben), lässt sich die Teilnahme nicht widerspruchsfrei zusammenführen (Unique Constraint
   * tournament_id+player_id) - dort bleibt die Quell-Teilnahme unangetastet stehen, statt die
   * Zusammenführung abzubrechen.
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
   * Verknüpft einen bestehenden (noch account-losen) Spieler-Eintrag nachträglich mit einem
   * Gruppenmitglied, damit dessen alte Stats (z.B. aus dem Excel-Import) zu seinem Account gehören.
   * Schlägt gezielt fehl, falls der Spieler zwischenzeitlich schon verknüpft wurde.
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

    // Decks, die dieser Spieler bekam, als er noch accountlos war, müssen auf den jetzt
    // verknüpften Account umgehängt werden - sonst wären sie danach unsichtbar (die Profilseite
    // liest nur noch user_id-Decks, die player_id-Zeile hat ab jetzt keinen eigenen Ort mehr).
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

    // Lieblingscommander per Alles-oder-nichts-Regel zusammenführen: hat der Account schon
    // mindestens einen gesetzt, bleibt dessen Liste unverändert (der Account ist die "Wahrheit"
    // für die Person). Nur wenn der Account noch komplett leer ist, übernimmt er die NPC-Liste -
    // die dann am NPC-Eintrag geleert wird, damit sie nicht doppelt/veraltet irgendwo weiterlebt.
    //
    // Der Schreibzugriff auf profiles.favorite_commanders eines ANDEREN Accounts ist nur erlaubt,
    // wenn die Person sich selbst verknüpft (isSelfLink) oder Developer ist - sonst dürfte ein
    // Host, der eine NPC mit dem Account eines anderen Spielers verknüpft, sonst unbemerkt in
    // dessen echtes Profil schreiben (siehe group-permissions.ts: Gruppenrechte decken nur
    // Stats/NPC-Daten ab, nicht das Profil eines fremden echten Accounts).
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

        // Falls der verknüpfte Account der gerade eingeloggte User selbst ist (Host verknüpft sich
        // z.B. selbst, oder der Spieler verknüpft während einer laufenden Session), muss auch das
        // schon geladene eigene Profil-Signal aktualisiert werden - sonst zeigt der Profil-Tab bis
        // zum nächsten Neuladen noch die alte (leere) Liste.
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
   * Führt eine "matches"-Abfrage aus und wiederholt sie einmal ohne die game_format-Spalte, falls
   * die in der Datenbank noch fehlt (Migration noch nicht ausgeführt, siehe
   * MATCH_HISTORY_SELECT_WITHOUT_FORMAT). Ohne diesen Rückfall macht eine ausstehende Migration den
   * kompletten Verlauf samt aller Statistiken unsichtbar, obwohl in der Datenbank alles unverändert
   * daliegt. Liefert null, wenn auch der zweite Versuch scheitert.
   */
  private async fetchMatchRows(
    run: (select: string) => PromiseLike<{ data: any[] | null; error: any }>,
    label: string
  ): Promise<any[] | null> {
    const first = await run(MATCH_HISTORY_SELECT);
    if (!first.error) return first.data ?? [];

    if (isMissingGameFormatError(first.error)) {
      console.warn(`${label}: Spalte game_format fehlt noch (SQL-Migration ausstehend), lade ohne sie.`);
      const retry = await run(MATCH_HISTORY_SELECT_WITHOUT_FORMAT);
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
   * Wie loadHistory(), aber für eine Liste von Gruppen statt einer einzelnen, und gibt die Matches
   * direkt zurück statt State zu setzen - für gruppenübergreifende Auswertungen im Stats-Tab (lokal
   * gewählte Fremdgruppe), die NICHT die echte aktive Gruppe (history()) verändern sollen.
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
   * Alle Matches, an denen ein Account teilgenommen hat, aus ALLEN Gruppen - für die Match-Liste
   * eines fremden Profils, wenn der Betrachter nicht in derselben Gruppe ist oder gar nicht
   * eingeloggt (sql/oeffentliche-matches-2026-09-23.sql). selfName ist der Name, unter dem die
   * Person im jeweiligen Match gespielt hat; er kann je Gruppe anders lauten. null = die Funktion
   * fehlt noch oder der Aufruf schlug fehl.
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
   * Ergänzt fehlende deck_id-Werte automatisch: falls ein Spieler keine explizite Deck-Auswahl
   * hat (weder eigenes noch geliehenes Deck), aber einen Commander-Namen, der zu einem seiner
   * eigenen Decks passt, wird das Deck automatisch verknüpft - sonst müsste man Alt-Matches ohne
   * Deck-Auswahl (z.B. aus dem Excel-Import) immer manuell nachpflegen. Bei Cube- und Draft-Spielen
   * bewusst NIE automatisch verknüpft (auch wenn zufällig ein commander-ähnlicher Name eingetragen
   * ist) - das sind keine Commander-Decks, eine automatische Verknüpfung wäre dort immer falsch.
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
    }
  ): Promise<string | null> {
    const groupId = this.groupService.groupId();
    if (!groupId) return null;

    const players = await this.resolveAutoDeckLinks(match.players, match.mode);

    // Schritt 1: Zeile in "matches" anlegen
    const { data: matchRow, error: matchError } = await supabase
      .from('matches')
      .insert({
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
      })
      .select('id, played_at')
      .single();

    if (matchError || !matchRow) {
      console.error('Konnte Match nicht anlegen:', matchError);
      return null;
    }

    // Schritt 2: Für jeden Spieler eine Zeile in "match_players" anlegen
    const playerRows = players.map((p) => ({
      match_id: matchRow.id,
      player_id: this.playerIdsByName()[p.name] ?? null,
      player_name: p.name,
      commander_name: p.commander ?? null,
      partner_commander_name: p.partnerCommander ?? null,
      team: p.team ?? null,
      is_archenemy: p.isArchenemy ?? false,
      deck_id: p.deckId ?? null,
    }));

    const { error: playersError } = await supabase.from('match_players').insert(playerRows);

    if (playersError) {
      console.error('Konnte Match-Spieler nicht anlegen:', playersError);
      return null;
    }

    // Schritt 3: Lokal ans Signal anhängen, damit die UI sofort aktualisiert.
    // Deck-Namen müssen extra nachgeladen werden - players kennt nur die deckId (kommt aus der
    // Session oder der Auto-Verknüpfung oben), nicht den Namen (der wird sonst erst beim
    // Neuladen aus der DB per Join befüllt).
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

    const full: Match = {
      ...match,
      id: matchRow.id,
      date: matchRow.played_at,
      countsInGeneralStats: match.countsInGeneralStats ?? true,
      players: players.map((p) => ({
        ...p,
        deckName: p.deckId ? deckNames[p.deckId] : undefined,
        deckOwnerId: p.deckId ? deckOwners[p.deckId] : undefined,
        deckOwnerPlayerId: p.deckId ? deckOwnerPlayerIds[p.deckId] : undefined,
        deckIsPrecon: p.deckId ? deckPrecons[p.deckId] : undefined,
      })),
    };
    this.history.update((matches) => [full, ...matches]);
    return matchRow.id;
  }

  /**
   * Trägt nachträglich die Platzierung (1 = Sieger, 2 = zweiter Platz, ...) einzelner Spieler
   * eines Matches ein oder ändert sie - rein optionale Zusatz-Info, der Sieger/Verlierer-Status
   * (matches.winner_name) bleibt davon komplett unberührt.
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
   * Trägt nachträglich fehlende (oder falsche) Commander samt optionalem Partner/Background
   * einzelner Spieler eines bereits gespeicherten Matches ein - z.B. wenn das beim Live-Tracking
   * vergessen wurde. Ist noch keine Deck-Verknüpfung vorhanden, wird - wie beim Anlegen eines
   * Matches - automatisch versucht, anhand des neuen Commander-Namens ein passendes eigenes Deck
   * zu finden (siehe resolveAutoDeckLinks); eine bereits bestehende Deck-Verknüpfung bleibt unangetastet.
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

  /** crypto.randomUUID() existiert nur in sicheren Kontexten (HTTPS/localhost) – daher Fallback. */
  private createId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // NEU
  // NEU
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
   * Setzt counts_in_general_stats für ALLE Einzelspiele der übergebenen Turnier-Tische auf `value` -
   * genutzt, um nachträglich Matches zu korrigieren, die trotz deaktiviertem "Auch in der
   * allgemeinen Statistik zählen" fälschlich mitgezählt wurden (siehe
   * TournamentService.repairCountsInGeneralStats, betraf Tische, deren Session ein Gerät nur passiv
   * per Realtime-Bridge übernommen hat statt sie selbst zu starten).
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
  /** Fügt Bulk-importierte Matches an (Datum wird mitgegeben statt automatisch gesetzt). Zählen immer in die allgemeine Statistik (kein Turnier-Bezug beim Import). */
  async importMatches(newMatches: (Omit<Match, 'id' | 'countsInGeneralStats'> & { countsInGeneralStats?: boolean })[]): Promise<void> {
    if (newMatches.length === 0) return;

    const groupId = this.groupService.groupId();
    if (!groupId) return;

    // Schritt 1: Herausfinden, welche Spielernamen noch NICHT existieren.
    const knownPlayers = new Set(this.allPlayers().map((p) => p.toLowerCase()));
    const newPlayerNames = new Set<string>();
    for (const match of newMatches) {
      for (const p of match.players) {
        if (!knownPlayers.has(p.name.toLowerCase())) {
          newPlayerNames.add(p.name);
          knownPlayers.add(p.name.toLowerCase());
        }
      }
    }

    // Schritt 2: Neue Spieler in Supabase anlegen (alle auf einmal).
    if (newPlayerNames.size > 0) {
      const rows = [...newPlayerNames].map((name) => ({ group_id: groupId, display_name: name }));
      const { data: newPlayerRows, error: playersError } = await supabase
        .from('players')
        .insert(rows)
        .select('id, display_name');

      if (playersError || !newPlayerRows) {
        console.error('Konnte neue Spieler nicht anlegen:', playersError);
        return;
      }

      this.allPlayers.update((players) => [...players, ...newPlayerNames]);
      this.playerIdsByName.update((map) => {
        const next = { ...map };
        for (const row of newPlayerRows) {
          next[row.display_name] = row.id;
        }
        return next;
      });
    }

    // Schritt 3: Jedes Match einzeln anlegen (matches + match_players).
    // Deck-Auto-Verknüpfung wird über einen gemeinsamen Cache dedupliziert, da z.B. beim
    // Excel-Import derselbe Spieler/Commander über sehr viele synthetische Matches wiederkehrt.
    const deckIdCache = new Map<string, string | null>();
    const resolveDeckId = async (playerName: string, commander: string | undefined): Promise<string | null> => {
      if (!commander) return null;
      const userId = this.playerUserIds()[playerName];
      const playerId = this.playerIdFor(playerName);
      if (!userId && !playerId) return null;
      const key = `${playerName.toLowerCase()}::${commander.toLowerCase()}`;
      if (!deckIdCache.has(key)) {
        let deckId: string | null = null;
        if (userId) deckId = await this.deckService.findDeckIdByCommander({ kind: 'user', userId }, commander);
        if (!deckId && playerId) deckId = await this.deckService.findDeckIdByCommander({ kind: 'player', playerId }, commander);
        deckIdCache.set(key, deckId);
      }
      return deckIdCache.get(key) ?? null;
    };

    const importedMatches: Match[] = [];
    for (const match of newMatches) {
      const { data: matchRow, error: matchError } = await supabase
        .from('matches')
        .insert({
          group_id: groupId,
          game_mode: match.mode,
          game_format: match.format ?? null,
          cube_id: match.cube?.id ?? null,
          winner_name: match.winner,
          played_at: match.date,
          draft_set_id: match.draftSet?.id ?? null,
          draft_set_code: match.draftSet?.code ?? null,
          draft_set_name: match.draftSet?.name ?? null,
          draft_set_released_at: match.draftSet?.releasedAt ?? null,
        })
        .select('id, played_at')
        .single();

      if (matchError || !matchRow) {
        console.error('Konnte importiertes Match nicht anlegen:', matchError);
        continue;
      }

      // Cube-/Draft-Spiele nie automatisch mit einem Commander-Deck verknüpfen, auch wenn zufällig
      // ein commander-ähnlicher Name im Import-Datensatz steht (siehe resolveAutoDeckLinks).
      const resolvedPlayers: MatchPlayer[] = [];
      for (const p of match.players) {
        const deckId =
          p.deckId ??
          (match.mode !== 'Cube' && match.mode !== 'Draft' ? await resolveDeckId(p.name, p.commander) : null) ??
          undefined;
        resolvedPlayers.push(deckId ? { ...p, deckId } : p);
      }

      const playerRows = resolvedPlayers.map((p) => ({
        match_id: matchRow.id,
        player_id: this.playerIdsByName()[p.name] ?? null,
        player_name: p.name,
        commander_name: p.commander ?? null,
        partner_commander_name: p.partnerCommander ?? null,
        team: p.team ?? null,
        is_archenemy: p.isArchenemy ?? false,
        deck_id: p.deckId ?? null,
      }));

      const { error: playersError } = await supabase.from('match_players').insert(playerRows);

      if (playersError) {
        console.error('Konnte Spieler für importiertes Match nicht anlegen:', playersError);
        continue;
      }

      importedMatches.push({
        ...match,
        id: matchRow.id,
        date: matchRow.played_at,
        players: resolvedPlayers,
        countsInGeneralStats: match.countsInGeneralStats ?? true,
      });
    }

    // Deck-Namen/Besitzer/Precon-Flag für die neu verknüpften Decks nachladen, damit die lokal
    // angehängten Matches sofort korrekt angezeigt werden (statt erst nach einem Neuladen).
    const deckIds = [
      ...new Set(
        importedMatches.flatMap((m) => m.players.map((p) => p.deckId).filter((id): id is string => !!id))
      ),
    ];
    if (deckIds.length > 0) {
      const { data: deckRows } = await supabase
        .from('decks')
        .select('id, name, user_id, player_id, is_precon')
        .in('id', deckIds);
      const deckNames = Object.fromEntries((deckRows ?? []).map((d) => [d.id, d.name]));
      const deckOwners = Object.fromEntries((deckRows ?? []).map((d) => [d.id, d.user_id]));
      const deckOwnerPlayerIds = Object.fromEntries((deckRows ?? []).map((d) => [d.id, d.player_id]));
      const deckPrecons = Object.fromEntries((deckRows ?? []).map((d) => [d.id, d.is_precon]));

      for (const m of importedMatches) {
        m.players = m.players.map((p) =>
          p.deckId
            ? {
                ...p,
                deckName: deckNames[p.deckId],
                deckOwnerId: deckOwners[p.deckId],
                deckOwnerPlayerId: deckOwnerPlayerIds[p.deckId],
                deckIsPrecon: deckPrecons[p.deckId],
              }
            : p
        );
      }
    }

    // Schritt 4: Lokal ans Signal anhängen.
    this.history.update((matches) => [...matches, ...importedMatches]);
  }

  // --- Cubes ---

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
