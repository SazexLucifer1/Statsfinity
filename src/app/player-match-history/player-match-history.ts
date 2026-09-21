import { Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MtgService } from '../mtg.service';
import { I18nService } from '../i18n.service';
import { LIVE_TRACKING_START_DATE, Match } from '../models';
import { DRAW, gameModeLabel, isPlayerWinner } from '../match-utils';
import { PlayerAvatar } from '../player-avatar/player-avatar';
import { Pager } from '../ui/pager/pager';

/** Ein Spiel aus Sicht EINER Person - alles, was die Profil-Historie je Zeile anzeigt, vorberechnet. */
export interface PlayerMatchRow {
  match: Match;
  result: 'win' | 'loss' | 'draw';
  commander: string | null;
  partnerCommander: string | null;
  deckName: string | null;
  placement: number | null;
  /** Alle übrigen Teilnehmer des Spiels (bei Two-Headed Giant also auch der eigene Teampartner). */
  others: string[];
}

/**
 * Match-Verlauf EINER Person, zum Ansehen - die Ergänzung zum Verlauf im Match-Tab, der alle
 * Spiele der Gruppe zeigt. Steht im Profil (eigenes, fremdes und NPC-Profil) und listet nur die
 * Spiele, an denen die jeweils angezeigte Person selbst teilgenommen hat.
 *
 * Bewusst ohne Bearbeiten/Löschen: das Korrigieren eines Ergebnisses samt Platzierung, Commander
 * und Cube hängt am Match-Tab und bleibt dort an einer Stelle, statt in zwei Ansichten zu leben.
 */
@Component({
  selector: 'app-player-match-history',
  imports: [DatePipe, PlayerAvatar, Pager],
  templateUrl: './player-match-history.html',
  styleUrl: './player-match-history.scss',
})
export class PlayerMatchHistory {
  readonly mtg = inject(MtgService);
  readonly i18n = inject(I18nService);

  /** Spielername, dessen Partien gezeigt werden - null, solange das Profil noch keinen kennt. */
  readonly playerName = input.required<string | null>();
  /** Jahresfilter des eigenen Profils; 'Alle' (Vorgabe) zeigt alle Jahre. */
  readonly year = input<number | 'Alle'>('Alle');

  readonly page = signal(0);
  readonly pageSize = 10;

  readonly rows = computed<PlayerMatchRow[]>(() => {
    const name = this.playerName();
    if (!name) return [];
    const year = this.year();

    const rows: PlayerMatchRow[] = [];
    // mtg.history() kommt bereits nach Datum absteigend sortiert aus Supabase.
    for (const match of this.mtg.history()) {
      // Dieselbe Grenze wie im Match-Tab: alte Excel-Importe bleiben in der Statistik, aber aus
      // dem sichtbaren Verlauf raus (siehe LIVE_TRACKING_START_DATE in models.ts).
      if (new Date(match.date) < LIVE_TRACKING_START_DATE) continue;
      if (year !== 'Alle' && new Date(match.date).getFullYear() !== year) continue;

      const me = match.players.find((p) => p.name === name);
      if (!me) continue;

      rows.push({
        match,
        result:
          match.winner === DRAW
            ? 'draw'
            : isPlayerWinner(match.mode, match.winner, me.name, me.team, me.isArchenemy)
              ? 'win'
              : 'loss',
        commander: me.commander ?? null,
        partnerCommander: me.partnerCommander ?? null,
        deckName: me.deckName ?? null,
        placement: me.placement ?? null,
        others: match.players.filter((p) => p.name !== name).map((p) => p.name),
      });
    }
    return rows;
  });

  readonly wins = computed(() => this.rows().filter((r) => r.result === 'win').length);

  readonly winRate = computed(() => {
    const total = this.rows().length;
    return total === 0 ? 0 : Math.round((this.wins() / total) * 100);
  });

  /** Gegen eine Seitenzahl, die nach einem Profil- oder Jahreswechsel hinter dem Ende liegt. */
  readonly effectivePage = computed(() =>
    Math.min(this.page(), Math.max(0, Math.ceil(this.rows().length / this.pageSize) - 1)),
  );

  readonly pagedRows = computed(() => {
    const start = this.effectivePage() * this.pageSize;
    return this.rows().slice(start, start + this.pageSize);
  });

  modeLabel(match: Match): string {
    return gameModeLabel(match.mode, match.format);
  }

  resultLabel(result: PlayerMatchRow['result']): string {
    return this.i18n.t(
      result === 'win'
        ? 'profile.matchHistoryWin'
        : result === 'draw'
          ? 'profile.matchHistoryDraw'
          : 'profile.matchHistoryLoss',
    );
  }
}
