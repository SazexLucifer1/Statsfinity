// NEU (komplette Datei)
import { Component, computed, effect, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
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
  ExcelImportService,
  IMPORT_LOSS_PLACEHOLDER,
  IMPORT_ARCHENEMY_LOSS_PLACEHOLDER,
} from '../excel-import.service';
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
import { isPlayerWinner as isMatchWinner } from '../match-utils';
import { Meter } from '../ui/meter/meter';
import { Pager } from '../ui/pager/pager';
import { SplitBar, SplitSegment } from '../ui/split-bar/split-bar';
import { RadarChart, RadarChartDatum } from '../ui/radar-chart/radar-chart';
import { ManaSymbol } from '../ui/mana-symbol/mana-symbol';
import { MultiSelect } from '../ui/multi-select/multi-select';
import { colorComboName, sortColors } from '../color-combo-names';
import { COLORLESS, FILTER_COLORS } from '../color-filter-match';
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

export type StatsViewMode = 'stats' | 'tournaments';
export type ColorStatsWeightMode = 'games' | 'decks';
export type StatsScope = 'group' | 'global';

const PAGE_SIZE = 10;

/**
 * Achsen des Farb-Netzdiagramms: die fünf Manafarben in WUBRG-Reihenfolge, farblos als sechste.
 * Bewusst fest und NIE nach Häufigkeit sortiert - dieselbe Begründung wie in profile-tab.ts, von
 * wo diese Konstante 1:1 übernommen ist (Komponenten-Styles/Konstanten sind gekapselt, eine
 * gemeinsame Datei für eine Zeile wäre hier Overengineering).
 */
const COLOR_RADAR_AXES: readonly string[] = [...FILTER_COLORS, COLORLESS];

/** Farb- und Kombinations-Zählung für die Gruppen-Statistik - siehe groupColorAndComboStats(). */
interface GroupColorEntry {
  color: (typeof COLOR_RADAR_AXES)[number];
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

interface ImportMappingRow {
  sheetName: string;
  /** '' = überspringen, '__NEW__' = neuer Spieler (siehe newName), sonst ein Name aus mtg.allPlayers() */
  selection: string;
  newName: string;
}

@Component({
  selector: 'app-stats-tab',
  imports: [
    DecimalPipe,
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
   Icon],
  templateUrl: './stats-tab.html',
  styleUrl: './stats-tab.scss',
})
export class StatsTab {
  readonly mtg = inject(MtgService);
  readonly groupService = inject(GroupService);
  private readonly excelImport = inject(ExcelImportService);
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
   * Deck-ID -> im Deck selbst hinterlegter Commander + Bild (deck_cards.is_commander/image_url) -
   * hat Vorrang vor dem in Partien hinterlegten Namen (siehe deckStats()), da der markierte
   * Commander die aktuelle Wahrheit ist und sich seit alten Matches geändert haben kann, und weil
   * der in Matches erfasste Name manchmal fehlt (z.B. Deck nie über den Match-Tab zugewiesen).
   */
  private readonly storedDeckCommanders = signal<Map<string, { name: string; imageUrl: string | null }>>(new Map());

  /**
   * Deck-IDs, hinter denen nur noch ein Grabstein steht (der Besitzer hat das Deck gelöscht, siehe
   * DeckService.deleteDeck()). Die Partien zählen unverändert weiter - die Rangliste kennzeichnet
   * solche Einträge nur und bietet kein "Ansehen" mehr an, da es keine Kartenliste mehr gibt.
   */
  private readonly deletedDeckIds = signal<Set<string>>(new Set());

  /** Deck-ID -> Farbidentität, für die gruppenweite Lieblingsfarben-/Farbkombinations-Statistik
   * (siehe groupColorAndComboStats()) - nur für Nicht-Precon-Decks geladen, siehe Effect unten. */
  private readonly deckColorIdentities = signal<Map<string, string[]>>(new Map());

  constructor() {
    effect(() => {
      // Vereinigung aus der echten aktiven Gruppe (bedient playerDeckStats() im Spieler-Details-
      // Bereich) und der lokal betrachteten Gruppe (bedient deckStats() unten) - reiner Bildcache,
      // ein Zuviel an geladenen IDs schadet nicht.
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
      // Precons bewusst außen vor - dieselbe Begründung wie im Profil-Tab (CardAndColorStats):
      // sie sind nicht selbst zusammengestellt, sollen also nicht in die Lieblingsfarben einfließen.
      // Liest viewedFilteredMatches() statt filteredMatches(), da groupColorAndComboStats() jetzt
      // dort hängt (folgt der lokal gewählten Gruppe, siehe "Lokaler Gruppen-Wechsler" oben).
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
      // Lädt viewedMatches() - siehe "Lokaler Gruppen-Wechsler" oben. mtg.history() wird in jedem
      // Zweig gelesen (auch wenn im global-/Fremdgruppen-Zweig nicht direkt verwendet), damit ein
      // neu erfasstes Match in der echten aktiven Gruppe die lokal betrachtete Fremdgruppe/Global-
      // Ansicht durch Neuladen ebenfalls aktuell hält.
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

    // Eine lokal gepinnte Fremdgruppen-Ansicht bliebe sonst unbemerkt "hängen", wenn anderswo (z.B.
    // im Gruppen-Tab) die echte aktive Gruppe gewechselt wird.
    effect(() => {
      this.groupService.groupId();
      this.viewedGroupId.set(null);
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

  // --- Sortierung der Ranglisten: nach Siegen, Winrate oder Spielanzahl umschaltbar ---
  // compareBySortMode/barValue/barMax/medal kommen aus rank-sort.ts - dieselbe Sortier- und
  // Balkenlogik braucht auch die eigenständige GlobalStats-Komponente (weltweit, ohne Login).

  readonly playerSortMode = signal<RankSortMode>('winRate');
  /** Gemeinsamer Sortier-Modus für die vereinte Decks&Commander-Rangliste. */
  readonly deckSortMode = signal<RankSortMode>('winRate');
  readonly playerDeckSortMode = signal<RankSortMode>('winRate');
  readonly playerCommanderSortMode = signal<RankSortMode>('winRate');

  // --- Balken der Ranglisten ---
  //
  // Die Balken hingen bisher fest an der Winrate, auch wenn nach Siegen oder Spielen sortiert war.
  // Die Liste war dann nach der einen Größe geordnet und der Balken zeigte eine andere - dadurch
  // sahen die Balken willkürlich aus, mal länger, mal kürzer, ohne erkennbaren Bezug zur
  // Reihenfolge. Jetzt zeigt der Balken immer die Größe, nach der gerade sortiert wird.
  readonly barValue = barValueFor;
  readonly barMax = barMaxFor;

  // --- Stats-Sichtbarkeit ---

  /**
   * Ob der aktuell eingeloggte Account (der Viewer) die Stats für `mode` überhaupt sehen darf.
   * Das legt der Host pro Account und Modus in "Sichtbarkeit verwalten" fest - auch für sich
   * selbst, z.B. als Selbst-Spoilerschutz. Ohne verknüpften Spieler oder ohne explizite
   * Einstellung ist der Zugriff standardmäßig erlaubt.
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

  /** Jahres-Filter als reine Funktion, damit sowohl die echte aktive Gruppe (yearFilteredMatches)
   * als auch die im Stats-Tab lokal gewählte Gruppe (viewedYearFilteredMatches) dieselbe Logik
   * benutzen, ohne sie zu duplizieren. */
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
   * Übernimmt die Auswahl aus dem Mehrfachauswahl-Menü (app-multi-select liefert ein Set<string>).
   * Gesperrte Modi werden hier nochmal herausgefiltert - das Menü sperrt sie zwar schon, aber die
   * Sichtbarkeitsregel darf nicht allein an der Oberfläche hängen (applyModeFilter() erzwingt sie
   * zusätzlich ein drittes Mal auf den Daten).
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

  // --- Format-Filter (Mehrfachauswahl, orthogonal zum Modus-Filter - beide lassen sich frei
  // kombinieren, z.B. nur "Cube" + nur "Modern"). Keine Sichtbarkeitssperre wie beim Modus-Filter -
  // das Format ist reine Statistik-Ansicht, keine Berechtigung. ---

  readonly deckFormats = DECK_FORMATS;

  /**
   * Genau EIN Format oder "Alle" - anders als beim Modus-Filter bewusst keine Mehrfachauswahl:
   * Deck-Ranglisten sind nur innerhalb eines Formats vergleichbar (siehe deckComparisonAvailable).
   *
   * Startet auf "Commander" statt auf "Alle" - dieselbe Begründung wie in der Global-Ansicht
   * (global-stats.ts): mit "Alle" bleibt die Rangliste "Decks & Commander" beim ersten Aufruf
   * leer, weil Decks über Formate hinweg nicht vergleichbar sind. Commander ist zudem das
   * Format, in dem hier praktisch alles gespielt wird.
   */
  readonly selectedFormat = signal<DeckFormat | 'Alle'>('Commander');

  setSelectedFormat(format: DeckFormat | 'Alle'): void {
    this.selectedFormat.set(format);
    this.selectedCommanderDetail.set(null);
    this.selectedDeckDetail.set(null);
  }

  /**
   * Format-Filter als reine Funktion, siehe applyYearFilter() für die Begründung.
   *
   * Matches ohne Format (Spezialevent) fallen bei einer konkreten Formatwahl heraus: wer sich
   * "Modern" ansieht, will keine formatlosen Spezialevents mitgezählt bekommen. Unter "Alle
   * Spielformate" laufen sie ganz normal mit.
   */
  private applyFormatFilter(matches: Match[]): Match[] {
    const format = this.selectedFormat();
    if (format === 'Alle') return matches;
    return matches.filter((m) => m.format === format);
  }

  /**
   * Ob Deck-/Commander-Vergleiche sinnvoll sind - nur innerhalb EINES Formats. Über alle Formate
   * hinweg stünde ein Commander-Deck gegen ein Modern-Deck in derselben Rangliste, was nichts
   * aussagt. Die betroffenen Abschnitte weichen dann einem Hinweis (stats.chooseFormatForDecksHint).
   */
  readonly deckComparisonAvailable = computed(() => this.selectedFormat() !== 'Alle');

  readonly filteredMatches = computed<Match[]>(() =>
    this.applyFormatFilter(this.applyModeFilter(this.yearFilteredMatches())),
  );

  // --- Lokaler Gruppen-Wechsler (nur Stats-Tab, betrifft NICHT die echte aktive Gruppe) ---
  //
  // filteredMatches() oben bleibt UNVERÄNDERT an der echten aktiven Gruppe (groupService.groupId(),
  // über mtg.history()) - das bedient weiterhin Spieler-Details und Head-to-Head, die bewusst nicht
  // von diesem Wechsler betroffen sind (siehe CLAUDE.md/Absprache: Berechtigungen und Host-Aktionen
  // bleiben an der echten Gruppe). Die reinen Auswertungs-Sektionen (Übersicht, Spieler-Rangliste,
  // Decks & Commander, Lieblingsfarben/Farbkombinationen) lesen stattdessen viewedFilteredMatches()
  // unten - das ist standardmäßig identisch zu filteredMatches() (folgt der echten aktiven Gruppe),
  // kann aber lokal auf eine andere eigene Gruppe umgeschaltet werden, ohne den Rest der App (Match-
  // /Gruppen-Tab) zu beeinflussen.

  /** null = folgt der echten aktiven Gruppe (Default, entspricht dem bisherigen Verhalten). */
  private readonly viewedGroupId = signal<string | null>(null);
  readonly effectiveViewedGroupId = computed(
    () => this.viewedGroupId() ?? this.groupService.groupId(),
  );

  setViewedGroup(groupId: string): void {
    this.viewedGroupId.set(groupId);
    this.selectedCommanderDetail.set(null);
    this.selectedDeckDetail.set(null);
  }

  /** Matches der lokal betrachteten Gruppe (Default: echte aktive Gruppe, kein Extra-Request). */
  private readonly viewedMatches = signal<Match[]>([]);

  private readonly viewedYearFilteredMatches = computed<Match[]>(() =>
    this.applyYearFilter(this.viewedMatches()),
  );
  readonly viewedFilteredMatches = computed<Match[]>(() =>
    this.applyFormatFilter(this.applyModeFilter(this.viewedYearFilteredMatches())),
  );

  // NEU
  /**
   * "Echte" Match-Anzahl statt roher Datensatz-Anzahl: der Excel-Import legt
   * pro real gespieltem Match mehrere Datensätze an (1x Sieger + 1x pro
   * Verlierer mit Platzhalter-Gewinner). Diese Verlierer-Duplikate zählen hier
   * nicht mit, sonst wäre "Spiele gesamt" ein Vielfaches der echten Zahl.
   * Betrifft nur Commander/Cube/Archenemy-Team-Import; bei live getrackten
   * Matches gibt's diese Duplikate ohnehin nicht (1 Match = 1 Datensatz).
   */
  readonly totalGames = computed(
    () =>
      this.viewedFilteredMatches().filter(
        (m) =>
          m.winner !== IMPORT_LOSS_PLACEHOLDER && m.winner !== IMPORT_ARCHENEMY_LOSS_PLACEHOLDER
      ).length
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

  /**
   * Von Host konfigurierter Override der Mindestspielzahl für die aktuelle Modus-Auswahl (vom
   * Host pro Modus bzw. für die Aggregat-Ansicht "Alle Modi" in "Qualifikationsschwellen
   * verwalten" einstellbar), oder null ohne explizite Einstellung.
   */
  private readonly qualificationOverride = computed<number | null>(() => {
    const key = this.isSingleMode() ?? 'Alle';
    return this.mtg.qualificationSettings().get(key) ?? null;
  });

  /**
   * Mindestanzahl Spiele (innerhalb des aktuellen Jahr+Modus-Filters), ab der ein Spieler in
   * der Rangliste nach Winrate auftaucht. Ohne Host-Override: bei "Alle Modi" eine höhere
   * Schwelle als bei einem einzelnen Modus.
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
   * Fasst Commander-Spiele ohne eigenständiges (Nicht-Precon-)Deck zusammen: sowohl gar nicht
   * verlinkte Matches als auch mit einem Precon-Deck gespielte, da Precons austauschbar sind und
   * hier nicht "das beste Deck von Spieler X" abgefragt wird, sondern der Commander allgemein.
   * Eigenständige Decks (keine Precons) laufen bewusst getrennt in deckStats(), da zwei
   * verschiedene Spieler mit demselben Commander in der Praxis unterschiedliche Decks bauen.
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
   * Stats pro eigenständigem (Nicht-Precon-)Deck (unabhängig davon, wer es in welchem Match
   * gespielt hat - z.B. bei geliehenen Decks). Precon-Decks laufen bewusst NICHT hier, sondern
   * gesammelt in commanderStats() - siehe Kommentar dort.
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
   * Verschiedene Commander insgesamt (eigenständige Decks + Precons/Unverlinkte). Steht bewusst
   * NICHT mehr in der Übersicht - dort zählt jetzt distinctDeckCount() -, sondern nur noch an der
   * "Decks & Commander"-Rangliste, wo die Commander auch tatsächlich aufgelistet werden.
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
   * Verschiedene gespielte Decks für die Übersichts-Kachel: jedes eigenständige Deck einmal, dazu
   * jeder Precon/unverlinkte Commander als ein Deck (für diese Partien gibt es kein angelegtes
   * Deck, gespielt wurde aber trotzdem eins). Das ist genau die Zeilenzahl der
   * "Decks & Commander"-Rangliste - die Kachel und die Liste darunter sagen damit dasselbe.
   */
  readonly distinctDeckCount = computed(() => this.combinedDeckCommanderStats().length);

  /**
   * Decks und Commander in EINER gemeinsamen Rangliste: eigenständige (Nicht-Precon-)Decks
   * bleiben als einzelne Einträge erhalten, Precons/unverlinkte Matches sind pro Commander
   * zusammengefasst (siehe commanderStats()).
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

  /**
   * Commander-Name -> im jeweiligen Deck hinterlegtes Bild, aus storedDeckCommanders abgeleitet -
   * für commanderStats() (Precons/unverlinkte Matches), die pro Commander-NAME statt pro Deck-ID
   * zusammengefasst werden und deshalb sonst nie von einem individuell gewählten Artwork
   * profitieren würden.
   */
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
   * Farb- und Farbkombinations-Zählung über ALLE (Nicht-Precon-)Decks der lokal betrachteten
   * Gruppe hinweg (siehe "Lokaler Gruppen-Wechsler" oben - Default: echte aktive Gruppe), die in
   * den aktuell gefilterten Matches (Zeitraum/Modus) vorkommen - Partien-Teilnahmen und Deck-Anzahl
   * parallel gezählt, wie DeckService.getCardAndColorStats() für den Profil-Tab. Anders als dort
   * läuft hier keine eigene DB-Abfrage: die Matches sind über viewedFilteredMatches() schon
   * geladen, nur die Farbidentität der beteiligten Decks kommt separat aus deckColorIdentities()
   * (siehe Effect oben) - Decks, deren Farbidentität noch nicht geladen ist oder wegen is_private
   * nicht lesbar war, fließen einfach nicht mit ein.
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
    const colorRanking: GroupColorEntry[] = COLOR_RADAR_AXES.map((color) => ({
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

  /** Farbverteilung als Netzdiagramm - feste Achsenreihenfolge, siehe COLOR_RADAR_AXES. */
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

  /** CSS-Farbe einer Manafarbe, aus den globalen --pip-*-Tokens - identisch zu colorVar() im Profil-Tab. */
  readonly colorVar = (color: string): string =>
    'WUBRG'.includes(color) ? `var(--pip-${color.toLowerCase()})` : 'var(--series-neutral)';

  /** Anzeigename einer Achse - identisch zu colorLabel() im Profil-Tab. */
  readonly colorLabel = (color: string): string =>
    color === COLORLESS ? this.i18n.t('deckView.colorless') : this.i18n.t(`pip.${color}`);

  /** Anzeigename einer Farbkombination (Eigenname wie "Azorius", sonst aneinandergereihte
   * Farbnamen) - identisch zu colorComboLabel() im Profil-Tab. */
  readonly colorComboLabel = (colors: string[]): string => {
    if (colors.length === 0) return this.i18n.t('deckView.colorless');
    if (colors.length === 1)
      return this.i18n.t('colorCombo.mono', { color: this.colorLabel(colors[0]) });
    if (colors.length >= 5) return this.i18n.t('colorCombo.fiveColor');
    return colorComboName(colors) ?? colors.map((c) => this.colorLabel(c)).join(' / ');
  };

  /** Farben einer Kombination in WUBRG-Reihenfolge - identisch zu comboColors() im Profil-Tab. */
  readonly comboColors = (colors: string[]): string[] => sortColors(colors);

  /** Umschalter Gruppe/Global - "Global" wird von der eigenständigen GlobalStats-Komponente
   * gerendert (siehe stats-tab.html), die auch ohne Login funktioniert und deshalb bewusst nicht
   * Teil dieser (komplett login-pflichtigen) Komponente ist. */
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
   * Head-to-Head bezieht sich bewusst nur auf live getrackte Spiele (ab LIVE_TRACKING_START_DATE),
   * nicht auf die per Excel importierten historischen Partien - die Import-Datensätze bilden
   * echte Gruppenrunden ab (oft >2 Spieler gleichzeitig) und eignen sich nicht für eine saubere
   * 1-gegen-1-Bilanz zwischen zwei bestimmten Spielern.
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
   * Der Direktvergleich als ein geteilter Balken.
   *
   * Vorher standen hier drei getrennte Zahlenkacheln (Spiele, Siege A, Siege B) plus ein Satz für
   * die übrigen Sieger. Drei Kacheln nebeneinander zeigen aber nicht, was die Frage ist: wer liegt
   * vorn und wie deutlich. Als ein Balken mit drei Abschnitten ist genau das der erste Eindruck.
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

  // --- Excel-Import ---

  readonly showImportDialog = signal(false);

  openImportDialog(): void {
    this.showImportDialog.set(true);
  }

  closeImportDialog(): void {
    this.showImportDialog.set(false);
  }

  readonly importPreview = signal<ImportMappingRow[]>([]);
  readonly importBusy = signal(false);
  readonly importMessage = signal('');

  /** '' = keine Zuordnung (Cube-Spiele bleiben ohne konkreten Cube-Bezug). */
  readonly importCubeId = signal<string>('');

  setImportCubeId(event: Event): void {
    this.importCubeId.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Jahr, dem die importierten (synthetischen) Spiele zugeordnet werden.
   * Datum wird beim Import fix auf den 31.12. dieses Jahres gesetzt – so
   * fließen die Alt-Statistiken korrekt in den Jahr-Filter des Stats-Tabs ein.
   */
  readonly importYear = signal<number>(new Date().getFullYear() - 1);

  readonly importYearOptions = computed<number[]>(() => {
    const current = new Date().getFullYear();
    const years: number[] = [];
    for (let y = current; y >= current - 10; y--) years.push(y);
    return years;
  });

  async onExcelSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.importMessage.set('');
    this.importBusy.set(true);
    try {
      const detected = await this.excelImport.loadFile(file);
      this.importPreview.set(
        detected.map((d) => {
          const existing = this.mtg
            .allPlayers()
            .find((p) => p.toLowerCase() === d.guessedPlayer.toLowerCase());
          return existing
            ? { sheetName: d.sheetName, selection: existing, newName: '' }
            : { sheetName: d.sheetName, selection: '__NEW__', newName: d.guessedPlayer };
        })
      );
    } catch {
      this.importMessage.set(this.i18n.t('stats.msg.fileReadError'));
    } finally {
      this.importBusy.set(false);
    }
  }

  updateImportSelection(sheetName: string, value: string): void {
    this.importPreview.update((rows) =>
      rows.map((r) =>
        r.sheetName === sheetName
          ? { ...r, selection: value, newName: value === '__NEW__' ? r.newName : '' }
          : r
      )
    );
  }

  updateImportNewName(sheetName: string, value: string): void {
    this.importPreview.update((rows) =>
      rows.map((r) => (r.sheetName === sheetName ? { ...r, newName: value } : r))
    );
  }

  private effectivePlayer(row: ImportMappingRow): string {
    return row.selection === '__NEW__' ? row.newName.trim() : row.selection;
  }

  async confirmImport(): Promise<void> {
    const mapping = this.importPreview()
      .map((r) => ({ sheetName: r.sheetName, player: this.effectivePlayer(r) }))
      .filter((r) => r.player.length > 0);

    if (mapping.length === 0) {
      this.importMessage.set(this.i18n.t('stats.msg.noMappingSelected'));
      return;
    }

    // NEU
    const importDate = `${this.importYear()}-12-31T00:00:00.000Z`;
    const selectedCube = this.mtg.cubes().find((c) => c.id === this.importCubeId());

    this.importBusy.set(true);
    this.importMessage.set(this.i18n.t('stats.msg.recognizingCommanders'));
    this.importPreview.set([]);

    const matches = await this.excelImport.buildMatches(
      mapping,
      importDate,
      selectedCube
        ? { id: selectedCube.id, name: selectedCube.name, isCommander: selectedCube.isCommander }
        : undefined,
      (done, total) =>
        this.importMessage.set(this.i18n.t('stats.msg.recognizingProgress', { done, total }))
    );

    this.importMessage.set(this.i18n.t('stats.msg.importingGames', { count: matches.length }));

    await this.mtg.importMatches(matches);

    this.importBusy.set(false);
    this.importMessage.set(
      this.i18n.t('stats.msg.importDone', {
        games: matches.length,
        sheets: mapping.length,
        year: this.importYear(),
      })
    );
  }

  cancelImport(): void {
    this.importPreview.set([]);
    this.importMessage.set('');
  }
  // NEU (ans Ende der Klasse anfügen, vor der letzten schließenden Klammer)

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
    this.importMessage.set('');
  }
}
