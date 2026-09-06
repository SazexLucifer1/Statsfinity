// NEU (komplette Datei)
import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MtgService } from '../mtg.service';
import { ScryfallCard, ScryfallService, ScryfallSet } from '../scryfall.service';
import { GameSessionService } from '../game-session.service';
import { GroupService } from '../group.service';
import { AuthService } from '../auth.service';
import { PlayerAvatar } from '../player-avatar/player-avatar';
import { DeckService, DeckOwner } from '../deck.service';
import { I18nService } from '../i18n.service';
import { TournamentService } from '../tournament.service';
import { DialogService } from '../dialog.service';
import { GAME_MODES, TEAM_OPTIONS, Match, LIVE_TRACKING_START_DATE, DECK_FORMATS } from '../models';
import { ARCHENEMY_OTHERS, DRAW, teamMemberLabel, gameModeLabel } from '../match-utils';
import { CardImage } from '../card-image/card-image';
import { BracketBadge } from '../ui/bracket-badge/bracket-badge';
import { storedDeckBracket } from '../bracket';

/** Ein einzelnes Spiel oder eine zu einer Karte zusammengefasste BO3-Turnierpartie (2-3 Einzelspiele) im Verlauf. */
export type HistoryRow =
  | { kind: 'single'; match: Match }
  | {
      kind: 'group';
      tournamentMatchId: string;
      date: string;
      mode: Match['mode'];
      format: Match['format'];
      players: [string, string];
      scores: [number, number];
      games: Match[];
    };

@Component({
  selector: 'app-match-tab',
  imports: [FormsModule, DatePipe, NgTemplateOutlet, PlayerAvatar, CardImage, BracketBadge],
  templateUrl: './match-tab.html',
  styleUrl: './match-tab.scss',
})
export class MatchTab {
  readonly mtg = inject(MtgService);
  readonly session = inject(GameSessionService);
  readonly groupService = inject(GroupService);
  readonly auth = inject(AuthService);
  private readonly scryfall = inject(ScryfallService);
  private readonly deckService = inject(DeckService);
  readonly i18n = inject(I18nService);
  readonly tournament = inject(TournamentService);
  private readonly dialog = inject(DialogService);

  openTournamentPanel(): void {
    this.tournament.openPanel();
  }

  readonly modes = GAME_MODES;
  readonly formats = DECK_FORMATS;
  readonly teamOptions = TEAM_OPTIONS;

  modeLabel(mode: Match['mode'], format: Match['format']): string {
    return gameModeLabel(mode, format);
  }

  // --- Cubes ---
  readonly newCubeName = signal('');
  readonly newCubeIsCommander = signal(false);

  // Commander-Suche (auch für optionalen Partner/Background)
  readonly searchTarget = signal<{ player: string; slot: 'commander' | 'partner' } | null>(null);
  readonly searchQuery = signal('');
  readonly suggestions = signal<string[]>([]);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly errorMessage = signal('');
  readonly successMessage = signal('');

  // Draft sets
  readonly draftSearchQuery = signal('');
  readonly draftSuggestions = signal<ScryfallSet[]>([] as any);
  readonly draftYear = signal<number | null>(null);
  private draftTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Spielerauswahl ---

  togglePlayer(name: string): void {
    this.session.togglePlayer(name);
    if (this.searchTarget()?.player === name) this.closeSearch();
  }

  isSelected(name: string): boolean {
    return this.session.isSelected(name);
  }

  // --- Gast-Modus: freie Namenseingabe statt Gruppen-Chips (kein Account nötig) ---

  readonly guestNameInput = signal('');
  readonly guestPlayerNames = signal<string[]>([]);

  addGuestPlayer(): void {
    const name = this.guestNameInput().trim();
    if (!name || this.guestPlayerNames().includes(name)) return;
    this.guestPlayerNames.update((names) => [...names, name]);
    this.session.togglePlayer(name);
    this.guestNameInput.set('');
  }

  removeGuestPlayer(name: string): void {
    this.guestPlayerNames.update((names) => names.filter((n) => n !== name));
    this.session.togglePlayer(name);
  }

  // --- Commander-Suche ---

  openSearch(playerName: string, slot: 'commander' | 'partner' = 'commander'): void {
    this.searchTarget.set({ player: playerName, slot });
    this.searchQuery.set('');
    this.suggestions.set([]);
  }

  closeSearch(): void {
    this.searchTarget.set(null);
    this.searchQuery.set('');
    this.suggestions.set([]);
  }

  onSearchInput(value: string): void {
    this.searchQuery.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(async () => {
      this.suggestions.set(await this.scryfall.autocomplete(value));
    }, 250);
  }

  assignSearchResult(cardName: string): void {
    const target = this.searchTarget();
    if (!target) return;
    if (target.slot === 'partner') {
      this.assignPartnerCommander(target.player, cardName);
    } else {
      this.assignCommander(target.player, cardName);
    }
  }

  async onDraftSearchInput(value: string): Promise<void> {
    this.draftSearchQuery.set(value);
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.updateDraftSuggestions(), 250);
  }

  async filterDraftsByYear(yearParam: string | number | null): Promise<void> {
    const year = yearParam === null || yearParam === '' ? null : Number(yearParam);

    if (yearParam !== null && yearParam !== '' && Number.isNaN(year)) {
      return;
    }

    this.draftYear.set(year);
    await this.updateDraftSuggestions();
  }

  private async updateDraftSuggestions(): Promise<void> {
    const query = this.draftSearchQuery().trim();
    const year = this.draftYear();

    if (!query && year === null) {
      this.draftSuggestions.set([] as any);
      return;
    }

    const results = await this.scryfall.searchSets(query, year);
    this.draftSuggestions.set(results as any);
  }

  selectDraftSet(
    set: { id: string; code?: string; name: string; released_at?: string; set_type?: string } | null
  ): void {
    this.session.selectDraftSet(set);
  }

  assignCommander(playerName: string, commander: string): void {
    this.session.assignCommander(playerName, commander);
    this.closeSearch();
  }

  clearCommander(playerName: string): void {
    this.session.clearCommander(playerName);
  }

  assignPartnerCommander(playerName: string, commander: string): void {
    this.session.assignPartnerCommander(playerName, commander);
    this.closeSearch();
  }

  clearPartnerCommander(playerName: string): void {
    this.session.clearPartnerCommander(playerName);
  }

  // --- Deck-Auswahl (eigenes Deck oder von jemand anderem geliehen) ---

  readonly deckPickerTarget = signal<string | null>(null);
  readonly deckPickerOptions = signal<
    {
      deckId: string;
      deckName: string;
      isPrecon: boolean;
      ownerName?: string;
      commanderName?: string;
      commanderImageUrl?: string | null;
      createdAt: string;
      preconReleaseYear: number | null;
      /** Nur fuer das Bracket-Abzeichen - siehe storedDeckBracket() in bracket.ts. */
      format: string | null;
      bracket: number | null;
      bracketAuto: number | null;
    }[]
  >([]);
  readonly deckPickerBusy = signal(false);
  readonly deckPickerMessage = signal('');
  /** Suchfeld im Deck-Auswahl-Dialog - filtert nach Deck- oder Commander-Name. */
  readonly deckPickerSearchQuery = signal('');
  /** Jahresfilter im Deck-Auswahl-Dialog - bei Precons das MTGJSON-Release-Jahr, sonst das Anlage-Jahr des Decks. */
  readonly deckPickerYearFilter = signal<number | null>(null);

  /** Effektives Jahr eines Deck-Picker-Eintrags für den Jahresfilter: bei Precons das echte Release-Jahr, sonst das Anlage-Jahr. */
  private deckPickerYear(option: { isPrecon: boolean; preconReleaseYear: number | null; createdAt: string }): number | null {
    if (option.isPrecon) return option.preconReleaseYear;
    return option.createdAt ? new Date(option.createdAt).getFullYear() : null;
  }

  setDeckPickerYearFilter(yearParam: string | number | null): void {
    if (yearParam === null || yearParam === '') {
      this.deckPickerYearFilter.set(null);
      return;
    }
    const year = Number(yearParam);
    if (Number.isNaN(year)) return;
    this.deckPickerYearFilter.set(year);
  }

  /** Sichtbare Deck-Optionen im Auswahl-Dialog: alphabetisch sortiert, gefiltert nach Suchtext (Deck- oder Commander-Name) und optionalem Jahr. */
  readonly filteredDeckPickerOptions = computed(() => {
    const query = this.deckPickerSearchQuery().trim().toLowerCase();
    const year = this.deckPickerYearFilter();

    return this.deckPickerOptions()
      .filter((o) => !query || o.deckName.toLowerCase().includes(query) || (o.commanderName?.toLowerCase().includes(query) ?? false))
      .filter((o) => year === null || this.deckPickerYear(o) === year)
      .sort((a, b) => a.deckName.localeCompare(b.deckName));
  });
  /** Kartenname (lowercase) -> Scryfall-Daten oder null (nicht gefunden) - Fallback fürs Vorschaubild, wenn das Deck kein individuell gewähltes Artwork hinterlegt hat. */
  readonly deckPickerCards = signal<Record<string, ScryfallCard | null>>({});
  /** true = "Deck ausleihen"-Fluss, in dem zuerst die leihgebende Person und erst danach deren Decks gewählt werden. */
  readonly deckPickerBorrowMode = signal(false);
  /** Andere mitspielende Personen mit eigenem Account, von denen geliehen werden kann - Zwischenschritt vor der eigentlichen Deck-Liste. */
  readonly borrowOwnerOptions = signal<string[]>([]);
  /** Gewählte leihgebende Person im Borrow-Flow, oder null solange noch die Personen-Auswahl angezeigt wird. */
  readonly borrowFromOwner = signal<string | null>(null);
  /**
   * true = der Picker wurde aus dem nachträglichen Commander-Bearbeiten-Panel im Verlauf geöffnet -
   * selectDeck() schreibt dann in commanderDraft statt in die laufende session (siehe saveCommanders).
   */
  readonly deckPickerHistoryMode = signal(false);

  async openOwnDeckPicker(playerName: string, historyMode = false): Promise<void> {
    const userId = this.mtg.playerUserIds()[playerName];
    const playerId = this.mtg.playerIdFor(playerName);
    if (!userId && !playerId) return;
    const owner: DeckOwner = userId ? { kind: 'user', userId } : { kind: 'player', playerId: playerId! };

    this.deckPickerTarget.set(playerName);
    this.deckPickerHistoryMode.set(historyMode);
    this.deckPickerBorrowMode.set(false);
    this.borrowFromOwner.set(null);
    this.deckPickerMessage.set('');
    this.deckPickerBusy.set(true);
    this.deckPickerCards.set({});
    this.deckPickerSearchQuery.set('');
    this.deckPickerYearFilter.set(null);

    const decks = await this.deckService.loadDecksForOwner(owner);
    const options = decks.map((d) => ({
      deckId: d.id,
      deckName: d.name,
      isPrecon: d.isPrecon,
      createdAt: d.createdAt,
      preconReleaseYear: d.preconReleaseYear,
      format: d.format,
      bracket: d.bracket,
      bracketAuto: d.bracketAuto,
    }));
    this.deckPickerOptions.set(options);
    if (decks.length === 0) {
      this.deckPickerMessage.set(this.i18n.t('match.msg.noOwnDecksImported'));
    }
    this.deckPickerBusy.set(false);
    await this.loadDeckPickerCommanders(options);
  }

  openBorrowDeckPicker(playerName: string, historyMode = false): void {
    this.deckPickerTarget.set(playerName);
    this.deckPickerHistoryMode.set(historyMode);
    this.deckPickerBorrowMode.set(true);
    this.borrowFromOwner.set(null);
    this.deckPickerMessage.set('');
    this.deckPickerOptions.set([]);
    this.deckPickerSearchQuery.set('');
    this.deckPickerYearFilter.set(null);

    // Im History-Modus (Verlauf bearbeiten) gibt es keine laufende session-Spielerauswahl mehr -
    // dort kommen alle Gruppenmitglieder mit eigenem Deck-Bestand als Leihgeber infrage, nicht nur
    // die (evtl. leere) Auswahl aus dem "Neues Match"-Formular.
    const candidateNames = historyMode ? this.mtg.allPlayers() : this.session.selectedPlayers().map((p) => p.name);
    const others = candidateNames.filter(
      (name) => name !== playerName && (this.mtg.playerUserIds()[name] || this.mtg.playerIdFor(name))
    );

    this.borrowOwnerOptions.set(others);
    if (others.length === 0) {
      this.deckPickerMessage.set(this.i18n.t('match.msg.noOtherDecksFound'));
    }
  }

  async selectBorrowOwner(owner: string): Promise<void> {
    this.borrowFromOwner.set(owner);
    this.deckPickerMessage.set('');
    this.deckPickerBusy.set(true);
    this.deckPickerCards.set({});

    const userId = this.mtg.playerUserIds()[owner];
    const playerId = this.mtg.playerIdFor(owner);
    const deckOwner: DeckOwner = userId ? { kind: 'user', userId } : { kind: 'player', playerId: playerId! };
    const decks = await this.deckService.loadDecksForOwner(deckOwner);
    const options = decks.map((d) => ({
      deckId: d.id,
      deckName: d.name,
      isPrecon: d.isPrecon,
      ownerName: owner,
      createdAt: d.createdAt,
      preconReleaseYear: d.preconReleaseYear,
      format: d.format,
      bracket: d.bracket,
      bracketAuto: d.bracketAuto,
    }));
    this.deckPickerOptions.set(options);
    if (decks.length === 0) {
      this.deckPickerMessage.set(this.i18n.t('match.msg.noOwnDecksImported'));
    }
    this.deckPickerBusy.set(false);
    await this.loadDeckPickerCommanders(options);
  }

  /**
   * Bracket-Abzeichen eines Eintrags in der Deck-Auswahl. Rein aus den gespeicherten Spalten -
   * für eine Auswahlliste die Kartenlisten aller Decks zu laden wäre nicht vertretbar.
   */
  deckPickerBracket(option: {
    format: string | null;
    bracket: number | null;
    bracketAuto: number | null;
  }): { level: number; source: 'manual' | 'auto' } | null {
    return storedDeckBracket(option);
  }

  backToBorrowOwners(): void {
    this.borrowFromOwner.set(null);
    this.deckPickerOptions.set([]);
    this.deckPickerMessage.set('');
    this.deckPickerCards.set({});
    this.deckPickerSearchQuery.set('');
    this.deckPickerYearFilter.set(null);
  }

  /** Lädt den hinterlegten Commander je Deck (inkl. individuell gewähltem Artwork) und lädt fehlende Bilder per Scryfall nach, damit die Deck-Auswahl Vorschaubilder statt nur Namen zeigt. */
  private async loadDeckPickerCommanders(
    options: { deckId: string; deckName: string; isPrecon: boolean; ownerName?: string }[]
  ): Promise<void> {
    if (options.length === 0) return;

    const stored = await this.deckService.getStoredCommanders(options.map((o) => o.deckId));
    this.deckPickerOptions.update((current) =>
      current.map((o) => {
        const commander = stored.get(o.deckId);
        return commander ? { ...o, commanderName: commander.name, commanderImageUrl: commander.imageUrl } : o;
      })
    );

    // Anders als früher NICHT mehr auf "ohne bereits hinterlegtes Artwork" gefiltert - das
    // DB-Feld deck_cards.image_url speichert nie eine Rückseite, die kommt für Doppelkarten immer
    // erst aus dieser Namenssuche, auch wenn die Vorderseite schon aus der DB bekannt ist.
    const missing = [
      ...new Set(
        this.deckPickerOptions()
          .filter((o) => o.commanderName)
          .map((o) => o.commanderName!)
      ),
    ];
    if (missing.length === 0) return;

    const found = await this.scryfall.findCardsBulk(missing);
    this.deckPickerCards.update((current) => {
      const next = { ...current };
      for (const name of missing) {
        next[name.toLowerCase()] = found.get(name.toLowerCase()) ?? null;
      }
      return next;
    });
  }

  /** Vorschaubild für eine Deck-Option - individuell gewähltes Artwork hat Vorrang vor dem generischen Scryfall-Bild zum Commander-Namen. */
  deckPickerThumb(option: { commanderName?: string; commanderImageUrl?: string | null }): string | null {
    if (option.commanderImageUrl) return option.commanderImageUrl;
    if (!option.commanderName) return null;
    return this.deckPickerCards()[option.commanderName.toLowerCase()]?.imageUrl ?? null;
  }

  /** Rückseite bei Doppelkarten - kommt immer aus der Namenssuche, nie aus einem im Deck hinterlegten Bild (das speichert nie eine Rückseite). */
  deckPickerBackImage(option: { commanderName?: string }): string | null {
    if (!option.commanderName) return null;
    return this.deckPickerCards()[option.commanderName.toLowerCase()]?.backImageUrl ?? null;
  }

  closeDeckPicker(): void {
    this.deckPickerTarget.set(null);
    this.deckPickerHistoryMode.set(false);
    this.deckPickerOptions.set([]);
    this.deckPickerMessage.set('');
    this.deckPickerCards.set({});
    this.deckPickerBorrowMode.set(false);
    this.borrowFromOwner.set(null);
    this.borrowOwnerOptions.set([]);
    this.deckPickerSearchQuery.set('');
    this.deckPickerYearFilter.set(null);
  }

  async selectDeck(deckId: string): Promise<void> {
    const playerName = this.deckPickerTarget();
    if (!playerName) return;

    const cards = await this.deckService.loadDeckCards(deckId);
    const commanders = cards.filter((c) => c.isCommander);

    if (commanders.length === 0) {
      this.deckPickerMessage.set(this.i18n.t('match.msg.noCommanderInDeck'));
      return;
    }

    if (this.deckPickerHistoryMode()) {
      this.commanderDraft.update((draft) => ({
        ...draft,
        [playerName]: {
          commander: commanders[0].cardName,
          partnerCommander: commanders[1]?.cardName ?? null,
          deckId,
        },
      }));
    } else {
      this.session.assignDeck(playerName, deckId, commanders[0].cardName, commanders[1]?.cardName);
    }
    this.closeDeckPicker();
  }

  setPlayerTeam(playerName: string, team: string): void {
    this.session.setPlayerTeam(playerName, team);
  }

  toggleArchenemy(playerName: string): void {
    this.session.toggleArchenemy(playerName);
  }

  // --- Cubes ---

  async addNewCube(): Promise<void> {
    const name = this.newCubeName().trim();
    if (!name) return;
    const created = await this.mtg.addCube(name, this.newCubeIsCommander());
    if (created) {
      this.session.selectedCubeId.set(created.id);
      this.newCubeName.set('');
      this.newCubeIsCommander.set(false);
      this.successMessage.set(this.i18n.t('match.msg.cubeAdded'));
      setTimeout(() => this.successMessage.set(''), 2000);
    } else {
      this.errorMessage.set(this.i18n.t('match.msg.cubeAddFailed'));
      setTimeout(() => this.errorMessage.set(''), 2500);
    }
  }
  async deleteCube(id: string, name: string): Promise<void> {
    if (await this.dialog.confirm(this.i18n.t('match.msg.confirmDeleteCube', { name }))) {
      if (this.session.selectedCubeId() === id) {
        this.session.selectedCubeId.set(null);
      }
      await this.mtg.deleteCube(id);
    }
  }
  // --- Verlauf ---

  readonly historyExpanded = signal(false);
  readonly historyPage = signal(0);
  readonly historyPageSize = 10;

  /**
   * Alte Excel-Import-Spiele (vor dem 17.07.2026) werden hier nur ausgeblendet, nicht gelöscht -
   * sie zählen weiterhin ganz normal in der Statistik mit (die liest direkt aus mtg.history()),
   * nur die Anzeige im Verlauf lässt sie weg.
   */
  readonly visibleHistory = computed(() =>
    this.mtg.history().filter((m) => new Date(m.date) >= LIVE_TRACKING_START_DATE)
  );

  /**
   * Fasst die 2-3 Einzelspiele eines BO3-Turniertisches zu einer Karte zusammen (aufklappbar, siehe
   * expandedGroupId) - sonst müsste man beim Nachtragen/Korrigieren eines Endstands durch 3 einzelne
   * Verlaufseinträge klicken. Pod-Tische (nur ein Spiel) und normale Spiele bleiben einzelne Einträge.
   */
  readonly historyRows = computed<HistoryRow[]>(() => {
    const matches = this.visibleHistory();
    const seen = new Set<string>();
    const rows: HistoryRow[] = [];

    for (const m of matches) {
      if (m.tournamentMatchId && m.players.length === 2) {
        if (seen.has(m.tournamentMatchId)) continue;
        seen.add(m.tournamentMatchId);

        const games = matches
          .filter((g) => g.tournamentMatchId === m.tournamentMatchId)
          .sort((a, b) => (a.tournamentGameNumber ?? 0) - (b.tournamentGameNumber ?? 0));

        if (games.length > 1) {
          const [p1, p2] = m.players.map((p) => p.name);
          rows.push({
            kind: 'group',
            tournamentMatchId: m.tournamentMatchId,
            date: m.date,
            mode: m.mode,
            format: m.format,
            players: [p1, p2],
            scores: [games.filter((g) => g.winner === p1).length, games.filter((g) => g.winner === p2).length],
            games,
          });
          continue;
        }
      }
      rows.push({ kind: 'single', match: m });
    }

    return rows;
  });

  readonly expandedGroupId = signal<string | null>(null);

  toggleGroup(tournamentMatchId: string): void {
    this.expandedGroupId.update((id) => (id === tournamentMatchId ? null : tournamentMatchId));
  }

  readonly historyTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.historyRows().length / this.historyPageSize))
  );

  readonly pagedHistory = computed(() => {
    const start = this.historyPage() * this.historyPageSize;
    return this.historyRows().slice(start, start + this.historyPageSize);
  });

  readonly historyRangeEnd = computed(() =>
    Math.min((this.historyPage() + 1) * this.historyPageSize, this.historyRows().length)
  );

  /** Findet zu einer Account-User-ID/players.id den Spielernamen in der aktuellen Gruppe (für "ausgeliehen von X" im Verlauf). */
  deckOwnerName(ownerId: string | undefined, ownerPlayerId?: string): string | null {
    return this.mtg.deckOwnerName(ownerId, ownerPlayerId);
  }

  /** true, wenn das im Verlauf gezeigte Deck nicht der spielenden Person selbst gehört (also geliehen wurde). */
  isBorrowedDeck(player: { name: string; deckOwnerId?: string; deckOwnerPlayerId?: string }): boolean {
    if (player.deckOwnerPlayerId) return this.mtg.playerIdFor(player.name) !== player.deckOwnerPlayerId;
    if (!player.deckOwnerId) return false;
    return this.mtg.playerUserIds()[player.name] !== player.deckOwnerId;
  }

  toggleHistory(): void {
    this.historyExpanded.update((v) => !v);
  }

  prevHistoryPage(): void {
    this.historyPage.update((p) => Math.max(0, p - 1));
  }

  nextHistoryPage(): void {
    this.historyPage.update((p) => Math.min(this.historyTotalPages() - 1, p + 1));
  }

  async deleteMatch(id: string): Promise<void> {
    if (await this.dialog.confirm(this.i18n.t('match.msg.confirmDeleteMatch'))) {
      await this.mtg.deleteMatch(id);
    }
  }

  // --- Ergebnis nachträglich bearbeiten (Sieger + Platzierung zusammen in einem Panel) ---

  readonly editingResultMatchId = signal<string | null>(null);
  readonly placementDraft = signal<Record<string, number | null>>({});

  startEditResult(match: Match): void {
    if (this.editingResultMatchId() === match.id) {
      this.editingResultMatchId.set(null);
      return;
    }
    this.placementDraft.set(Object.fromEntries(match.players.map((p) => [p.name, p.placement ?? null])));
    this.commanderDraft.set(
      Object.fromEntries(
        match.players.map((p) => [
          p.name,
          { commander: p.commander ?? null, partnerCommander: p.partnerCommander ?? null, deckId: p.deckId },
        ])
      )
    );
    this.cubeEditDraft.set(match.cube?.id ?? null);
    this.editingResultMatchId.set(match.id);
  }

  closeEditResult(): void {
    this.editingResultMatchId.set(null);
    this.closeCommanderEdit();
  }

  // --- Commander nachträglich eintragen/ändern (Teil des Ergebnis-Bearbeiten-Panels) ---

  readonly commanderDraft = signal<
    Record<string, { commander: string | null; partnerCommander: string | null; deckId?: string }>
  >({});
  readonly commanderEditTarget = signal<{ player: string; slot: 'commander' | 'partner' } | null>(null);
  readonly commanderEditQuery = signal('');
  readonly commanderEditSuggestions = signal<string[]>([]);
  private commanderEditTimer: ReturnType<typeof setTimeout> | null = null;

  openCommanderEdit(playerName: string, slot: 'commander' | 'partner' = 'commander'): void {
    this.commanderEditTarget.set({ player: playerName, slot });
    this.commanderEditQuery.set('');
    this.commanderEditSuggestions.set([]);
  }

  closeCommanderEdit(): void {
    this.commanderEditTarget.set(null);
    this.commanderEditQuery.set('');
    this.commanderEditSuggestions.set([]);
  }

  onCommanderEditSearchInput(value: string): void {
    this.commanderEditQuery.set(value);
    if (this.commanderEditTimer) clearTimeout(this.commanderEditTimer);
    this.commanderEditTimer = setTimeout(async () => {
      this.commanderEditSuggestions.set(await this.scryfall.autocomplete(value));
    }, 250);
  }

  assignCommanderEditResult(cardName: string): void {
    const target = this.commanderEditTarget();
    if (!target) return;
    this.commanderDraft.update((draft) => ({
      ...draft,
      [target.player]: {
        commander: draft[target.player]?.commander ?? null,
        partnerCommander: draft[target.player]?.partnerCommander ?? null,
        // Freitext-Commander-Suche ist nicht mehr an ein konkret gewähltes Deck gebunden - eine
        // evtl. per Deck-Picker gesetzte deckId wird verworfen, damit beim Speichern wieder die
        // automatische Namens-Zuordnung greift (siehe MtgService.setCommanders).
        [target.slot === 'partner' ? 'partnerCommander' : 'commander']: cardName,
      },
    }));
    this.closeCommanderEdit();
  }

  clearCommanderDraft(playerName: string): void {
    this.commanderDraft.update((draft) => ({
      ...draft,
      [playerName]: { commander: null, partnerCommander: draft[playerName]?.partnerCommander ?? null },
    }));
  }

  clearPartnerCommanderDraft(playerName: string): void {
    this.commanderDraft.update((draft) => ({
      ...draft,
      [playerName]: { commander: draft[playerName]?.commander ?? null, partnerCommander: null },
    }));
  }

  async saveCommanders(match: Match): Promise<void> {
    const draft = this.commanderDraft();
    await this.mtg.setCommanders(
      match.id,
      match.players.map((p) => ({
        name: p.name,
        commander: draft[p.name]?.commander ?? null,
        partnerCommander: draft[p.name]?.partnerCommander ?? null,
        deckId: draft[p.name]?.deckId,
      }))
    );
    this.closeCommanderEdit();
  }

  // --- Cube nachträglich ändern (Teil des Ergebnis-Bearbeiten-Panels, nur bei Cube-Spielen) ---

  readonly cubeEditDraft = signal<string | null>(null);

  setCubeEditDraft(cubeId: string): void {
    this.cubeEditDraft.set(cubeId);
  }

  async saveCube(match: Match): Promise<void> {
    const cubeId = this.cubeEditDraft();
    if (!cubeId) return;
    await this.mtg.updateMatchCube(match.id, cubeId);
  }

  /**
   * Ändert den Sieger eines Matches im Verlauf - bei einem Turnier-Spiel wird zusätzlich der
   * zugehörige Tisch neu berechnet (Spielstand/Tisch-Sieger), sonst würde eine Korrektur hier nur
   * die normale Statistik ändern, aber nicht die Turnier-Ansicht - siehe TournamentService.
   */
  async setMatchWinner(id: string, winner: string): Promise<void> {
    const match = this.mtg.history().find((m) => m.id === id);
    await this.mtg.updateMatchWinner(id, winner);

    if (match?.tournamentMatchId) {
      if (match.players.length === 2) {
        await this.tournament.correctGameWinner(match.tournamentMatchId, id, winner);
      } else {
        const winnerPlayerId = this.mtg.playerIdFor(winner);
        if (winnerPlayerId) await this.tournament.correctWinner(match.tournamentMatchId, winnerPlayerId);
      }
    }
  }

  setPlacementDraft(name: string, value: string): void {
    this.placementDraft.update((d) => ({ ...d, [name]: value === '' ? null : Number(value) }));
  }

  async savePlacements(match: Match): Promise<void> {
    const draft = this.placementDraft();
    await this.mtg.setPlacements(
      match.id,
      match.players.map((p) => ({ name: p.name, placement: draft[p.name] ?? null }))
    );
    this.editingResultMatchId.set(null);
  }
  /** Mögliche Gewinner-Optionen für ein Match, abhängig vom Spielmodus. */
  winnerOptions(match: Match): { value: string; label: string }[] {
    const options: { value: string; label: string }[] = [];

    if (match.mode === 'Two-Headed Giant') {
      const teams = [...new Set(match.players.filter((p) => p.team).map((p) => p.team as string))];
      options.push(...teams.map((t) => ({ value: t, label: teamMemberLabel(match.players, t) })));
    } else if (match.mode === 'Archenemy') {
      const archenemy = match.players.find((p) => p.isArchenemy);
      if (archenemy) {
        options.push({
          value: archenemy.name,
          label: `👹 ${archenemy.name}${this.i18n.t('match.archenemySuffix')}`,
        });
      }
      options.push({ value: ARCHENEMY_OTHERS, label: this.i18n.t('match.theOthers') });
    } else {
      options.push(...match.players.map((p) => ({ value: p.name, label: p.name })));
    }

    options.push({ value: DRAW, label: this.i18n.t('match.draw') });
    return options;
  }
}
