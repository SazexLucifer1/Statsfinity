import { Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import QRCode from 'qrcode';
import { ProfileService, RankChoice } from '../profile.service';
import { DECK_FORMATS, DeckFormat, GAME_MODES, GameMode, Match } from '../models';
import { EloEntry, eloRanking, rankFromLp, ratedFormatsFor } from '../elo';
import { ProfileRank } from '../profile-rank/profile-rank';
import { rankStyle } from '../ui/rank-badge/rank-badge';
import { MtgService } from '../mtg.service';
import { GroupService } from '../group.service';
import { DeckList } from '../deck-list/deck-list';
import { DeckViewerService } from '../deck-viewer.service';
import {
  DeckService,
  BorrowedDeckInfo,
  UnassignedCommanderStats,
  UnassignedCommanderCategory,
  CrossGroupPersonalStats,
  CardAndColorStats,
  DeckOwner,
} from '../deck.service';
import { ManualDeckLinkService } from '../manual-deck-link.service';
import { CardPreviewService } from '../card-preview.service';
import { AuthService } from '../auth.service';
import { BackgroundService } from '../background.service';
import { ScryfallCard, ScryfallService } from '../scryfall.service';
import { I18nService } from '../i18n.service';
import { ArtLanguageService } from '../art-language.service';
import { ART_LANGUAGES, ArtLang } from '../art-languages';
import { FeedbackService } from '../feedback.service';
import { DialogService } from '../dialog.service';
import { CardImage } from '../card-image/card-image';
import { CommanderStatList } from '../commander-stat-list/commander-stat-list';
import { FavoriteCommanderEditor } from '../favorite-commander-editor/favorite-commander-editor';
import { BarChart, BarChartDatum } from '../ui/bar-chart/bar-chart';
import { RadarChart, RadarChartDatum } from '../ui/radar-chart/radar-chart';
import { Meter } from '../ui/meter/meter';
import { ManaSymbol } from '../ui/mana-symbol/mana-symbol';
import { Podium, PodiumEntry, PODIUM_SIZE } from '../ui/podium/podium';
import { PlayerMatchHistory } from '../player-match-history/player-match-history';
import { splitPodium } from '../rank-sort';
import { colorComboLabel, colorLabel, colorRadarData, colorVar, sortColors } from '../color-combo-names';
import { Icon } from '../ui/icon/icon';
import { CommentInbox } from '../comment-inbox/comment-inbox';
import { FriendsPanel } from '../friends-panel/friends-panel';
import { FriendStatus } from '../friend-status/friend-status';

@Component({
  selector: 'app-profile-tab',
  imports: [FormsModule, DatePipe, DecimalPipe, NgTemplateOutlet, DeckList, CardImage, CommanderStatList, FavoriteCommanderEditor, BarChart, RadarChart, Meter, ManaSymbol, Podium, PlayerMatchHistory, Icon, CommentInbox, ProfileRank, FriendsPanel, FriendStatus],
  templateUrl: './profile-tab.html',
  styleUrl: './profile-tab.scss',
})
export class ProfileTab {
  readonly profileService = inject(ProfileService);
  readonly artLanguage = inject(ArtLanguageService);
  readonly artLanguages = ART_LANGUAGES;

  /** Umschalter für die Sprache der Kartenbilder (Profil) - siehe art-language.service.ts. */
  setArtLanguage(lang: ArtLang): void {
    void this.artLanguage.setLang(lang);
  }

  /** Erklärung zur Sprache der Kartenbilder - steht hinter dem i-Knopf statt offen unter dem Feld. */
  showArtLanguageInfo(): void {
    void this.dialog.alert(this.i18n.t('profile.artLanguageHint'));
  }
  readonly mtg = inject(MtgService);
  readonly groupService = inject(GroupService);
  private readonly deckService = inject(DeckService);
  private readonly deckViewer = inject(DeckViewerService);
  readonly manualDeckLink = inject(ManualDeckLinkService);
  readonly cardPreview = inject(CardPreviewService);
  private readonly auth = inject(AuthService);
  readonly backgrounds = inject(BackgroundService);
  private readonly scryfall = inject(ScryfallService);
  readonly i18n = inject(I18nService);
  readonly feedback = inject(FeedbackService);
  private readonly dialog = inject(DialogService);

  readonly deckListRef = viewChild<DeckList>('deckListRef');
  readonly ownCommanderListRef = viewChild<CommanderStatList>('ownCommanderListRef');
  readonly viewingCommanderListRef = viewChild<CommanderStatList>('viewingCommanderListRef');
  readonly viewingNpcCommanderListRef = viewChild<CommanderStatList>('viewingNpcCommanderListRef');

  /**
   * Stats eines fremden/NPC-Profils ausblenden, wenn der Host dem Viewer alle Modi gesperrt hat
   * (Host ausgenommen).
   */
  readonly othersStatsHidden = computed(
    () => this.isViewingOther() && this.mtg.allModesHiddenForMe() && !this.groupService.isOwner()
  );

  /**
   * computed statt Objektliteral im Template - sonst gälte der Signal-Input von DeckList bei jedem
   * Tick als geändert (Lade-Dauerschleife).
   */
  readonly ownDeckOwner = computed<DeckOwner | null>(() => {
    const userId = this.profileService.profile()?.id;
    return userId ? { kind: 'user', userId } : null;
  });

  readonly viewingDeckOwner = computed<DeckOwner | null>(() => {
    const userId = this.profileService.viewingUserId();
    return userId ? { kind: 'user', userId } : null;
  });

  /** Deck-Besitzer für ein gerade angesehenes NPC-Profil (siehe viewNpcProfile in profile.service.ts). */
  readonly viewingNpcDeckOwner = computed<DeckOwner | null>(() => {
    const playerId = this.profileService.viewingPlayerId();
    return playerId ? { kind: 'player', playerId } : null;
  });

  // --- Elo-Rang (elo.ts): Abzeichen im Kopf, Rahmen und Profilbild in Rangfarbe ---

  /** Gewählter Modus des eigenen Profils bzw. des angesehenen Accounts (NPCs: immer Standard). */
  private readonly ownRankChoice = signal<RankChoice>(ProfileService.DEFAULT_RANK_CHOICE);
  private readonly viewedRankChoice = signal<RankChoice>(ProfileService.DEFAULT_RANK_CHOICE);
  readonly rankChoice = computed<RankChoice>(() => {
    if (this.profileService.viewingUserId()) return this.viewedRankChoice();
    if (this.profileService.viewingPlayerId()) return ProfileService.DEFAULT_RANK_CHOICE;
    return this.ownRankChoice();
  });

  /**
   * Der Rang ist Gruppensache und nicht öffentlich: gerechnet wird über die Partien genau EINER
   * Gruppe mit eingeschaltetem Rangsystem, die der Betrachter selbst sehen darf. Eigenes Profil:
   * die gewählte Gruppe (Auswahlfeld), sonst die aktive. Fremdes Profil: dessen gewählte Gruppe,
   * sofern der Betrachter darin Mitglied ist (sonst liefert profile_rank_choice() null), ersatzweise
   * die aktive Gruppe, wenn beide darin spielen. NPC: die aktive Gruppe. Sonst kein Rang.
   */
  readonly rankableGroups = computed(() =>
    this.groupService.myGroups().filter((g) => this.groupService.isRankedGroup(g.id)),
  );

  readonly rankGroupId = computed<string | null>(() => {
    const active = this.groupService.groupId();
    const activeRanked = this.groupService.isRankedGroup(active) ? active : null;
    if (this.profileService.viewingPlayerId()) return activeRanked;
    const chosen = this.rankChoice().groupId;
    if (this.profileService.viewingUserId()) {
      if (chosen && this.groupService.isRankedGroup(chosen)) return chosen;
      return activeRanked && this.profileHistoryName() ? activeRanked : null;
    }
    if (chosen && this.rankableGroups().some((g) => g.id === chosen)) return chosen;
    return activeRanked ?? this.rankableGroups()[0]?.id ?? null;
  });

  readonly rankGroupName = computed(
    () => this.groupService.myGroups().find((g) => g.id === this.rankGroupId())?.name ?? null,
  );

  /** Partien und Spielername einer anderen als der aktiven Gruppe, nachgeladen (siehe Konstruktor). */
  private readonly otherGroupRankData = signal<{
    groupId: string;
    userId: string;
    matches: Match[];
    playerName: string | null;
  } | null>(null);

  private readonly rankMatches = computed<Match[]>(() => {
    const groupId = this.rankGroupId();
    if (!groupId) return [];
    if (groupId === this.groupService.groupId()) return this.mtg.history();
    const other = this.otherGroupRankData();
    return other?.groupId === groupId ? other.matches : [];
  });
  private readonly rankPlayerName = computed<string | null>(() => {
    const groupId = this.rankGroupId();
    if (!groupId) return null;
    if (groupId === this.groupService.groupId()) return this.profileHistoryName();
    const other = this.otherGroupRankData();
    return other?.groupId === groupId ? other.playerName : null;
  });

  /** Account, dessen Rang gerade gezeigt wird (eigener oder angesehener); null bei NPCs. */
  private readonly rankUserId = computed<string | null>(() =>
    this.profileService.viewingPlayerId()
      ? null
      : (this.profileService.viewingUserId() ?? this.profileService.profile()?.id ?? null),
  );

  /** Modi, in denen der Spieler gewertet ist, plus der gewählte; in der Reihenfolge von GAME_MODES. */
  readonly rankModes = computed<GameMode[]>(() => {
    const name = this.rankPlayerName();
    const matches = this.rankMatches();
    return GAME_MODES.filter(
      (m) =>
        m === this.rankChoice().mode ||
        (!!name && eloRanking(matches, m).some((e) => e.name === name)),
    );
  });

  /**
   * Alle Formate zur Auswahl - auch die ohne Partien, die zeigen dann "Nicht eingerankt". Nur für
   * einen Modus ohne Format (Spezialevent, format null) gibt es nichts zu wählen.
   */
  readonly rankFormats = computed<DeckFormat[]>(() =>
    this.rankChoice().format === null ? [] : DECK_FORMATS,
  );

  readonly rankEntry = computed<EloEntry | null>(() => {
    const name = this.rankPlayerName();
    if (!name) return null;
    const { mode, format } = this.rankChoice();
    return eloRanking(this.rankMatches(), mode, { format }).find((e) => e.name === name) ?? null;
  });

  /** CSS-Variablen für den Rahmen um den Profilkopf; null = ungewertet/Einstufung, normaler Rahmen. */
  readonly rankFrameStyle = computed(() => {
    const e = this.rankEntry();
    return e && !e.provisional ? rankStyle(rankFromLp(e.lp).tier) : null;
  });

  /**
   * Beim Moduswechsel bleibt das Format, wenn der Spieler darin auch in diesem Modus gewertet ist;
   * sonst das erste Format, in dem er es ist (2HG wird z. B. selten Modern gespielt). Hat der
   * Modus nur Partien ohne Format (Spezialevent), gilt null.
   */
  setRankMode(mode: GameMode): void {
    const name = this.rankPlayerName();
    const matches = this.rankMatches();
    const current = this.rankChoice().format;
    const rated = name ? ratedFormatsFor(matches, mode, name, DECK_FORMATS) : [];
    const formatlos =
      !!name &&
      rated.length === 0 &&
      eloRanking(matches, mode, { format: null }).some((e) => e.name === name);
    const format =
      current && rated.includes(current)
        ? current
        : (rated[0] ?? (formatlos ? null : (current ?? ProfileService.DEFAULT_RANK_CHOICE.format)));
    this.saveRankChoice({ ...this.rankChoice(), mode, format });
  }

  setRankFormat(format: DeckFormat): void {
    this.saveRankChoice({ ...this.rankChoice(), format });
  }

  setRankGroup(groupId: string): void {
    this.saveRankChoice({ ...this.rankChoice(), groupId });
  }

  private saveRankChoice(choice: RankChoice): void {
    this.ownRankChoice.set(choice);
    void this.profileService.saveRankChoice(choice);
  }

  // --- Developer-Vollansicht eines fremden Profils ---

  /** Ob überhaupt ein fremdes Profil angesehen wird (Account oder NPC) statt des eigenen. */
  readonly isViewingOther = computed(
    () => !!this.profileService.viewingUserId() || !!this.profileService.viewingPlayerId()
  );

  /** Ob der Umschalter auf die Vollansicht angeboten wird: nur Developer, nur im fremden Profil. */
  readonly canDevFullView = computed(() => !!this.profileService.profile()?.isDeveloper && this.isViewingOther());

  private readonly devFullViewChoice = signal(false);

  /**
   * Developer-Vollansicht: zeigt bei einem fremden Profil denselben Statistik- und Deckbereich wie
   * dessen eigenes Profil, rein lesend, zum Nachvollziehen von Fehlern. Bewusst ein Umschalter,
   * damit ein Developer auch die normale Ansicht sehen kann.
   */
  readonly devFullView = computed(() => this.canDevFullView() && this.devFullViewChoice());

  toggleDevFullView(): void {
    this.devFullViewChoice.update((on) => !on);
  }

  /**
   * Besitzer des Hauptbereichs: der eigene Account, in der Developer-Vollansicht das fremde Profil.
   */
  readonly statsOwner = computed<DeckOwner | null>(() =>
    this.devFullView() ? this.viewingDeckOwner() ?? this.viewingNpcDeckOwner() : this.ownDeckOwner()
  );

  /**
   * Account-ID für die gruppenübergreifende Statistik; null bei NPC-Profilen (kein Account, keine
   * anderen Gruppen).
   */
  readonly statsUserId = computed<string | null>(() =>
    this.devFullView() ? this.profileService.viewingUserId() : this.profileService.profile()?.id ?? null
  );

  /** Lieblingscommander des angesehenen NPC-Profils, direkt aus MtgService. */
  readonly viewingNpcFavoriteCommanders = computed<string[]>(() => {
    const name = this.profileService.viewingPlayerName();
    return name ? this.mtg.playerFavoriteCommanders()[name] ?? [] : [];
  });

  /**
   * Matches eines fremden Accounts außerhalb der eigenen Gruppe (oder ohne Login) über
   * loadPublicMatchesForUser(); null = normale Gruppen-Historie.
   */
  readonly publicViewedMatches = signal<{ match: Match; selfName: string }[] | null>(null);

  /**
   * Spielername des angezeigten Profils (eigenes, fremder Account oder NPC) für die Match-Historie
   * (aufgelöst wie in countPlacements).
   */
  readonly profileHistoryName = computed(() => {
    const npcName = this.profileService.viewingPlayerName();
    if (npcName) return npcName;
    const userId = this.profileService.viewingUserId() ?? this.profileService.profile()?.id ?? null;
    return this.playerNameForUserId(userId);
  });

  /** Findet den Spielernamen (mtg.playerUserIds ist name-indiziert) zu einer Account-User-ID, oder null ohne Zuordnung. */
  private playerNameForUserId(userId: string | null): string | null {
    if (!userId) return null;
    const entry = Object.entries(this.mtg.playerUserIds()).find(([, uid]) => uid === userId);
    return entry?.[0] ?? null;
  }

  /**
   * Wie oft welcher Platz erreicht wurde (nur Matches mit Platzierung), für das angezeigte Profil.
   */
  readonly placementDistribution = computed<{ placement: number; count: number }[]>(() =>
    this.countPlacements('Alle'),
  );

  /**
   * Dasselbe, eingegrenzt auf das Jahr des eigenen Profils - eigene Ableitung, damit fremde Profile
   * nicht still nach einem unsichtbaren Jahr gefiltert werden.
   */
  readonly ownPlacementDistribution = computed<{ placement: number; count: number }[]>(() =>
    this.countPlacements(this.statsYear()),
  );

  private countPlacements(year: number | 'Alle'): { placement: number; count: number }[] {
    const npcName = this.profileService.viewingPlayerName();
    const userId = this.profileService.viewingUserId() ?? this.profileService.profile()?.id ?? null;
    const name = npcName ?? this.playerNameForUserId(userId);
    if (!name) return [];

    const counts = new Map<number, number>();
    for (const match of this.mtg.history()) {
      if (match.countsInGeneralStats === false) continue;
      if (year !== 'Alle' && new Date(match.date).getFullYear() !== year) continue;
      const placement = match.players.find((p) => p.name === name)?.placement;
      if (placement != null) counts.set(placement, (counts.get(placement) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([placement, count]) => ({ placement, count }));
  }

  /** Platzierungsverteilung als Säulendiagramm. */
  readonly placementChart = computed<BarChartDatum[]>(() =>
    this.toPlacementChart(this.placementDistribution()),
  );

  readonly ownPlacementChart = computed<BarChartDatum[]>(() =>
    this.toPlacementChart(this.ownPlacementDistribution()),
  );

  private toPlacementChart(entries: { placement: number; count: number }[]): BarChartDatum[] {
    return entries.map((p) => ({
      label: this.i18n.t('placement.badge', { placement: p.placement }),
      value: p.count,
    }));
  }

  readonly unassignedCommanderStats = signal<UnassignedCommanderStats[]>([]);
  /** Gleiches wie unassignedCommanderStats, aber für ein FREMDES Profil - rein zum Ansehen, ohne Reparieren/Verlinken (das kann nur der Account-Besitzer selbst). */
  readonly viewingUnassignedCommanderStats = signal<UnassignedCommanderStats[]>([]);
  /** Gleiches wie viewingUnassignedCommanderStats, aber für ein gerade angesehenes NPC-Profil. */
  readonly viewingNpcUnassignedCommanderStats = signal<UnassignedCommanderStats[]>([]);

  // --- Umschalter der drei "kein eigenes Deck"-Listen im eigenen Profil ---

  /** Reihenfolge der Listen: 'none' zuerst, nur dort gibt es etwas zu tun. */
  private static readonly COMMANDER_LIST_MODES: UnassignedCommanderCategory[] = ['none', 'borrowed', 'cube'];

  private readonly commanderListModeChoice = signal<UnassignedCommanderCategory>('none');

  /** Nur Listen anbieten, in denen auch etwas steht - sonst zeigte der Umschalter auf leere Listen. */
  readonly commanderListModes = computed<UnassignedCommanderCategory[]>(() => {
    const stats = this.unassignedCommanderStats();
    return ProfileTab.COMMANDER_LIST_MODES.filter((mode) => stats.some((c) => c.category === mode));
  });

  /** Die gewählte Liste, zurückfallend auf die erste vorhandene - die Auswahl kann durch ein Verlinken leer werden. */
  readonly commanderListMode = computed<UnassignedCommanderCategory>(() => {
    const modes = this.commanderListModes();
    const chosen = this.commanderListModeChoice();
    return modes.includes(chosen) ? chosen : (modes[0] ?? 'none');
  });

  readonly shownUnassignedCommanderStats = computed<UnassignedCommanderStats[]>(() =>
    this.unassignedCommanderStats().filter((c) => c.category === this.commanderListMode()),
  );

  /** Nur die echten "es fehlt ein Deck"-Einträge - fremde und NPC-Profile bekommen keinen Umschalter. */
  readonly viewingCommanderStatsWithoutDeck = computed<UnassignedCommanderStats[]>(() =>
    this.viewingUnassignedCommanderStats().filter((c) => c.category === 'none'),
  );

  readonly viewingNpcCommanderStatsWithoutDeck = computed<UnassignedCommanderStats[]>(() =>
    this.viewingNpcUnassignedCommanderStats().filter((c) => c.category === 'none'),
  );

  setCommanderListMode(mode: UnassignedCommanderCategory): void {
    this.commanderListModeChoice.set(mode);
    this.ownCommanderListRef()?.reset();
  }

  commanderListCount(mode: UnassignedCommanderCategory): number {
    return this.unassignedCommanderStats().filter((c) => c.category === mode).length;
  }

  /** Kurze Beschriftung für den Umschalter - die ausführliche steht als Überschrift darüber. */
  commanderListShortKey(mode: UnassignedCommanderCategory): string {
    return mode === 'borrowed'
      ? 'profile.commanderListBorrowed'
      : mode === 'cube'
        ? 'profile.commanderListCube'
        : 'profile.commanderListWithoutDeck';
  }

  commanderListTitleKey(mode: UnassignedCommanderCategory): string {
    return mode === 'borrowed'
      ? 'profile.commanderBorrowed'
      : mode === 'cube'
        ? 'profile.commanderCube'
        : 'profile.commanderWithoutDeck';
  }

  commanderListHintKey(mode: UnassignedCommanderCategory): string {
    return mode === 'borrowed'
      ? 'profile.commanderBorrowedHint'
      : mode === 'cube'
        ? 'profile.commanderCubeHint'
        : 'profile.commanderWithoutDeckHint';
  }
  readonly npcFavoriteCommanderBusy = signal(false);

  /** Gesamt-Statistik über ALLE Gruppen des eigenen Accounts hinweg (siehe DeckService.getCrossGroupPersonalStats) -
   * bewusst nur fürs eigene Profil, nicht beim Ansehen eines fremden. Das Stats-Tab bleibt unverändert pro aktiver Gruppe. */
  readonly crossGroupStats = signal<CrossGroupPersonalStats | null>(null);

  /** Umschalter Statistik/Decks im eigenen Profil, Start auf den Decks (dort wird gearbeitet). */
  readonly profileViewTab = signal<'stats' | 'decks'>('decks');

  // --- Zeitraum-Filter der Profil-Statistiken ---

  /** Wie im Statistik-Tab: das laufende Jahr ist die Vorauswahl, 'Alle' fasst alle Jahre zusammen. */
  readonly statsYear = signal<number | 'Alle'>(new Date().getFullYear());

  /**
   * Jahre zur Auswahl: das laufende Jahr immer, dazu die Jahre aus dem Match-Verlauf der aktiven
   * Gruppe.
   */
  readonly availableStatsYears = computed<number[]>(() => {
    const years = new Set<number>([new Date().getFullYear()]);
    for (const match of this.mtg.history()) years.add(new Date(match.date).getFullYear());
    return [...years].sort((a, b) => b - a);
  });

  setStatsYear(year: number | 'Alle'): void {
    this.statsYear.set(year);
  }

  setProfileViewTab(tab: 'stats' | 'decks'): void {
    this.profileViewTab.set(tab);
  }

  /**
   * Meistgespielte Karten, Farben und Farbkombinationen über alle eigenen Gruppen (ohne Precons),
   * nur fürs eigene Profil.
   */
  readonly cardAndColorStats = signal<CardAndColorStats | null>(null);

  // Farb-Hilfen für die Vorlage, Logik in color-combo-names.ts.
  readonly colorVar = colorVar;
  readonly colorLabel = (color: string): string => colorLabel(this.i18n, color);
  readonly colorComboLabel = (colors: string[]): string => colorComboLabel(this.i18n, colors);
  readonly comboColors = (colors: string[]): string[] => sortColors(colors);

  /** Gewichtung der drei Ranglisten: "games" nach Partien je Deck, "decks" jedes Deck einmal. */
  readonly statsWeightMode = signal<'games' | 'decks'>('games');

  setStatsWeightMode(mode: 'games' | 'decks'): void {
    this.statsWeightMode.set(mode);
  }

  /** Wählt je nach aktivem Modus den passenden Zählwert eines Eintrags aus. */
  readonly countFor = (entry: { gameCount: number; deckCount: number }): number =>
    this.statsWeightMode() === 'games' ? entry.gameCount : entry.deckCount;

  /** Top 5 meistgenutzte Karten nach aktivem Modus sortiert - die Rohliste enthält bewusst ALLE
   * Karten (siehe DeckService.getCardAndColorStats), damit hier ohne Neuladen umsortiert werden kann. */
  readonly rankedMostUsedCards = computed(() => {
    const cards = this.cardAndColorStats()?.mostUsedCards ?? [];
    return [...cards].sort((a, b) => this.countFor(b) - this.countFor(a)).slice(0, 5);
  });

  /** Farbverteilung als Netzdiagramm in fester Achsenreihenfolge. */
  readonly colorRadarChart = computed<RadarChartDatum[]>(() =>
    colorRadarData(this.i18n, this.cardAndColorStats()?.colorRanking ?? [], this.countFor),
  );

  readonly rankedColorComboRanking = computed(() => {
    const combos = this.cardAndColorStats()?.colorComboRanking ?? [];
    return [...combos].sort((a, b) => this.countFor(b) - this.countFor(a));
  });

  /** Höchster Zählwert für die relative Balkenbreite in der Karten-Rangliste. */
  readonly maxMostUsedCardCount = computed(() =>
    Math.max(1, ...this.rankedMostUsedCards().map((c) => this.countFor(c)))
  );

  /** Höchster Zählwert für die relative Balkenbreite in der Farbkombinations-Rangliste. */
  readonly maxColorComboCount = computed(() =>
    Math.max(1, ...this.rankedColorComboRanking().map((c) => this.countFor(c)))
  );

  // --- Siegertreppchen für die ersten drei Plätze; die Listen sind hier nicht seitenweise, die
  // Nummerierung darunter beginnt bei PODIUM_SIZE + 1. ---

  readonly podiumSize = PODIUM_SIZE;

  private readonly mostUsedCardsSplit = computed(() => splitPodium(this.rankedMostUsedCards(), 0));
  readonly mostUsedCardsRest = computed(() => this.mostUsedCardsSplit().rest);
  readonly mostUsedCardsPodium = computed<PodiumEntry[]>(() =>
    this.mostUsedCardsSplit().podium.map((c) => ({
      key: c.cardName,
      name: c.cardName,
      detail: '',
      value: `${this.countFor(c)}×`,
      imageUrl: this.mostUsedCardImage(c),
    }))
  );

  /** Bild einer meistgespielten Karte: bevorzugt das im Deck hinterlegte, sonst das über Scryfall
   * nachgeladene (siehe commanderCards) - im Deck steckt in der Regel nur für Commander eines. */
  readonly mostUsedCardImage = (card: { cardName: string; imageUrl: string | null }): string | null =>
    card.imageUrl ?? this.commanderImage(card.cardName);

  private readonly colorComboSplit = computed(() =>
    splitPodium(this.rankedColorComboRanking(), 0)
  );
  readonly colorComboRest = computed(() => this.colorComboSplit().rest);
  readonly colorComboPodium = computed<PodiumEntry[]>(() =>
    this.colorComboSplit().podium.map((combo) => ({
      key: combo.colors.join('') || 'C',
      name: this.colorComboLabel(combo.colors),
      detail: '',
      value: `${this.countFor(combo)}×`,
      symbols: combo.colors.length === 0 ? ['C'] : this.comboColors(combo.colors),
    }))
  );

  /** Öffnet das geliehene (fremde) Deck; Bearbeiten schaltet die Detailansicht selbst ab. */
  async openBorrowedDeck(borrowed: BorrowedDeckInfo): Promise<void> {
    const deck = await this.deckService.getDeckById(borrowed.id);
    if (deck) await this.deckViewer.open(deck);
  }

  /** Klick auf einen Treppchen-Platz der Karten-Rangliste zeigt die Karte groß - dasselbe wie ein
   * Klick auf das Vorschaubild in der Liste darunter. */
  openPodiumCard(entry: PodiumEntry): void {
    if (entry.imageUrl) {
      this.cardPreview.open(entry.imageUrl, this.commanderBackImage(entry.name), entry.name);
    }
  }

  private async refreshUnassignedAndDecks(): Promise<void> {
    const owner = this.statsOwner();
    if (!owner) return;
    this.unassignedCommanderStats.set(
      await this.deckService.getUnassignedCommanderStats(owner)
    );
    await this.deckListRef()?.refreshDecks();
  }

  /**
   * Lädt die "kein eigenes Deck"-Liste neu - in das Signal des gerade sichtbaren Blocks
   * (Hauptbereich oder Fremdansicht).
   */
  private async reloadUnassignedFor(owner: DeckOwner): Promise<void> {
    if (this.devFullView() || !this.isViewingOther()) {
      await this.refreshUnassignedAndDecks();
      return;
    }
    const stats = await this.deckService.getUnassignedCommanderStats(owner);
    if (owner.kind === 'player') this.viewingNpcUnassignedCommanderStats.set(stats);
    else this.viewingUnassignedCommanderStats.set(stats);
  }

  constructor() {
    // Rang aus einer anderen als der aktiven Gruppe: deren Partien und den Spielernamen des
    // Accounts dort nachladen (mtg.history() kennt nur die aktive Gruppe).
    effect(() => {
      const groupId = this.rankGroupId();
      const userId = this.rankUserId();
      if (!groupId || !userId || groupId === this.groupService.groupId()) return;
      const current = this.otherGroupRankData();
      if (current?.groupId === groupId && current.userId === userId) return;
      void Promise.all([
        this.mtg.loadMatchesForGroups([groupId]),
        this.mtg.playerNameInGroup(groupId, userId),
      ]).then(([matches, playerName]) => {
        if (this.rankGroupId() !== groupId || this.rankUserId() !== userId) return;
        this.otherGroupRankData.set({ groupId, userId, matches, playerName });
      });
    });

    effect(() => {
      const userId = this.profileService.profile()?.id;
      if (!userId) return;
      void this.profileService.loadRankChoice(userId).then((choice) => {
        if (this.profileService.profile()?.id === userId) this.ownRankChoice.set(choice);
      });
    });

    effect(() => {
      const userId = this.profileService.viewingUserId();
      this.viewedRankChoice.set(ProfileService.DEFAULT_RANK_CHOICE);
      if (!userId) return;
      void this.profileService.loadRankChoice(userId).then((choice) => {
        if (this.profileService.viewingUserId() === userId) this.viewedRankChoice.set(choice);
      });
    });

    effect(() => {
      const userId = this.profileService.viewingUserId();
      const inMeinerGruppe = !!this.profileHistoryName();
      this.publicViewedMatches.set(null);
      if (!userId || inMeinerGruppe) return;
      void this.mtg.loadPublicMatchesForUser(userId).then((matches) => {
        // Inzwischen ein anderes Profil geöffnet - diese Antwort gehört nicht mehr hierher.
        if (this.profileService.viewingUserId() !== userId) return;
        this.publicViewedMatches.set(matches ?? []);
      });
    });

    effect(() => {
      const owner = this.statsOwner();
      if (!owner) {
        this.unassignedCommanderStats.set([]);
        return;
      }
      this.deckService.getUnassignedCommanderStats(owner).then((stats) => {
        this.unassignedCommanderStats.set(stats);
        this.ownCommanderListRef()?.reset();
      });
    });

    effect(() => {
      const userId = this.statsUserId();
      if (!userId) {
        this.crossGroupStats.set(null);
        return;
      }
      const year = this.statsYear();
      this.deckService
        .getCrossGroupPersonalStats(userId, year === 'Alle' ? undefined : year)
        .then((stats) => this.crossGroupStats.set(stats));
    });

    effect(() => {
      const owner = this.statsOwner();
      if (!owner) {
        this.cardAndColorStats.set(null);
        return;
      }
      const year = this.statsYear();
      this.deckService
        .getCardAndColorStats(owner, year === 'Alle' ? undefined : year)
        .then((stats) => this.cardAndColorStats.set(stats));
    });

    effect(() => {
      const userId = this.profileService.viewingUserId();
      // In der Developer-Vollansicht zeigt der gemeinsame Haupt-Bereich die Liste - dieselbe
      // Abfrage hier ein zweites Mal zu stellen, lädt nur unsichtbare Daten nach.
      if (!userId || this.devFullView()) {
        this.viewingUnassignedCommanderStats.set([]);
        return;
      }
      this.deckService.getUnassignedCommanderStats({ kind: 'user', userId }).then((stats) => {
        this.viewingUnassignedCommanderStats.set(stats);
        this.viewingCommanderListRef()?.reset();
      });
    });

    effect(() => {
      const playerId = this.profileService.viewingPlayerId();
      if (!playerId || this.devFullView()) {
        this.viewingNpcUnassignedCommanderStats.set([]);
        return;
      }
      this.deckService.getUnassignedCommanderStats({ kind: 'player', playerId }).then((stats) => {
        this.viewingNpcUnassignedCommanderStats.set(stats);
        this.viewingNpcCommanderListRef()?.reset();
      });
    });

    effect(() => {
      // Bilder für eigene, fremde und NPC-Lieblingscommander - ein Cache nach Kartenname.
      const ownNames = this.profileService.profile()?.favoriteCommanders ?? [];
      const viewedNames = this.profileService.viewingProfile()?.favoriteCommanders ?? [];
      const npcNames = this.viewingNpcFavoriteCommanders();
      const names = [...new Set([...ownNames, ...viewedNames, ...npcNames])];
      if (names.length === 0) {
        this.favoriteCommanderCards.set({});
        return;
      }
      Promise.all(names.map((n) => this.scryfall.findCard(n).then((card) => [n, card] as const))).then((entries) => {
        this.favoriteCommanderCards.set(Object.fromEntries(entries));
      });
    });

    effect(() => {
      const names = [
        ...this.unassignedCommanderStats().map((c) => c.commander),
        ...this.viewingUnassignedCommanderStats().map((c) => c.commander),
        ...this.viewingNpcUnassignedCommanderStats().map((c) => c.commander),
        // image_url ist meist nur beim Commander gefüllt; deshalb die Top 5 per Name nachschlagen.
        ...this.rankedMostUsedCards()
          .filter((c) => !c.imageUrl)
          .map((c) => c.cardName),
      ];
      this.commanderCardsRetry();
      const cache = this.commanderCards();
      const missing = [...new Set(names)].filter((n) => !(n.toLowerCase() in cache));
      if (missing.length === 0) return;

      const failed = new Set<string>();
      this.scryfall.findCardsBulk(missing, failed).then((found) => {
        this.commanderCards.update((current) => {
          const next = { ...current };
          for (const name of missing) {
            // Gescheiterte Anfrage (meist Scryfalls Rate-Limit) ist nicht "Karte gibt es nicht" -
            // als null abgelegt, bliebe das Bild bis zum Neuladen der App verschwunden.
            if (failed.has(name)) continue;
            next[name.toLowerCase()] = found.get(name.toLowerCase()) ?? null;
          }
          return next;
        });
        if (failed.size > 0 && this.commanderCardsRetryCount++ < 3) {
          setTimeout(() => this.commanderCardsRetry.update((n) => n + 1), 10_000);
        }
      });
    });

    // Lädt die Feedback-Eingänge einmalig nach, sobald erkannt wird, dass der Account Developer ist.
    let feedbackLoadTriggered = false;
    effect(() => {
      if (!this.profileService.profile()?.isDeveloper || feedbackLoadTriggered) return;
      feedbackLoadTriggered = true;
      this.feedback.loadEntries();
    });
  }

  /** Kartenname (lowercase) -> Scryfall-Daten oder null (nicht gefunden). Füllt die "Commander ohne
   * Deck"-Liste und springt bei den meistgespielten Karten ein, wo im Deck kein Bild hinterlegt ist. */
  private readonly commanderCards = signal<Record<string, ScryfallCard | null>>({});
  /** Stößt das Nachladen nach einer gescheiterten Anfrage erneut an - höchstens dreimal, damit
   * ein nicht erreichbares Scryfall nicht endlos Anfragen erzeugt. */
  private readonly commanderCardsRetry = signal(0);
  private commanderCardsRetryCount = 0;

  /** Arrow-Function, damit sie als Input weitergereicht werden kann, ohne `this` zu verlieren. */
  readonly commanderImage = (name: string | undefined): string | null => {
    if (!name) return null;
    return this.commanderCards()[name.toLowerCase()]?.imageUrl ?? null;
  };

  readonly commanderBackImage = (name: string | undefined): string | null => {
    if (!name) return null;
    return this.commanderCards()[name.toLowerCase()]?.backImageUrl ?? null;
  };

  /** Öffnet die große Kartenvorschau für einen Lieblingscommander (fremdes Profil - beim eigenen
   * öffnet der Klick stattdessen den Bearbeiten-Dialog, siehe openFavoriteCommanderDialog()). */
  openFavoriteCommanderPreview(name: string): void {
    const card = this.favoriteCommanderCards()[name];
    if (!card?.imageUrl) return;
    this.cardPreview.open(card.imageUrl, card.backImageUrl, name);
  }

  /** Feedback-Einträge für die Admin-Ansicht - "erledigt" standardmäßig ausgeblendet. */
  readonly visibleFeedbackEntries = computed(() =>
    this.feedback.showDoneEntries()
      ? this.feedback.entries()
      : this.feedback.entries().filter((e) => e.status === 'open')
  );

  // --- Top-3-Lieblings-Commander (füllt den sonst leeren Bereich neben Avatar/Gruppen) ---

  readonly favoriteCommanderCards = signal<Record<string, ScryfallCard | null>>({});

  readonly showFavoriteCommanderDialog = signal(false);
  readonly favoriteCommanderBusy = signal(false);

  openFavoriteCommanderDialog(): void {
    this.showFavoriteCommanderDialog.set(true);
  }

  closeFavoriteCommanderDialog(): void {
    this.showFavoriteCommanderDialog.set(false);
  }

  /** Als gebundene Arrow-Function-Properties gehalten, damit sie unverändert als onAdd/onRemove-
   * Inputs an app-favorite-commander-editor durchgereicht werden können. */
  readonly addFavoriteCommander = async (name: string): Promise<void> => {
    const current = this.profileService.profile()?.favoriteCommanders ?? [];
    if (current.length >= 3 || current.includes(name)) return;

    this.favoriteCommanderBusy.set(true);
    await this.profileService.updateFavoriteCommanders([...current, name]);
    this.favoriteCommanderBusy.set(false);
  };

  readonly removeFavoriteCommander = async (name: string): Promise<void> => {
    const current = this.profileService.profile()?.favoriteCommanders ?? [];

    this.favoriteCommanderBusy.set(true);
    await this.profileService.updateFavoriteCommanders(current.filter((c) => c !== name));
    this.favoriteCommanderBusy.set(false);
  };

  /** Meistgespielte Commander (Hauptcommander, Partner zählt nicht mit) dieser Person, absteigend - respektiert countsInGeneralStats wie der Rest der Statistik. */
  private topPlayedCommanders(playerName: string, limit: number): string[] {
    const counts = new Map<string, number>();
    for (const match of this.mtg.history()) {
      if (match.countsInGeneralStats === false) continue;
      const commander = match.players.find((p) => p.name === playerName)?.commander;
      if (commander) counts.set(commander, (counts.get(commander) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name).slice(0, limit);
  }

  readonly canAutofillFavoriteCommanders = computed(() => {
    const name = this.mtg.myPlayerName();
    const current = this.profileService.profile()?.favoriteCommanders ?? [];
    if (!name || current.length >= 3) return false;
    return this.topPlayedCommanders(name, 3).some((c) => !current.includes(c));
  });

  /** Füllt die restlichen freien Lieblings-Commander-Plätze mit den meistgespielten Commandern dieser Person auf - für alle, die die Liste nicht von Hand befüllen wollen. */
  async autofillFavoriteCommanders(): Promise<void> {
    const name = this.mtg.myPlayerName();
    if (!name || this.favoriteCommanderBusy()) return;

    const current = this.profileService.profile()?.favoriteCommanders ?? [];
    const remaining = 3 - current.length;
    if (remaining <= 0) return;

    const additions = this.topPlayedCommanders(name, current.length + remaining)
      .filter((c) => !current.includes(c))
      .slice(0, remaining);
    if (additions.length === 0) return;

    this.favoriteCommanderBusy.set(true);
    await this.profileService.updateFavoriteCommanders([...current, ...additions]);
    this.favoriteCommanderBusy.set(false);
  }

  // --- Lieblingscommander eines NPC-Profils (nur Host), wie oben, aber über
  // MtgService.setPlayerFavoriteCommanders. ---

  readonly addNpcFavoriteCommander = async (name: string): Promise<void> => {
    const playerName = this.profileService.viewingPlayerName();
    if (!playerName) return;
    const current = this.viewingNpcFavoriteCommanders();
    if (current.length >= 3 || current.includes(name)) return;

    this.npcFavoriteCommanderBusy.set(true);
    await this.mtg.setPlayerFavoriteCommanders(playerName, [...current, name]);
    this.npcFavoriteCommanderBusy.set(false);
  };

  readonly removeNpcFavoriteCommander = async (name: string): Promise<void> => {
    const playerName = this.profileService.viewingPlayerName();
    if (!playerName) return;
    const current = this.viewingNpcFavoriteCommanders();

    this.npcFavoriteCommanderBusy.set(true);
    await this.mtg.setPlayerFavoriteCommanders(
      playerName,
      current.filter((c) => c !== name)
    );
    this.npcFavoriteCommanderBusy.set(false);
  };

  readonly canAutofillNpcFavoriteCommanders = computed(() => {
    const name = this.profileService.viewingPlayerName();
    const current = this.viewingNpcFavoriteCommanders();
    if (!name || current.length >= 3) return false;
    return this.topPlayedCommanders(name, 3).some((c) => !current.includes(c));
  });

  async autofillNpcFavoriteCommanders(): Promise<void> {
    const name = this.profileService.viewingPlayerName();
    if (!name || this.npcFavoriteCommanderBusy()) return;

    const current = this.viewingNpcFavoriteCommanders();
    const remaining = 3 - current.length;
    if (remaining <= 0) return;

    const additions = this.topPlayedCommanders(name, current.length + remaining)
      .filter((c) => !current.includes(c))
      .slice(0, remaining);
    if (additions.length === 0) return;

    this.npcFavoriteCommanderBusy.set(true);
    await this.mtg.setPlayerFavoriteCommanders(name, [...current, ...additions]);
    this.npcFavoriteCommanderBusy.set(false);
  }

  /** Bündelt die Dialog-Bindings für eigenes bzw. NPC-Profil (keine Ternaries im Template). */
  readonly favoriteCommandersDialogTarget = computed(() => {
    if (this.profileService.viewingPlayerId()) {
      return {
        isNpc: true as const,
        favorites: this.viewingNpcFavoriteCommanders(),
        busy: this.npcFavoriteCommanderBusy(),
        canAutofill: this.canAutofillNpcFavoriteCommanders(),
        onAdd: this.addNpcFavoriteCommander,
        onRemove: this.removeNpcFavoriteCommander,
        onAutofill: () => this.autofillNpcFavoriteCommanders(),
      };
    }
    return {
      isNpc: false as const,
      favorites: this.profileService.profile()?.favoriteCommanders ?? [],
      busy: this.favoriteCommanderBusy(),
      canAutofill: this.canAutofillFavoriteCommanders(),
      onAdd: this.addFavoriteCommander,
      onRemove: this.removeFavoriteCommander,
      onAutofill: () => this.autofillFavoriteCommanders(),
    };
  });

  readonly editedName = signal('');
  readonly isEditing = signal(false);
  readonly saveMessage = signal('');

  startEdit(): void {
    this.editedName.set(this.profileService.profile()?.displayName ?? '');
    this.isEditing.set(true);
    this.saveMessage.set('');
  }

  cancelEdit(): void {
    this.isEditing.set(false);
  }

  async saveName(): Promise<void> {
    const success = await this.profileService.updateDisplayName(this.editedName());
    if (success) {
      this.isEditing.set(false);
      this.saveMessage.set(this.i18n.t('profile.msg.nameSaved'));
      setTimeout(() => this.saveMessage.set(''), 2000);
    } else {
      this.saveMessage.set(this.i18n.t('profile.msg.nameSaveFailed'));
    }
  }

  // --- Profilbild ---

  readonly avatarUploading = signal(false);
  readonly avatarError = signal('');

  async onAvatarSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.avatarError.set(this.i18n.t('profile.msg.pleaseSelectImage'));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      this.avatarError.set(this.i18n.t('profile.msg.avatarTooLarge'));
      return;
    }

    this.avatarError.set('');
    this.avatarUploading.set(true);
    const success = await this.profileService.uploadAvatar(file);
    this.avatarUploading.set(false);

    if (!success) {
      this.avatarError.set(this.i18n.t('profile.msg.avatarUploadFailed'));
    }
  }

  // --- App teilen ---

  readonly shareUrl = window.location.origin;
  readonly showShareDialog = signal(false);
  readonly qrDataUrl = signal<string | null>(null);
  readonly linkCopied = signal(false);

  async openShareDialog(): Promise<void> {
    this.showShareDialog.set(true);
    if (!this.qrDataUrl()) {
      const dataUrl = await QRCode.toDataURL(this.shareUrl, { width: 240, margin: 1 });
      this.qrDataUrl.set(dataUrl);
    }
  }

  closeShareDialog(): void {
    this.showShareDialog.set(false);
  }

  async copyShareLink(): Promise<void> {
    await navigator.clipboard.writeText(this.shareUrl);
    this.linkCopied.set(true);
    setTimeout(() => this.linkCopied.set(false), 2000);
  }

  // --- Commander-Namen reparieren (Alt-Daten von vor Verbesserungen an der Erkennung) ---

  readonly showRepairInfoDialog = signal(false);
  readonly repairBusy = signal(false);
  readonly repairProgress = signal<{ done: number; total: number } | null>(null);
  readonly repairMessage = signal('');

  openRepairInfoDialog(): void {
    this.repairMessage.set('');
    this.showRepairInfoDialog.set(true);
  }

  closeRepairInfoDialog(): void {
    this.showRepairInfoDialog.set(false);
  }

  async repairCommanderNames(): Promise<void> {
    /** Host repariert beim Ansehen eines FREMDEN Profils oder NPC-Profils dessen Decks, sonst geht's um den eigenen Account. */
    const viewingPlayerId = this.profileService.viewingPlayerId();
    const viewingUserId = this.profileService.viewingUserId();
    const owner: DeckOwner | null = viewingPlayerId
      ? { kind: 'player', playerId: viewingPlayerId }
      : this.resolveUserOwner(viewingUserId);
    if (!owner) return;

    this.repairBusy.set(true);
    this.repairMessage.set('');
    this.repairProgress.set({ done: 0, total: 0 });

    const result = await this.deckService.repairCommanderNames(owner, (done, total) =>
      this.repairProgress.set({ done, total })
    );
    const preconResult = await this.deckService.backfillPreconReleaseYears(owner);

    this.repairBusy.set(false);
    this.repairProgress.set(null);

    const messages = [
      result.checked === 0
        ? this.i18n.t('profile.msg.repairNothingToCheck')
        : this.i18n.t('profile.msg.repairDone', {
            checked: result.checked,
            fixed: result.fixed,
            linked: result.linked,
          }),
    ];
    if (preconResult.checked > 0) {
      if (preconResult.catalogUnavailable) {
        messages.push(this.i18n.t('profile.msg.repairPreconYearsCatalogUnavailable'));
      } else if (preconResult.updated < preconResult.checked) {
        messages.push(
          this.i18n.t('profile.msg.repairPreconYearsPartial', {
            updated: preconResult.updated,
            checked: preconResult.checked,
            names: preconResult.unmatchedNames.join(', '),
          })
        );
      } else {
        messages.push(this.i18n.t('profile.msg.repairPreconYears', { updated: preconResult.updated }));
      }
    }
    this.repairMessage.set(messages.join(' '));

    await this.reloadUnassignedFor(owner);
  }

  /** null nur, wenn weder ein fremder Account angesehen wird noch überhaupt ein Account eingeloggt ist (sollte im Profil-Tab praktisch nie vorkommen). */
  private resolveUserOwner(viewingUserId: string | null): DeckOwner | null {
    const userId = viewingUserId ?? this.auth.currentUser()?.id;
    return userId ? { kind: 'user', userId } : null;
  }

  // --- Manuell Commander <-> Deck verlinken/entlinken (Dialog + Logik in ManualDeckLinkService) ---

  /** Der Knopf im gemeinsamen Haupt-Bereich - gilt fürs eigene Profil wie für die Developer-Vollansicht. */
  async openManualLinkDialogForCurrent(): Promise<void> {
    const owner = this.statsOwner();
    if (!owner) return;
    await this.manualDeckLink.open(owner, () => this.reloadUnassignedFor(owner));
  }

  /** Für den Admin, der beim Ansehen eines FREMDEN Profils Alt-Spiele dieser Person nachträglich verlinkt. */
  async openManualLinkDialogFor(viewingUserId: string): Promise<void> {
    const owner: DeckOwner = { kind: 'user', userId: viewingUserId };
    await this.manualDeckLink.open(owner, async () => {
      this.viewingUnassignedCommanderStats.set(await this.deckService.getUnassignedCommanderStats(owner));
    });
  }

  /** Für den Host, der beim Ansehen eines NPC-Profils dessen Alt-Spiele nachträglich verlinkt. */
  async openManualLinkDialogForNpc(playerId: string): Promise<void> {
    const owner: DeckOwner = { kind: 'player', playerId };
    await this.manualDeckLink.open(owner, async () => {
      this.viewingNpcUnassignedCommanderStats.set(await this.deckService.getUnassignedCommanderStats(owner));
    });
  }

  // --- Hintergrundbilder ---

  readonly showBackgroundsDialog = signal(false);

  openBackgroundsDialog(): void {
    this.showBackgroundsDialog.set(true);
  }

  closeBackgroundsDialog(): void {
    this.showBackgroundsDialog.set(false);
  }

  async onBackgroundFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    await this.backgrounds.uploadBackground(file);
  }

  async deleteBackground(id: string): Promise<void> {
    if (await this.dialog.confirm(this.i18n.t('profile.msg.confirmDeleteBackground'))) {
      await this.backgrounds.deleteBackground(id);
    }
  }

  readonly sharingBackgroundId = signal<string | null>(null);
  readonly shareCandidates = signal<{ userId: string; displayName: string }[]>([]);
  readonly shareBusy = signal(false);
  readonly shareMessage = signal('');

  async openBackgroundShareDialog(backgroundId: string): Promise<void> {
    this.sharingBackgroundId.set(backgroundId);
    this.shareBusy.set(true);
    this.shareMessage.set('');

    const myUserId = this.auth.currentUser()?.id;
    const seen = new Map<string, string>();
    for (const group of this.groupService.myGroups()) {
      const members = await this.groupService.loadGroupMembers(group.id);
      for (const m of members) {
        if (m.userId !== myUserId) seen.set(m.userId, m.displayName);
      }
    }

    this.shareCandidates.set([...seen.entries()].map(([userId, displayName]) => ({ userId, displayName })));
    this.shareBusy.set(false);
  }

  closeBackgroundShareDialog(): void {
    this.sharingBackgroundId.set(null);
    this.shareCandidates.set([]);
    this.shareMessage.set('');
  }

  async shareBackgroundWith(userId: string): Promise<void> {
    const backgroundId = this.sharingBackgroundId();
    if (!backgroundId) return;

    const ok = await this.backgrounds.shareBackground(backgroundId, userId);
    this.shareMessage.set(ok ? this.i18n.t('profile.msg.shared') : this.i18n.t('profile.msg.shareFailed'));
    if (ok) setTimeout(() => this.shareMessage.set(''), 2000);
  }

  // --- Datenexport (Art. 20 DSGVO) ---

  readonly exportBusy = signal(false);

  async downloadMyData(): Promise<void> {
    this.exportBusy.set(true);
    const data = await this.profileService.exportMyData();
    this.exportBusy.set(false);

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `statsfinity-daten-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  // --- Account löschen (Danger Zone) ---

  readonly showDeleteAccountConfirm = signal(false);
  readonly deleteAccountConfirmText = signal('');
  readonly deleteAccountBusy = signal(false);
  readonly deleteAccountError = signal('');

  readonly canConfirmDeleteAccount = computed(() => this.i18n.isDeleteConfirmed(this.deleteAccountConfirmText()));

  openDeleteAccountConfirm(): void {
    this.showDeleteAccountConfirm.set(true);
    this.deleteAccountConfirmText.set('');
    this.deleteAccountError.set('');
  }

  closeDeleteAccountConfirm(): void {
    this.showDeleteAccountConfirm.set(false);
    this.deleteAccountConfirmText.set('');
    this.deleteAccountError.set('');
  }

  async confirmDeleteAccount(): Promise<void> {
    if (!this.canConfirmDeleteAccount()) return;

    this.deleteAccountBusy.set(true);
    this.deleteAccountError.set('');

    const result = await this.auth.deleteAccount();

    this.deleteAccountBusy.set(false);

    if (!result.success) {
      this.deleteAccountError.set(this.i18n.t('stats.msg.unknownDeleteError'));
      return;
    }
    // Erfolgreich: auth.currentUser() wird durch das signOut() in deleteAccount() null,
    // die App zeigt danach automatisch den Login-Screen.
  }
}