import { Component, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TournamentService } from '../tournament.service';
import { GroupService } from '../group.service';
import { I18nService } from '../i18n.service';
import { DialogService } from '../dialog.service';
import { StandingsRow, Tournament, TournamentMatch } from '../tournament.models';
import { gameModeLabel } from '../match-utils';
import { Meter } from '../ui/meter/meter';
import { Icon } from '../ui/icon/icon';

/**
 * Historie abgeschlossener (und laufender) Turniere einer Gruppe - eigener Nav-Tab, getrennt vom
 * "Live"-Turnier-Panel (tournament-panel/), damit man alte Turniere ansehen kann, ohne den
 * aktuell laufenden Turnier-Zustand zu beeinflussen. Zeigt zusätzlich eine Gesamtrangliste über
 * alle abgeschlossenen Turniere der Gruppe hinweg.
 */
@Component({
  selector: 'app-tournament-history',
  imports: [DatePipe, Meter, Icon],
  templateUrl: './tournament-history.html',
  styleUrl: './tournament-history.scss',
})
export class TournamentHistory {
  private readonly tournament = inject(TournamentService);
  readonly groupService = inject(GroupService);
  readonly i18n = inject(I18nService);
  private readonly dialog = inject(DialogService);

  readonly tournaments = this.tournament.tournamentHistory;
  readonly aggregateStandings = this.tournament.aggregateStandings;

  readonly selectedTournament = signal<Tournament | null>(null);
  readonly selectedStandings = signal<StandingsRow[]>([]);
  readonly selectedMatches = signal<TournamentMatch[]>([]);
  readonly loadingDetail = signal(false);
  readonly showStandingsInfo = signal(false);

  toggleStandingsInfo(): void {
    this.showStandingsInfo.update((v) => !v);
  }

  constructor() {
    effect(() => {
      const groupId = this.groupService.groupId();
      if (!groupId) return;
      this.tournament.loadTournamentHistory(groupId);
      this.tournament.loadAggregateStandings(groupId);
    });
  }

  async openTournament(t: Tournament): Promise<void> {
    this.selectedTournament.set(t);
    this.loadingDetail.set(true);
    const detail = await this.tournament.loadTournamentDetail(t.id, t.tableSize);
    this.selectedStandings.set(detail.standings);
    this.selectedMatches.set(detail.matches);
    this.loadingDetail.set(false);
  }

  closeTournament(): void {
    this.selectedTournament.set(null);
    this.selectedStandings.set([]);
    this.selectedMatches.set([]);
    this.showStandingsInfo.set(false);
  }

  modeLabel(t: Tournament): string {
    return gameModeLabel(t.gameMode, t.gameFormat);
  }

  participantNamesFor(match: TournamentMatch): string {
    return match.participants.map((p) => p.playerName).join(', ');
  }

  /** Rundet einen Quotienten (0..1) auf einen ganzzahligen Prozentwert für die Standings-Anzeige. */
  pct(value: number): number {
    return Math.round(value * 100);
  }

  winnerNameFor(match: TournamentMatch): string | null {
    if (!match.winnerPlayerId) return null;
    return match.participants.find((p) => p.playerId === match.winnerPlayerId)?.playerName ?? null;
  }

  readonly deletingTournamentId = signal<string | null>(null);

  /** Löscht gezielt EIN Turnier samt seiner Einzelspiele (host-only, siehe TournamentService.deleteTournament). */
  async deleteTournament(t: Tournament, event: Event): Promise<void> {
    event.stopPropagation();
    const groupId = this.groupService.groupId();
    if (!groupId || this.deletingTournamentId()) return;
    if (!(await this.dialog.confirm(this.i18n.t('tournamentHistory.confirmDelete', { name: t.name })))) return;

    this.deletingTournamentId.set(t.id);
    const result = await this.tournament.deleteTournament(t.id, groupId);
    this.deletingTournamentId.set(null);

    if (!result.success) {
      await this.dialog.alert(this.i18n.t('tournamentHistory.deleteFailed'));
      return;
    }
    if (this.selectedTournament()?.id === t.id) this.closeTournament();
  }

  readonly togglingCountsId = signal<string | null>(null);

  /**
   * Schaltet nachträglich um, ob die Einzelspiele dieses Turniers in die allgemeine Statistik
   * einfließen (host-only, siehe TournamentService.setCountInGeneralStats) - z.B. wenn die Checkbox
   * beim Erstellen versehentlich falsch gesetzt war. Setzt die Checkbox bei Abbruch/Fehler bewusst
   * per input.checked zurück, statt sich auf Change Detection zu verlassen.
   */
  async toggleCountInGeneralStats(t: Tournament, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const nextValue = input.checked;

    if (this.togglingCountsId()) {
      input.checked = t.countInGeneralStats;
      return;
    }

    const confirmKey = nextValue ? 'tournamentHistory.confirmIncludeInStats' : 'tournamentHistory.confirmExcludeFromStats';
    if (!(await this.dialog.confirm(this.i18n.t(confirmKey, { name: t.name })))) {
      input.checked = t.countInGeneralStats;
      return;
    }

    this.togglingCountsId.set(t.id);
    const success = await this.tournament.setCountInGeneralStats(t.id, nextValue);
    this.togglingCountsId.set(null);

    if (!success) {
      input.checked = t.countInGeneralStats;
      await this.dialog.alert(this.i18n.t('tournamentHistory.toggleCountsFailed'));
      return;
    }
    this.selectedTournament.set({ ...t, countInGeneralStats: nextValue });
  }
}
