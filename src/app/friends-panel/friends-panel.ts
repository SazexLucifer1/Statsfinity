import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { CardThumb } from '../ui/card-thumb/card-thumb';
import { InfoToggle } from '../ui/info-toggle/info-toggle';
import { I18nService } from '../i18n.service';
import { DialogService } from '../dialog.service';
import { ProfileService } from '../profile.service';
import { MtgService } from '../mtg.service';
import { NavigationService } from '../navigation.service';
import { FriendActivity, FriendOverall, FriendsService, ProfileHit } from '../friends.service';
import { divisionLabel, eloRanking, rankFromLp } from '../elo';
import { gameModeLabel } from '../match-utils';
import { DeckFormat, GameMode } from '../models';
import { PlayerAvatar } from '../player-avatar/player-avatar';
import { Meter } from '../ui/meter/meter';
import { Icon } from '../ui/icon/icon';

type FriendsTab = 'friends' | 'news' | 'ranking';

/**
 * Freunde im eigenen Profil: hinzufügen (Profilsuche), Anfragen, Liste, Neuigkeiten und die
 * Freunde-Rangliste. Fremde Profile zeigen stattdessen app-friend-status.
 */
@Component({
  selector: 'app-friends-panel',
  imports: [DatePipe, PlayerAvatar, Meter, Icon, InfoToggle, CardThumb],
  templateUrl: './friends-panel.html',
  styleUrl: './friends-panel.scss',
})
export class FriendsPanel {
  readonly i18n = inject(I18nService);
  readonly friends = inject(FriendsService);
  private readonly dialog = inject(DialogService);
  private readonly profileService = inject(ProfileService);
  private readonly mtg = inject(MtgService);
  private readonly navigation = inject(NavigationService);

  readonly tab = signal<FriendsTab>('friends');

  // --- Suche ---
  readonly query = signal('');
  readonly hits = signal<ProfileHit[]>([]);
  readonly searching = signal(false);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  onQuery(value: string): void {
    this.query.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (value.trim().length < 2) {
      this.hits.set([]);
      return;
    }
    this.searchTimer = setTimeout(async () => {
      this.searching.set(true);
      const hits = await this.friends.search(value);
      if (this.query() === value) this.hits.set(hits);
      this.searching.set(false);
    }, 300);
  }

  async add(hit: ProfileHit): Promise<void> {
    await this.friends.request(hit.id);
  }

  async remove(userId: string, name: string, confirmKey: string | null): Promise<void> {
    if (confirmKey && !(await this.dialog.confirm(this.i18n.t(confirmKey, { name })))) return;
    await this.friends.remove(userId);
  }

  openProfile(userId: string): void {
    this.profileService.viewProfile(userId);
  }

  // --- Neuigkeiten ---
  readonly activity = signal<FriendActivity[]>([]);
  readonly activityLoaded = signal(false);

  // --- Rangliste ---
  readonly overall = signal<FriendOverall[]>([]);
  readonly overallLoaded = signal(false);

  /** Ab so vielen Partien steht jemand in der Winrate-Liste (wie die Qualifikation im Stats-Tab). */
  readonly MIN_GAMES = 5;

  readonly winRateRanking = computed(() =>
    this.overall()
      .filter((o) => o.games >= this.MIN_GAMES)
      .map((o) => ({ ...o, winRate: (o.wins / o.games) * 100 }))
      .sort((a, b) => b.winRate - a.winRate || b.games - a.games),
  );
  readonly belowMin = computed(() => this.overall().filter((o) => o.games < this.MIN_GAMES));

  /**
   * Elo unter Freunden: nur aus Freundesspielen, mit derselben Rechnung wie in der Gruppe.
   * Freundesspiele sind nie "Ranked" einer Gruppe - hier zählen sie trotzdem, es ist ja eine
   * eigene Wertung.
   */
  readonly friendElo = computed(() => {
    const matches = this.mtg.friendHistory().map((m) => ({ ...m, isRanked: true }));
    return eloRanking(matches, 'Normal' as GameMode).sort((a, b) => b.lp - a.lp);
  });

  constructor() {
    effect(() => {
      const tab = this.tab();
      if (tab === 'news' && !this.activityLoaded()) {
        this.friends.activity().then((a) => {
          this.activity.set(a);
          this.activityLoaded.set(true);
        });
      }
      if (tab === 'ranking' && !this.overallLoaded()) {
        this.friends.overallStats().then((o) => {
          this.overall.set(o);
          this.overallLoaded.set(true);
        });
        this.mtg.loadFriendMatches();
      }
    });
  }

  rankLabel(lp: number): string {
    const rank = rankFromLp(lp);
    return `${this.i18n.t('profile.rank.tier.' + rank.tier)} ${divisionLabel(rank.division)}`.trim();
  }

  activityModeLabel(a: FriendActivity): string {
    return a.gameMode
      ? gameModeLabel(a.gameMode as GameMode, (a.gameFormat as DeckFormat) ?? null)
      : '';
  }

  /** Derselbe Weg wie ein QR-Code: Suche-Tab, Decks, dieses Deck öffnen. */
  openDeck(deckId: string): void {
    this.navigation.openPublicDeck(deckId);
  }
}
