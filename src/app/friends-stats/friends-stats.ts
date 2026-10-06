import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../i18n.service';
import { AuthService } from '../auth.service';
import { ProfileService } from '../profile.service';
import { FriendsService } from '../friends.service';
import { MtgService } from '../mtg.service';
import { GameMode, Match } from '../models';
import {
  PersonMatches,
  commanderRecords,
  headToHeadRecord,
  mergePeopleMatches,
  peopleRecords,
} from '../match-insights';
import { eloRanking } from '../elo';
import { MatchInsights } from '../match-insights/match-insights';
import { PlayerAvatar } from '../player-avatar/player-avatar';
import { Meter } from '../ui/meter/meter';
import { InfoToggle } from '../ui/info-toggle/info-toggle';

interface Person {
  userId: string;
  name: string;
  avatarUrl: string | null;
  isMe: boolean;
}

/**
 * Statistik-Tab, Ansicht "Freunde": ich und meine Freunde über ALLE Gruppen und Freundesspiele
 * (Wunsch des Users, 06.10.2026 - nur Freundschaften mit Konto, keine Gruppen-Mitspieler).
 *
 * Die Partien kommen über public_player_matches() je Person (dieselbe Quelle wie die öffentliche
 * Match-Liste im Profil) plus die eigenen Freundesspiele; mergePeopleMatches() legt sie zusammen
 * und benennt jede Person auf ihren Profilnamen um, weil sie in jeder Gruppe anders heißen kann.
 * Keine eigene Tabelle, keine Migration.
 */
@Component({
  selector: 'app-friends-stats',
  imports: [FormsModule, MatchInsights, PlayerAvatar, Meter, InfoToggle],
  templateUrl: './friends-stats.html',
  styleUrl: './friends-stats.scss',
})
export class FriendsStats {
  readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthService);
  private readonly profileService = inject(ProfileService);
  readonly friends = inject(FriendsService);
  private readonly mtg = inject(MtgService);

  /** Ab so vielen Partien steht jemand in der Rangliste (wie die Freunde-Rangliste im Profil). */
  readonly MIN_GAMES = 5;

  readonly loading = signal(true);
  private readonly allMatches = signal<Match[]>([]);
  private readonly friendGames = signal<Match[]>([]);

  readonly people = computed<Person[]>(() => {
    const me = this.auth.currentUser();
    const profile = this.profileService.profile();
    const list: Person[] = this.friends.friends().map((f) => ({
      userId: f.otherId,
      name: f.displayName,
      avatarUrl: f.avatarUrl,
      isMe: false,
    }));
    if (me && profile) {
      list.unshift({
        userId: me.id,
        name: profile.displayName,
        avatarUrl: profile.avatarUrl,
        isMe: true,
      });
    }
    return list;
  });

  readonly selectedYear = signal<string>('Alle');
  readonly selectedFormat = signal<string>('Alle');
  readonly selectedPerson = signal<string | null>(null);

  readonly availableYears = computed(() =>
    [...new Set(this.allMatches().map((m) => m.date.slice(0, 4)))].sort().reverse(),
  );
  readonly availableFormats = computed(() =>
    [
      ...new Set(
        this.allMatches()
          .map((m) => m.format)
          .filter((f): f is NonNullable<typeof f> => !!f),
      ),
    ].sort(),
  );

  private filter(matches: readonly Match[]): Match[] {
    const year = this.selectedYear();
    const format = this.selectedFormat();
    return matches.filter(
      (m) =>
        (year === 'Alle' || m.date.startsWith(year)) && (format === 'Alle' || m.format === format),
    );
  }

  readonly filteredMatches = computed(() => this.filter(this.allMatches()));
  /** Für den Jahresrückblick: ohne Jahresfilter, er wählt sein Jahr selbst. */
  readonly allMatchesForReview = computed(() => this.allMatches());

  readonly records = computed(() => {
    const avatars = new Map(this.people().map((p) => [p.name, p]));
    return peopleRecords(
      this.filteredMatches(),
      this.people().map((p) => p.name),
    ).map((r) => ({ ...r, person: avatars.get(r.name)! }));
  });
  readonly ranking = computed(() =>
    this.records()
      .filter((r) => r.games >= this.MIN_GAMES)
      .sort((a, b) => b.winRate - a.winRate || b.games - a.games),
  );
  readonly belowMin = computed(() =>
    this.records().filter((r) => r.games > 0 && r.games < this.MIN_GAMES),
  );

  /** Elo nur aus Freundesspielen - gruppenübergreifend würden fremde Runden vermischt. */
  readonly elo = computed(() => {
    const matches = this.filter(this.friendGames()).map((m) => ({ ...m, isRanked: true }));
    return eloRanking(matches, 'Normal' as GameMode).sort((a, b) => b.lp - a.lp);
  });

  readonly myName = computed(() => this.people().find((p) => p.isMe)?.name ?? null);

  readonly headToHead = computed(() => {
    const me = this.myName();
    const other = this.selectedPerson();
    if (!me || !other || other === me) return null;
    return headToHeadRecord(this.filteredMatches(), me, other);
  });

  readonly commanders = computed(() => {
    const name = this.selectedPerson();
    return name ? commanderRecords(this.filteredMatches(), name).slice(0, 6) : [];
  });

  constructor() {
    if (!this.friends.loaded()) void this.friends.refresh();
    effect(() => {
      // Neu laden, sobald die Freundesliste steht oder sich ändert.
      const people = this.people();
      if (!this.friends.loaded()) return;
      void this.load(people);
    });
  }

  private loadToken = 0;

  private async load(people: Person[]): Promise<void> {
    const token = ++this.loadToken;
    this.loading.set(true);
    const [entries, friendGames] = await Promise.all([
      Promise.all(people.map((p) => this.mtg.loadPublicMatchesForUser(p.userId))),
      this.mtg.loadFriendMatches(),
    ]);
    if (token !== this.loadToken) return;
    const sources: PersonMatches[] = people.map((p, i) => ({
      userId: p.userId,
      name: p.name,
      entries: entries[i] ?? [],
    }));
    this.friendGames.set(
      mergePeopleMatches(
        sources.map((s) => ({ ...s, entries: [] })),
        friendGames,
      ),
    );
    this.allMatches.set(mergePeopleMatches(sources, friendGames));
    this.loading.set(false);
  }

  togglePerson(name: string): void {
    this.selectedPerson.set(this.selectedPerson() === name ? null : name);
  }
}
