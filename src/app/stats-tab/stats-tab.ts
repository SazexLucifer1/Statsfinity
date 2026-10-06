import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MtgService } from '../mtg.service';
import { GroupService } from '../group.service';
import { NavigationService } from '../navigation.service';
import { ProfileService } from '../profile.service';
import { CardPreviewService } from '../card-preview.service';
import { PlayerAvatar } from '../player-avatar/player-avatar';
import { ScryfallCard, ScryfallService } from '../scryfall.service';
import { DeckService } from '../deck.service';
import { DeckViewerService } from '../deck-viewer.service';
import { CardImage } from '../card-image/card-image';
import {
  CommanderStats,
  DeckStats,
  DECK_FORMATS,
  DeckFormat,
  GAME_MODES,
  GameMode,
  LIVE_TRACKING_START_DATE,
  Match,
  PlayerStats,
} from '../models';
import { I18nService } from '../i18n.service';
import { TournamentHistory } from '../tournament-history/tournament-history';
import { isImportLossDuplicate, isPlayerWinner as isMatchWinner } from '../match-utils';
import {
  ELO_PROVISIONAL_GAMES,
  EloEntry,
  RankTier,
  divisionLabel, eloRanking, rankFromLp, rankTiersFor, ratedModes } from '../elo';
import { RankBadge, rankStyle } from '../ui/rank-badge/rank-badge';
import { Meter } from '../ui/meter/meter';
import { Pager } from '../ui/pager/pager';
import { SplitBar, SplitSegment } from '../ui/split-bar/split-bar';
import { RadarChart, RadarChartDatum } from '../ui/radar-chart/radar-chart';
import { ManaSymbol } from '../ui/mana-symbol/mana-symbol';
import { MultiSelect } from '../ui/multi-select/multi-select';
import { colorComboLabel, colorLabel, colorRadarData, colorVar, sortColors } from '../color-combo-names';
import { COLORLESS, COLOR_AXES, FILTER_COLORS } from '../color-filter-match';
import {
  RankSortMode,
  compareBySortMode,
  medal as medalFor,
  barValue as barValueFor,
  barMax as barMaxFor,
  splitPodium,
  podiumRestOffset,
} from '../rank-sort';
import { Podium, PodiumEntry } from '../ui/podium/podium';
import { GlobalStats } from '../global-stats/global-stats';
import { Icon } from '../ui/icon/icon';
import { MatchInsights } from '../match-insights/match-insights';
import { FriendsStats } from '../friends-stats/friends-stats';
import { AuthService } from '../auth.service';
import { FriendsService } from '../friends.service';

export type StatsViewMode = 'stats' | 'tournaments';
export type ColorStatsWeightMode = 'games' | 'decks';
export type StatsScope = 'group' | 'global' | 'friends';

const PAGE_SIZE = 10;

/** Farb- und Kombinations-Zählung für die Gruppen-Statistik - siehe groupColorAndComboStats(). */
interface GroupColorEntry {
  color: (typeof COLOR_AXES)[number];
  gameCount: number;
  deckCount: number;
}

interface GroupColorComboEntry {
  colors: string[];
  gameCount: number;
  deckCount: number;
}

/** Gemeinsame Zeile für die vereinte Decks&Commander-Rangliste (siehe combinedDeckCommanderStats). */
interface CombinedRankEntry {
  key: string;
  name: string;
  cardName?: string;
  /** Nur bei Deck-Einträgen gesetzt (deck_cards.image_url) - hat Vorrang vor der Namenssuche in commanderImage(). */
  cardImageUrl?: string | null;
  games: number;
  wins: number;
  winRate: number;
  playedBy: { name: string; borrowed: boolean }[];
  /** Nur bei einem eigenständigen Deck gesetzt (nicht bei einer Commander-Sammelzeile aus Precons/unverlinkten Matches) - für den "Ansehen"-Sprung zum Deck. */
  deckId?: string;
  /** true = das Deck gibt es nicht mehr (Grabstein) - zählt weiter mit, lässt sich aber nicht mehr öffnen. */
  isDeleted?: boolean;
}

@Component({
  selector: 'app-stats-tab',
  imports: [
    RankBadge,
    MatchInsights,
    DecimalPipe,
    DatePipe,
    PlayerAvatar,
    FormsModule,
    TournamentHistory,
    CardImage,
    Meter,
    Pager,
    SplitBar,
    RadarChart,
    ManaSymbol,
    MultiSelect,
    Podium,
    GlobalStats,
    FriendsStats,
   Icon],
  templateUrl: './stats-tab.html',
  styleUrl: './stats-tab.scss',
})
export class StatsTab {
  readonly mtg = inject(MtgService);
  readonly groupService = inject(GroupService);
  readonly auth = inject(AuthService);
  readonly friends = inject(FriendsService);
  private readonly scryfall = inject(ScryfallService);
  private readonly deckService = inject(DeckService);
  private readonly viewer = inject(DeckViewerService);
  private readonly navigation = inject(NavigationService);
  private readonly profileService = inject(ProfileService);
  readonly cardPreview = inject(CardPreviewService);
  readonly i18n = inject(I18nService);

  /** Umschalter oben im Stats-Tab zwischen normaler Statistik und der Turnier-Historie. */
  readonly viewMode = signal<StatsViewMode>('stats');

  // --- Von einem angezeigten Spielernamen direkt zu dessen Profil springen (nur bei echtem Account) ---

  isPlayerLinked(name: string): boolean {
    return !!this.mtg.playerUserIds()[name];
  }

  async openPlayerProfile(name: string): Promise<void> {
    const userId = this.mtg.playerUserIds()[name];
    if (!userId) return;
    this.navigation.goToTab('profile');
    await this.profileService.viewProfile(userId);
  }

  // --- Kartenbilder (Commander/Erfolgreichste Commander & Decks) ---

  /** Kartenname (lowercase) -> Scryfall-Daten oder null (nicht gefunden). Nur für aktuell sichtbare Einträge geladen. */
  private readonly cardDetails = signal<Record<string, ScryfallCard | null>>({});
  /**
   * Deck-ID → im Deck markierter Commander + Bild. Hat Vorrang vor dem Namen aus den Partien
   * (aktueller, und dort fehlt er manchmal).
   */
  private readonly storedDeckCommanders = signal<Map<string, { name: string; imageUrl: string | null }>>(new Map());

  /**
   * Deck-IDs, hinter denen nur ein Grabstein steht: Partien zählen weiter, die Rangliste bietet
   * kein "Ansehen" an.
   */
  private readonly deletedDeckIds = signal<Set<string>>(new Set());

  /** Deck-ID -> Farbidentität, für die gruppenweite Lieblingsfarben-/Farbkombinations-Statistik
   * (siehe groupColorAndComboStats()) - nur für Nicht-Precon-Decks geladen, siehe Effect unten. */
  private readonly deckColorIdentities = signal<Map<string, string[]>>(new Map());

  constructor() {
    effect(() => {
      // Aktive und lokal betrachtete Gruppe zusammen - reiner Bildcache, zu viele IDs schaden
      // nicht.
      const deckIds = [
        ...new Set([
          ...this.filteredMatches().flatMap((m) =>
            m.players.map((p) => p.deckId).filter((id): id is string => !!id),
          ),
          ...this.viewedFilteredMatches().flatMap((m) =>
            m.players.map((p) => p.deckId).filter((id): id is string => !!id),
          ),
        ]),
      ];
      if (deckIds.length === 0) return;
      this.deckService.getStoredCommanders(deckIds).then((map) => this.storedDeckCommanders.set(map));
      this.deckService.getDeletedDeckInfos(deckIds).then((map) => this.deletedDeckIds.set(new Set(map.keys())));
    });

    effect(() => {
      // Ohne Precons (nicht selbst gebaut), aus viewedFilteredMatches() (lokal gewählte Gruppe).
      const deckIds = [
        ...new Set(
          this.viewedFilteredMatches().flatMap((m) =>
            m.players
              .filter((p) => p.deckId && p.deckIsPrecon !== true)
              .map((p) => p.deckId as string),
          ),
        ),
      ];
      if (deckIds.length === 0) return;
      this.deckService.getColorIdentities(deckIds).then((map) => this.deckColorIdentities.set(map));
    });

    effect(() => {
      // Lädt viewedMatches(). mtg.history() wird in jedem Zweig gelesen, damit ein neues Match auch
      // die fremde/globale Ansicht auffrischt.
      const activeGroupId = this.groupService.groupId();
      const activeHistory = this.mtg.history();
      const groupId = this.effectiveViewedGroupId();

      if (!groupId) {
        this.viewedMatches.set([]);
        return;
      }
      if (groupId === activeGroupId) {
        this.viewedMatches.set(activeHistory);
        return;
      }
      this.mtg.loadMatchesForGroups([groupId]).then((matches) => this.viewedMatches.set(matches));
    });

    effect(() => {
      const names = new Set<string>();
      for (const e of this.pagedCombinedStats()) {
        if (e.cardName) names.add(e.cardName);
      }
      for (const e of this.pagedCombinedInQualification()) {
        if (e.cardName) names.add(e.cardName);
      }
      for (const c of this.playerCommanderStats()) {
        names.add(c.commander);
      }
      for (const d of this.playerDeckStats()) {
        if (d.commander) names.add(d.commander);
      }
      for (const c of this.h2hCommanderStatsA()) {
        names.add(c.commander);
      }
      for (const c of this.h2hCommanderStatsB()) {
        names.add(c.commander);
      }
      const cache = this.cardDetails();
      const missing = [...names].filter((n) => !(n.toLowerCase() in cache));
      if (missing.length === 0) return;

      this.scryfall.findCardsBulk(missing).then((found) => {
        this.cardDetails.update((current) => {
          const next = { ...current };
          for (const name of missing) {
            next[name.toLowerCase()] = found.get(name.toLowerCase()) ?? null;
          }
          return next;
        });
      });
    });
  }

  /** Kartenbild-URL für einen Commander-Namen - ein im Deck selbst hinterlegtes Bild (storedImageUrl) hat Vorrang vor der generischen Namenssuche. */
  commanderImage(name: string | undefined, storedImageUrl?: string | null): string | null {
    if (storedImageUrl) return storedImageUrl;
    if (!name) return null;
    return this.cardDetails()[name.toLowerCase()]?.imageUrl ?? null;
  }

  /** Rückseite bei Doppelkarten - kommt immer aus der Namenssuche, nie aus einem im Deck hinterlegten Bild (das speichert nie eine Rückseite). */
  commanderBackImage(name: string | undefined): string | null {
    if (!name) return null;
    return this.cardDetails()[name.toLowerCase()]?.backImageUrl ?? null;
  }

  // --- Elo-Wertung je Spielmodus (elo.ts) - über alle live erfassten Partien, ohne Jahresfilter ---

  // Wie der Rang im Profil je Modus UND Format: dem Format-Filter oben folgend ("Alle" = alle
  // Formate eines Modus gemeinsam). Ein Modern-Sieg soll keinen Commander-Rang verschieben.
  // Nur in einer Gruppe mit eingeschaltetem Rangsystem (Schalter des Gruppenleiters).
  /** Partien der laufenden Ranked-Saison (groups.ranked_since) - Grundlage aller Elo-Werte hier. */
  private readonly seasonMatches = computed(() =>
    this.groupService.seasonMatches(this.viewedMatches(), this.effectiveViewedGroupId()),
  );
  readonly eloModes = computed(() =>
    !this.groupService.canSeeRanked(this.effectiveViewedGroupId())
      ? []
      : ratedModes(
          this.applyFormatFilter(this.seasonMatches()),
          GAME_MODES.filter((m) => this.canViewMode(m)),
        ),
  );
  private readonly eloModeChoice = signal<GameMode | null>(null);
  readonly eloMode = computed(() => {
    const choice = this.eloModeChoice();
    const modes = this.eloModes();
    return choice && modes.includes(choice) ? choice : (modes[0] ?? null);
  });
  readonly eloRanking = computed<EloEntry[]>(() => {
    const mode = this.eloMode();
    if (!mode) return [];
    const format = this.selectedFormat();
    return eloRanking(this.seasonMatches(), mode, format === 'Alle' ? {} : { format });
  });
  readonly eloPage = signal(0);
  readonly pagedEloRanking = computed(() => {
    const pages = Math.max(1, Math.ceil(this.eloRanking().length / PAGE_SIZE));
    const start = Math.min(this.eloPage(), pages - 1) * PAGE_SIZE;
    // Ganze Zahlen ohne Tausendertrennzeichen - "1,016" läse sich im deutschen Text als Kommazahl.
    return this.eloRanking()
      .slice(start, start + PAGE_SIZE)
      .map((e, i) => ({
        ...e,
        place: start + i,
        lp: Math.round(e.lp),
        rank: rankFromLp(e.lp),
        peak: Math.round(e.peak),
        lastChange: Math.round(e.lastChange),
      }));
  });
  readonly showEloInfo = signal(false);
  /** Rangsystem aus, aber der Gruppenleiter sieht die Wertung trotzdem (nur er). */
  readonly eloHiddenForOthers = computed(
    () => !this.groupService.isRankedGroup(this.effectiveViewedGroupId()),
  );
  readonly placementTotal = ELO_PROVISIONAL_GAMES;

  /**
   * Rangfarbe für die Ringe um die Profilbilder im ganzen Tab - derselbe Modus wie die Elo-Liste
   * (Standard Normal) und das Format aus dem Filter oben. Leer ohne Rangsystem in der Gruppe.
   */
  private readonly rankTiers = computed<Map<string, RankTier>>(() => {
    if (!this.groupService.isRankedGroup(this.effectiveViewedGroupId())) return new Map();
    const format = this.selectedFormat();
    return rankTiersFor(
      this.seasonMatches(),
      this.eloMode() ?? 'Normal',
      format === 'Alle' ? undefined : format,
    );
  });

  rankTierFor(name: string): RankTier | null {
    return this.rankTiers().get(name) ?? null;
  }

  /** CSS-Variablen der Rangfarbe für eine Spielerkachel (Klasse .rank-tinted in styles.scss). */
  rankVars(tier: RankTier | null): Record<string, string> | null {
    return rankStyle(tier);
  }

  /** "Gold III" - Rangname für Abzeichen und Tooltip in der Elo-Liste. */
  rankLabel(rank: ReturnType<typeof rankFromLp>): string {
    const tier = this.i18n.t('profile.rank.tier.' + rank.tier);
    return rank.division == null ? tier : `${tier} ${divisionLabel(rank.division)}`;
  }

  setEloMode(mode: GameMode): void {
    this.eloModeChoice.set(mode);
    this.eloPage.set(0);
  }

  // --- Sortierung der Ranglisten (Logik in rank-sort.ts, geteilt mit GlobalStats) ---

  readonly playerSortMode = signal<RankSortMode>('winRate');
  /** Gemeinsamer Sortier-Modus für die vereinte Decks&Commander-Rangliste. */
  readonly deckSortMode = signal<RankSortMode>('winRate');
  readonly playerDeckSortMode = signal<RankSortMode>('winRate');
  readonly playerCommanderSortMode = signal<RankSortMode>('winRate');

  // --- Balken der Ranglisten: zeigen immer die Größe, nach der sortiert wird ---
  readonly barValue = barValueFor;
  readonly barMax = barMaxFor;

  // --- Stats-Sichtbarkeit ---

  /**
   * Darf der Viewer die Stats für `mode` sehen? Legt der Host je Account und Modus fest; ohne
   * Spieler oder Einstellung erlaubt.
   */
  canViewMode(mode: GameMode): boolean {
    const myName = this.mtg.myPlayerName();
    if (!myName) return true;
    return this.mtg.statVisibility().get(myName)?.get(mode) ?? true;
  }

  /** Modi, die für den eingeloggten Account gesperrt sind (für den Hinweis-Banner). */
  readonly blockedModes = computed(() => GAME_MODES.filter((m) => !this.canViewMode(m)));

  // --- Zeitraum-Filter (Jahr) ---

  /** Startet auf dem laufenden Jahr statt auf "Alle": gefragt ist beim Öffnen fast immer die
   * aktuelle Saison, die Gesamtübersicht holt man sich gezielt über den Filter. */
  readonly selectedYear = signal<number | 'Alle'>(new Date().getFullYear());

  readonly availableYears = computed<number[]>(() => {
    // Das laufende Jahr steht immer zur Auswahl, auch bevor darin das erste Match gespielt wurde -
    // sonst zeigte das Feld beim Öffnen eine Vorauswahl, die es in der Liste gar nicht gibt.
    const years = new Set<number>([new Date().getFullYear()]);
    for (const m of this.mtg.history()) {
      years.add(new Date(m.date).getFullYear());
    }
    return [...years].sort((a, b) => b - a);
  });

  setSelectedYear(year: number | 'Alle'): void {
    this.selectedYear.set(year);
    this.selectedCommanderDetail.set(null);
    this.selectedDeckDetail.set(null);
  }

  /** Jahresfilter als reine Funktion für aktive und lokal gewählte Gruppe. */
  private applyYearFilter(matches: Match[]): Match[] {
    const year = this.selectedYear();
    // countsInGeneralStats=false (Turnier-Einstellung) blendet ein Match hier aus allen Stats-Tab-
    // Aggregaten aus - im normalen Match-Verlauf (match-tab.ts visibleHistory) bleibt es trotzdem sichtbar.
    const base = matches.filter((m) => m.countsInGeneralStats !== false);
    return year === 'Alle' ? base : base.filter((m) => new Date(m.date).getFullYear() === year);
  }

  private readonly yearFilteredMatches = computed<Match[]>(() =>
    this.applyYearFilter(this.mtg.history()),
  );

  // --- Modus-Filter (Mehrfachauswahl: eigene Kombination aus mehreren Modi möglich) ---

  readonly gameModes = GAME_MODES;

  /** Aktuell gewählte Modi. Default: alle - die für den Account gesperrten werden trotzdem
   * unten per canViewMode() rausgefiltert. */
  readonly selectedModes = signal<Set<GameMode>>(new Set(GAME_MODES));

  /** Der eine ausgewählte Modus, falls genau einer gewählt ist - sonst null (Mehrfach- oder Nullauswahl = Aggregat-Ansicht). */
  readonly isSingleMode = computed<GameMode | null>(() => {
    const modes = [...this.selectedModes()];
    return modes.length === 1 ? modes[0] : null;
  });

  /**
   * Übernimmt die Mehrfachauswahl. Gesperrte Modi werden trotz gesperrtem Menü nochmals gefiltert
   * (und in applyModeFilter() ein drittes Mal).
   */
  setSelectedModes(next: Set<string>): void {
    const allowed = GAME_MODES.filter((m) => next.has(m) && this.canViewMode(m));
    this.selectedModes.set(new Set(allowed));
    this.selectedCommanderDetail.set(null);
    this.selectedDeckDetail.set(null);
  }

  /** Modus-Filter als reine Funktion - siehe applyYearFilter() für die Begründung. */
  private applyModeFilter(matches: Match[]): Match[] {
    const modes = this.selectedModes();
    return matches.filter((m) => modes.has(m.mode) && this.canViewMode(m.mode));
  }

  // --- Format-Filter, frei kombinierbar mit dem Modus-Filter; reine Ansicht, keine Berechtigung
  // ---

  readonly deckFormats = DECK_FORMATS;

  /**
   * Genau EIN Format oder "Alle" - Deck-Ranglisten sind nur innerhalb eines Formats vergleichbar.
   * Start auf Commander, sonst wäre "Decks & Commander" beim ersten Aufruf leer.
   */
  readonly selectedFormat = signal<DeckFormat | 'Alle'>('Commander');

  setSelectedFormat(format: DeckFormat | 'Alle'): void {
    this.selectedFormat.set(format);
    this.selectedCommanderDetail.set(null);
    this.selectedDeckDetail.set(null);
  }

  /**
   * Format-Filter als reine Funktion. Matches ohne Format (Spezialevent) zählen nur unter "Alle".
   */
  private applyFormatFilter(matches: Match[]): Match[] {
    const format = this.selectedFormat();
    if (format === 'Alle') return matches;
    return matches.filter((m) => m.format === format);
  }

  /**
   * Deck-/Commander-Vergleiche nur innerhalb eines Formats; sonst ein Hinweis
   * (stats.chooseFormatForDecksHint).
   */
  readonly deckComparisonAvailable = computed(() => this.selectedFormat() !== 'Alle');

  readonly filteredMatches = computed<Match[]>(() =>
    this.applyFormatFilter(this.applyModeFilter(this.yearFilteredMatches())),
  );

  /** Für den Jahresrückblick: alle zählenden Partien der Gruppe, ohne Jahres-/Modusfilter. */
  readonly reviewMatches = computed<Match[]>(() =>
    this.mtg.history().filter((m) => m.countsInGeneralStats !== false),
  );

  // --- Gruppen-Wechsler im Stats-Tab ---
  //
  // Wechselt die echte aktive Gruppe (dieselbe wie im Gruppen-Tab). Früher war das eine nur
  // lokale Ansicht: Übersicht, Ranglisten und Farben sprangen um, Spieler-Details, Elo,
  // Head-to-Head und Spiel-Analysen blieben aber an der aktiven Gruppe hängen - wer die
  // Statistik einer anderen Gruppe sehen wollte, musste doch in den Gruppen-Tab (Wunsch des
  // Users, 06.10.2026: umstellbar direkt hier).
  readonly effectiveViewedGroupId = computed(() => this.groupService.groupId());

  setViewedGroup(groupId: string): void {
    this.selectedCommanderDetail.set(null);
    this.selectedDeckDetail.set(null);
    this.groupService.switchGroup(groupId);
  }

  /** Matches der lokal betrachteten Gruppe (Default: echte aktive Gruppe, kein Extra-Request). */
  private readonly viewedMatches = signal<Match[]>([]);

  private readonly viewedYearFilteredMatches = computed<Match[]>(() =>
    this.applyYearFilter(this.viewedMatches()),
  );
  readonly viewedFilteredMatches = computed<Match[]>(() =>
    this.applyFormatFilter(this.applyModeFilter(this.viewedYearFilteredMatches())),
  );

  /**
   * Echte Match-Zahl: der Excel-Import legt je Match mehrere Datensätze an (Sieger + je Verlierer
   * mit Platzhalter); diese Duplikate zählen nicht.
   */
  readonly totalGames = computed(
    () => this.viewedFilteredMatches().filter((m) => !isImportLossDuplicate(m)).length,
  );

  readonly playerStats = computed<PlayerStats[]>(() => {
    const stats = new Map<string, { games: number; wins: number }>();
    for (const match of this.viewedFilteredMatches()) {
      for (const p of match.players) {
        const entry = stats.get(p.name) ?? { games: 0, wins: 0 };
        entry.games++;
        if (this.isPlayerWinner(match, p.name)) entry.wins++;
        stats.set(p.name, entry);
      }
    }
    return [...stats.entries()]
      .map(([name, s]) => ({ name, ...s, winRate: s.games > 0 ? (s.wins / s.games) * 100 : 0 }))
      .sort((a, b) => b.wins - a.wins || b.winRate - a.winRate);
  });

  /** Vom Host eingestellte Mindestspielzahl für die aktuelle Modus-Auswahl, sonst null. */
  private readonly qualificationOverride = computed<number | null>(() => {
    const key = this.isSingleMode() ?? 'Alle';
    return this.mtg.qualificationSettings().get(key) ?? null;
  });

  /**
   * Mindestanzahl Spiele (im aktuellen Filter) für die Winrate-Rangliste; ohne Override bei "Alle
   * Modi" höher.
   */
  readonly qualificationThreshold = computed(
    () => this.qualificationOverride() ?? (this.isSingleMode() === null ? 10 : 3)
  );

  /** Rangliste: nur qualifizierte Spieler (>= Schwelle), sortiert nach Winrate statt nach Siegen. */
  readonly rankedPlayerStats = computed<PlayerStats[]>(() =>
    this.playerStats()
      .filter((p) => p.games >= this.qualificationThreshold())
      .sort(compareBySortMode(this.playerSortMode()))
  );

  /** Seitenweise Anzeige der Spieler-Rangliste (10 pro Seite). */
  readonly playerPage = signal(0);
  readonly playerTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.rankedPlayerStats().length / PAGE_SIZE))
  );
  readonly playerEffectivePage = computed(() =>
    Math.min(this.playerPage(), this.playerTotalPages() - 1)
  );
  readonly pagedPlayerStats = computed(() => {
    const start = this.playerEffectivePage() * PAGE_SIZE;
    return this.rankedPlayerStats().slice(start, start + PAGE_SIZE);
  });

  // Erste drei aufs Siegertreppchen (ui/podium), der Rest bleibt Liste - siehe rank-sort.ts.
  private readonly playerSplit = computed(() =>
    splitPodium(this.pagedPlayerStats(), this.playerEffectivePage())
  );
  readonly pagedPlayerStatsRest = computed(() => this.playerSplit().rest);
  readonly playerRestOffset = computed(() =>
    podiumRestOffset(this.playerEffectivePage(), PAGE_SIZE)
  );
  readonly playerPodium = computed<PodiumEntry[]>(() =>
    this.playerSplit().podium.map((p) => ({
      key: p.name,
      name: p.name,
      detail: `${p.wins} / ${p.games} ${this.i18n.t('stats.wins')}`,
      value: `${Math.round(p.winRate)}%`,
      imageUrl: this.mtg.playerAvatars()[p.name] ?? null,
    }))
  );



  /** Spieler unterhalb der Schwelle, mit Anzeige wie viele Spiele noch bis zur Qualifikation fehlen. */
  readonly playersInQualification = computed(() =>
    this.playerStats()
      .filter((p) => p.games < this.qualificationThreshold())
      .map((p) => ({ ...p, gamesNeeded: this.qualificationThreshold() - p.games }))
      .sort((a, b) => a.gamesNeeded - b.gamesNeeded || a.name.localeCompare(b.name))
  );

  /** Seitenweise Anzeige der Spieler-Qualifikationsliste (10 pro Seite). */
  readonly playerQualPage = signal(0);
  readonly playerQualTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.playersInQualification().length / PAGE_SIZE))
  );
  readonly playerQualEffectivePage = computed(() =>
    Math.min(this.playerQualPage(), this.playerQualTotalPages() - 1)
  );
  readonly pagedPlayersInQualification = computed(() => {
    const start = this.playerQualEffectivePage() * PAGE_SIZE;
    return this.playersInQualification().slice(start, start + PAGE_SIZE);
  });



  /** Ob die Spielerliste in "Spiele bis zur Qualifikation" ausgeklappt ist - analog zu showPlayerDecks/showPlayerCommanders. */
  readonly showQualification = signal(false);

  toggleQualification(): void {
    this.showQualification.update((v) => !v);
  }

  /**
   * Commander-Spiele ohne eigenes (Nicht-Precon-)Deck, zusammengefasst je Commander - Precons sind
   * austauschbar. Eigene Decks laufen getrennt in deckStats().
   */
  readonly commanderStats = computed<CommanderStats[]>(() => {
    const stats = new Map<string, { games: number; wins: number; playedBy: Set<string> }>();
    for (const match of this.viewedFilteredMatches()) {
      for (const p of match.players) {
        if (!p.commander) continue;
        if (p.deckId && p.deckIsPrecon !== true) continue;
        const entry = stats.get(p.commander) ?? { games: 0, wins: 0, playedBy: new Set<string>() };
        entry.games++;
        entry.playedBy.add(p.name);
        if (this.isPlayerWinner(match, p.name)) entry.wins++;
        stats.set(p.commander, entry);
      }
    }
    return [...stats.entries()]
      .map(([commander, s]) => ({
        commander,
        games: s.games,
        wins: s.wins,
        winRate: s.games > 0 ? (s.wins / s.games) * 100 : 0,
        playedBy: [...s.playedBy],
      }))
      .sort((a, b) => b.wins - a.wins || b.winRate - a.winRate);
  });

  /** Mindestanzahl Spiele für die Decks&Commander-Rangliste - Host-Override falls gesetzt, sonst Standard 5. */
  readonly commanderQualificationThreshold = computed(() => this.qualificationOverride() ?? 5);
  /** Gleiche Schwelle, ein Alias für Vorlagen, die noch den alten Deck-spezifischen Namen nutzen. */
  readonly deckQualificationThreshold = this.commanderQualificationThreshold;

  // --- Deck-Statistiken ---

  /** Findet zu einer Account-User-ID/players.id den Spielernamen in der aktuellen Gruppe (für "ausgeliehen von X"). */
  private deckOwnerName(ownerId: string | undefined, ownerPlayerId?: string): string | null {
    return this.mtg.deckOwnerName(ownerId, ownerPlayerId);
  }

  /**
   * Statistik je eigenem (Nicht-Precon-)Deck, egal wer es spielte. Precons siehe commanderStats().
   */
  readonly deckStats = computed<DeckStats[]>(() => {
    const stats = new Map<
      string,
      {
        deckName: string;
        isPrecon: boolean;
        ownerId?: string;
        ownerPlayerId?: string;
        games: number;
        wins: number;
        pilots: Set<string>;
        commander?: string;
      }
    >();
    for (const match of this.viewedFilteredMatches()) {
      for (const p of match.players) {
        if (!p.deckId || p.deckIsPrecon === true) continue;
        const entry = stats.get(p.deckId) ?? {
          deckName: p.deckName ?? 'Unbekanntes Deck',
          isPrecon: p.deckIsPrecon ?? false,
          ownerId: p.deckOwnerId,
          ownerPlayerId: p.deckOwnerPlayerId,
          games: 0,
          wins: 0,
          pilots: new Set<string>(),
        };
        entry.games++;
        entry.pilots.add(p.name);
        if (p.commander) entry.commander = p.commander;
        if (this.isPlayerWinner(match, p.name)) entry.wins++;
        stats.set(p.deckId, entry);
      }
    }
    const stored = this.storedDeckCommanders();
    const geloescht = this.deletedDeckIds();
    return [...stats.entries()]
      .map(([deckId, s]) => {
        const ownerName = this.deckOwnerName(s.ownerId, s.ownerPlayerId);
        const storedCommander = stored.get(deckId);
        return {
          deckId,
          deckName: s.deckName,
          isPrecon: s.isPrecon,
          isDeleted: geloescht.has(deckId),
          games: s.games,
          wins: s.wins,
          winRate: s.games > 0 ? (s.wins / s.games) * 100 : 0,
          pilots: [...s.pilots].map((name) => ({
            name,
            borrowed: ownerName !== null && name !== ownerName,
          })),
          commander: storedCommander?.name ?? s.commander,
          commanderImageUrl: storedCommander?.imageUrl ?? null,
        };
      })
      .sort((a, b) => b.wins - a.wins || b.winRate - a.winRate);
  });

  /**
   * Verschiedene Commander (eigene Decks + Precons/Unverlinkte), angezeigt an der "Decks &
   * Commander"-Rangliste.
   */
  readonly distinctCommanderCount = computed(() => {
    const names = new Set<string>();
    for (const d of this.deckStats()) {
      if (d.commander) names.add(d.commander);
    }
    for (const c of this.commanderStats()) names.add(c.commander);
    return names.size;
  });

  /**
   * Verschiedene gespielte Decks für die Übersicht = Zeilenzahl der "Decks & Commander"-Rangliste
   * (Precon/unverlinkter Commander zählt als ein Deck).
   */
  readonly distinctDeckCount = computed(() => this.combinedDeckCommanderStats().length);

  /**
   * Decks und Commander in einer Rangliste: eigene Decks einzeln, Precons/Unverlinkte je Commander.
   */
  readonly combinedDeckCommanderStats = computed<CombinedRankEntry[]>(() => [
    ...this.deckStats().map((d) => ({
      key: `d:${d.deckId}`,
      name: d.deckName,
      cardName: d.commander,
      cardImageUrl: d.commanderImageUrl,
      games: d.games,
      wins: d.wins,
      winRate: d.winRate,
      playedBy: d.pilots,
      deckId: d.deckId,
      isDeleted: d.isDeleted,
    })),
    ...this.commanderStats().map((c) => ({
      key: `c:${c.commander}`,
      name: c.commander,
      cardName: c.commander,
      cardImageUrl: this.storedCommanderImageByName().get(c.commander.toLowerCase()),
      games: c.games,
      wins: c.wins,
      winRate: c.winRate,
      playedBy: c.playedBy.map((name) => ({ name, borrowed: false })),
    })),
  ]);

  /** Öffnet ein Deck aus der Rangliste in der Deck-Detailansicht (root-level Overlay, funktioniert von jedem Tab aus). */
  async openDeckFromRanking(deckId: string): Promise<void> {
    const deck = await this.deckService.getDeckById(deckId);
    // Ein Grabstein hat keine Kartenliste mehr - die Ansicht bliebe leer. Der Knopf wird für solche
    // Einträge gar nicht erst angezeigt, das hier ist die Absicherung gegen veraltete Daten.
    if (deck && !deck.deletedAt) this.viewer.open(deck);
  }

  /** Commander-Name → hinterlegtes Bild, damit auch commanderStats() gewählte Artworks zeigt. */
  private readonly storedCommanderImageByName = computed(() => {
    const map = new Map<string, string>();
    for (const { name, imageUrl } of this.storedDeckCommanders().values()) {
      if (imageUrl && !map.has(name.toLowerCase())) map.set(name.toLowerCase(), imageUrl);
    }
    return map;
  });

  /** Rangliste: nur qualifizierte Decks/Commander (>= Schwelle), sortiert nach Winrate. */
  readonly rankedCombinedStats = computed<CombinedRankEntry[]>(() =>
    this.combinedDeckCommanderStats()
      .filter((e) => e.games >= this.commanderQualificationThreshold())
      .sort(compareBySortMode(this.deckSortMode()))
  );

  /** Seitenweise Anzeige der Decks&Commander-Rangliste (10 pro Seite). */
  readonly combinedPage = signal(0);
  readonly combinedTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.rankedCombinedStats().length / PAGE_SIZE))
  );
  readonly combinedEffectivePage = computed(() =>
    Math.min(this.combinedPage(), this.combinedTotalPages() - 1)
  );
  readonly pagedCombinedStats = computed(() => {
    const start = this.combinedEffectivePage() * PAGE_SIZE;
    return this.rankedCombinedStats().slice(start, start + PAGE_SIZE);
  });

  // Erste drei aufs Siegertreppchen (ui/podium), der Rest bleibt Liste - siehe rank-sort.ts.
  private readonly combinedSplit = computed(() =>
    splitPodium(this.pagedCombinedStats(), this.combinedEffectivePage())
  );
  readonly pagedCombinedStatsRest = computed(() => this.combinedSplit().rest);
  readonly combinedRestOffset = computed(() =>
    podiumRestOffset(this.combinedEffectivePage(), PAGE_SIZE)
  );
  readonly combinedPodium = computed<PodiumEntry[]>(() =>
    this.combinedSplit().podium.map((e) => ({
      key: e.key,
      name: e.name,
      detail: `${e.wins} / ${e.games} ${this.i18n.t('stats.wins')}`,
      value: `${Math.round(e.winRate)}%`,
      imageUrl: this.commanderImage(e.cardName, e.cardImageUrl),
    }))
  );

  /** Klick auf einen Treppchen-Platz der Decks&Commander-Rangliste zeigt die Karte groß - dasselbe
   * wie ein Klick auf das Vorschaubild in der Liste darunter. */
  openPodiumCard(entry: PodiumEntry): void {
    if (entry.imageUrl) {
      this.cardPreview.open(entry.imageUrl, this.commanderBackImage(entry.name), entry.name);
    }
  }



  /** Decks/Commander unterhalb der Schwelle, mit Anzeige wie viele Spiele noch bis zur Qualifikation fehlen. */
  readonly combinedInQualification = computed(() =>
    this.combinedDeckCommanderStats()
      .filter((e) => e.games < this.commanderQualificationThreshold())
      .map((e) => ({ ...e, gamesNeeded: this.commanderQualificationThreshold() - e.games }))
      .sort((a, b) => a.gamesNeeded - b.gamesNeeded || a.name.localeCompare(b.name))
  );

  /** Seitenweise Anzeige der Decks&Commander-Qualifikationsliste (10 pro Seite). */
  readonly combinedQualPage = signal(0);
  readonly combinedQualTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.combinedInQualification().length / PAGE_SIZE))
  );
  readonly combinedQualEffectivePage = computed(() =>
    Math.min(this.combinedQualPage(), this.combinedQualTotalPages() - 1)
  );
  readonly pagedCombinedInQualification = computed(() => {
    const start = this.combinedQualEffectivePage() * PAGE_SIZE;
    return this.combinedInQualification().slice(start, start + PAGE_SIZE);
  });



  /** Ob die nicht-qualifizierten Decks/Commander (Qualifikations-Liste) eingeblendet sind. */
  readonly showDeckQualification = signal(false);

  toggleDeckQualification(): void {
    this.showDeckQualification.update((v) => !v);
  }

  // --- Gruppenweite Lieblingsfarben & Farbkombinationen ---

  /** Umschalter wie im Profil-Tab: "games" gewichtet nach tatsächlich gespielten Partien je Deck
   * (Standard), "decks" zählt jedes Deck nur 1x, unabhängig davon, wie oft es gespielt wurde. */
  readonly colorStatsWeightMode = signal<ColorStatsWeightMode>('games');

  setColorStatsWeightMode(mode: ColorStatsWeightMode): void {
    this.colorStatsWeightMode.set(mode);
  }

  /** Wählt je nach aktivem Modus den passenden Zählwert eines Eintrags aus - identisch zu countFor() im Profil-Tab. */
  readonly colorCountFor = (entry: { gameCount: number; deckCount: number }): number =>
    this.colorStatsWeightMode() === 'games' ? entry.gameCount : entry.deckCount;

  /**
   * Farben und Farbkombinationen aller (Nicht-Precon-)Decks der betrachteten Gruppe in den
   * gefilterten Matches, nach Partien und nach Decks gezählt. Ohne eigene DB-Abfrage: die
   * Farbidentität kommt aus deckColorIdentities(); nicht lesbare (private) Decks fehlen.
   */
  private readonly groupColorAndComboStats = computed(() => {
    const identities = this.deckColorIdentities();
    const colorCounts = new Map<
      string,
      { gameCount: number; deckCount: number; decks: Set<string> }
    >();
    const comboCounts = new Map<
      string,
      { colors: string[]; gameCount: number; deckCount: number; decks: Set<string> }
    >();

    for (const match of this.viewedFilteredMatches()) {
      for (const p of match.players) {
        if (!p.deckId || p.deckIsPrecon === true) continue;
        const identity = identities.get(p.deckId);
        if (identity === undefined) continue;

        const colors = FILTER_COLORS.filter((c) => identity.includes(c));
        for (const color of colors.length > 0 ? colors : [COLORLESS]) {
          const entry = colorCounts.get(color) ?? {
            gameCount: 0,
            deckCount: 0,
            decks: new Set<string>(),
          };
          entry.gameCount++;
          entry.decks.add(p.deckId);
          entry.deckCount = entry.decks.size;
          colorCounts.set(color, entry);
        }

        const comboKey = colors.join('');
        const combo = comboCounts.get(comboKey) ?? {
          colors,
          gameCount: 0,
          deckCount: 0,
          decks: new Set<string>(),
        };
        combo.gameCount++;
        combo.decks.add(p.deckId);
        combo.deckCount = combo.decks.size;
        comboCounts.set(comboKey, combo);
      }
    }

    // Immer alle sechs Achsen, auch mit 0 - das Netzdiagramm braucht eine feste Achsenmenge.
    const colorRanking: GroupColorEntry[] = COLOR_AXES.map((color) => ({
      color,
      gameCount: colorCounts.get(color)?.gameCount ?? 0,
      deckCount: colorCounts.get(color)?.deckCount ?? 0,
    }));
    const colorComboRanking: GroupColorComboEntry[] = [...comboCounts.values()].map((c) => ({
      colors: c.colors,
      gameCount: c.gameCount,
      deckCount: c.deckCount,
    }));

    return { colorRanking, colorComboRanking };
  });

  /** Farbverteilung als Netzdiagramm - feste Achsenreihenfolge, siehe COLOR_AXES. */
  readonly groupColorRadarChart = computed<RadarChartDatum[]>(() =>
    this.groupColorAndComboStats().colorRanking.map((stat) => ({
      label: this.colorLabel(stat.color),
      value: this.colorCountFor(stat),
      color: this.colorVar(stat.color),
      symbol: stat.color,
    })),
  );

  readonly rankedGroupColorCombos = computed(() =>
    [...this.groupColorAndComboStats().colorComboRanking].sort(
      (a, b) => this.colorCountFor(b) - this.colorCountFor(a),
    ),
  );

  /** Höchster Zählwert für die relative Balkenbreite in der Farbkombinations-Rangliste. */
  readonly maxGroupColorComboCount = computed(() =>
    Math.max(1, ...this.rankedGroupColorCombos().map((c) => this.colorCountFor(c))),
  );

  // Farb-Hilfen für die Vorlage, Logik in color-combo-names.ts.
  readonly colorVar = colorVar;
  readonly colorLabel = (color: string): string => colorLabel(this.i18n, color);
  readonly colorComboLabel = (colors: string[]): string => colorComboLabel(this.i18n, colors);
  readonly comboColors = (colors: string[]): string[] => sortColors(colors);

  /** Umschalter Gruppe/Global; "Global" rendert GlobalStats (funktioniert ohne Login). */
  readonly viewScope = signal<StatsScope>('group');

  setViewScope(scope: StatsScope): void {
    this.viewScope.set(scope);
  }

  // --- Spieler-Details ---

  readonly selectedPlayer = signal<string | null>(null);
  readonly selectedCommanderDetail = signal<string | null>(null);
  readonly selectedDeckDetail = signal<string | null>(null);

  /** Suchfeld für die Spielerauswahl unten - ersetzt die frühere Chip-Wand mit einem Klick pro
   * Spieler, die bei großen Gruppen (50+ Leute) den halben Screen gefüllt hat. */
  readonly playerSearchQuery = signal('');

  readonly filteredPlayersForDetail = computed(() => {
    const query = this.playerSearchQuery().trim().toLowerCase();
    const all = this.mtg.allPlayers();
    if (!query) return all;
    return all.filter((p) => p.toLowerCase().includes(query));
  });

  selectPlayer(player: string): void {
    const isSame = this.selectedPlayer() === player;
    this.selectedPlayer.set(isSame ? null : player);
    this.playerSearchQuery.set('');
    this.selectedCommanderDetail.set(null);
    this.selectedDeckDetail.set(null);
    this.showPlayerDecks.set(false);
    this.showPlayerCommanders.set(false);
  }

  toggleCommanderDetail(commander: string): void {
    if (this.isSingleMode() !== null) return;
    this.selectedCommanderDetail.set(
      this.selectedCommanderDetail() === commander ? null : commander
    );
  }

  toggleDeckDetail(deckId: string): void {
    if (this.isSingleMode() !== null) return;
    this.selectedDeckDetail.set(this.selectedDeckDetail() === deckId ? null : deckId);
  }

  private readonly selectedPlayerMatches = computed<Match[]>(() => {
    const player = this.selectedPlayer();
    if (!player) return [];
    return this.filteredMatches().filter((m) => m.players.some((p) => p.name === player));
  });

  readonly playerTotalGames = computed(() => this.selectedPlayerMatches().length);

  /** Nur Matches, in denen für den gewählten Spieler eine Platzierung eingetragen wurde (rein optionale Zusatz-Info). */
  private readonly playerPlacements = computed<number[]>(() => {
    const player = this.selectedPlayer();
    if (!player) return [];
    return this.selectedPlayerMatches()
      .map((m) => m.players.find((p) => p.name === player)?.placement)
      .filter((v): v is number => v != null);
  });

  readonly playerPlacementCount = computed(() => this.playerPlacements().length);

  readonly playerAveragePlacement = computed(() => {
    const placements = this.playerPlacements();
    if (placements.length === 0) return null;
    return placements.reduce((sum, p) => sum + p, 0) / placements.length;
  });

  readonly playerTotalWins = computed(() => {
    const player = this.selectedPlayer();
    if (!player) return 0;
    return this.selectedPlayerMatches().filter((m) => this.isPlayerWinner(m, player)).length;
  });

  readonly playerWinRate = computed(() => {
    const games = this.playerTotalGames();
    return games > 0 ? (this.playerTotalWins() / games) * 100 : 0;
  });

  readonly playerModeStats = computed(() => {
    const player = this.selectedPlayer();
    if (!player) return [];

    const stats = new Map<GameMode, { games: number; wins: number }>();
    for (const match of this.selectedPlayerMatches()) {
      const entry = stats.get(match.mode) ?? { games: 0, wins: 0 };
      entry.games++;
      if (this.isPlayerWinner(match, player)) entry.wins++;
      stats.set(match.mode, entry);
    }

    return [...stats.entries()]
      .map(([mode, s]) => ({ mode, ...s, winRate: s.games > 0 ? (s.wins / s.games) * 100 : 0 }))
      .sort((a, b) => b.games - a.games);
  });

  readonly playerFormatStats = computed(() => {
    const player = this.selectedPlayer();
    if (!player) return [];

    const stats = new Map<DeckFormat, { games: number; wins: number }>();
    for (const match of this.selectedPlayerMatches()) {
      if (match.format === null) continue; // Spezialevent hat kein Format, zählt hier nicht mit
      const entry = stats.get(match.format) ?? { games: 0, wins: 0 };
      entry.games++;
      if (this.isPlayerWinner(match, player)) entry.wins++;
      stats.set(match.format, entry);
    }

    return [...stats.entries()]
      .map(([format, s]) => ({ format, ...s, winRate: s.games > 0 ? (s.wins / s.games) * 100 : 0 }))
      .sort((a, b) => b.games - a.games);
  });

  readonly playerCommanderStats = computed(() => {
    const player = this.selectedPlayer();
    if (!player) return [];

    const stats = new Map<string, { games: number; wins: number }>();
    for (const match of this.selectedPlayerMatches()) {
      const entry0 = match.players.find((p) => p.name === player);
      if (!entry0?.commander) continue;
      const entry = stats.get(entry0.commander) ?? { games: 0, wins: 0 };
      entry.games++;
      if (this.isPlayerWinner(match, player)) entry.wins++;
      stats.set(entry0.commander, entry);
    }

    return [...stats.entries()]
      .map(([commander, s]) => ({
        commander,
        ...s,
        winRate: s.games > 0 ? (s.wins / s.games) * 100 : 0,
      }))
      .sort(compareBySortMode(this.playerCommanderSortMode()));
  });

  /** Deck-Stats des ausgewählten Spielers (eigene + geliehene Decks, die er selbst gespielt hat). */
  readonly playerDeckStats = computed(() => {
    const player = this.selectedPlayer();
    if (!player) return [];

    const stats = new Map<
      string,
      {
        deckName: string;
        isPrecon: boolean;
        ownerId?: string;
        ownerPlayerId?: string;
        games: number;
        wins: number;
        commander?: string;
      }
    >();
    for (const match of this.selectedPlayerMatches()) {
      const entry0 = match.players.find((p) => p.name === player);
      if (!entry0?.deckId) continue;
      const entry = stats.get(entry0.deckId) ?? {
        deckName: entry0.deckName ?? 'Unbekanntes Deck',
        isPrecon: entry0.deckIsPrecon ?? false,
        ownerId: entry0.deckOwnerId,
        ownerPlayerId: entry0.deckOwnerPlayerId,
        games: 0,
        wins: 0,
      };
      entry.games++;
      if (entry0.commander) entry.commander = entry0.commander;
      if (this.isPlayerWinner(match, player)) entry.wins++;
      stats.set(entry0.deckId, entry);
    }

    const stored = this.storedDeckCommanders();
    const geloescht = this.deletedDeckIds();
    return [...stats.entries()]
      .map(([deckId, s]) => {
        const ownerName = this.deckOwnerName(s.ownerId, s.ownerPlayerId);
        const storedCommander = stored.get(deckId);
        return {
          deckId,
          deckName: s.deckName,
          isPrecon: s.isPrecon,
          isDeleted: geloescht.has(deckId),
          games: s.games,
          wins: s.wins,
          winRate: s.games > 0 ? (s.wins / s.games) * 100 : 0,
          borrowed: ownerName !== null && ownerName !== player,
          ownerName,
          commander: storedCommander?.name ?? s.commander,
          commanderImageUrl: storedCommander?.imageUrl ?? null,
        };
      })
      .sort(compareBySortMode(this.playerDeckSortMode()));
  });

  /** Ob die ausklappbaren "Decks"/"Gespielte Commander"-Bereiche in den Spieler-Details offen sind. */
  readonly showPlayerDecks = signal(false);
  readonly showPlayerCommanders = signal(false);

  togglePlayerDecks(): void {
    this.showPlayerDecks.update((v) => !v);
  }

  togglePlayerCommanders(): void {
    this.showPlayerCommanders.update((v) => !v);
  }

  readonly commanderDetailStats = computed(() => {
    const player = this.selectedPlayer();
    const commander = this.selectedCommanderDetail();
    if (!player || !commander) return [];

    const stats = new Map<GameMode, { games: number; wins: number }>();
    for (const match of this.filteredMatches()) {
      const entry0 = match.players.find((p) => p.name === player);
      if (!entry0 || entry0.commander !== commander) continue;
      const entry = stats.get(match.mode) ?? { games: 0, wins: 0 };
      entry.games++;
      if (this.isPlayerWinner(match, player)) entry.wins++;
      stats.set(match.mode, entry);
    }

    return [...stats.entries()]
      .map(([mode, s]) => ({ mode, ...s, winRate: s.games > 0 ? (s.wins / s.games) * 100 : 0 }))
      .sort((a, b) => b.games - a.games);
  });

  /** Wie commanderDetailStats(), aber für ein aufgeklapptes Deck statt einen Commander. */
  readonly deckDetailStats = computed(() => {
    const player = this.selectedPlayer();
    const deckId = this.selectedDeckDetail();
    if (!player || !deckId) return [];

    const stats = new Map<GameMode, { games: number; wins: number }>();
    for (const match of this.filteredMatches()) {
      const entry0 = match.players.find((p) => p.name === player);
      if (!entry0 || entry0.deckId !== deckId) continue;
      const entry = stats.get(match.mode) ?? { games: 0, wins: 0 };
      entry.games++;
      if (this.isPlayerWinner(match, player)) entry.wins++;
      stats.set(match.mode, entry);
    }

    return [...stats.entries()]
      .map(([mode, s]) => ({ mode, ...s, winRate: s.games > 0 ? (s.wins / s.games) * 100 : 0 }))
      .sort((a, b) => b.games - a.games);
  });

  // --- Head-to-Head ---

  /** Ob die Head-to-Head-Sektion ausgeklappt ist - standardmäßig eingeklappt, da nicht jeder das immer sehen will. */
  readonly showH2h = signal(false);

  toggleH2h(): void {
    this.showH2h.update((v) => !v);
  }

  readonly h2hPlayerA = signal<string | null>(null);
  readonly h2hPlayerB = signal<string | null>(null);

  setH2hPlayerA(player: string): void {
    this.h2hPlayerA.set(player || null);
  }

  setH2hPlayerB(player: string): void {
    this.h2hPlayerB.set(player || null);
  }

  /**
   * Head-to-Head nur mit live getrackten Spielen (ab LIVE_TRACKING_START_DATE) - Excel-Importe
   * bilden Gruppenrunden ab und taugen nicht für 1-gegen-1.
   */
  private readonly h2hMatches = computed<Match[]>(() => {
    const a = this.h2hPlayerA();
    const b = this.h2hPlayerB();
    if (!a || !b || a === b) return [];
    return this.filteredMatches().filter(
      (m) =>
        new Date(m.date) >= LIVE_TRACKING_START_DATE &&
        m.players.some((p) => p.name === a) &&
        m.players.some((p) => p.name === b)
    );
  });

  readonly h2hGames = computed(() => this.h2hMatches().length);

  readonly h2hWinsA = computed(() => {
    const a = this.h2hPlayerA();
    if (!a) return 0;
    return this.h2hMatches().filter((m) => this.isPlayerWinner(m, a)).length;
  });

  readonly h2hWinsB = computed(() => {
    const b = this.h2hPlayerB();
    if (!b) return 0;
    return this.h2hMatches().filter((m) => this.isPlayerWinner(m, b)).length;
  });

  /** Spiele, die weder A noch B gewonnen hat (bei mehr als 2 Teilnehmern im Match möglich). */
  readonly h2hWinsOther = computed(
    () => this.h2hGames() - this.h2hWinsA() - this.h2hWinsB()
  );

  /**
   * Direktvergleich als ein geteilter Balken: zeigt auf einen Blick, wer wie deutlich vorn liegt.
   */
  readonly h2hSegments = computed<SplitSegment[]>(() => [
    { label: this.h2hPlayerA() ?? '', value: this.h2hWinsA(), color: 'var(--series-1)' },
    { label: this.h2hPlayerB() ?? '', value: this.h2hWinsB(), color: 'var(--series-2)' },
    {
      label: this.i18n.t('stats.h2h.otherWinner'),
      value: this.h2hWinsOther(),
      color: 'var(--series-neutral)',
    },
  ]);

  private h2hCommanderStatsFor(player: string): { commander: string; games: number; wins: number; winRate: number }[] {
    const stats = new Map<string, { games: number; wins: number }>();
    for (const match of this.h2hMatches()) {
      const entry0 = match.players.find((p) => p.name === player);
      if (!entry0?.commander) continue;
      const entry = stats.get(entry0.commander) ?? { games: 0, wins: 0 };
      entry.games++;
      if (this.isPlayerWinner(match, player)) entry.wins++;
      stats.set(entry0.commander, entry);
    }
    return [...stats.entries()]
      .map(([commander, s]) => ({ commander, ...s, winRate: s.games > 0 ? (s.wins / s.games) * 100 : 0 }))
      .sort((a, b) => b.games - a.games);
  }

  readonly h2hCommanderStatsA = computed(() => {
    const a = this.h2hPlayerA();
    return a ? this.h2hCommanderStatsFor(a) : [];
  });

  readonly h2hCommanderStatsB = computed(() => {
    const b = this.h2hPlayerB();
    return b ? this.h2hCommanderStatsFor(b) : [];
  });

  private isPlayerWinner(match: Match, playerName: string): boolean {
    const player = match.players.find((p) => p.name === playerName);
    return isMatchWinner(match.mode, match.winner, playerName, player?.team, player?.isArchenemy);
  }

  readonly medal = medalFor;

  // --- Hard-Reset (Danger Zone) ---

  readonly showResetConfirm = signal(false);
  readonly resetConfirmText = signal('');

  openResetConfirm(): void {
    this.showResetConfirm.set(true);
    this.resetConfirmText.set('');
  }

  closeResetConfirm(): void {
    this.showResetConfirm.set(false);
    this.resetConfirmText.set('');
    this.resetError.set('');
  }

  updateResetConfirmText(value: string): void {
    this.resetConfirmText.set(value);
  }

  readonly canConfirmReset = computed(() => this.i18n.isDeleteConfirmed(this.resetConfirmText()));
  readonly resetError = signal('');
  readonly resetBusy = signal(false);

  async confirmReset(): Promise<void> {
    if (!this.canConfirmReset()) return;

    this.resetBusy.set(true);
    this.resetError.set('');

    const result = await this.mtg.resetAllData();

    this.resetBusy.set(false);

    if (!result.success) {
      this.resetError.set(result.error ?? this.i18n.t('stats.msg.unknownDeleteError'));
      return;
    }

    this.closeResetConfirm();
    this.selectedPlayer.set(null);
    this.selectedCommanderDetail.set(null);
    this.selectedDeckDetail.set(null);
  }
}
