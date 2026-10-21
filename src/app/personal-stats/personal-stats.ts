import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { I18nService } from '../i18n.service';
import { MtgService } from '../mtg.service';
import { DeckService, CardAndColorStats, DeckOwner } from '../deck.service';
import { CardPreviewService } from '../card-preview.service';
import { DECK_FORMATS, GameMode, Match } from '../models';
import { PersonMatches, didWin, headToHeadRecord, mergePeopleMatches } from '../match-insights';
import { isImportLossDuplicate } from '../match-utils';
import { colorComboLabel, colorRadarData, sortColors } from '../color-combo-names';
import { splitPodium } from '../rank-sort';
import { PerformanceStats } from '../performance-stats/performance-stats';
import { MatchInsights } from '../match-insights/match-insights';
import { PlayerMatchHistory } from '../player-match-history/player-match-history';
import { PlayerAvatar } from '../player-avatar/player-avatar';
import { BarChart, BarChartDatum } from '../ui/bar-chart/bar-chart';
import { RadarChart, RadarChartDatum } from '../ui/radar-chart/radar-chart';
import { Meter } from '../ui/meter/meter';
import { CardThumb } from '../ui/card-thumb/card-thumb';
import { ManaSymbol } from '../ui/mana-symbol/mana-symbol';
import { Podium, PodiumEntry, PODIUM_SIZE } from '../ui/podium/podium';
import { SplitBar, SplitSegment } from '../ui/split-bar/split-bar';

/** Eine Person, deren Statistik gezeigt wird - mit Konto (userId) oder nur als Gruppen-Spieler. */
export interface StatsPerson {
  userId: string | null;
  /** Anzeigename (Profilname, sonst Name in der Gruppe). */
  name: string;
  /** Name in der aktiven Gruppe, null = spielt dort nicht. */
  groupName: string | null;
  avatarUrl: string | null;
}

/**
 * Persönliche Statistik einer Person im Statistik-Tab (Wunsch des Users, 20.10.2026): vorher stand
 * die eigene Statistik im Profil, die der anderen nur verstreut. Umschaltbar zwischen allen Gruppen
 * (public_player_matches() plus Freundesspiele, wie friends-stats/) und der aktiven Gruppe
 * (mtg.history()). Mit `compareWith` (ich) kommt der direkte Vergleich dazu.
 */
@Component({
  selector: 'app-personal-stats',
  imports: [
    FormsModule,
    DecimalPipe,
    PerformanceStats,
    MatchInsights,
    PlayerMatchHistory,
    PlayerAvatar,
    BarChart,
    RadarChart,
    Meter,
    CardThumb,
    ManaSymbol,
    Podium,
    SplitBar,
  ],
  templateUrl: './personal-stats.html',
  styleUrl: './personal-stats.scss',
})
export class PersonalStats {
  readonly i18n = inject(I18nService);
  private readonly mtg = inject(MtgService);
  private readonly deckService = inject(DeckService);
  private readonly cardPreview = inject(CardPreviewService);

  readonly person = input.required<StatsPerson>();
  /** Gesetzt = fremde Person, verglichen mit mir. */
  readonly compareWith = input<StatsPerson | null>(null);
  /** Zeigt einen Zurück-Knopf (Spieler aus einer Liste geöffnet). */
  readonly showBack = input(false);
  readonly back = output<void>();

  readonly deckFormats = DECK_FORMATS;
  readonly podiumSize = PODIUM_SIZE;

  readonly scope = signal<'all' | 'group'>('all');
  readonly year = signal<number | 'Alle'>(new Date().getFullYear());
  readonly format = signal<string>('Alle');

  /** Ohne Konto gibt es nur die Gruppe, ohne Platz in der Gruppe nur "alle". */
  readonly canChooseScope = computed(() => !!this.person().userId && !!this.person().groupName);
  readonly effectiveScope = computed<'all' | 'group'>(() => {
    const p = this.person();
    if (!p.userId) return 'group';
    if (!p.groupName) return 'all';
    return this.scope();
  });

  readonly loading = signal(false);
  private readonly allGroupsMatches = signal<Match[]>([]);

  constructor() {
    effect(() => {
      const person = this.person();
      const other = this.compareWith();
      if (!person.userId) return;
      untracked(() => void this.loadAllGroups(person, other));
    });

    effect(() => {
      const owner = this.cardStatsOwner();
      const year = this.year();
      if (!owner) {
        this.cardAndColorStats.set(null);
        return;
      }
      void this.deckService
        .getCardAndColorStats(owner, year === 'Alle' ? undefined : year)
        .then((stats) => {
          if (this.cardStatsOwner() === owner) this.cardAndColorStats.set(stats);
        });
    });
  }

  private loadToken = 0;

  private async loadAllGroups(person: StatsPerson, other: StatsPerson | null): Promise<void> {
    const token = ++this.loadToken;
    this.loading.set(true);
    const people = [person, ...(other ? [other] : [])];
    const [entries, friendGames] = await Promise.all([
      Promise.all(
        people.map((p) => (p.userId ? this.mtg.loadPublicMatchesForUser(p.userId) : null)),
      ),
      this.mtg.loadFriendMatches(),
    ]);
    if (token !== this.loadToken) return;
    // Die Partien der aktiven Gruppe zuerst: Sie kommen vollständig (auch mit privaten Decks),
    // die öffentliche Liste lässt deren Namen weg - mergePeopleMatches behält je Partie die erste.
    const sources: PersonMatches[] = people.map((p, i) => ({
      userId: p.userId ?? '',
      name: p.name,
      entries: [...this.groupEntries(p), ...(entries[i] ?? [])],
    }));
    this.allGroupsMatches.set(mergePeopleMatches(sources, friendGames));
    this.loading.set(false);
  }

  private groupEntries(p: StatsPerson): { match: Match; selfName: string }[] {
    const name = p.groupName;
    if (!name) return [];
    return this.mtg
      .history()
      .filter((m) => m.players.some((x) => x.name === name))
      .map((match) => ({ match, selfName: name }));
  }

  /** Partien der aktiven Gruppe, die Personen auf ihren Anzeigenamen umbenannt. */
  private readonly groupMatches = computed<Match[]>(() => {
    const people = [this.person(), ...(this.compareWith() ? [this.compareWith()!] : [])];
    return mergePeopleMatches(
      people.map((p) => ({ userId: p.userId ?? '', name: p.name, entries: this.groupEntries(p) })),
    );
  });

  /** Alle Partien der gewählten Quelle mit Jahr/Format, noch nicht auf die Person eingegrenzt. */
  readonly sourceMatches = computed<Match[]>(() => {
    const year = this.year();
    const format = this.format();
    const base = this.effectiveScope() === 'all' ? this.allGroupsMatches() : this.groupMatches();
    return base.filter(
      (m) =>
        m.countsInGeneralStats !== false &&
        (year === 'Alle' || new Date(m.date).getFullYear() === year) &&
        (format === 'Alle' || m.format === format),
    );
  });

  readonly personMatches = computed(() => {
    const name = this.person().name;
    return this.sourceMatches().filter((m) => m.players.some((p) => p.name === name));
  });

  /** Für den Jahresrückblick der Spiel-Analysen: ohne Jahresfilter. */
  readonly reviewMatches = computed(() =>
    this.effectiveScope() === 'all' ? this.allGroupsMatches() : this.groupMatches(),
  );

  readonly availableYears = computed<number[]>(() => {
    const years = new Set<number>([new Date().getFullYear()]);
    for (const m of this.reviewMatches()) years.add(new Date(m.date).getFullYear());
    return [...years].sort((a, b) => b - a);
  });

  /** Für den Match-Verlauf: in der Gruppe dessen eigene Quelle (mit LP), sonst diese Partien. */
  readonly historyEntries = computed(() => {
    if (this.effectiveScope() === 'group') return null;
    const name = this.person().name;
    return this.personMatches().map((match) => ({ match, selfName: name }));
  });

  // --- Nach Spielmodus ---

  readonly modeStats = computed(() => {
    const name = this.person().name;
    const stats = new Map<GameMode, { games: number; wins: number }>();
    for (const m of this.personMatches()) {
      if (isImportLossDuplicate(m) && m.players.length > 1) continue;
      const entry = stats.get(m.mode) ?? { games: 0, wins: 0 };
      entry.games++;
      if (didWin(m, name)) entry.wins++;
      stats.set(m.mode, entry);
    }
    return [...stats.entries()]
      .map(([mode, s]) => ({ mode, ...s, winRate: (s.wins / s.games) * 100 }))
      .sort((a, b) => b.games - a.games);
  });

  // --- Platzierungen ---

  readonly placementChart = computed<BarChartDatum[]>(() => {
    const name = this.person().name;
    const counts = new Map<number, number>();
    for (const m of this.personMatches()) {
      const placement = m.players.find((p) => p.name === name)?.placement;
      if (placement != null) counts.set(placement, (counts.get(placement) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([placement, count]) => ({
        label: this.i18n.t('placement.badge', { placement }),
        value: count,
      }));
  });

  // --- Direkter Vergleich ---

  readonly headToHead = computed(() => {
    const other = this.compareWith();
    if (!other) return null;
    return headToHeadRecord(this.sourceMatches(), this.person().name, other.name);
  });

  readonly headToHeadSegments = computed<SplitSegment[]>(() => {
    const h = this.headToHead();
    const other = this.compareWith();
    if (!h || !other) return [];
    return [
      { label: this.person().name, value: h.aWins, color: 'var(--series-1)' },
      { label: other.name, value: h.bWins, color: 'var(--series-2)' },
      {
        label: this.i18n.t('stats.h2h.otherWinner'),
        value: h.games - h.aWins - h.bWins,
        color: 'var(--series-neutral)',
      },
    ];
  });

  // --- Karten und Farben (aus dem Profil umgezogen) ---

  /**
   * Zählt über die Decks der Person - geladen über DeckService.getCardAndColorStats(). Über alle
   * Gruppen nur für mich: von anderen sieht man nur die Decks der eigenen Gruppen, eine Zahl
   * "über alle Gruppen" wäre dann still unvollständig.
   */
  private readonly cardStatsOwner = computed<DeckOwner | null>(() => {
    const p = this.person();
    if (this.effectiveScope() === 'all') {
      return p.userId && !this.compareWith() ? { kind: 'user', userId: p.userId } : null;
    }
    const playerId = p.groupName ? this.mtg.playerIdFor(p.groupName) : null;
    return playerId ? { kind: 'player', playerId } : null;
  });

  readonly cardAndColorStats = signal<CardAndColorStats | null>(null);

  /** Gewichtung der Ranglisten: nach Partien je Deck oder jedes Deck einmal. */
  readonly weightMode = signal<'games' | 'decks'>('games');

  readonly countFor = (entry: { gameCount: number; deckCount: number }): number =>
    this.weightMode() === 'games' ? entry.gameCount : entry.deckCount;

  readonly comboColors = (colors: string[]): string[] => sortColors(colors);
  readonly colorComboLabel = (colors: string[]): string => colorComboLabel(this.i18n, colors);

  private readonly rankedCards = computed(() =>
    [...(this.cardAndColorStats()?.mostUsedCards ?? [])]
      .sort((a, b) => this.countFor(b) - this.countFor(a))
      .slice(0, 5),
  );
  private readonly rankedCombos = computed(() =>
    [...(this.cardAndColorStats()?.colorComboRanking ?? [])].sort(
      (a, b) => this.countFor(b) - this.countFor(a),
    ),
  );

  readonly maxCardCount = computed(() =>
    Math.max(1, ...this.rankedCards().map((c) => this.countFor(c))),
  );
  readonly maxComboCount = computed(() =>
    Math.max(1, ...this.rankedCombos().map((c) => this.countFor(c))),
  );

  readonly colorRadarChart = computed<RadarChartDatum[]>(() =>
    colorRadarData(this.i18n, this.cardAndColorStats()?.colorRanking ?? [], this.countFor),
  );

  private readonly cardsSplit = computed(() => splitPodium(this.rankedCards(), 0));
  readonly cardsRest = computed(() => this.cardsSplit().rest);
  readonly cardsPodium = computed<PodiumEntry[]>(() =>
    this.cardsSplit().podium.map((c) => ({
      key: c.cardName,
      name: c.cardName,
      detail: '',
      value: `${this.countFor(c)}×`,
      imageUrl: c.imageUrl,
    })),
  );

  private readonly combosSplit = computed(() => splitPodium(this.rankedCombos(), 0));
  readonly combosRest = computed(() => this.combosSplit().rest);
  readonly combosPodium = computed<PodiumEntry[]>(() =>
    this.combosSplit().podium.map((combo) => ({
      key: combo.colors.join('') || 'C',
      name: this.colorComboLabel(combo.colors),
      detail: '',
      value: `${this.countFor(combo)}×`,
      symbols: combo.colors.length === 0 ? ['C'] : this.comboColors(combo.colors),
    })),
  );

  openPodiumCard(entry: PodiumEntry): void {
    if (entry.imageUrl) this.cardPreview.open(entry.imageUrl, null, entry.name);
  }
}
