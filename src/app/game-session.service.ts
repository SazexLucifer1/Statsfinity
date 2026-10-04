import { Injectable, WritableSignal, computed, effect, inject, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { DeckFormat, GameMode, LifeLog, LifeLogEvent, MatchPlayer, TEAM_OPTIONS, TeamName } from './models';

/** Formate mit Singleton-Regel/eigenem Commander - steuert, ob bei Kategorie 'Normal' die Commander-Auswahl im Match-Tab erscheint (siehe GameSessionService.requiresCommanderSelection). */
const COMMANDER_STYLE_FORMATS: DeckFormat[] = ['Commander', 'Pauper Commander', 'Brawl', 'Historic Brawl'];
import { MtgService } from './mtg.service';
import { I18nService } from './i18n.service';
import { GroupService } from './group.service';
import { AuthService } from './auth.service';
import { supabase } from './supabase.client';

/**
 * Obergrenze für den Lebenspunkte-Verlauf einer Partie. Eine lange Commander-Runde kommt auf
 * einige hundert Änderungen; die Grenze fängt nur einen Ausreißer ab (Finger auf dem Knopf
 * vergessen), damit weder der Live-Sync noch die Zeile in matches ausufern.
 */
const LIFE_LOG_MAX_EVENTS = 3000;

/** Einmal pro Tab/Ladevorgang erzeugt - dient dazu, eigene Realtime-Updates (Echo) beim Empfang wiederzuerkennen und zu ignorieren. */
const CLIENT_ID = crypto.randomUUID();

/**
 * JSON.stringify mit sortierten Keys - JSONB ändert die Reihenfolge, sonst würde ein empfangener,
 * gleicher Stand nie als bekannt erkannt (Ping-Pong zwischen Geräten).
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k])).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Der zwischen Geräten synchronisierte Teil des Zustands. Nicht dabei: phase/minimized (je Gerät)
 * und die pending*Delta-Puffer (nur lokale Tipp-Glättung).
 */
export interface LiveSessionState {
  mode: GameMode;
  format: DeckFormat | null;
  /** Ranked oder freies Match (Match.isRanked); fehlt bei Sessions von vor diesem Feature -> Ranked. */
  isRanked?: boolean;
  selectedPlayers: MatchPlayer[];
  selectedCubeId: string | null;
  selectedDraftSet: SelectedDraftSet | null;
  lifeTotals: Record<string, number>;
  commanderDamage: Record<string, Record<string, number>>;
  poisonCounters: Record<string, number>;
  poisonView: Record<string, boolean>;
  deadPlayers: Record<string, boolean>;
  deadMessageMap: Record<string, string>;
  commanderDamageFocus: string | null;
  manualOrder: string[] | null;
  pinnedBottomKey: string | null;
  winner: string | null;
  /** Ab hier optional: fehlen bei Sessions von vor dem Partie-Verlauf (sql/partie-verlauf-2026-10-04.sql). */
  startedAt?: string | null;
  startingPlayerKey?: string | null;
  lifeLogUnits?: string[];
  lifeLogStart?: number;
  lifeLog?: LifeLogEvent[];
}

export interface SelectedDraftSet {
  id: string;
  code?: string;
  name: string;
  releasedAt?: string;
  set_type?: string;
}

export interface DamageSource {
  key: string;
  label: string;
}

/**
 * Eine Panel-Einheit im Ingame-Raster: ein Spieler, bei Two-Headed Giant ein Team. `key` ist der
 * Schlüssel aller Session-Signale (Spielername bzw. Team-Name).
 */
export interface IngameUnit {
  key: string;
  label: string;
  commander?: string;
  partnerCommander?: string;
  members: MatchPlayer[];
}

/**
 * Zustand des laufenden (oder vorbereiteten) Matches - als Service, damit ein Spiel Tab-Wechsel
 * übersteht (Komponenten werden dabei zerstört).
 */
@Injectable({ providedIn: 'root' })
export class GameSessionService {
  private readonly mtg = inject(MtgService);
  private readonly i18n = inject(I18nService);
  private readonly groupService = inject(GroupService);
  private readonly auth = inject(AuthService);

  readonly OTHERS = '__OTHERS__';
  readonly DRAW = '__DRAW__';

  readonly phase = signal<'setup' | 'ingame'>('setup');
  readonly minimized = signal(false);
  readonly showWinnerPanel = signal(false);

  readonly mode = signal<GameMode>('Normal');
  /** Gespieltes MTG-Format, kombiniert mit mode - null nur bei mode 'Spezialevent' (siehe setMode()). */
  readonly format = signal<DeckFormat | null>('Commander');
  /**
   * Ranked oder freies Match - nur wählbar, wenn die Gruppe Ranked spielt
   * (GroupService.rankedEnabled); sonst ohnehin egal, weil nicht gerechnet wird. Standard Ranked.
   */
  readonly isRanked = signal(true);
  readonly selectedPlayers = signal<MatchPlayer[]>([]);
  readonly winner = signal<string | null>(null);
  readonly selectedCubeId = signal<string | null>(null);
  readonly selectedDraftSet = signal<SelectedDraftSet | null>(null);

  /**
   * Zuletzt gespeichertes Match, für nachträgliche Platzierungen (PlacementDialog) und fürs
   * BO3-Ergebnis (TournamentService, nur mit tournamentMatchId).
   */
  readonly lastFinishedMatch = signal<{
    matchId: string;
    players: MatchPlayer[];
    winner: string;
    tournamentMatchId?: string;
  } | null>(null);

  /** Gesetzt, wenn das aktuelle Spiel Teil eines Turnier-Tisches ist - siehe TournamentService.startGameForMatch(). */
  readonly activeTournamentMatchId = signal<string | null>(null);
  /** Ob das aktuelle (Turnier-)Spiel beim Speichern in die allgemeine Statistik einfließen soll - vom Turnier vererbt, sonst immer true (normale Spiele zählen immer). */
  readonly activeTournamentCountsInStats = signal<boolean>(true);

  // --- Geräteübergreifender Live-Sync (live_game_sessions, Supabase Realtime) ---

  /** ID meiner eigenen live_game_sessions-Zeile, solange ich (mit)spiele oder beigetreten bin - null, wenn dieses Gerät gerade nicht an einer laufenden Partie hängt. */
  readonly liveSessionId = signal<string | null>(null);

  /** Gesetzt, wenn die eigene Live-Session gerade von einem ANDEREN Gerät beendet wurde (dort gespeichert/verworfen) - TournamentService reagiert darauf, um bei einem entschiedenen Tisch automatisch das Panel zu öffnen, obwohl dieses Gerät das Spiel nicht selbst gespeichert hat. */
  readonly remoteSessionEnded = signal<{ tournamentMatchId: string | null } | null>(null);

  /** Alle aktuell laufenden Spiele der eigenen Gruppe (für die "Laufende Spiele"-Übersicht im Match-Tab UND die "Beitreten statt Starten"-Beschriftung im Turnier-Panel), roh - inkl. der eigenen Session. */
  private readonly groupLiveSessions = signal<
    {
      id: string;
      mode: GameMode;
      format: DeckFormat | null;
      playerNames: string[];
      tournamentMatchId: string | null;
    }[]
  >([]);

  /**
   * Laufende Spiele der Gruppe ohne die eigene Session und ohne Turnier-Tische (die haben eine
   * eigene Zugriffsprüfung) - für die Liste im Match-Tab.
   */
  readonly otherGroupLiveSessions = computed(() =>
    this.groupLiveSessions().filter((s) => s.id !== this.liveSessionId() && !s.tournamentMatchId)
  );

  /** Läuft für diesen Turnier-Tisch bereits eine Live-Session (egal ob meine eigene oder die einer anderen Person)? Treibt die "Beitreten"- statt "Starten"-Beschriftung im Turnier-Panel. */
  hasLiveSessionForTable(tournamentMatchId: string): boolean {
    return this.groupLiveSessions().some((s) => s.tournamentMatchId === tournamentMatchId);
  }

  private realtimeChannel: RealtimeChannel | null = null;
  private groupSessionsChannel: RealtimeChannel | null = null;
  private pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Signatur (JSON) des zuletzt gepushten oder empfangenen Stands - verhindert, dass ein gerade per Realtime übernommener Stand sofort wieder (unnötig) zurückgepusht wird. */
  private lastSyncedSignature: string | null = null;

  /** Der Teil des Zustands, der synchronisiert wird - siehe LiveSessionState. Neues Objekt bei jeder relevanten Änderung, damit der Push-Effect unten zuverlässig reagiert. */
  private readonly syncSnapshot = computed<LiveSessionState>(() => ({
    mode: this.mode(),
    format: this.format(),
    isRanked: this.isRanked(),
    selectedPlayers: this.selectedPlayers(),
    selectedCubeId: this.selectedCubeId(),
    selectedDraftSet: this.selectedDraftSet(),
    lifeTotals: this.lifeTotals(),
    commanderDamage: this.commanderDamage(),
    poisonCounters: this.poisonCounters(),
    poisonView: this.poisonView(),
    deadPlayers: this.deadPlayers(),
    deadMessageMap: this.deadMessageMap(),
    commanderDamageFocus: this.commanderDamageFocus(),
    manualOrder: this.manualOrder(),
    pinnedBottomKey: this.pinnedBottomKey(),
    winner: this.winner(),
    startedAt: this.startedAt(),
    startingPlayerKey: this.startingPlayerKey(),
    lifeLogUnits: this.lifeLogUnits(),
    lifeLogStart: this.lifeLogStart(),
    lifeLog: this.lifeLog(),
  }));

  // --- Partie-Verlauf (sql/partie-verlauf-2026-10-04.sql): Startzeit, Startspieler und jede
  // Lebenspunkte-/Giftänderung. Liegt im synchronisierten Zustand, damit das speichernde Gerät
  // auch die Änderungen kennt, die auf einem anderen getippt wurden. ---

  /** Zeitpunkt von startGame() als ISO-String. */
  readonly startedAt = signal<string | null>(null);
  /** Panel-Key der Einheit, die angefangen hat - aus der Auslosung oder im Sieger-Dialog gewählt. */
  readonly startingPlayerKey = signal<string | null>(null);
  /** Panel-Keys beim Spielstart; die Einträge in lifeLog verweisen per Index darauf. */
  readonly lifeLogUnits = signal<string[]>([]);
  readonly lifeLogStart = signal(0);
  readonly lifeLog = signal<LifeLogEvent[]>([]);

  private logLifeChange(key: string, delta: number, poison: boolean): void {
    const startedAt = this.startedAt();
    if (!startedAt || delta === 0) return;
    const unit = this.lifeLogUnits().indexOf(key);
    if (unit === -1) return;
    const second = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
    const event: LifeLogEvent = poison ? [second, unit, delta, 1] : [second, unit, delta];
    this.lifeLog.update((log) => (log.length >= LIFE_LOG_MAX_EVENTS ? log : [...log, event]));
  }

  /** Startspieler setzen; derselbe Key ein zweites Mal hebt die Auswahl auf. */
  toggleStartingPlayer(key: string): void {
    this.startingPlayerKey.update((current) => (current === key ? null : key));
  }

  /**
   * Sitzordnung im Uhrzeigersinn, so wie die Panels um das Handy herum liegen. In der
   * zweispaltigen Ansicht sitzt die linke Spalte am linken Tischrand (Panel um 90° gedreht), die
   * rechte am rechten, ein Sonderslot unten an der unteren Kante. Von oben gesehen im
   * Uhrzeigersinn: rechte Spalte von oben nach unten, dann unten, dann linke Spalte von unten
   * nach oben. Magic gibt den Zug nach links weiter - für jemanden, der zur Tischmitte schaut, ist
   * das genau diese Richtung. Stimmt nur, wenn die Panels so liegen wie die Leute sitzen (dafür
   * gibt es "Spieler neu anordnen").
   */
  private seatingRing(): string[] {
    const units = this.ingameUnits().map((u) => u.key);
    if (this.ingameColumns() === 1) return units;
    const bottom = this.hasOddBottomSlot() ? units.pop() : undefined;
    const left = units.filter((_, i) => i % 2 === 0);
    const right = units.filter((_, i) => i % 2 === 1);
    return [...right, ...(bottom ? [bottom] : []), ...left.reverse()];
  }

  /** Panel-Key -> Platz in der Zugreihenfolge (1 = Startspieler); leer, solange keiner gewählt ist. */
  turnOrderByUnit(): Record<string, number> {
    const starter = this.startingPlayerKey();
    const ring = this.seatingRing();
    const startIndex = starter ? ring.indexOf(starter) : -1;
    if (startIndex === -1) return {};
    const order: Record<string, number> = {};
    ring.forEach((key, i) => {
      order[key] = ((i - startIndex + ring.length) % ring.length) + 1;
    });
    return order;
  }

  /** Verlauf für matches.life_log, oder undefined, wenn die Partie nicht im Tracker lief. */
  private buildLifeLog(): LifeLog | undefined {
    if (!this.startedAt() || this.lifeLogUnits().length === 0) return undefined;
    return { v: 1, start: this.lifeLogStart(), units: this.lifeLogUnits(), events: this.lifeLog() };
  }

  /** Nach Panel-Key indiziert (Spielername bzw. 2HG-Team). */
  readonly lifeTotals = signal<Record<string, number>>({});
  /** commanderDamage[Ziel-Key][Quelle-Key] = Schaden */
  readonly commanderDamage = signal<Record<string, Record<string, number>>>({});
  /** poisonCounters[Panel-Key] = Anzahl Gift-Marken (10 = Niederlage) */
  readonly poisonCounters = signal<Record<string, number>>({});

  /** Zeigt ein Panel gerade Gift statt Leben? Rein lokal, betrifft nur dieses eine Panel. */
  readonly poisonView = signal<Record<string, boolean>>({});

  /** Rein visueller "Tot"-Status pro Panel – greift bewusst nicht in Leben/Sieger-Logik ein. */

  readonly deadPlayers = signal<Record<string, boolean>>({});

  private readonly deathMessageKeys = Array.from({ length: 15 }, (_, i) => `game.death.${i + 1}`);

  /** Zufällig gezogener Todes-Spruch pro Panel, bleibt bis zur Wiederbelebung stabil. */
  readonly deadMessageMap = signal<Record<string, string>>({});

  isDead(key: string): boolean {
    return this.deadPlayers()[key] ?? false;
  }

  toggleDead(key: string): void {
    const wasDead = this.isDead(key);
    this.deadPlayers.update((all) => ({ ...all, [key]: !wasDead }));

    if (!wasDead) {
      // Wird gerade als tot markiert -> neuen zufälligen Spruch ziehen.
      const msgKey = this.deathMessageKeys[Math.floor(Math.random() * this.deathMessageKeys.length)];
      this.deadMessageMap.update((all) => ({ ...all, [key]: this.i18n.t(msgKey) }));
    }
  }

  /** Aktueller Todes-Spruch fürs Panel, Fallback falls (noch) keiner gezogen wurde. */
  deadMessage(key: string): string {
    return this.deadMessageMap()[key] ?? this.i18n.t('game.deadFallback');
  }

  /**
   * Gesetzt: diese Einheit sammelt Commander-Schaden ein; die anderen Panels werden zu
   * Eingabe-Trackern gegen sie.
   */
  readonly commanderDamageFocus = signal<string | null>(null);

  /** Manuelle Panel-Reihenfolge ("Spieler neu anordnen"), angewendet vor dem pinnedBottomKey. */
  readonly manualOrder = signal<string[] | null>(null);

  /** Tauscht die Positionen zweier Panel-Einheiten (per Key) in der Anzeige-Reihenfolge. */
  swapUnits(keyA: string, keyB: string): void {
    if (keyA === keyB) return;
    const currentOrder = this.ingameUnits().map((u) => u.key);
    const idxA = currentOrder.indexOf(keyA);
    const idxB = currentOrder.indexOf(keyB);
    if (idxA === -1 || idxB === -1) return;
    const next = [...currentOrder];
    [next[idxA], next[idxB]] = [next[idxB], next[idxA]];
    this.manualOrder.set(next);
  }

  /**
   * Panel für den Sonderslot unten bei ungerader Anzahl (Longpress auf den Namen); bei Archenemy
   * vorbelegt.
   */
  readonly pinnedBottomKey = signal<string | null>(null);

  setPinnedBottomKey(key: string | null): void {
    this.pinnedBottomKey.set(key);
  }

  /** Setzt die Kategorie und hält das Format konsistent - Spezialevent hat nie ein Format, alle anderen brauchen eins (Default Commander, falls gerade keins gesetzt war). */
  setMode(mode: GameMode): void {
    this.mode.set(mode);
    if (mode === 'Spezialevent') {
      this.format.set(null);
    } else if (this.format() === null) {
      this.format.set('Commander');
    }
  }

  readonly isTwoHeadedGiantMode = computed(() => this.mode() === 'Two-Headed Giant');

  /** Panel-Einheiten: bei 2HG eine je Team ("A & B"), sonst eine je Spieler. */
  readonly ingameUnits = computed<IngameUnit[]>(() => {
    let units: IngameUnit[];

    if (this.isTwoHeadedGiantMode()) {
      const teamOrder: string[] = [];
      const teams = new Map<string, MatchPlayer[]>();
      for (const p of this.selectedPlayers()) {
        const team = p.team ?? 'Unbekannt';
        if (!teams.has(team)) {
          teams.set(team, []);
          teamOrder.push(team);
        }
        teams.get(team)!.push(p);
      }
      units = teamOrder.map((team) => {
        const members = teams.get(team)!;
        return {
          key: team,
          label: members.map((m) => m.name).join(' & '),
          members,
        };
      });
    } else {
      units = this.selectedPlayers().map((p) => ({
        key: p.name,
        label: p.name,
        commander: p.commander,
        partnerCommander: p.partnerCommander,
        members: [p],
      }));
    }
    const manual = this.manualOrder();
    if (manual) {
      const byKey = new Map(units.map((u) => [u.key, u]));
      const ordered: IngameUnit[] = [];
      for (const key of manual) {
        const unit = byKey.get(key);
        if (unit) {
          ordered.push(unit);
          byKey.delete(key);
        }
      }
      ordered.push(...byKey.values());
      units = ordered;
    }

    // Sonderslot unten (ungerade Anzahl, quer liegend): der angeheftete Key
    // landet am Ende der Liste und damit automatisch im letzten Grid-Index.
    const pinned = this.pinnedBottomKey();
    if (pinned) {
      const idx = units.findIndex((u) => u.key === pinned);
      if (idx !== -1 && idx !== units.length - 1) {
        const [unit] = units.splice(idx, 1);
        units.push(unit);
      }
    }

    return units;
  });

  readonly requiresCommanderSelection = computed(() => {
    if (this.mode() === 'Two-Headed Giant' || this.mode() === 'Archenemy') return true;
    if (this.mode() === 'Normal') {
      const format = this.format();
      return format !== null && COMMANDER_STYLE_FORMATS.includes(format);
    }
    if (this.mode() === 'Cube') {
      const cube = this.mtg.cubes().find((c) => c.id === this.selectedCubeId());
      return Boolean(cube && cube.isCommander);
    }
    if (this.mode() === 'Draft') {
      const ds = this.selectedDraftSet();
      return Boolean(ds && ds.set_type === 'commander');
    }
    return false;
  });

  readonly canSave = computed(() => {
    if (this.selectedPlayers().length < 2 || this.winner() === null) return false;

    if (this.isTwoHeadedGiantMode()) {
      return this.selectedPlayers().every((player) => Boolean(player.team));
    }

    if (this.mode() === 'Archenemy') {
      const archenemies = this.selectedPlayers().filter((p) => p.isArchenemy);
      if (archenemies.length !== 1) return false;
      if (!this.selectedPlayers().every((p) => Boolean(p.commander))) return false;
      const w = this.winner();
      if (!w) return false;
      if (w === this.OTHERS) return true;
      if (w === this.DRAW) return true;
      return this.selectedPlayers().some((p) => p.name === w);
    }

    return true;
  });

  readonly canStartGame = computed(() => {
    if (this.selectedPlayers().length < 2) return false;

    if (this.isTwoHeadedGiantMode()) {
      return this.selectedPlayers().every((player) => Boolean(player.team));
    }

    if (this.mode() === 'Archenemy') {
      const archenemies = this.selectedPlayers().filter((p) => p.isArchenemy);
      if (archenemies.length !== 1) return false;
    }

    // Das Cube-<select> im Match-Tab hat keinen leeren Platzhalter-Eintrag mehr - ohne diese Prüfung
    // ließe sich ein Cube-Spiel sonst starten, obwohl (noch) gar kein Cube existiert/ausgewählt ist.
    if (this.mode() === 'Cube' && !this.selectedCubeId()) return false;

    return true;
  });

  /** Ob zwei Panels nebeneinander passen; Schwelle aus --bp-lg wie in den Styles. */
  private readonly wideViewport = signal(false);

  private watchViewportWidth(): void {
    if (typeof window === 'undefined') return;
    const px = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--bp-lg'),
    );
    const query = window.matchMedia(`(min-width: ${px || 1000}px)`);
    this.wideViewport.set(query.matches);
    query.addEventListener('change', (e) => this.wideViewport.set(e.matches));
  }

  /**
   * Spaltenanzahl: bei zwei Spielern auf breiten Fenstern nebeneinander, ab drei Spielern zwei
   * Spalten.
   */
  readonly ingameColumns = computed(() => {
    const units = this.ingameUnits().length;
    if (units <= 1) return 1;
    if (units === 2) return this.wideViewport() ? 2 : 1;
    return 2;
  });

  /** Gibt es bei der aktuellen Panel-Anzahl einen Sonderslot unten (ungerade Anzahl im 2-Spalten-Grid)? */
  readonly hasOddBottomSlot = computed(
    () => this.ingameColumns() === 2 && this.ingameUnits().length % 2 === 1
  );
  /** Vertikale Position des ⋮-Knopfs: 50 %, bei Sonderslot unten die Mitte der übrigen Reihen. */
  readonly centerButtonTopPercent = computed(() => {
    if (!this.hasOddBottomSlot()) return 50;
    const cols = this.ingameColumns();
    const totalRows = Math.ceil(this.ingameUnits().length / cols);
    return ((totalRows - 1) / (2 * totalRows)) * 100;
  });

  constructor() {
    this.watchViewportWidth();

    // Cube vorauswählen: das <select> zeigt ohne Platzhalter optisch den ersten Eintrag, schreibt
    // ihn aber nicht ins Model - sonst blockierte canStartGame.
    effect(
      () => {
        if (this.mode() !== 'Cube' || this.selectedCubeId()) return;
        const first = this.mtg.cubes()[0];
        if (first) this.selectedCubeId.set(first.id);
      },
      { allowSignalWrites: true }
    );

    // Sieger vorschlagen, sobald nur eine Einheit lebt (alle tot = Unentschieden). Nur Vorauswahl;
    // Archenemy ausgenommen.
    effect(
      () => {
        if (this.phase() !== 'ingame' || this.mode() === 'Archenemy') return;
        const units = this.ingameUnits();
        if (units.length < 2) return;
        const alive = units.filter((u) => !this.isDead(u.key));
        if (alive.length === 1) {
          this.winner.set(alive[0].key);
        } else if (alive.length === 0) {
          this.winner.set(this.DRAW);
        }
      },
      { allowSignalWrites: true }
    );

    // Push: synchronisierbaren Zustand gebündelt (400 ms) in live_game_sessions schreiben, solange
    // liveSessionId gesetzt ist; die Signatur verhindert das Zurückschicken empfangener Stände.
    effect(() => {
      const snapshot = this.syncSnapshot();
      const sessionId = this.liveSessionId();
      if (!sessionId) return;

      const signature = stableStringify(snapshot);
      if (signature === this.lastSyncedSignature) return;

      if (this.pushDebounceTimer) clearTimeout(this.pushDebounceTimer);
      this.pushDebounceTimer = setTimeout(() => {
        this.pushDebounceTimer = null;
        this.lastSyncedSignature = signature;
        supabase
          .from('live_game_sessions')
          .update({ state: snapshot, updated_by_client: CLIENT_ID, updated_at: new Date().toISOString() })
          .eq('id', sessionId)
          .then(({ error }) => {
            if (error) console.error('Konnte Live-Spielstand nicht synchronisieren:', error);
          });
      }, 400);
    });

    // Übersicht "laufende Spiele der Gruppe" (für die Beitreten-Liste im Match-Tab) - initial laden
    // und per Realtime aktuell halten, sobald sich die aktive Gruppe ändert.
    effect(() => {
      const groupId = this.groupService.groupId();
      if (this.groupSessionsChannel) {
        supabase.removeChannel(this.groupSessionsChannel);
        this.groupSessionsChannel = null;
      }
      if (!groupId) {
        this.groupLiveSessions.set([]);
        return;
      }
      this.refreshGroupLiveSessions(groupId);
      this.groupSessionsChannel = supabase
        .channel(`live_game_sessions_group:${groupId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'live_game_sessions', filter: `group_id=eq.${groupId}` },
          () => this.refreshGroupLiveSessions(groupId)
        )
        .subscribe();
    });
  }

  private async refreshGroupLiveSessions(groupId: string): Promise<void> {
    const { data, error } = await supabase
      .from('live_game_sessions')
      .select('id, state, tournament_match_id')
      .eq('group_id', groupId);
    if (error) {
      console.error('Konnte laufende Spiele der Gruppe nicht laden:', error);
      return;
    }
    this.groupLiveSessions.set(
      (data ?? []).map((row) => {
        const state = row.state as LiveSessionState;
        return {
          id: row.id,
          mode: state.mode,
          format: state.format ?? null,
          playerNames: state.selectedPlayers.map((p) => p.name),
          tournamentMatchId: row.tournament_match_id ?? null,
        };
      })
    );
  }

  private unsubscribeLiveSession(): void {
    if (this.realtimeChannel) {
      supabase.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
  }

  private subscribeLiveSession(sessionId: string): void {
    this.unsubscribeLiveSession();
    this.realtimeChannel = supabase
      .channel(`live_game_session:${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'live_game_sessions', filter: `id=eq.${sessionId}` },
        (payload) => {
          // Verspätete Events eines verlassenen Channels ignorieren (sessionId vom Erzeugen).
          if (this.liveSessionId() !== sessionId) return;
          const row = payload.new as { state: LiveSessionState; updated_by_client: string };
          if (row.updated_by_client === CLIENT_ID) return; // eigenes Echo, nicht nochmal übernehmen
          this.applySyncSnapshot(row.state);
        }
      )
      .on(
        // Die andere Seite hat gespeichert/verworfen - ohne das hinge ein beigetretenes Gerät im
        // Tracker fest.
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'live_game_sessions', filter: `id=eq.${sessionId}` },
        async () => {
          if (this.liveSessionId() !== sessionId) return;

          // Erst bestätigen, dass die Zeile weg ist: bei schnellen Re-Subscribes kamen falsche
          // DELETE-Events (Beitritts-Loop).
          const { data } = await supabase.from('live_game_sessions').select('id').eq('id', sessionId).maybeSingle();
          if (data) {
            return;
          }
          if (this.liveSessionId() !== sessionId) return;

          this.handleRemoteSessionEnded();
        }
      )
      .subscribe();
  }

  /** Reagiert darauf, dass die eigene Live-Session von einem ANDEREN Gerät beendet wurde (dort gespeichert/verworfen) - schließt hier lokal genauso ab, ohne die (schon gelöschte) Zeile nochmal selbst zu löschen. */
  private handleRemoteSessionEnded(): void {
    const tournamentMatchId = this.activeTournamentMatchId();
    this.unsubscribeLiveSession();
    this.liveSessionId.set(null);
    this.lastSyncedSignature = null;
    this.resetLocalState();
    this.remoteSessionEnded.set({ tournamentMatchId });
  }

  private applySyncSnapshot(state: LiveSessionState): void {
    this.mode.set(state.mode);
    this.isRanked.set(state.isRanked ?? true);
    // Fallback für Sessions von vor diesem Feature (state.format fehlt dann im JSONB-Stand).
    this.format.set(state.format ?? (state.mode === 'Spezialevent' ? null : 'Commander'));
    this.selectedPlayers.set(state.selectedPlayers);
    this.selectedCubeId.set(state.selectedCubeId);
    this.selectedDraftSet.set(state.selectedDraftSet);
    this.lifeTotals.set(state.lifeTotals);
    this.commanderDamage.set(state.commanderDamage);
    this.poisonCounters.set(state.poisonCounters);
    this.poisonView.set(state.poisonView);
    this.deadPlayers.set(state.deadPlayers);
    this.deadMessageMap.set(state.deadMessageMap);
    this.commanderDamageFocus.set(state.commanderDamageFocus);
    this.manualOrder.set(state.manualOrder);
    this.pinnedBottomKey.set(state.pinnedBottomKey);
    this.winner.set(state.winner);
    this.startedAt.set(state.startedAt ?? null);
    this.startingPlayerKey.set(state.startingPlayerKey ?? null);
    this.lifeLogUnits.set(state.lifeLogUnits ?? []);
    this.lifeLogStart.set(state.lifeLogStart ?? 0);
    this.lifeLog.set(state.lifeLog ?? []);
    this.lastSyncedSignature = stableStringify(state);
  }

  /**
   * Legt die eigene live_game_sessions-Zeile an (fire-and-forget). liveSessionId erst nach
   * erfolgreichem Insert setzen, sonst UPDATE auf eine noch fehlende Zeile.
   */
  private beginLiveSession(): void {
    const groupId = this.groupService.groupId();
    const userId = this.auth.currentUser()?.id;
    if (!groupId || !userId) return;

    const id = crypto.randomUUID();
    const initialState = this.syncSnapshot();

    (async () => {
      // Keine alten eigenen Zeilen löschen - zwei Geräte mit demselben Account würden sich sonst
      // gegenseitig die Session nehmen.
      const { error } = await supabase.from('live_game_sessions').insert({
        id,
        group_id: groupId,
        tournament_match_id: this.activeTournamentMatchId(),
        created_by: userId,
        state: initialState,
        updated_by_client: CLIENT_ID,
      });
      if (error) {
        console.error('Konnte Live-Session nicht anlegen:', error);
        return;
      }
      this.lastSyncedSignature = stableStringify(initialState);
      this.liveSessionId.set(id);
      this.subscribeLiveSession(id);
    })();
  }

  private readonly joinLiveSessionCallLog: number[] = [];
  private joinLiveSessionNotbremseLoggedAt = 0;

  /** Tritt einer laufenden Live-Session bei (Turnier-Tisch oder "Laufende Spiele"). */
  async joinLiveSession(sessionId: string): Promise<void> {
    // Bremse gegen wiederholte/parallele Aufrufe (sonst Beitritts-Loop über Effects) - als Erstes
    // und ohne Logging.
    if (this.liveSessionId() === sessionId) return;

    // Notbremse: falls trotz allem ein Loop entsteht, wenigstens die Datenbank nicht fluten - und
    // nach dem ersten Auslösen für 5s komplett stumm bleiben, statt die Konsole weiter zuzuspammen.
    const now = Date.now();
    while (this.joinLiveSessionCallLog.length > 0 && now - this.joinLiveSessionCallLog[0] > 2000) {
      this.joinLiveSessionCallLog.shift();
    }
    this.joinLiveSessionCallLog.push(now);
    if (this.joinLiveSessionCallLog.length > 5) {
      if (now - this.joinLiveSessionNotbremseLoggedAt > 5000) {
        console.error('[live-sync] NOTBREMSE: joinLiveSession wurde >5x in 2s aufgerufen - breche für 5s ab.');
        this.joinLiveSessionNotbremseLoggedAt = now;
      }
      return;
    }

    const { data, error } = await supabase
      .from('live_game_sessions')
      .select('state')
      .eq('id', sessionId)
      .maybeSingle();
    if (error || !data) {
      console.error('Konnte laufendes Spiel nicht laden:', error);
      return;
    }
    this.applySyncSnapshot(data.state as LiveSessionState);
    this.liveSessionId.set(sessionId);
    this.minimized.set(false);
    this.phase.set('ingame');
    this.subscribeLiveSession(sessionId);
  }

  /** Beendet die eigene Live-Session (Speichern oder Verwerfen) - löscht die geteilte Zeile für alle Beteiligten. */
  private endLiveSession(): void {
    const id = this.liveSessionId();
    this.unsubscribeLiveSession();
    this.liveSessionId.set(null);
    this.lastSyncedSignature = null;
    if (id) {
      supabase
        .from('live_game_sessions')
        .delete()
        .eq('id', id)
        .then(({ error }) => {
          if (error) console.error('Konnte Live-Session nicht löschen:', error);
        });
    }
  }

  /** Alle Commander/Partner-Commander der Mitglieder einer Panel-Einheit als eigene Schadensquellen. */
  panelRotation(index: number): number {
    const cols = this.ingameColumns();

    if (this.hasOddBottomSlot() && index === this.ingameUnits().length - 1) {
      return 0;
    }

    if (cols === 1) {
      return index % 2 === 0 ? 180 : 0;
    }
    const col = index % cols;
    return col === 0 ? 90 : -90;
  }

  /** Alle Commander/Partner-Commander der Mitglieder einer Panel-Einheit als eigene Schadensquellen. */
  commandersOf(unit: IngameUnit): DamageSource[] {
    const sources: DamageSource[] = [];
    for (const m of unit.members) {
      if (m.commander) sources.push({ key: `${m.name}::main`, label: m.commander });
      if (m.partnerCommander)
        sources.push({ key: `${m.name}::partner`, label: m.partnerCommander });
    }
    if (sources.length === 0) sources.push({ key: `${unit.key}::main`, label: unit.label });
    return sources;
  }

  commanderDamageValue(target: string, sourceKey: string): number {
    return this.commanderDamage()[target]?.[sourceKey] ?? 0;
  }

  adjustLife(key: string, delta: number): void {
    this.lifeTotals.update((totals) => ({ ...totals, [key]: (totals[key] ?? 0) + delta }));
    this.logLifeChange(key, delta, false);
  }

  adjustCommanderDamage(target: string, sourceKey: string, delta: number): void {
    const current = this.commanderDamageValue(target, sourceKey);
    const next = Math.max(0, current + delta);
    const actualDelta = next - current;
    if (actualDelta === 0) return;

    this.commanderDamage.update((all) => ({
      ...all,
      [target]: { ...(all[target] ?? {}), [sourceKey]: next },
    }));
    // Commander-Schaden ist zugleich normaler Lebenspunktverlust -> Leben sinkt, wenn Schaden steigt.
    this.adjustLife(target, -actualDelta);
  }

  poisonValue(key: string): number {
    return this.poisonCounters()[key] ?? 0;
  }

  adjustPoison(key: string, delta: number): void {
    const current = this.poisonValue(key);
    const next = Math.max(0, current + delta);
    this.poisonCounters.update((totals) => ({ ...totals, [key]: next }));
    this.logLifeChange(key, next - current, true);
  }

  // --- Gepuffertes Tippen: Leben/Gift/Commander-Schaden sammeln ein sichtbares Delta ("-6") und
  // werden nach kurzer Pause verrechnet - erspart Kopfrechnen. ---

  private static readonly PENDING_COMMIT_DELAY_MS = 700;
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Panel-Key -> noch nicht verrechnetes Lebens-Delta. */
  readonly pendingLifeDelta = signal<Record<string, number>>({});
  /** Panel-Key -> noch nicht verrechnetes Gift-Delta. */
  readonly pendingPoisonDelta = signal<Record<string, number>>({});
  /** "target::sourceKey" -> noch nicht verrechnetes Commander-Schaden-Delta. */
  readonly pendingCommanderDamageDelta = signal<Record<string, number>>({});

  private bufferChange(
    pendingSignal: WritableSignal<Record<string, number>>,
    timerNamespace: string,
    key: string,
    delta: number,
    commit: (totalDelta: number) => void
  ): void {
    pendingSignal.update((map) => ({ ...map, [key]: (map[key] ?? 0) + delta }));

    const timerKey = `${timerNamespace}:${key}`;
    const existing = this.pendingTimers.get(timerKey);
    if (existing) clearTimeout(existing);

    this.pendingTimers.set(
      timerKey,
      setTimeout(() => {
        this.pendingTimers.delete(timerKey);
        const total = pendingSignal()[key] ?? 0;
        pendingSignal.update((map) => {
          const next = { ...map };
          delete next[key];
          return next;
        });
        if (total !== 0) commit(total);
      }, GameSessionService.PENDING_COMMIT_DELAY_MS)
    );
  }

  bufferLifeChange(key: string, delta: number): void {
    this.bufferChange(this.pendingLifeDelta, 'life', key, delta, (total) =>
      this.adjustLife(key, total)
    );
  }

  bufferPoisonChange(key: string, delta: number): void {
    this.bufferChange(this.pendingPoisonDelta, 'poison', key, delta, (total) =>
      this.adjustPoison(key, total)
    );
  }

  bufferCommanderDamageChange(target: string, sourceKey: string, delta: number): void {
    const key = `${target}::${sourceKey}`;
    this.bufferChange(this.pendingCommanderDamageDelta, 'cd', key, delta, (total) =>
      this.adjustCommanderDamage(target, sourceKey, total)
    );
  }

  isPoisonView(key: string): boolean {
    return this.poisonView()[key] ?? false;
  }

  /** Eigenes Panel: schaltet nur lokal zwischen Leben- und Gift-Anzeige um. */
  togglePoisonView(key: string): void {
    this.poisonView.update((views) => ({ ...views, [key]: !(views[key] ?? false) }));
  }

  /** Eigenes Panel: startet den globalen "Schaden gegen mich"-Modus für alle Panels. */
  startCommanderDamageFocus(key: string): void {
    this.commanderDamageFocus.set(key);
  }

  /** Beendet den Fokus-Modus, alle Panels kehren zu ihrer normalen Leben/Gift-Ansicht zurück. */
  exitCommanderDamageFocus(): void {
    this.commanderDamageFocus.set(null);
  }

  /** Aus dem Fokus-Modus heraus direkt zur eigenen Gift-Ansicht wechseln. */
  goToPoisonFromFocus(key: string): void {
    this.poisonView.update((views) => ({ ...views, [key]: true }));
    this.commanderDamageFocus.set(null);
  }

  private defaultStartingLife(): number {
    const mode = this.mode();
    if (mode === 'Two-Headed Giant') return 60;
    if (mode === 'Cube') {
      const cube = this.mtg.cubes().find((c) => c.id === this.selectedCubeId());
      return cube?.isCommander ? 40 : 20;
    }
    if (mode === 'Draft') {
      return this.selectedDraftSet()?.set_type === 'commander' ? 40 : 20;
    }
    return 40;
  }

  startGame(): void {
    if (!this.canStartGame()) return;

    // Archenemy landet standardmäßig im Sonderslot unten, solange der Nutzer
    // noch nichts anderes per Longpress festgelegt hat.
    if (this.mode() === 'Archenemy' && this.pinnedBottomKey() === null) {
      const archenemy = this.selectedPlayers().find((p) => p.isArchenemy);
      if (archenemy) this.pinnedBottomKey.set(archenemy.name);
    }

    const startLife = this.defaultStartingLife();
    const totals: Record<string, number> = {};
    const damage: Record<string, Record<string, number>> = {};
    const poison: Record<string, number> = {};
    const poisonViews: Record<string, boolean> = {};
    for (const unit of this.ingameUnits()) {
      totals[unit.key] = startLife;
      damage[unit.key] = {};
      poison[unit.key] = 0;
      poisonViews[unit.key] = false;
    }
    this.lifeTotals.set(totals);
    this.commanderDamage.set(damage);
    this.poisonCounters.set(poison);
    this.poisonView.set(poisonViews);
    this.startedAt.set(new Date().toISOString());
    this.startingPlayerKey.set(null);
    this.lifeLogUnits.set(Object.keys(totals));
    this.lifeLogStart.set(startLife);
    this.lifeLog.set([]);
    this.commanderDamageFocus.set(null);
    this.deadPlayers.set({});
    this.showWinnerPanel.set(false);
    this.winner.set(null);
    this.minimized.set(false);
    this.phase.set('ingame');

    this.beginLiveSession();
  }

  minimizeGame(): void {
    this.minimized.set(true);
  }

  reopenGame(): void {
    this.minimized.set(false);
  }

  /** Während saveAndReset() läuft (verhindert doppeltes Anlegen bei Doppel-Tipp auf "Speichern"). */
  readonly saving = signal(false);

  /** Speichert das Match und setzt die komplette Session zurück. Setzt voraus, dass canSave() bereits geprüft wurde. */
  async saveAndReset(): Promise<void> {
    const winner = this.winner();
    if (!winner || !this.canSave() || this.saving()) return;

    this.saving.set(true);
    try {
      const cube = this.mtg.cubes().find((c) => c.id === this.selectedCubeId());
      const draftSet = this.selectedDraftSet();
      // Platz in der Zugreihenfolge je Spieler - bei 2HG teilen sich die Teammitglieder ihn.
      const turnOrder = this.turnOrderByUnit();
      const players = this.selectedPlayers().map((p) => {
        const order = turnOrder[this.isTwoHeadedGiantMode() ? (p.team ?? '') : p.name];
        return order ? { ...p, turnOrder: order } : p;
      });
      const tournamentMatchId = this.activeTournamentMatchId() ?? undefined;

      const matchId = await this.mtg.addMatch({
        mode: this.mode(),
        format: this.format(),
        players,
        winner,
        cube: cube ? { id: cube.id, name: cube.name, isCommander: cube.isCommander } : undefined,
        draftSet:
          this.mode() === 'Draft' && draftSet
            ? {
                id: draftSet.id,
                code: draftSet.code,
                name: draftSet.name,
                releasedAt: draftSet.releasedAt,
              }
            : undefined,
        tournamentMatchId,
        countsInGeneralStats: this.activeTournamentCountsInStats(),
        isRanked: this.isRanked(),
        startedAt: this.startedAt() ?? undefined,
        lifeLog: this.buildLifeLog(),
      });

      if (matchId) {
        this.lastFinishedMatch.set({ matchId, players, winner, tournamentMatchId });
      }

      this.resetAll();
      this.deadMessageMap.set({});
    } finally {
      this.saving.set(false);
    }
  }

  /** Verwirft die Session ohne zu speichern. */
  discardAndReset(): void {
    this.resetAll();
  }

  private resetAll(): void {
    this.endLiveSession();
    this.resetLocalState();
  }

  /** Setzt alle lokalen Session-Signale zurück, ohne die geteilte live_game_sessions-Zeile anzufassen - für den Fall, dass die Zeile bereits woanders gelöscht wurde (siehe handleRemoteSessionEnded). */
  private resetLocalState(): void {
    this.phase.set('setup');
    this.showWinnerPanel.set(false);
    this.minimized.set(false);
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.pendingTimers.clear();
    this.pendingLifeDelta.set({});
    this.pendingPoisonDelta.set({});
    this.pendingCommanderDamageDelta.set({});
    this.lifeTotals.set({});
    this.commanderDamage.set({});
    this.poisonCounters.set({});
    this.poisonView.set({});
    this.commanderDamageFocus.set(null);
    this.deadPlayers.set({});
    this.selectedPlayers.set([]);
    this.winner.set(null);
    this.selectedCubeId.set(null);
    this.selectedDraftSet.set(null);
    this.mode.set('Normal');
    this.format.set('Commander');
    this.isRanked.set(true);
    this.pinnedBottomKey.set(null);
    this.pinnedBottomKey.set(null);
    this.manualOrder.set(null);
    this.activeTournamentMatchId.set(null);
    this.activeTournamentCountsInStats.set(true);
    this.startedAt.set(null);
    this.startingPlayerKey.set(null);
    this.lifeLogUnits.set([]);
    this.lifeLogStart.set(0);
    this.lifeLog.set([]);
  }

  // --- Setup-Mutationen (Spieler, Commander, Team, Archenemy) ---

  togglePlayer(name: string): void {
    const current = this.selectedPlayers();
    if (current.some((p) => p.name === name)) {
      this.selectedPlayers.set(current.filter((p) => p.name !== name));
      if (this.winner() === name) this.winner.set(null);
    } else {
      this.selectedPlayers.set([...current, { name }]);
    }
  }

  isSelected(name: string): boolean {
    return this.selectedPlayers().some((p) => p.name === name);
  }

  assignCommander(playerName: string, commander: string): void {
    this.selectedPlayers.update((players) =>
      players.map((p) => (p.name === playerName ? { ...p, commander, deckId: undefined } : p))
    );
  }

  /** Weist ein importiertes Deck zu - übernimmt dessen Commander (+Partner) und merkt sich die Deck-ID fürs Tracking. */
  assignDeck(playerName: string, deckId: string, commander: string, partnerCommander?: string): void {
    this.selectedPlayers.update((players) =>
      players.map((p) => (p.name === playerName ? { ...p, commander, partnerCommander, deckId } : p))
    );
  }

  clearCommander(playerName: string): void {
    this.selectedPlayers.update((players) =>
      players.map((p) =>
        p.name === playerName
          ? { ...p, commander: undefined, partnerCommander: undefined, deckId: undefined }
          : p
      )
    );
  }

  assignPartnerCommander(playerName: string, commander: string): void {
    this.selectedPlayers.update((players) =>
      players.map((p) => (p.name === playerName ? { ...p, partnerCommander: commander } : p))
    );
  }

  clearPartnerCommander(playerName: string): void {
    this.selectedPlayers.update((players) =>
      players.map((p) => (p.name === playerName ? { ...p, partnerCommander: undefined } : p))
    );
  }

  setPlayerTeam(playerName: string, team: string): void {
    const normalizedTeam = TEAM_OPTIONS.includes(team as TeamName) ? (team as TeamName) : undefined;
    this.selectedPlayers.update((players) =>
      players.map((p) => (p.name === playerName ? { ...p, team: normalizedTeam } : p))
    );
  }

  toggleArchenemy(playerName: string): void {
    this.selectedPlayers.update((players) =>
      players.map((p) => ({
        ...p,
        isArchenemy: p.name === playerName ? !(p.isArchenemy ?? false) : false,
      }))
    );
    const w = this.winner();
    if (w && w !== this.OTHERS && !this.selectedPlayers().some((p) => p.name === w)) {
      this.winner.set(null);
    }
  }

  selectDraftSet(
    set: { id: string; code?: string; name: string; released_at?: string; set_type?: string } | null
  ): void {
    if (!set) {
      this.selectedDraftSet.set(null);
      return;
    }
    this.selectedDraftSet.set({
      id: set.id,
      code: set.code,
      name: set.name,
      releasedAt: set.released_at,
      set_type: set.set_type,
    });
  }
}
