import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { GroupService } from './group.service';
import { MtgService } from './mtg.service';
import { GameSessionService, SelectedDraftSet } from './game-session.service';
import { DeckFormat, GameMode } from './models';
import { PageVisibilityService } from './page-visibility.service';
import { DialogService } from './dialog.service';
import { I18nService } from './i18n.service';
import { chunk } from './array-utils';
import {
  ParticipantStatus,
  RoundCountMode,
  StandingsRow,
  TableSize,
  Tournament,
  TournamentMatch,
  TournamentParticipant,
  TournamentRound,
  TournamentStatus,
} from './tournament.models';

/** Pro Tisch ermittelte Paarung, bevor sie als tournament_matches-Zeile gespeichert wird. Ein einzelner Eintrag bedeutet Freilos. */
interface Pairing {
  playerIds: string[];
}

/**
 * Swiss-Turnier, unterstützt sowohl klassisches 1v1 mit Best-of-3 (tableSize=2) als auch
 * Mehrspieler-Pods mit Einzelspiel pro Tisch (tableSize=4, wie normales Commander). Jedes Spiel
 * eines Tisches läuft als ganz normales Match über den bestehenden GameSessionService/
 * ingame-tracker (unterstützt Pods bereits nativ) - dieser Service bildet nur die Turnier-Ebene
 * darüber (Kader, Paarungen, Standings) und hört per effect() auf session.lastFinishedMatch(), um
 * Ergebnisse einzusammeln (gleiches Muster wie PlacementDialog).
 */
@Injectable({ providedIn: 'root' })
export class TournamentService {
  private readonly auth = inject(AuthService);
  private readonly groupService = inject(GroupService);
  private readonly mtg = inject(MtgService);
  private readonly session = inject(GameSessionService);
  private readonly pageVisibility = inject(PageVisibilityService);
  private readonly dialog = inject(DialogService);
  private readonly i18n = inject(I18nService);

  /** Steuert die Sichtbarkeit des globalen Turnier-Overlays (TournamentPanel), unabhängig davon, ob schon ein Turnier existiert (Erstellungs-Wizard nutzt dasselbe Overlay). */
  readonly panelExpanded = signal(false);

  openPanel(): void {
    this.panelExpanded.set(true);
  }

  closePanel(): void {
    this.panelExpanded.set(false);
  }

  togglePanel(): void {
    this.panelExpanded.update((v) => !v);
  }

  /** Genau ein aktives/laufendes Turnier pro Gruppe in v1 - das jeweils neueste (schließt auch ein gerade beendetes, aber noch nicht weggeklicktes Podium mit ein). */
  readonly activeTournament = signal<Tournament | null>(null);
  readonly participants = signal<TournamentParticipant[]>([]);
  readonly rounds = signal<TournamentRound[]>([]);
  /** Alle Tische aller Runden dieses Turniers (für Pairing-History + aktuelle Ansicht). */
  readonly matches = signal<TournamentMatch[]>([]);

  readonly isOrganizer = computed(
    () => !!this.activeTournament() && this.auth.currentUser()?.id === this.activeTournament()!.createdBy
  );

  readonly myParticipant = computed(() => {
    const name = this.mtg.myPlayerName();
    if (!name) return null;
    const playerId = this.mtg.playerIdFor(name);
    if (!playerId) return null;
    return this.participants().find((p) => p.playerId === playerId) ?? null;
  });

  readonly pendingParticipants = computed(() => this.participants().filter((p) => p.status === 'invited'));

  readonly currentRound = computed(() =>
    this.rounds().find((r) => r.roundNumber === this.activeTournament()?.currentRound) ?? null
  );

  readonly currentRoundMatches = computed(() => {
    const round = this.currentRound();
    if (!round) return [];
    return this.matches().filter((m) => m.roundId === round.id);
  });

  readonly myCurrentMatch = computed(() => {
    const participant = this.myParticipant();
    if (!participant) return null;
    return (
      this.currentRoundMatches().find((m) => m.participants.some((p) => p.playerId === participant.playerId)) ?? null
    );
  });

  /** Prüft completedAt statt winnerPlayerId, damit unentschiedene Pod-Tische (kein Sieger, aber fertig) mitzählen. */
  readonly canAdvanceRound = computed(() => {
    const current = this.currentRoundMatches();
    return current.length > 0 && current.every((m) => !!m.completedAt);
  });

  readonly standings = computed<StandingsRow[]>(() => this.computeStandings());

  /** Zeitlimit (Minuten) läuft pro Tisch erst ab dem tatsächlichen "Spiel starten"-Klick, nicht ab Rundenbeginn. */
  matchDeadlineAt(match: TournamentMatch): string | null {
    if (!match.startedAt) return null;
    const roundLengthMinutes = this.activeTournament()?.roundLengthMinutes ?? 50;
    return new Date(new Date(match.startedAt).getTime() + roundLengthMinutes * 60_000).toISOString();
  }

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** True, sobald der Tab einmal im Hintergrund lag - siehe Poll-Effect im Konstruktor. */
  private missedPollsWhileHidden = false;

  /** Verhindert, dass dieselbe fertig gespielte Partie (matchRowId) innerhalb derselben Sitzung mehrfach verarbeitet wird - zusätzliche Absicherung neben der ohnehin idempotenten Neuberechnung in recordGameResult(). */
  private readonly processedGameResults = new Set<string>();

  constructor() {
    effect(() => {
      const groupId = this.groupService.groupId();
      if (groupId) {
        this.loadForGroup(groupId);
      } else {
        this.clear();
      }
    });

    // Ersatz für Supabase Realtime (im Repo bisher nirgends verwendet) - reicht für den
    // Sonntags-Event. Pollt bewusst, sobald überhaupt eine Gruppe aktiv ist (nicht erst, wenn
    // schon ein Turnier läuft) - sonst bekommt jemand, der die App schon offen hatte, BEVOR die
    // veranstaltende Person ein neues Turnier erstellt hat, das nie mit (der Turnier-Knopf in der Tab-Leiste taucht
    // dann für diese Person nie auf, ohne dass sie die Seite manuell neu lädt).
    effect(() => {
      const groupId = this.groupService.groupId();
      // Im Hintergrund pausieren: der Browser drosselt Timer in versteckten Tabs ohnehin auf ~1x pro
      // Minute, die Abfragen kommen dort also nur unregelmäßig durch - kosten aber Akku und
      // Datenvolumen, und beim Zurückkommen prasseln die aufgestauten Antworten auf einmal herein.
      // Stattdessen wird beim Zurückkommen genau einmal frisch geladen und danach normal weiter
      // gepollt.
      const visible = this.pageVisibility.visible();
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      if (!groupId || !visible) return;

      if (this.missedPollsWhileHidden) {
        this.missedPollsWhileHidden = false;
        this.loadForGroup(groupId);
      }
      this.pollTimer = setInterval(() => this.loadForGroup(groupId), 2_000);
    });

    // Merkt sich, dass der Tab zwischendurch weg war - nur dann lohnt das sofortige Nachladen oben
    // (beim allerersten Durchlauf erledigt das schon der Effect auf groupId).
    effect(() => {
      if (!this.pageVisibility.visible()) this.missedPollsWhileHidden = true;
    });

    // Bridge: ein im Turnier-Kontext gespieltes Spiel fließt automatisch ins Tisch-Ergebnis ein.
    // Bei einem noch unentschiedenen BO3 wird direkt das nächste Spiel gestartet (siehe
    // handleGameFinished) - erst ein entschiedener Tisch öffnet wieder das Turnier-Panel, statt die
    // spielende Person einfach im normalen Match-Tab-Setup stehen zu lassen.
    effect(() => {
      const finished = this.session.lastFinishedMatch();
      if (!finished || !finished.tournamentMatchId) return;
      this.handleGameFinished(finished.tournamentMatchId, finished.matchId, finished.winner);
    });

    // Bridge: wurde die eigene Live-Session von einem ANDEREN Gerät beendet (dort gespeichert), hat
    // dieses Gerät nie selbst lastFinishedMatch gesetzt. Ist der Tisch noch nicht entschieden, startet
    // das andere Gerät bei sich bereits automatisch das nächste Spiel (siehe handleGameFinished) -
    // hier wird kurz auf dessen neue Live-Session gewartet und ihr beigetreten, statt unabhängig eine
    // zweite anzulegen oder einfach im Turnier-Panel hängen zu bleiben.
    effect(() => {
      const ended = this.session.remoteSessionEnded();
      if (!ended || !ended.tournamentMatchId) return;

      // Harte Bremse: egal was remoteSessionEnded() wiederholt neu auslöst, für denselben Tisch wird
      // innerhalb von 5s nur EIN Durchlauf gestartet - ohne das konnte ein sich selbst befeuernder
      // Loop den Browser in die Knie zwingen (siehe Konsolen-Absturz beim Testen).
      const now = Date.now();
      const last = this.lastRemoteSessionEndedHandledAt.get(ended.tournamentMatchId) ?? 0;
      if (now - last < 5000) {
        console.warn('[live-sync] Wiederholtes remoteSessionEnded für denselben Tisch innerhalb von 5s ignoriert (Notbremse)');
        return;
      }
      this.lastRemoteSessionEndedHandledAt.set(ended.tournamentMatchId, now);

      this.handleRemoteSessionEnded(ended.tournamentMatchId);
    });
  }

  private readonly lastRemoteSessionEndedHandledAt = new Map<string, number>();

  /**
   * Wartet nach einer Fremd-Beendigung darauf, dass entweder der Tisch inzwischen entschieden ist
   * (dann Panel öffnen) ODER eine neue Live-Session fürs nächste Spiel auftaucht (dann beitreten) -
   * beide Prüfungen laufen bewusst zusammen in EINER Schleife, statt nacheinander: das andere Gerät
   * braucht nach dem Löschen der alten Session selbst noch ein paar Netzwerk-Schritte, bis "Tisch
   * entschieden" tatsächlich in der Datenbank steht, und in dem Fall wird nie eine neue Session
   * angelegt - ein einmaliger Entschieden-Check ganz am Anfang würde das also verpassen und
   * stattdessen sinnlos die vollen ~4s auf ein drittes Spiel warten, das nie kommt.
   */
  private async handleRemoteSessionEnded(
    tournamentMatchId: string,
    attempts = 10,
    delayMs = 400
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const groupId = this.activeTournament()?.groupId;
      if (groupId) await this.loadForGroup(groupId);

      const match = this.matches().find((m) => m.id === tournamentMatchId);
      const decided = !match || match.participants.length !== 2 || !!match.winnerPlayerId || match.isDraw;
      if (decided || !match) {
        this.openPanel();
        return;
      }

      // .limit(1) statt .maybeSingle(): robust falls durch frühere Test-/Absturz-Reste mehr als eine
      // Zeile zu diesem Tisch existiert (maybeSingle() würde dann mit einem Fehler abbrechen) - nimmt
      // in dem Fall einfach die neueste.
      const { data, error } = await supabase
        .from('live_game_sessions')
        .select('id')
        .eq('tournament_match_id', tournamentMatchId)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) console.error('Konnte laufende Session nicht suchen:', error);
      if (data && data.length > 0) {
        await this.session.joinLiveSession(data[0].id);
        this.session.activeTournamentMatchId.set(tournamentMatchId);
        // Ohne das würde dieses Gerät (das die neue Session nur passiv per Realtime-Bridge
        // übernimmt statt selbst startGameForMatch() aufzurufen) beim Speichern immer mit dem
        // Default true zählen - egal was für dieses Turnier eingestellt ist. Betrifft z.B. Spiel 2/3
        // eines BO3-Tisches, wenn nicht dieselbe Person/dasselbe Gerät jedes Einzelspiel speichert.
        this.session.activeTournamentCountsInStats.set(this.activeTournament()?.countInGeneralStats ?? true);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // Falls binnen ~4s weder "entschieden" noch eine neue Session auftaucht (z.B. Netzwerk-Hänger):
    // ins Panel zurückfallen, dort kann notfalls manuell "Spiel starten" geklickt werden.
    this.openPanel();
  }

  /**
   * True, während handleGameFinished() ein gerade beendetes Turnier-Spiel verarbeitet (Server-
   * Roundtrip für Spielstand/nächstes Spiel) - hält den Ingame-Tracker sichtbar (siehe
   * ingame-tracker.html), statt kurz auf den leeren Match-Tab zurückzufallen und dann wieder
   * reinzuspringen, bis feststeht, ob das nächste BO3-Spiel startet oder das Turnier-Panel öffnet.
   */
  readonly autoAdvancing = signal(false);

  readonly refreshing = signal(false);

  /** Manuelles Nachladen auf Knopfdruck (im Turnier-Panel) - ergänzt das automatische Polling, wenn jemand nicht bis zu 8 Sekunden warten möchte. */
  async refreshNow(): Promise<void> {
    const groupId = this.groupService.groupId();
    if (!groupId || this.refreshing()) return;
    this.refreshing.set(true);
    try {
      await this.loadForGroup(groupId);
    } finally {
      this.refreshing.set(false);
    }
  }

  private clear(): void {
    this.activeTournament.set(null);
    this.participants.set([]);
    this.rounds.set([]);
    this.matches.set([]);
  }

  // --- Laden ---

  private async loadForGroup(groupId: string): Promise<void> {
    // 'completed' wird bewusst mitgeladen (nicht nur 'setup'/'active') - sonst bekommt niemand
    // außer der Person, die "Turnier beenden" geklickt hat, den Endstand zu sehen. Ein bereits aktiv
    // weggeklicktes Podium (results_dismissed) zählt hier absichtlich wie "kein Turnier" - persistiert
    // in der DB statt nur lokal, damit es nach einem Reload nicht wieder auftaucht.
    const { data, error } = await supabase
      .from('tournaments')
      .select('*')
      .eq('group_id', groupId)
      .in('status', ['setup', 'active', 'completed'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('Konnte Turnier nicht laden:', error);
      this.clear();
      return;
    }
    if (!data || (data.status === 'completed' && data.results_dismissed)) {
      this.clear();
      return;
    }

    this.activeTournament.set(this.mapTournament(data));
    await this.loadParticipants(data.id);
    await this.loadRoundsAndMatches(data.id);
  }

  /** Blendet das Endergebnis-Podium eines beendeten Turniers dauerhaft aus (für alle Geräte, übersteht auch einen Reload) - siehe TournamentPanel.closeFinalResults(). */
  async dismissResults(tournamentId: string): Promise<void> {
    const { error } = await supabase
      .from('tournaments')
      .update({ results_dismissed: true })
      .eq('id', tournamentId);
    if (error) {
      console.error('Konnte Podium nicht schließen:', error);
      return;
    }
    const groupId = this.activeTournament()?.groupId;
    if (groupId) await this.loadForGroup(groupId);
  }

  private async loadParticipants(tournamentId: string): Promise<void> {
    this.participants.set(await this.fetchParticipants(tournamentId));
  }

  private async fetchParticipants(tournamentId: string): Promise<TournamentParticipant[]> {
    const { data, error } = await supabase
      .from('tournament_participants')
      .select('id, tournament_id, player_id, status, had_bye, joined_at, players ( display_name )')
      .eq('tournament_id', tournamentId);

    if (error) {
      console.error('Konnte Turnier-Teilnehmer nicht laden:', error);
      return [];
    }

    return (data ?? []).map((row: any) => ({
      id: row.id,
      tournamentId: row.tournament_id,
      playerId: row.player_id,
      playerName: row.players?.display_name ?? '',
      status: row.status as ParticipantStatus,
      hadBye: row.had_bye,
      joinedAt: row.joined_at,
    }));
  }

  private async loadRoundsAndMatches(tournamentId: string): Promise<void> {
    const { rounds, matches } = await this.fetchRoundsAndMatches(tournamentId);
    this.rounds.set(rounds);
    this.matches.set(matches);
  }

  private async fetchRoundsAndMatches(
    tournamentId: string
  ): Promise<{ rounds: TournamentRound[]; matches: TournamentMatch[] }> {
    const { data: roundsData, error: roundsError } = await supabase
      .from('tournament_rounds')
      .select('*')
      .eq('tournament_id', tournamentId)
      .order('round_number');

    if (roundsError) {
      console.error('Konnte Turnier-Runden nicht laden:', roundsError);
      return { rounds: [], matches: [] };
    }

    const rounds: TournamentRound[] = (roundsData ?? []).map((row: any) => ({
      id: row.id,
      tournamentId: row.tournament_id,
      roundNumber: row.round_number,
      status: row.status,
      startedAt: row.started_at,
      deadlineAt: row.deadline_at,
    }));
    const roundNumberById = new Map(rounds.map((r) => [r.id, r.roundNumber]));

    // Embedded Join ist hier unproblematisch (genau eine FK von tournament_match_players auf
    // players, anders als früher mit zwei fest verdrahteten Spieler-Spalten auf tournament_matches).
    const { data: matchesData, error: matchesError } = await supabase
      .from('tournament_matches')
      .select(
        `
        id, tournament_id, round_id, table_number, is_bye, is_draw, started_at,
        winner_player_id, winner_source, completed_at,
        tournament_match_players ( player_id, games_won, players ( display_name ) )
      `
      )
      .eq('tournament_id', tournamentId)
      .order('table_number');

    if (matchesError) {
      console.error('Konnte Turnier-Paarungen nicht laden:', matchesError);
      return { rounds, matches: [] };
    }

    const matches: TournamentMatch[] = (matchesData ?? []).map((row: any) => ({
      id: row.id,
      tournamentId: row.tournament_id,
      roundId: row.round_id,
      roundNumber: roundNumberById.get(row.round_id) ?? 0,
      tableNumber: row.table_number,
      isBye: row.is_bye,
      isDraw: row.is_draw,
      startedAt: row.started_at,
      participants: (row.tournament_match_players ?? []).map((p: any) => ({
        playerId: p.player_id,
        playerName: p.players?.display_name ?? '',
        gamesWon: p.games_won,
      })),
      winnerPlayerId: row.winner_player_id,
      winnerSource: row.winner_source,
      completedAt: row.completed_at,
    }));

    return { rounds, matches };
  }

  // --- Historie (abgeschlossene Turniere) für den Turniere-Tab im Stats-Bereich ---

  /** Alle Turniere dieser Gruppe (jeder Status), neueste zuerst - für die Turnier-Historie-Ansicht. */
  readonly tournamentHistory = signal<Tournament[]>([]);

  async loadTournamentHistory(groupId: string): Promise<void> {
    const { data, error } = await supabase
      .from('tournaments')
      .select('*')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Konnte Turnier-Historie nicht laden:', error);
      this.tournamentHistory.set([]);
      return;
    }
    this.tournamentHistory.set((data ?? []).map((row) => this.mapTournament(row)));
  }

  /** Kader, Paarungen und Endstand eines beliebigen (auch abgeschlossenen) Turniers - unabhängig vom "aktiven" Turnier des Live-Panels. */
  async loadTournamentDetail(
    tournamentId: string,
    tableSize: TableSize
  ): Promise<{ participants: TournamentParticipant[]; matches: TournamentMatch[]; standings: StandingsRow[] }> {
    const participants = await this.fetchParticipants(tournamentId);
    const { matches } = await this.fetchRoundsAndMatches(tournamentId);
    return { participants, matches, standings: this.computeStandingsFor(participants, matches, tableSize) };
  }

  /** Aggregierte Rangliste über alle abgeschlossenen Turniere der Gruppe hinweg (Gesamtpunkte, Siege, durchschnittliche Platzierung). */
  readonly aggregateStandings = signal<
    { playerId: string; playerName: string; tournamentsPlayed: number; totalPoints: number; wins: number; avgPlacement: number }[]
  >([]);

  async loadAggregateStandings(groupId: string): Promise<void> {
    const { data: tournamentRows, error } = await supabase
      .from('tournaments')
      .select('id, table_size')
      .eq('group_id', groupId)
      .eq('status', 'completed');

    if (error) {
      console.error('Konnte Turnier-Gesamtrangliste nicht laden:', error);
      this.aggregateStandings.set([]);
      return;
    }

    const acc = new Map<
      string,
      { playerName: string; tournamentsPlayed: number; totalPoints: number; wins: number; placementSum: number }
    >();

    for (const row of tournamentRows ?? []) {
      const { standings } = await this.loadTournamentDetail(row.id, row.table_size as TableSize);
      standings.forEach((s, index) => {
        const entry = acc.get(s.playerId) ?? {
          playerName: s.playerName,
          tournamentsPlayed: 0,
          totalPoints: 0,
          wins: 0,
          placementSum: 0,
        };
        entry.tournamentsPlayed += 1;
        entry.totalPoints += s.points;
        entry.wins += s.wins;
        entry.placementSum += index + 1;
        acc.set(s.playerId, entry);
      });
    }

    this.aggregateStandings.set(
      [...acc.entries()]
        .map(([playerId, e]) => ({
          playerId,
          playerName: e.playerName,
          tournamentsPlayed: e.tournamentsPlayed,
          totalPoints: e.totalPoints,
          wins: e.wins,
          avgPlacement: e.placementSum / e.tournamentsPlayed,
        }))
        .sort((a, b) => b.totalPoints - a.totalPoints || a.avgPlacement - b.avgPlacement)
    );
  }

  private mapTournament(row: any): Tournament {
    return {
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      status: row.status as TournamentStatus,
      gameMode: row.game_mode as GameMode,
      gameFormat: (row.game_format as DeckFormat) ?? null,
      tableSize: row.table_size as TableSize,
      roundCountMode: row.round_count_mode as RoundCountMode,
      manualRoundCount: row.manual_round_count,
      roundCount: row.round_count,
      currentRound: row.current_round,
      roundLengthMinutes: row.round_length_minutes,
      inviteCode: row.invite_code,
      createdBy: row.created_by,
      createdAt: row.created_at,
      draftSet: row.draft_set ?? null,
      cubeId: row.cube_id ?? null,
      countInGeneralStats: row.count_in_general_stats ?? true,
    };
  }

  // --- Erstellen / Beitreten ---

  private generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  async createTournament(
    groupId: string,
    name: string,
    gameMode: GameMode,
    gameFormat: DeckFormat | null,
    tableSize: TableSize,
    roundCountMode: RoundCountMode,
    manualRoundCount: number | null,
    initialPlayerNames: string[],
    draftSet: SelectedDraftSet | null,
    cubeId: string | null,
    countInGeneralStats: boolean
  ): Promise<string | null> {
    const user = this.auth.currentUser();
    const trimmedName = name.trim();
    if (!user || !trimmedName || initialPlayerNames.length < 2) return null;

    let tournamentId: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = this.generateCode();
      const { data, error } = await supabase
        .from('tournaments')
        .insert({
          group_id: groupId,
          name: trimmedName,
          game_mode: gameMode,
          game_format: gameFormat,
          table_size: tableSize,
          round_count_mode: roundCountMode,
          manual_round_count: roundCountMode === 'manual' ? manualRoundCount : null,
          invite_code: code,
          created_by: user.id,
          draft_set: gameMode === 'Draft' ? draftSet : null,
          cube_id: gameMode === 'Cube' ? cubeId : null,
          count_in_general_stats: countInGeneralStats,
        })
        .select('id')
        .single();

      if (!error && data) {
        tournamentId = data.id;
        break;
      }
      if (error && error.code !== '23505') {
        console.error('Konnte Turnier nicht anlegen:', error);
        return null;
      }
    }

    if (!tournamentId) {
      console.error('Konnte keinen eindeutigen Turnier-Code finden.');
      return null;
    }

    const participantRows = initialPlayerNames
      .map((name) => ({ id: this.mtg.playerIdFor(name), status: this.initialStatusFor(name) }))
      .filter((p): p is { id: string; status: ParticipantStatus } => !!p.id)
      .map((p) => ({
        tournament_id: tournamentId,
        player_id: p.id,
        status: p.status,
        joined_at: p.status === 'joined' ? new Date().toISOString() : null,
      }));

    if (participantRows.length > 0) {
      const { error } = await supabase.from('tournament_participants').insert(participantRows);
      if (error) console.error('Konnte Turnier-Teilnehmer nicht anlegen:', error);
    }

    await this.loadForGroup(groupId);
    return tournamentId;
  }

  /**
   * Beitritt per Einladungscode - für Personen, die die veranstaltende Person beim Erstellen
   * nicht direkt ausgewählt hat. Setzt voraus, dass die Person bereits Mitglied dieser Gruppe ist
   * (players-Eintrag vorhanden) - für alle anderen greift weiterhin der normale Gruppen-Beitritt
   * per Code (group.service.ts), das ist hier bewusst nicht dupliziert.
   */
  async joinByCode(code: string): Promise<{ success: boolean; messageKey: string; params?: Record<string, string> }> {
    const trimmedCode = code.trim().toUpperCase();
    if (!trimmedCode) return { success: false, messageKey: 'tournament.msg.codeRequired' };

    const { data: tournamentRow, error: tournamentError } = await supabase
      .from('tournaments')
      .select('id, group_id, status')
      .eq('invite_code', trimmedCode)
      .maybeSingle();

    if (tournamentError || !tournamentRow) {
      return { success: false, messageKey: 'tournament.msg.invalidCode' };
    }
    if (tournamentRow.status !== 'setup') {
      return { success: false, messageKey: 'tournament.msg.notJoinable' };
    }

    const groupId = this.groupService.groupId();
    if (!groupId || groupId !== tournamentRow.group_id) {
      // Betrifft sowohl "noch in gar keiner Gruppe" als auch "in einer anderen Gruppe" - die
      // Lösung ist in beiden Fällen dieselbe: erst per Gruppen-Code beitreten (group.service.ts).
      return { success: false, messageKey: 'tournament.msg.notInGroup' };
    }

    const name = this.mtg.myPlayerName();
    const playerId = name ? this.mtg.playerIdFor(name) : null;
    if (!playerId) {
      return { success: false, messageKey: 'tournament.msg.noPlayerProfile' };
    }

    const { data: existingRow } = await supabase
      .from('tournament_participants')
      .select('id, status')
      .eq('tournament_id', tournamentRow.id)
      .eq('player_id', playerId)
      .maybeSingle();

    if (existingRow) {
      if (existingRow.status === 'invited') {
        const { error } = await supabase
          .from('tournament_participants')
          .update({ status: 'joined', joined_at: new Date().toISOString() })
          .eq('id', existingRow.id);
        if (error) {
          console.error('Konnte Turnier-Beitritt nicht speichern:', error);
          return { success: false, messageKey: 'tournament.msg.joinFailed' };
        }
      }
    } else {
      const { error } = await supabase.from('tournament_participants').insert({
        tournament_id: tournamentRow.id,
        player_id: playerId,
        status: 'joined',
        joined_at: new Date().toISOString(),
      });
      if (error) {
        console.error('Konnte Turnier-Teilnahme nicht anlegen:', error);
        return { success: false, messageKey: 'tournament.msg.joinFailed' };
      }
    }

    await this.loadForGroup(groupId);
    return { success: true, messageKey: 'tournament.msg.joinSuccess' };
  }

  /**
   * Accountlose Spieler (players.user_id === null, z.B. Gäste ohne eigenen Login) können sich nie
   * selbst per confirmJoin() bestätigen - sie treten deshalb sofort als "joined" bei, sobald die
   * veranstaltende Person sie auswählt. Die veranstaltende Person selbst braucht sich ebenfalls
   * nicht extra zu bestätigen. Alle anderen Personen mit Account müssen weiterhin selbst bestätigen.
   */
  private initialStatusFor(playerName: string): ParticipantStatus {
    const uid = this.mtg.playerUserIds()[playerName];
    if (!uid) return 'joined';
    if (uid === this.auth.currentUser()?.id) return 'joined';
    return 'invited';
  }

  async addParticipant(tournamentId: string, playerName: string): Promise<boolean> {
    const playerId = this.mtg.playerIdFor(playerName);
    if (!playerId) return false;

    const status = this.initialStatusFor(playerName);
    const { error } = await supabase.from('tournament_participants').insert({
      tournament_id: tournamentId,
      player_id: playerId,
      status,
      joined_at: status === 'joined' ? new Date().toISOString() : null,
    });

    if (error) {
      console.error('Konnte Teilnehmer nicht hinzufügen:', error);
      return false;
    }
    await this.loadParticipants(tournamentId);
    return true;
  }

  async removeParticipant(participantId: string, tournamentId: string): Promise<boolean> {
    const tournament = this.activeTournament();
    if (!tournament || tournament.id !== tournamentId || !this.isOrganizer()) return false;

    const { error } = await supabase.from('tournament_participants').delete().eq('id', participantId);
    if (error) {
      console.error('Konnte Teilnehmer nicht entfernen:', error);
      return false;
    }
    await this.loadParticipants(tournamentId);
    return true;
  }

  async confirmJoin(tournamentId: string): Promise<boolean> {
    const name = this.mtg.myPlayerName();
    const playerId = name ? this.mtg.playerIdFor(name) : null;
    if (!playerId) return false;

    const { error } = await supabase
      .from('tournament_participants')
      .update({ status: 'joined', joined_at: new Date().toISOString() })
      .eq('tournament_id', tournamentId)
      .eq('player_id', playerId);

    if (error) {
      console.error('Konnte Turnier-Beitritt nicht speichern:', error);
      return false;
    }
    await this.loadParticipants(tournamentId);
    return true;
  }

  // --- Runden / Pairing ---

  async startTournament(tournamentId: string): Promise<boolean> {
    const tournament = this.activeTournament();
    if (!tournament || tournament.id !== tournamentId || !this.isOrganizer()) return false;

    const joined = this.participants().filter((p) => p.status === 'joined');
    if (joined.length < 2) {
      console.error('Mindestens 2 beigetretene Personen nötig, um das Turnier zu starten.');
      return false;
    }

    const roundCount =
      tournament.roundCountMode === 'manual'
        ? Math.max(1, tournament.manualRoundCount ?? 1)
        : Math.max(1, Math.ceil(Math.log2(joined.length)));

    const { error } = await supabase
      .from('tournaments')
      .update({ status: 'active', round_count: roundCount })
      .eq('id', tournamentId);

    if (error) {
      console.error('Konnte Turnier nicht starten:', error);
      return false;
    }

    await this.loadForGroup(tournament.groupId);
    return this.startNextRound(tournamentId);
  }

  async startNextRound(tournamentId: string): Promise<boolean> {
    const tournament = this.activeTournament();
    if (!tournament || tournament.id !== tournamentId || !this.isOrganizer()) return false;

    const nextRoundNumber = tournament.currentRound + 1;
    if (tournament.roundCount && nextRoundNumber > tournament.roundCount) {
      return this.endTournament(tournamentId);
    }

    const joined = this.participants().filter((p) => p.status === 'joined');
    const pairings =
      nextRoundNumber === 1
        ? this.generateRound1Pairings(joined, tournament.tableSize)
        : this.generateSwissPairings(joined, tournament.tableSize);

    const deadlineAt = new Date(Date.now() + tournament.roundLengthMinutes * 60_000).toISOString();

    const { data: roundRow, error: roundError } = await supabase
      .from('tournament_rounds')
      .insert({ tournament_id: tournamentId, round_number: nextRoundNumber, deadline_at: deadlineAt })
      .select('id')
      .single();

    if (roundError || !roundRow) {
      console.error('Konnte Runde nicht anlegen:', roundError);
      return false;
    }

    // Tische bewusst einzeln nacheinander anlegen (statt Bulk-Insert), damit jede zurückgegebene
    // ID sicher der richtigen Paarung zugeordnet werden kann - ein Bulk-Insert garantiert keine
    // zur Eingabe passende Rückgabe-Reihenfolge, und die Teilnehmer-Zeilen brauchen die echte ID.
    const nowIso = new Date().toISOString();
    const insertedTables: { id: string; playerIds: string[] }[] = [];
    for (let i = 0; i < pairings.length; i++) {
      const pairing = pairings[i];
      const isBye = pairing.playerIds.length === 1;
      const { data: tableRow, error: tableError } = await supabase
        .from('tournament_matches')
        .insert({
          tournament_id: tournamentId,
          round_id: roundRow.id,
          table_number: i + 1,
          is_bye: isBye,
          winner_player_id: isBye ? pairing.playerIds[0] : null,
          winner_source: isBye ? 'bye' : null,
          completed_at: isBye ? nowIso : null,
        })
        .select('id')
        .single();

      if (tableError || !tableRow) {
        console.error('Konnte Tisch nicht anlegen:', tableError);
        return false;
      }
      insertedTables.push({ id: tableRow.id, playerIds: pairing.playerIds });
    }

    const participantRows = insertedTables.flatMap((t) =>
      t.playerIds.map((playerId) => ({ tournament_match_id: t.id, player_id: playerId }))
    );
    const { error: participantsError } = await supabase.from('tournament_match_players').insert(participantRows);
    if (participantsError) {
      console.error('Konnte Tisch-Teilnehmer nicht anlegen:', participantsError);
      return false;
    }

    const byePlayerIds = pairings.filter((p) => p.playerIds.length === 1).map((p) => p.playerIds[0]);
    for (const byePlayerId of byePlayerIds) {
      await supabase
        .from('tournament_participants')
        .update({ had_bye: true })
        .eq('tournament_id', tournamentId)
        .eq('player_id', byePlayerId);
    }

    const { error: bumpError } = await supabase
      .from('tournaments')
      .update({ current_round: nextRoundNumber })
      .eq('id', tournamentId);
    if (bumpError) console.error('Konnte aktuelle Runde nicht aktualisieren:', bumpError);

    await this.loadForGroup(tournament.groupId);
    return true;
  }

  async endTournament(tournamentId: string): Promise<boolean> {
    const tournament = this.activeTournament();
    if (!tournament || tournament.id !== tournamentId || !this.isOrganizer()) return false;

    const { error } = await supabase.from('tournaments').update({ status: 'completed' }).eq('id', tournamentId);
    if (error) {
      console.error('Konnte Turnier nicht abschließen:', error);
      return false;
    }
    const groupId = this.activeTournament()?.groupId;
    if (groupId) await this.loadForGroup(groupId);
    return true;
  }

  /**
   * Bricht ein Turnier unwiderruflich ab (Organizer-only) - löscht die tournaments-Zeile, was
   * Teilnehmer/Runden/Tische/Tisch-Teilnehmer per on-delete-cascade mitlöscht. Bereits gespielte
   * Einzelspiele bleiben in der normalen Statistik erhalten (matches.tournament_match_id wird per
   * on-delete-set-null nur entkoppelt, nicht die Zeile selbst gelöscht).
   */
  async cancelTournament(tournamentId: string): Promise<boolean> {
    const tournament = this.activeTournament();
    if (!tournament || tournament.id !== tournamentId || !this.isOrganizer()) return false;

    const { error } = await supabase.from('tournaments').delete().eq('id', tournamentId);
    if (error) {
      console.error('Konnte Turnier nicht abbrechen:', error);
      return false;
    }

    this.closePanel();
    await this.loadForGroup(tournament.groupId);
    return true;
  }

  /**
   * Ändert nachträglich, ob die Einzelspiele eines (auch bereits abgeschlossenen) Turniers in die
   * allgemeine Statistik einfließen (host-only, siehe TournamentHistory) - für den Fall, dass die
   * Checkbox beim Erstellen versehentlich falsch gesetzt war, oder um Altlasten eines früheren Bugs
   * zu korrigieren (siehe GameSessionService.activeTournamentCountsInStats/handleRemoteSessionEnded).
   * Aktualisiert sowohl das Turnier selbst als auch ALLE bereits gespeicherten Einzelspiele auf den
   * neuen Wert.
   */
  async setCountInGeneralStats(tournamentId: string, value: boolean): Promise<boolean> {
    if (!this.groupService.hasPermission('tournament.manage')) return false;

    const { error: tournamentError } = await supabase
      .from('tournaments')
      .update({ count_in_general_stats: value })
      .eq('id', tournamentId);
    if (tournamentError) {
      console.error('Konnte Turnier-Statistik-Einstellung nicht speichern:', tournamentError);
      return false;
    }

    const { data: tableRows, error } = await supabase
      .from('tournament_matches')
      .select('id')
      .eq('tournament_id', tournamentId);
    if (error) {
      console.error('Konnte Turnier-Tische nicht laden:', error);
      return false;
    }
    const tournamentMatchIds = (tableRows ?? []).map((t) => t.id);
    const matchesUpdated = await this.mtg.setCountsInGeneralStatsForTournamentMatchIds(tournamentMatchIds, value);
    if (!matchesUpdated) return false;

    this.tournamentHistory.update((list) =>
      list.map((t) => (t.id === tournamentId ? { ...t, countInGeneralStats: value } : t))
    );
    if (this.activeTournament()?.id === tournamentId) {
      this.activeTournament.update((t) => (t ? { ...t, countInGeneralStats: value } : t));
    }
    return true;
  }

  /**
   * Löscht unwiderruflich EIN Turnier samt aller seiner Einzelspiele - anders als cancelTournament()
   * (nur für das eigene, gerade aktive Turnier gedacht; Einzelspiele bleiben als normale Matches
   * erhalten) funktioniert das für JEDES Turnier der Gruppe (host-only, siehe TournamentHistory) und
   * löscht auch die matches-Zeilen selbst, das Turnier verschwindet also komplett aus Verlauf/Statistik.
   */
  async deleteTournament(tournamentId: string, groupId: string): Promise<{ success: boolean; error?: string }> {
    if (groupId !== this.groupService.groupId() || !this.groupService.hasPermission('tournament.manage')) {
      return { success: false, error: 'Keine Berechtigung.' };
    }

    const result = await this.deleteTournamentRows([tournamentId]);
    if (!result.success) return result;

    this.clear();
    await Promise.all([
      this.loadForGroup(groupId),
      this.loadTournamentHistory(groupId),
      this.loadAggregateStandings(groupId),
    ]);
    return { success: true };
  }

  /**
   * Löscht Tabelle für Tabelle in Abhängigkeitsreihenfolge (statt sich auf DB-Cascades zu
   * verlassen) für die übergebenen Turnier-IDs - genutzt von deleteTournament(). Löscht bewusst
   * auch die matches-Zeilen selbst (anders als cancelTournament(), das sie nur entkoppelt), sie
   * verschwinden also aus der Statistik.
   */
  private async deleteTournamentRows(tournamentIds: string[]): Promise<{ success: boolean; error?: string }> {
    if (tournamentIds.length === 0) return { success: true };

    const { data: tableRows, error: tablesError } = await supabase
      .from('tournament_matches')
      .select('id')
      .in('tournament_id', tournamentIds);

    if (tablesError) {
      console.error('Konnte Turnier-Tische nicht laden:', tablesError);
      return { success: false, error: tablesError.message };
    }

    const tournamentMatchIds = (tableRows ?? []).map((t) => t.id);

    // Einzelspiele (auch aus der allgemeinen Statistik) zuerst löschen - danach die Turnier-Ebene selbst.
    const matchesDeleted = await this.mtg.deleteMatchesForTournamentMatchIds(tournamentMatchIds);
    if (!matchesDeleted) {
      return { success: false, error: 'Konnte die Einzelspiele der Turniere nicht löschen.' };
    }

    for (const batch of chunk(tournamentMatchIds, 150)) {
      const { error: sessionsError } = await supabase
        .from('live_game_sessions')
        .delete()
        .in('tournament_match_id', batch);
      if (sessionsError) console.error('Konnte laufende Sessions nicht löschen:', sessionsError);

      const { error: tmpError } = await supabase
        .from('tournament_match_players')
        .delete()
        .in('tournament_match_id', batch);
      if (tmpError) {
        console.error('Konnte Tisch-Teilnehmer nicht löschen:', tmpError);
        return { success: false, error: tmpError.message };
      }
    }

    const { error: matchesTableError } = await supabase
      .from('tournament_matches')
      .delete()
      .in('tournament_id', tournamentIds);
    if (matchesTableError) {
      console.error('Konnte Turnier-Tische nicht löschen:', matchesTableError);
      return { success: false, error: matchesTableError.message };
    }

    const { error: roundsError } = await supabase
      .from('tournament_rounds')
      .delete()
      .in('tournament_id', tournamentIds);
    if (roundsError) {
      console.error('Konnte Turnier-Runden nicht löschen:', roundsError);
      return { success: false, error: roundsError.message };
    }

    const { error: participantsError } = await supabase
      .from('tournament_participants')
      .delete()
      .in('tournament_id', tournamentIds);
    if (participantsError) {
      console.error('Konnte Turnier-Teilnehmer nicht löschen:', participantsError);
      return { success: false, error: participantsError.message };
    }

    const { error: tournamentsDeleteError } = await supabase
      .from('tournaments')
      .delete()
      .in('id', tournamentIds);
    if (tournamentsDeleteError) {
      console.error('Konnte Turniere nicht löschen:', tournamentsDeleteError);
      return { success: false, error: tournamentsDeleteError.message };
    }

    return { success: true };
  }

  private shuffle<T>(items: T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  private generateRound1Pairings(joined: TournamentParticipant[], tableSize: TableSize): Pairing[] {
    const shuffled = this.shuffle(joined).map((p) => p.playerId);
    return this.buildTablesAvoidingRepeats(shuffled, tableSize, new Set());
  }

  /** playerIdA::playerIdB (sortiert) für jedes bereits gemeinsam an einem Tisch gesessene Personen-Paar dieses Turniers. */
  private pairingHistory(): Set<string> {
    const history = new Set<string>();
    for (const m of this.matches()) {
      if (m.isBye) continue;
      const ids = m.participants.map((p) => p.playerId);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          history.add([ids[i], ids[j]].sort().join('::'));
        }
      }
    }
    return history;
  }

  private generateSwissPairings(joined: TournamentParticipant[], tableSize: TableSize): Pairing[] {
    const pointsById = new Map(this.computeStandings().map((s) => [s.playerId, s.points]));
    const sorted = [...joined].sort((a, b) => {
      const diff = (pointsById.get(b.playerId) ?? 0) - (pointsById.get(a.playerId) ?? 0);
      return diff !== 0 ? diff : Math.random() - 0.5;
    });

    const tables = this.buildTablesAvoidingRepeats(
      sorted.map((p) => p.playerId),
      tableSize,
      this.pairingHistory()
    );
    return this.ensureByeFairness(tables);
  }

  /**
   * Verteilt eine geordnete Spielerliste (Runde 1: zufällig, Swiss: nach Punkten sortiert) auf
   * Tische der Zielgröße `tableSize`, möglichst gleichmäßig (Größen tableSize oder tableSize-1)
   * statt eines kleinen Rest-Tisches. Ein einzelner übrig bleibender Spieler bekommt ein Freilos.
   * Versucht beim Auffüllen jedes Tisches, Personen zu bevorzugen, die laut `history` noch nicht
   * zusammen an einem Tisch saßen; findet sich niemand Konfliktfreies mehr, wird die Person mit
   * den wenigsten Wiederholungs-Konflikten genommen (Fallback, wird geloggt).
   *
   * Die Suche nach einer konfliktfreien Person ist bewusst auf ein Fenster der Größe `tableSize`
   * um die aktuelle Position im (nach Punkten sortierten) Pool begrenzt, statt das gesamte
   * restliche Feld zu durchsuchen - sonst reißt die Wiederholungs-Vermeidung Punktgruppen
   * auseinander (z.B. würden zwei punktgleiche Erstplatzierte quer durchs Feld getrennt, nur um
   * eine Wiederholung zu vermeiden, statt sie für einen klaren Showdown zusammenzulassen).
   */
  private buildTablesAvoidingRepeats(orderedPlayerIds: string[], tableSize: number, history: Set<string>): Pairing[] {
    const n = orderedPlayerIds.length;
    if (n === 0) return [];
    if (n === 1) return [{ playerIds: orderedPlayerIds }];

    const numTables = Math.max(1, Math.ceil(n / tableSize));
    const base = Math.floor(n / numTables);
    const remainder = n % numTables;
    const tableSizes = Array.from({ length: numTables }, (_, t) => base + (t < remainder ? 1 : 0));

    const pool = [...orderedPlayerIds];
    const tables: Pairing[] = [];

    for (const size of tableSizes) {
      const table: string[] = [pool.shift()!];

      while (table.length < size && pool.length > 0) {
        const searchWindow = Math.min(pool.length, tableSize);
        let bestIndex = 0;
        let bestConflicts = Infinity;
        for (let i = 0; i < searchWindow; i++) {
          const conflicts = table.filter((memberId) => history.has([memberId, pool[i]].sort().join('::'))).length;
          if (conflicts < bestConflicts) {
            bestConflicts = conflicts;
            bestIndex = i;
            if (conflicts === 0) break;
          }
        }
        if (bestConflicts > 0) {
          console.warn(`Swiss-Pairing: Wiederholte Paarung(en) an einem Tisch nicht vermeidbar (${bestConflicts}).`);
        }
        table.push(pool.splice(bestIndex, 1)[0]);
      }

      tables.push({ playerIds: table });
    }

    return tables;
  }

  /** Tauscht ein Freilos mit jemandem, der noch keins hatte, falls die aktuelle Zuteilung eine Person doppelt trifft. */
  private ensureByeFairness(tables: Pairing[]): Pairing[] {
    const byeTable = tables.find((t) => t.playerIds.length === 1);
    if (!byeTable) return tables;

    const byePlayerId = byeTable.playerIds[0];
    const hadBye = this.participants().find((p) => p.playerId === byePlayerId)?.hadBye;
    if (!hadBye) return tables;

    for (const table of tables) {
      if (table === byeTable) continue;
      const swapIndex = table.playerIds.findIndex(
        (id) => !this.participants().find((p) => p.playerId === id)?.hadBye
      );
      if (swapIndex !== -1) {
        const swapId = table.playerIds[swapIndex];
        table.playerIds[swapIndex] = byePlayerId;
        byeTable.playerIds[0] = swapId;
        break;
      }
    }
    return tables;
  }

  private computeStandings(): StandingsRow[] {
    const tableSize = this.activeTournament()?.tableSize ?? 2;
    return this.computeStandingsFor(this.participants(), this.matches(), tableSize);
  }

  /**
   * Mindestwert für die eigene Match-/Spiel-Sieg-Quote, bevor sie in die Quote ANDERER Personen
   * einfließt (offizielle Turnierregel) - verhindert, dass eine einzelne frühe Klatsche (z.B. 0
   * Siege aus Runde 1) die OMW%/OGW% der eigenen späteren Gegner den Rest des Turniers über
   * unverhältnismäßig nach unten zieht.
   */
  private static readonly TIEBREAKER_FLOOR = 1 / 3;

  private computeStandingsFor(
    participants: TournamentParticipant[],
    matches: TournamentMatch[],
    tableSize: TableSize
  ): StandingsRow[] {
    const wins = new Map<string, number>();
    const losses = new Map<string, number>();
    const byes = new Map<string, number>();
    const matchesPlayed = new Map<string, number>();
    const gamesWon = new Map<string, number>();
    const gamesPlayed = new Map<string, number>();
    /** Echte Gegner je entschiedener Runde (Freilose ausgenommen) - bei Pods alle Mitspieler am Tisch, ggf. mit Wiederholungen. */
    const opponents = new Map<string, string[]>();

    const bump = (map: Map<string, number>, id: string, by = 1) => map.set(id, (map.get(id) ?? 0) + by);

    for (const p of participants) {
      wins.set(p.playerId, 0);
      losses.set(p.playerId, 0);
      byes.set(p.playerId, 0);
      matchesPlayed.set(p.playerId, 0);
      gamesWon.set(p.playerId, 0);
      gamesPlayed.set(p.playerId, 0);
      opponents.set(p.playerId, []);
    }

    for (const m of matches) {
      if (m.isBye) {
        const byePlayerId = m.participants[0]?.playerId;
        if (byePlayerId) {
          bump(byes, byePlayerId);
          bump(wins, byePlayerId);
          bump(matchesPlayed, byePlayerId);
          // Offizielle Konvention: ein Freilos zählt für die eigene Spiel-Sieg-Quote wie ein volles
          // gewonnenes Match (Best-of-3: 2:0, Pod-Einzelspiel: 1:0), statt gar keine Spiele beizusteuern.
          const byeGames = tableSize === 2 ? 2 : 1;
          bump(gamesWon, byePlayerId, byeGames);
          bump(gamesPlayed, byePlayerId, byeGames);
        }
        continue;
      }
      if (!m.completedAt) continue; // Tisch noch offen -> fließt in keine Quote ein

      const ids = m.participants.map((participant) => participant.playerId);
      for (const id of ids) {
        bump(matchesPlayed, id);
        opponents.get(id)?.push(...ids.filter((otherId) => otherId !== id));
      }

      if (m.participants.length === 2) {
        const [a, b] = m.participants;
        const gamesAtTable = a.gamesWon + b.gamesWon;
        bump(gamesWon, a.playerId, a.gamesWon);
        bump(gamesWon, b.playerId, b.gamesWon);
        bump(gamesPlayed, a.playerId, gamesAtTable);
        bump(gamesPlayed, b.playerId, gamesAtTable);
      } else {
        // Pod: ein Tisch = ein Einzelspiel (kein Best-of-3), Unentschieden zählt als von niemandem gewonnenes Spiel.
        for (const id of ids) bump(gamesPlayed, id);
        if (m.winnerPlayerId) bump(gamesWon, m.winnerPlayerId);
      }

      if (!m.winnerPlayerId) continue; // Unentschieden -> niemand bekommt Punkte
      bump(wins, m.winnerPlayerId);
      for (const id of ids) {
        if (id !== m.winnerPlayerId) bump(losses, id);
      }
    }

    const floor = TournamentService.TIEBREAKER_FLOOR;
    const matchWinPercent = (playerId: string): number => {
      const played = matchesPlayed.get(playerId) ?? 0;
      if (played === 0) return floor;
      return Math.max(floor, (wins.get(playerId) ?? 0) / played);
    };
    const gameWinPercent = (playerId: string): number => {
      const played = gamesPlayed.get(playerId) ?? 0;
      if (played === 0) return floor;
      return Math.max(floor, (gamesWon.get(playerId) ?? 0) / played);
    };

    return participants
      .map((p) => {
        const opponentIds = opponents.get(p.playerId) ?? [];
        const omwPercent = opponentIds.length
          ? opponentIds.reduce((sum, id) => sum + matchWinPercent(id), 0) / opponentIds.length
          : 0;
        const ogwPercent = opponentIds.length
          ? opponentIds.reduce((sum, id) => sum + gameWinPercent(id), 0) / opponentIds.length
          : 0;
        return {
          playerId: p.playerId,
          playerName: p.playerName,
          points: (wins.get(p.playerId) ?? 0) * 3,
          wins: wins.get(p.playerId) ?? 0,
          losses: losses.get(p.playerId) ?? 0,
          byes: byes.get(p.playerId) ?? 0,
          omwPercent,
          gwPercent: gameWinPercent(p.playerId),
          ogwPercent,
        };
      })
      .sort(
        (a, b) =>
          b.points - a.points || b.omwPercent - a.omwPercent || b.gwPercent - a.gwPercent || b.ogwPercent - a.ogwPercent
      );
  }

  // --- Spiel-Integration ---

  /**
   * Startet die bestehende Einzel-Match-Session (ingame-tracker/Commander-Pods) für diesen Tisch.
   * Nutzt bewusst immer die tatsächlichen Namen aller Tisch-Teilnehmer statt einer "ich"-
   * Perspektive - so kann auch die veranstaltende Person das Spiel stellvertretend für accountlose
   * Personen starten und deren Ergebnis eintragen, nicht nur die Spielenden selbst.
   *
   * Das 50-Minuten-Limit beginnt bewusst erst mit dem ersten "Spiel starten"-Klick an diesem Tisch
   * (startedAt), nicht schon mit dem Auslosen der Runde - bei Spiel 2/3 desselben 1v1-Tisches
   * bleibt der einmal gesetzte Zeitpunkt stehen.
   */
  /** Tische, für die gerade ein startGameForMatch()-Aufruf läuft - verhindert, dass zwei parallele Aufrufe (z.B. Auto-Weiterschaltung + ein gleichzeitiger Klick) für denselben Tisch je eine eigene Live-Session anlegen. */
  private readonly startingGameForTable = new Set<string>();

  async startGameForMatch(match: TournamentMatch): Promise<void> {
    // Harte Absicherung: ein bereits entschiedener Tisch (BO3 mit 2 Siegen, Pod mit Ergebnis) darf
    // nicht erneut gestartet werden - egal ob das versehentlich per Klick oder durch die
    // automatische Weiterschaltung in handleGameFinished() passieren würde.
    if (match.isBye || match.participants.length < 2 || match.winnerPlayerId || match.isDraw) return;
    if (this.startingGameForTable.has(match.id)) return;
    this.startingGameForTable.add(match.id);

    try {
      await this.startGameForMatchInner(match);
    } finally {
      this.startingGameForTable.delete(match.id);
    }
  }

  private async startGameForMatchInner(match: TournamentMatch): Promise<void> {
    if (!match.startedAt) {
      const startedAt = new Date().toISOString();
      const { error } = await supabase
        .from('tournament_matches')
        .update({ started_at: startedAt })
        .eq('id', match.id);
      if (error) {
        console.error('Konnte Start-Zeitpunkt nicht speichern:', error);
      } else {
        this.matches.update((current) => current.map((m) => (m.id === match.id ? { ...m, startedAt } : m)));
      }
    }

    // Falls für diesen Tisch schon eine laufende Live-Session existiert (z.B. weil die andere Person
    // bereits "Spiel starten" geklickt hat), an diese ankoppeln statt unabhängig neu aufzusetzen -
    // beide Geräte sehen dann denselben Live-Stand, siehe GameSessionService.joinLiveSession.
    // .limit(1) statt .maybeSingle(): robust falls durch frühere Test-/Absturz-Reste mehr als eine
    // Zeile zu diesem Tisch existiert.
    const { data: existingSessions, error: findError } = await supabase
      .from('live_game_sessions')
      .select('id')
      .eq('tournament_match_id', match.id)
      .order('created_at', { ascending: false })
      .limit(1);
    if (findError) console.error('Konnte laufende Session für diesen Tisch nicht prüfen:', findError);
    const existingSession = existingSessions?.[0] ?? null;

    const tournament = this.activeTournament();
    this.session.activeTournamentMatchId.set(match.id);
    this.session.activeTournamentCountsInStats.set(tournament?.countInGeneralStats ?? true);

    if (existingSession) {
      await this.session.joinLiveSession(existingSession.id);
    } else {
      this.session.setMode(tournament?.gameMode ?? 'Normal');
      this.session.format.set(tournament ? tournament.gameFormat : 'Commander');
      this.session.selectedDraftSet.set(tournament?.draftSet ?? null);
      this.session.selectedCubeId.set(tournament?.cubeId ?? null);
      this.session.selectedPlayers.set(match.participants.map((p) => ({ name: p.playerName })));
      this.session.startGame();
    }

    this.closePanel();
  }

  /**
   * Berechnet den BO3-Spielstand eines 2-Personen-Tisches komplett neu aus den tatsächlich
   * gespeicherten matches-Zeilen (statt hochzuzählen - siehe Kommentar zur Endlos-Zähler-Absicherung
   * weiter unten) und schreibt Spielstand + Tisch-Sieger entsprechend fest. Wird sowohl beim
   * automatischen Eintragen eines fertig gespielten Spiels als auch bei der nachträglichen
   * Korrektur eines einzelnen Spielergebnisses aufgerufen - kann den Tisch dabei auch wieder von
   * "entschieden" zurück auf "offen" setzen, falls eine Korrektur das nötig macht.
   */
  private async recomputeBo3(
    tournamentMatchId: string,
    winnerEntry: { playerId: string; playerName: string },
    otherEntry: { playerId: string; playerName: string }
  ): Promise<{ winnerWins: number; otherWins: number; ok: boolean }> {
    const { data: gameRows, error: gameRowsError } = await supabase
      .from('matches')
      .select('winner_name')
      .eq('tournament_match_id', tournamentMatchId);

    if (gameRowsError || !gameRows) {
      // Bewusst OHNE zu schreiben zurück: mit einem leeren Leseergebnis würde unten sonst
      // winner_player_id/completed_at auf null gesetzt und damit ein bereits entschiedener Tisch
      // wieder auf "offen" zurückgedreht.
      console.error('Konnte Spielstand nicht neu berechnen:', gameRowsError);
      return { winnerWins: 0, otherWins: 0, ok: false };
    }

    const winnerWins = gameRows.filter((r) => r.winner_name === winnerEntry.playerName).length;
    const otherWins = gameRows.filter((r) => r.winner_name === otherEntry.playerName).length;
    const decided = winnerWins >= 2 || otherWins >= 2;
    const overallWinnerId = winnerWins >= 2 ? winnerEntry.playerId : otherWins >= 2 ? otherEntry.playerId : null;

    const { error } = await supabase
      .from('tournament_match_players')
      .update({ games_won: winnerWins })
      .eq('tournament_match_id', tournamentMatchId)
      .eq('player_id', winnerEntry.playerId);
    if (error) console.error('Konnte Spielstand nicht speichern:', error);

    const { error: otherError } = await supabase
      .from('tournament_match_players')
      .update({ games_won: otherWins })
      .eq('tournament_match_id', tournamentMatchId)
      .eq('player_id', otherEntry.playerId);
    if (otherError) console.error('Konnte Spielstand nicht speichern:', otherError);

    const { error: winnerError } = await supabase
      .from('tournament_matches')
      .update({
        winner_player_id: overallWinnerId,
        winner_source: overallWinnerId ? 'games' : null,
        completed_at: decided ? new Date().toISOString() : null,
      })
      .eq('id', tournamentMatchId);
    if (winnerError) console.error('Konnte Turnier-Sieger nicht speichern:', winnerError);

    // ok=false heißt: der Spielstand steht jetzt NICHT so in der Datenbank, wie er hier berechnet
    // wurde. Die Aufrufer dürfen daraufhin weder den Tisch als entschieden behandeln noch
    // automatisch das nächste Spiel starten - sonst entsteht die Endlosschleife aus
    // "speichern schlägt fehl -> Tisch bleibt offen -> nächstes Spiel -> speichern schlägt fehl".
    return { winnerWins, otherWins, ok: !error && !otherError && !winnerError };
  }

  /** Einzelne gespeicherte Spiele eines Tisches (für die nachträgliche "Sieger ändern"-Korrektur bei BO3-Tischen). */
  async fetchGamesFor(tournamentMatchId: string): Promise<{ id: string; gameNumber: number; winnerName: string }[]> {
    const { data, error } = await supabase
      .from('matches')
      .select('id, tournament_game_number, winner_name')
      .eq('tournament_match_id', tournamentMatchId)
      .order('tournament_game_number', { ascending: true });

    if (error) {
      console.error('Konnte Einzelspiele nicht laden:', error);
      return [];
    }
    return (data ?? []).map((row) => ({
      id: row.id,
      gameNumber: row.tournament_game_number ?? 0,
      winnerName: row.winner_name,
    }));
  }

  /**
   * Korrigiert, wer ein einzelnes bereits gespeichertes Spiel innerhalb eines BO3-Tisches
   * gewonnen hat - der eigentliche Grund, warum man überhaupt einen Tisch-Sieger ändern will, ist
   * ja fast immer, dass genau dieses Einzelspiel falsch gespeichert wurde. Berechnet danach
   * Spielstand und Tisch-Sieger frisch aus den (jetzt korrigierten) Spielen.
   */
  async correctGameWinner(tournamentMatchId: string, gameRowId: string, newWinnerName: string): Promise<boolean> {
    const match = this.matches().find((m) => m.id === tournamentMatchId);
    if (!match || match.participants.length !== 2) return false;

    const { error } = await supabase.from('matches').update({ winner_name: newWinnerName }).eq('id', gameRowId);
    if (error) {
      console.error('Konnte Spielergebnis nicht korrigieren:', error);
      return false;
    }

    const { ok } = await this.recomputeBo3(tournamentMatchId, match.participants[0], match.participants[1]);
    await this.deleteLiveSessionForTable(tournamentMatchId);
    await this.loadRoundsAndMatches(match.tournamentId);
    return ok;
  }

  /** Trägt ein fertig gespieltes Einzelspiel ein und meldet zurück, ob der Tisch damit entschieden ist (BO3 erst ab 2 Siegen, Pods sofort) - siehe handleGameFinished(). */
  private async recordGameResult(
    tournamentMatchId: string,
    matchRowId: string,
    winnerName: string
  ): Promise<{ decided: boolean; ok: boolean }> {
    if (this.processedGameResults.has(matchRowId)) return { decided: false, ok: true };
    // Sperre sofort setzen, damit zwei gleichzeitige Durchläufe dasselbe Spiel nicht doppelt
    // eintragen - bei einem Fehlschlag unten aber wieder zurücknehmen, sonst könnte dieses Spiel
    // nie mehr nachgetragen werden (z.B. nachdem eine gestörte Datenbank wieder erreichbar ist).
    this.processedGameResults.add(matchRowId);
    const giveUp = (ok: boolean) => {
      if (!ok) this.processedGameResults.delete(matchRowId);
      return { decided: false, ok };
    };

    const match = this.matches().find((m) => m.id === tournamentMatchId);
    if (!match) return giveUp(false);

    const isDraw = winnerName === this.session.DRAW;
    let decided = false;

    if (match.participants.length === 2) {
      // 1v1 Best-of-3: ein Unentschieden-Einzelspiel zählt für keine Seite, Tisch bleibt offen.
      // Das ist kein Fehler, sondern ein gültiges Ergebnis - die Sperre bleibt deshalb bestehen.
      if (isDraw) return { decided: false, ok: true };

      const winnerPlayerId = this.mtg.playerIdFor(winnerName);
      const winnerEntry = match.participants.find((p) => p.playerId === winnerPlayerId);
      const otherEntry = match.participants.find((p) => p.playerId !== winnerPlayerId);
      if (!winnerEntry || !otherEntry) return giveUp(false);

      const { winnerWins, otherWins, ok } = await this.recomputeBo3(tournamentMatchId, winnerEntry, otherEntry);
      if (!ok) return giveUp(false);
      decided = winnerWins >= 2 || otherWins >= 2;

      const { error: gameNumberError } = await supabase
        .from('matches')
        .update({ tournament_game_number: winnerWins + otherWins })
        .eq('id', matchRowId);
      if (gameNumberError) console.error('Konnte Spielnummer nicht am Match hinterlegen:', gameNumberError);
    } else {
      // Pod (3-4 Personen): das erste eingetragene Ergebnis entscheidet den Tisch sofort.
      decided = true;
      if (isDraw) {
        const { error } = await supabase
          .from('tournament_matches')
          .update({ is_draw: true, completed_at: new Date().toISOString() })
          .eq('id', tournamentMatchId);
        if (error) {
          console.error('Konnte Unentschieden nicht speichern:', error);
          return giveUp(false);
        }
      } else {
        const winnerPlayerId = this.mtg.playerIdFor(winnerName);
        if (!winnerPlayerId) return giveUp(false);
        const { error } = await supabase
          .from('tournament_matches')
          .update({ winner_player_id: winnerPlayerId, winner_source: 'games', completed_at: new Date().toISOString() })
          .eq('id', tournamentMatchId);
        if (error) {
          console.error('Konnte Turnier-Sieger nicht speichern:', error);
          return giveUp(false);
        }
      }

      const { error: gameNumberError } = await supabase
        .from('matches')
        .update({ tournament_game_number: 1 })
        .eq('id', matchRowId);
      if (gameNumberError) console.error('Konnte Spielnummer nicht am Match hinterlegen:', gameNumberError);
    }

    await this.loadRoundsAndMatches(match.tournamentId);
    return { decided, ok: true };
  }

  /**
   * Reagiert auf ein fertig gespieltes Turnier-Spiel: bei einem noch unentschiedenen BO3-Tisch
   * (weniger als 2 Siege für beide Seiten) wird direkt das nächste Spiel am selben Tisch gestartet,
   * statt zurück ins Turnier-Panel zu springen - sonst müsste man nach jedem Einzelspiel manuell
   * wieder "Spiel starten" klicken. Erst wenn der Tisch entschieden ist (BO3 mit 2 Siegen, oder ein
   * Pod-Tisch nach seinem einen Spiel), geht es automatisch zurück ins Turnier-Panel.
   */
  private async handleGameFinished(tournamentMatchId: string, matchRowId: string, winnerName: string): Promise<void> {
    this.autoAdvancing.set(true);
    try {
      const { ok } = await this.recordGameResult(tournamentMatchId, matchRowId, winnerName);

      // Konnte das Ergebnis nicht gespeichert werden, steht der Tisch weiterhin auf "offen" - dann
      // aber NICHT automatisch das nächste Spiel starten: der nächste Versuch würde genauso
      // scheitern, und das Ganze liefe endlos weiter (Fehler 42P17 in den RLS-Policies, siehe
      // sql/fix-tournament-rls-recursion-2026-09-03.sql). Stattdessen einmal sichtbar melden und
      // zurück ins Turnier-Panel, damit man überhaupt wieder herauskommt.
      if (!ok) {
        this.openPanel();
        await this.dialog.alert(this.i18n.t('tournament.msg.saveFailed'));
        return;
      }

      // Bewusst aus dem frisch neu geladenen Tisch selbst abgeleitet (statt nur aus dem Rückgabewert
      // von recordGameResult) - so bleibt diese Entscheidung immer konsistent mit der Sperre in
      // startGameForMatch(), die einen bereits entschiedenen Tisch ohnehin nicht mehr startet.
      const match = this.matches().find((m) => m.id === tournamentMatchId);
      const decided = !match || match.participants.length !== 2 || !!match.winnerPlayerId || match.isDraw;

      if (decided || !match) {
        this.openPanel();
        return;
      }

      await this.startGameForMatch(match);
    } finally {
      this.autoAdvancing.set(false);
    }
  }

  /**
   * Korrigiert den Sieger eines bereits entschiedenen Pod-Tisches (3-4 Personen) - für 2-Personen-
   * BO3-Tische gibt es stattdessen die genauere correctGameWinner()-Korrektur pro Einzelspiel.
   * Ein Pod-Tisch hat normalerweise genau ein gespeichertes Spiel; dessen winner_name wird
   * gleich mit korrigiert, damit die normale Statistik konsistent zur Turnier-Wertung bleibt.
   */
  async correctWinner(tournamentMatchId: string, winnerPlayerId: string): Promise<boolean> {
    const match = this.matches().find((m) => m.id === tournamentMatchId);
    if (!match || match.isBye || match.participants.length < 2) return false;

    const { error } = await supabase
      .from('tournament_matches')
      .update({
        winner_player_id: winnerPlayerId,
        winner_source: 'manual',
        is_draw: false,
        completed_at: new Date().toISOString(),
      })
      .eq('id', tournamentMatchId);

    if (error) {
      console.error('Konnte Sieger nicht korrigieren:', error);
      return false;
    }

    const winnerEntry = match.participants.find((p) => p.playerId === winnerPlayerId);
    if (winnerEntry && match.participants.length > 2) {
      const { error: gameError } = await supabase
        .from('matches')
        .update({ winner_name: winnerEntry.playerName })
        .eq('tournament_match_id', tournamentMatchId);
      if (gameError) console.error('Konnte Spielergebnis nicht mit korrigieren:', gameError);
    }

    await this.deleteLiveSessionForTable(tournamentMatchId);
    await this.loadRoundsAndMatches(match.tournamentId);
    return true;
  }

  /**
   * "Sieger festlegen"-Override, unabhängig vom bisherigen Spielstand nutzbar (z.B. bei
   * Zeitablauf). Legt zusätzlich eine ganz normale matches-Zeile an (wie ein live über den
   * Ingame-Tracker gespieltes Spiel) - sonst würde dieser Tisch zwar in der Turnier-Tabelle
   * mitzählen, aber nie im Match-Verlauf/in der Statistik auftauchen, weil dort ausschließlich
   * über addMatch() befüllt wird.
   */
  async setManualWinner(tournamentMatchId: string, winnerPlayerId: string): Promise<boolean> {
    const match = this.matches().find((m) => m.id === tournamentMatchId);
    if (!match || match.isBye || match.participants.length < 2) return false;

    const { error } = await supabase
      .from('tournament_matches')
      .update({
        winner_player_id: winnerPlayerId,
        winner_source: 'manual',
        is_draw: false,
        completed_at: new Date().toISOString(),
      })
      .eq('id', tournamentMatchId);

    if (error) {
      console.error('Konnte Sieger nicht manuell festlegen:', error);
      return false;
    }

    await this.recordManualMatchRow(match, winnerPlayerId);
    await this.deleteLiveSessionForTable(tournamentMatchId);
    await this.loadRoundsAndMatches(match.tournamentId);
    return true;
  }

  /** Manuelles "kein Sieger" für Pods (z.B. Zeitablauf ohne eindeutiges Ergebnis) - trägt ebenfalls eine matches-Zeile nach, siehe setManualWinner(). */
  async setManualDraw(tournamentMatchId: string): Promise<boolean> {
    const match = this.matches().find((m) => m.id === tournamentMatchId);
    if (!match || match.isBye || match.participants.length < 2) return false;

    const { error } = await supabase
      .from('tournament_matches')
      .update({
        is_draw: true,
        winner_player_id: null,
        winner_source: 'manual',
        completed_at: new Date().toISOString(),
      })
      .eq('id', tournamentMatchId);

    if (error) {
      console.error('Konnte Unentschieden nicht manuell festlegen:', error);
      return false;
    }

    await this.recordManualMatchRow(match, null);
    await this.deleteLiveSessionForTable(tournamentMatchId);
    await this.loadRoundsAndMatches(match.tournamentId);
    return true;
  }

  /**
   * Trägt für einen 2-Personen-BO3-Tisch direkt einen Endstand (2:0 oder 2:1) nach, ohne dass die
   * Einzelspiele über den Ingame-Tracker gespielt wurden - für den Fall, dass die Spieler ihre
   * Partien nicht live mit der App getrackt haben. Ersetzt dazu alle bisher zu diesem Tisch
   * gespeicherten matches-Zeilen durch genau winnerWins + loserWins neue Zeilen, damit die
   * allgemeine Statistik weiterhin pro Einzelspiel (nicht nur pro Tisch) korrekt zählt.
   */
  async setManualScore(tournamentMatchId: string, winnerPlayerId: string, loserWins: 0 | 1): Promise<boolean> {
    const match = this.matches().find((m) => m.id === tournamentMatchId);
    if (!match || match.isBye || match.participants.length !== 2) return false;

    const winnerEntry = match.participants.find((p) => p.playerId === winnerPlayerId);
    const otherEntry = match.participants.find((p) => p.playerId !== winnerPlayerId);
    if (!winnerEntry || !otherEntry) return false;

    const deleted = await this.mtg.deleteMatchesForTournamentTable(tournamentMatchId);
    if (!deleted) return false;

    const winnerWins = 2;
    let allRowsCreated = true;
    for (let i = 0; i < winnerWins + loserWins; i++) {
      const thisWinnerName = i < winnerWins ? winnerEntry.playerName : otherEntry.playerName;
      const matchRowId = await this.mtg.addMatch({
        mode: this.activeTournament()?.gameMode ?? 'Normal',
        format: this.activeTournament() ? this.activeTournament()!.gameFormat : 'Commander',
        players: match.participants.map((p) => ({ name: p.playerName })),
        winner: thisWinnerName,
        tournamentMatchId: match.id,
        countsInGeneralStats: this.activeTournament()?.countInGeneralStats ?? true,
      });
      if (matchRowId) {
        const { error } = await supabase.from('matches').update({ tournament_game_number: i + 1 }).eq('id', matchRowId);
        if (error) console.error('Konnte Spielnummer nicht am Match hinterlegen:', error);
      } else {
        // Ohne diese Zeile stimmt der Endstand nicht mehr - vorher wurde das stillschweigend
        // übergangen und die Funktion meldete trotzdem Erfolg.
        console.error('Konnte Einzelspiel für den manuellen Endstand nicht anlegen.');
        allRowsCreated = false;
      }
    }

    const { ok } = await this.recomputeBo3(tournamentMatchId, winnerEntry, otherEntry);
    await this.deleteLiveSessionForTable(tournamentMatchId);
    await this.loadRoundsAndMatches(match.tournamentId);
    return ok && allRowsCreated;
  }

  /**
   * Löscht eine ggf. noch laufende Live-Session dieses Tisches - nötig, wenn der Sieger manuell
   * (nicht durch tatsächliches Zu-Ende-Spielen) festgelegt wird, z.B. per Endstand-Buttons. Ohne das
   * würde ein Gerät, das gerade live mit diesem Tisch verbunden ist, nie erfahren, dass der Tisch
   * inzwischen entschieden ist, und im Ingame-Tracker hängen bleiben (die Löschung löst über Realtime
   * genau denselben Abschluss-Mechanismus aus wie ein normales Speichern - siehe
   * GameSessionService.subscribeLiveSession/handleRemoteSessionEnded).
   */
  private async deleteLiveSessionForTable(tournamentMatchId: string): Promise<void> {
    const { error } = await supabase
      .from('live_game_sessions')
      .delete()
      .eq('tournament_match_id', tournamentMatchId);
    if (error) console.error('Konnte Live-Session des Tisches nicht schließen:', error);
  }

  private async recordManualMatchRow(match: TournamentMatch, winnerPlayerId: string | null): Promise<void> {
    const winnerName = winnerPlayerId
      ? match.participants.find((p) => p.playerId === winnerPlayerId)?.playerName
      : this.session.DRAW;
    if (!winnerName) return;

    const matchRowId = await this.mtg.addMatch({
      mode: this.activeTournament()?.gameMode ?? 'Normal',
      format: this.activeTournament() ? this.activeTournament()!.gameFormat : 'Commander',
      players: match.participants.map((p) => ({ name: p.playerName })),
      winner: winnerName,
      tournamentMatchId: match.id,
      countsInGeneralStats: this.activeTournament()?.countInGeneralStats ?? true,
    });
    if (!matchRowId) return;

    const gameNumber =
      match.participants.length === 2
        ? match.participants.reduce((sum, p) => sum + p.gamesWon, 0) + 1
        : 1;
    const { error: gameNumberError } = await supabase
      .from('matches')
      .update({ tournament_game_number: gameNumber })
      .eq('id', matchRowId);
    if (gameNumberError) console.error('Konnte Spielnummer nicht am Match hinterlegen:', gameNumberError);
  }
}
