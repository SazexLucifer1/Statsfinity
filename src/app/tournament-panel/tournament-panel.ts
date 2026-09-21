import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TournamentService } from '../tournament.service';
import { GameSessionService, SelectedDraftSet } from '../game-session.service';
import { MtgService } from '../mtg.service';
import { GroupService } from '../group.service';
import { ScryfallService, ScryfallSet } from '../scryfall.service';
import { I18nService } from '../i18n.service';
import { DialogService } from '../dialog.service';
import { TournamentMatch, TableSize } from '../tournament.models';
import { GAME_MODES, GameMode, DeckFormat, DECK_FORMATS } from '../models';
import { Icon } from '../ui/icon/icon';

/** Two-Headed Giant ist teambasiert und passt nicht zu individuellem Swiss-Ranking - daher hier ausgeschlossen. */
const TOURNAMENT_GAME_MODES: GameMode[] = GAME_MODES.filter((m) => m !== 'Two-Headed Giant');

/**
 * Globales Overlay für die Turnier-Ebene (Erstellung, Beitreten, laufende Runde mit Timer,
 * Standings) - gemountet in app.html, gleiches Muster wie IngameTracker/PlacementDialog.
 * Die eigentlichen Einzelspiele laufen weiterhin über den unveränderten IngameTracker (unterstützt
 * sowohl 1v1 als auch Mehrspieler-Pods nativ); dieses Panel schließt sich beim Start eines Spiels
 * selbst (siehe TournamentService.startGameForMatch).
 */
@Component({
  selector: 'app-tournament-panel',
  imports: [FormsModule, Icon],
  templateUrl: './tournament-panel.html',
  styleUrl: './tournament-panel.scss',
})
export class TournamentPanel {
  readonly tournament = inject(TournamentService);
  readonly session = inject(GameSessionService);
  readonly mtg = inject(MtgService);
  private readonly groupService = inject(GroupService);
  private readonly scryfall = inject(ScryfallService);
  private readonly dialog = inject(DialogService);
  readonly i18n = inject(I18nService);

  readonly gameModes = TOURNAMENT_GAME_MODES;
  readonly formats = DECK_FORMATS;

  // --- Erstellungs-Wizard ---
  readonly newName = signal('');
  readonly selectedGameMode = signal<GameMode>('Normal');
  readonly selectedGameFormat = signal<DeckFormat | null>('Commander');
  readonly selectedTableSize = signal<TableSize>(2);
  readonly roundCountMode = signal<'auto' | 'manual'>('auto');
  readonly manualRoundCount = signal<number>(4);
  readonly selectedPlayerNames = signal<Set<string>>(new Set());
  readonly creating = signal(false);

  /** Ob die Matches dieses Turniers zusätzlich in die allgemeine Statistik einfließen sollen (Default: ja, wie bisher). */
  readonly countInGeneralStats = signal(true);

  // --- Wizard: Cube (nur bei Modus 'Cube') - gemeinsamer Cube fürs ganze Turnier, gleiches Muster wie match-tab.ts ---
  readonly wizardCubeId = signal<string | null>(null);
  readonly newCubeName = signal('');
  readonly newCubeIsCommander = signal(false);

  async addNewCube(): Promise<void> {
    const name = this.newCubeName().trim();
    if (!name) return;
    const created = await this.mtg.addCube(name, this.newCubeIsCommander());
    if (created) {
      this.wizardCubeId.set(created.id);
      this.newCubeName.set('');
      this.newCubeIsCommander.set(false);
    }
  }

  async deleteCube(id: string, name: string): Promise<void> {
    if (await this.dialog.confirm(this.i18n.t('match.msg.confirmDeleteCube', { name }))) {
      if (this.wizardCubeId() === id) this.wizardCubeId.set(null);
      await this.mtg.deleteCube(id);
    }
  }

  // --- Wizard: Draft-Set (nur bei Modus 'Draft') - gemeinsames Set fürs ganze Turnier, gleiches Muster wie match-tab.ts ---
  readonly wizardDraftSet = signal<SelectedDraftSet | null>(null);
  readonly draftSearchQuery = signal('');
  readonly draftSuggestions = signal<ScryfallSet[]>([]);
  readonly draftYear = signal<number | null>(null);
  private draftTimer: ReturnType<typeof setTimeout> | null = null;

  onDraftSearchInput(value: string): void {
    this.draftSearchQuery.set(value);
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.updateDraftSuggestions(), 250);
  }

  async filterDraftsByYear(yearParam: string | number | null): Promise<void> {
    const year = yearParam === null || yearParam === '' ? null : Number(yearParam);
    if (yearParam !== null && yearParam !== '' && Number.isNaN(year)) return;
    this.draftYear.set(year);
    await this.updateDraftSuggestions();
  }

  private async updateDraftSuggestions(): Promise<void> {
    const query = this.draftSearchQuery().trim();
    const year = this.draftYear();
    if (!query && year === null) {
      this.draftSuggestions.set([]);
      return;
    }
    this.draftSuggestions.set(await this.scryfall.searchSets(query, year));
  }

  selectDraftSet(set: ScryfallSet | null): void {
    if (!set) {
      this.wizardDraftSet.set(null);
      return;
    }
    this.wizardDraftSet.set({
      id: set.id,
      code: set.code,
      name: set.name,
      releasedAt: set.released_at,
      set_type: set.set_type,
    });
  }

  // --- "Sieger festlegen"-Auswahl pro Tisch ---
  readonly winnerPickerFor = signal<string | null>(null);
  /** Bei bereits entschiedenen BO3-Tischen: die Einzelspiele, um gezielt eins davon zu korrigieren statt nur den Gesamt-Sieger zu überschreiben. */
  readonly gamesForCorrection = signal<{ id: string; gameNumber: number; winnerName: string }[]>([]);

  // --- Beitritt per Einladungscode ---
  readonly joinCode = signal('');
  readonly joining = signal(false);
  readonly joinMessage = signal('');

  /** Zusätzlich zum Turnier-Code angezeigt - wer noch nicht Gruppenmitglied ist, braucht zuerst diesen. */
  readonly groupInviteCode = signal<string | null>(null);

  /** Endstand-Bildschirm nach "Turnier beenden" - abgeleitet aus dem geladenen Status, damit ihn jedes Gerät sieht (nicht nur das, das auf "Turnier beenden" geklickt hat). */
  readonly showingResults = computed(() => this.tournament.activeTournament()?.status === 'completed');

  constructor() {
    // Lädt den (dauerhaften, idempotenten) Gruppen-Einladungscode nach, sobald die veranstaltende
    // Person den Setup-Screen sieht - damit sie Gruppen- und Turnier-Code zusammen teilen kann.
    effect(() => {
      const t = this.tournament.activeTournament();
      const groupId = this.groupService.groupId();
      if (!t || t.status !== 'setup' || !this.tournament.isOrganizer() || !groupId) return;
      this.groupService.createInvite(groupId).then((code) => this.groupInviteCode.set(code));
    });
  }

  togglePlayerSelection(name: string): void {
    this.selectedPlayerNames.update((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  setManualRoundCount(value: string | number): void {
    this.manualRoundCount.set(Math.max(1, Number(value) || 1));
  }

  /** Setzt die Turnier-Kategorie und hält das Format konsistent - analog GameSessionService.setMode(). */
  setSelectedGameMode(mode: GameMode): void {
    this.selectedGameMode.set(mode);
    if (mode === 'Spezialevent') {
      this.selectedGameFormat.set(null);
    } else if (this.selectedGameFormat() === null) {
      this.selectedGameFormat.set('Commander');
    }
  }

  async createTournament(): Promise<void> {
    const groupId = this.groupService.groupId();
    if (!groupId || this.creating()) return;

    this.creating.set(true);
    const id = await this.tournament.createTournament(
      groupId,
      this.newName(),
      this.selectedGameMode(),
      this.selectedGameFormat(),
      this.selectedTableSize(),
      this.roundCountMode(),
      this.roundCountMode() === 'manual' ? this.manualRoundCount() : null,
      [...this.selectedPlayerNames()],
      this.wizardDraftSet(),
      this.wizardCubeId(),
      this.countInGeneralStats()
    );
    this.creating.set(false);

    if (id) {
      this.newName.set('');
      this.selectedPlayerNames.set(new Set());
      this.wizardDraftSet.set(null);
      this.wizardCubeId.set(null);
      this.countInGeneralStats.set(true);
      this.draftSearchQuery.set('');
      this.draftSuggestions.set([]);
      this.draftYear.set(null);
    }
  }

  async confirmJoin(): Promise<void> {
    const t = this.tournament.activeTournament();
    if (t) await this.tournament.confirmJoin(t.id);
  }

  async redeemCode(): Promise<void> {
    if (this.joining()) return;
    this.joining.set(true);
    const result = await this.tournament.joinByCode(this.joinCode());
    this.joining.set(false);
    this.joinMessage.set(this.i18n.t(result.messageKey, result.params));
    if (result.success) this.joinCode.set('');
  }

  async startTournament(): Promise<void> {
    const t = this.tournament.activeTournament();
    if (!t) return;

    const joinedCount = this.tournament.participants().filter((p) => p.status === 'joined').length;
    if (joinedCount < 2) {
      await this.dialog.alert(this.i18n.t('tournament.notEnoughJoined'));
      return;
    }

    const pending = this.tournament.pendingParticipants();
    if (pending.length > 0) {
      const names = pending.map((p) => p.playerName).join(', ');
      if (!(await this.dialog.confirm(this.i18n.t('tournament.confirmStartWithPending', { names })))) return;
    }
    await this.tournament.startTournament(t.id);
  }

  async startNextRound(): Promise<void> {
    const t = this.tournament.activeTournament();
    if (!t) return;

    if (!this.tournament.canAdvanceRound()) {
      if (!(await this.dialog.confirm(this.i18n.t('tournament.confirmForceNextRound')))) return;
    }
    await this.tournament.startNextRound(t.id);
  }

  async cancelTournament(): Promise<void> {
    const t = this.tournament.activeTournament();
    if (!t) return;
    if (!(await this.dialog.confirm(this.i18n.t('tournament.confirmCancel')))) return;
    await this.tournament.cancelTournament(t.id);
  }

  async endTournament(): Promise<void> {
    const t = this.tournament.activeTournament();
    if (!t) return;
    if (!this.tournament.canAdvanceRound()) {
      if (!(await this.dialog.confirm(this.i18n.t('tournament.confirmEndEarly')))) return;
    }

    // Standings bleiben nach dem Beenden weiter geladen (status='completed' zählt jetzt auch als
    // ladbar, siehe loadForGroup) - kein Schnappschuss mehr nötig, jedes Gerät berechnet sie live.
    await this.tournament.endTournament(t.id);
  }

  async closeFinalResults(): Promise<void> {
    const t = this.tournament.activeTournament();
    if (t) await this.tournament.dismissResults(t.id);
    this.close();
  }

  async startMyGame(): Promise<void> {
    const match = this.tournament.myCurrentMatch();
    if (match) await this.tournament.startGameForMatch(match);
  }

  async startGameFor(match: TournamentMatch): Promise<void> {
    await this.tournament.startGameForMatch(match);
  }

  /** Namen aller anderen Tisch-Teilnehmenden außer mir selbst, kommagetrennt (für "Dein Match": "gegen A, B, C"). */
  othersLabelFor(match: TournamentMatch): string {
    const myName = this.mtg.myPlayerName();
    return match.participants
      .map((p) => p.playerName)
      .filter((name) => name !== myName)
      .join(', ');
  }

  /** Alle Teilnehmenden-Namen eines Tisches, kommagetrennt (für die Paarungsliste). */
  participantNamesFor(match: TournamentMatch): string {
    return match.participants.map((p) => p.playerName).join(', ');
  }

  /** Rundet einen Quotienten (0..1) auf einen ganzzahligen Prozentwert für die Standings-Anzeige. */
  pct(value: number): number {
    return Math.round(value * 100);
  }

  /**
   * Organizer, Gruppen-Host oder eine der tatsächlich am Tisch spielenden Personen dürfen das Spiel
   * starten/den Sieger festlegen - so kann die veranstaltende Person das auch stellvertretend für
   * accountlose Personen tun. Der Gruppen-Host muss mit drin sein, weil die Datenbank-Policy ihn
   * ausdrücklich erlaubt (siehe security-fixes-2026-08-26.sql): ohne ihn sah ein Host, der das
   * Turnier nicht selbst angelegt hat, den Knopf gar nicht erst.
   */
  canManageMatch(match: TournamentMatch): boolean {
    const myName = this.mtg.myPlayerName();
    return (
      this.tournament.isOrganizer() ||
      this.groupService.isOwner() ||
      match.participants.some((p) => p.playerName === myName)
    );
  }

  winnerNameFor(match: TournamentMatch): string | null {
    if (!match.winnerPlayerId) return null;
    return match.participants.find((p) => p.playerId === match.winnerPlayerId)?.playerName ?? null;
  }

  /** Öffnet die Sieger-Auswahl - bei bereits entschiedenen BO3-Tischen werden stattdessen die Einzelspiele zum gezielten Korrigieren geladen. */
  async openWinnerPicker(match: TournamentMatch): Promise<void> {
    this.winnerPickerFor.set(match.id);
    if (match.participants.length === 2 && (match.winnerPlayerId || match.isDraw)) {
      this.gamesForCorrection.set(await this.tournament.fetchGamesFor(match.id));
    } else {
      this.gamesForCorrection.set([]);
    }
  }

  closeWinnerPicker(): void {
    this.winnerPickerFor.set(null);
    this.gamesForCorrection.set([]);
  }

  /**
   * Schließt die Sieger-Auswahl nur bei Erfolg. Vorher wurde der Rückgabewert weggeworfen und der
   * Dialog in jedem Fall geschlossen - ein fehlgeschlagenes Speichern sah deshalb exakt so aus wie
   * ein erfolgreiches, nämlich als würde gar nichts passieren.
   */
  private async applyWinnerChoice(action: Promise<boolean>): Promise<void> {
    if (await action) {
      this.closeWinnerPicker();
      return;
    }
    await this.dialog.alert(this.i18n.t('tournament.msg.saveFailed'));
  }

  async pickWinner(match: TournamentMatch, winnerPlayerId: string): Promise<void> {
    await this.applyWinnerChoice(
      match.winnerPlayerId
        ? this.tournament.correctWinner(match.id, winnerPlayerId)
        : this.tournament.setManualWinner(match.id, winnerPlayerId)
    );
  }

  /** Trägt einen BO3-Endstand direkt ein (2:0/2:1), ohne dass die Einzelspiele über den Ingame-Tracker gespielt wurden. */
  async pickScore(match: TournamentMatch, winnerPlayerId: string, loserWins: 0 | 1): Promise<void> {
    await this.applyWinnerChoice(this.tournament.setManualScore(match.id, winnerPlayerId, loserWins));
  }

  async pickDraw(matchId: string): Promise<void> {
    await this.applyWinnerChoice(this.tournament.setManualDraw(matchId));
  }

  /** Korrigiert, wer ein einzelnes bereits gespeichertes Spiel innerhalb eines BO3-Tisches gewonnen hat - lädt die Liste danach neu, damit man bei Bedarf gleich noch ein weiteres Spiel korrigieren kann. */
  async correctGame(tournamentMatchId: string, gameRowId: string, newWinnerName: string): Promise<void> {
    const ok = await this.tournament.correctGameWinner(tournamentMatchId, gameRowId, newWinnerName);
    this.gamesForCorrection.set(await this.tournament.fetchGamesFor(tournamentMatchId));
    if (!ok) await this.dialog.alert(this.i18n.t('tournament.msg.saveFailed'));
  }

  close(): void {
    this.tournament.closePanel();
  }
}
