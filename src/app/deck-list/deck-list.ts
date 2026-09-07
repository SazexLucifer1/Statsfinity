import { Component, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DeckService, Deck, DeckGameStats, DeckOwner } from '../deck.service';
import { DeckViewerService } from '../deck-viewer.service';
import { DeckImportService } from '../deck-import.service';
import { ScryfallCard, ScryfallService } from '../scryfall.service';
import { I18nService } from '../i18n.service';
import { DialogService } from '../dialog.service';
import { GoldfishService } from '../goldfish.service';
import { CardImage } from '../card-image/card-image';
import { OverflowMenu } from '../ui/overflow-menu/overflow-menu';
import { Pager } from '../ui/pager/pager';
import { BracketBadge } from '../ui/bracket-badge/bracket-badge';
import { storedDeckBracket } from '../bracket';
import { DECK_FORMATS, DeckFormat } from '../models';

export type DeckSortMode = 'alpha' | 'winRate' | 'games';

interface DeckWithStats extends Deck {
  games: number;
  wins: number;
  winRate: number;
  commander?: string;
  /** Individuell gewähltes Artwork des markierten Commanders (deck_cards.image_url) - hat Vorrang vor dem generischen Scryfall-Bild zum Namen. */
  commanderImageUrl?: string | null;
}

/** Obergrenze für die Seitengröße - auf dem Handy (1 Spalte) weiterhin genau dieser Wert. */
const PAGE_SIZE_CAP = 10;
/** Muss zu deck-list.scss (.deck-list Grid) passen: grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px. */
const GRID_MIN_COLUMN_PX = 300;
const GRID_GAP_PX = 12;

/**
 * Breite, ab der deck-list.scss auf das mehrspaltige Karten-Grid umschaltet.
 *
 * Wird aus der CSS-Custom-Property --bp-md gelesen (gesetzt in styles/_breakpoints.scss), damit
 * hier NICHT dieselbe Zahl ein zweites Mal steht: vorher war das ein hartkodiertes
 * '(min-width: 640px)', das still auseinanderlaufen konnte, sobald jemand nur das SCSS anfasst.
 * Der Fallback greift nur, wenn das Stylesheet noch nicht geladen ist.
 */
function gridBreakpointPx(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--bp-md');
  return Number.parseFloat(raw) || 700;
}

@Component({
  selector: 'app-deck-list',
  imports: [DecimalPipe, FormsModule, CardImage, OverflowMenu, Pager, BracketBadge],
  templateUrl: './deck-list.html',
  styleUrl: './deck-list.scss',
})
export class DeckList {
  readonly owner = input.required<DeckOwner>();
  /** Wenn true, sind Import/Bearbeiten/Löschen ausgeblendet - reine Ansicht fremder Decks. */
  readonly readonlyMode = input(false);
  /** Wenn true, werden Winrate/Spiele-Hinweis und die entsprechenden Sortier-Chips ausgeblendet (z.B. während einer aktiven Gruppen-Stats-Sperre). */
  readonly hideStats = input(false);

  private readonly deckService = inject(DeckService);
  readonly viewer = inject(DeckViewerService);
  readonly goldfish = inject(GoldfishService);
  readonly importService = inject(DeckImportService);
  private readonly scryfall = inject(ScryfallService);
  readonly i18n = inject(I18nService);
  private readonly dialog = inject(DialogService);

  readonly decks = signal<Deck[]>([]);
  private readonly deckStats = signal<Map<string, DeckGameStats>>(new Map());
  /** Fallback-Commander direkt aus dem Deck (deck_cards), falls noch keine Partie mit Commander-Angabe existiert. */
  private readonly storedCommanders = signal<Map<string, { name: string; imageUrl: string | null }>>(new Map());
  readonly loading = signal(true);

  readonly searchQuery = signal('');
  readonly sortMode = signal<DeckSortMode>('alpha');
  readonly formats = DECK_FORMATS;
  /**
   * Formatfilter der Liste. 'all' zeigt alle Decks (auch die ohne hinterlegtes Format),
   * sonst nur Decks genau dieses Formats. Vorbelegt mit 'Commander', weil das in dieser Gruppe
   * das gespielte Standardformat ist - wer etwas anderes sucht, stellt einmal um.
   */
  readonly formatFilter = signal<DeckFormat | 'all'>('Commander');
  readonly page = signal(0);
  /** Als "Outdated" markierte Decks sind standardmäßig ausgeblendet. */
  readonly showOutdated = signal(false);

  private readonly deckListEl = viewChild<ElementRef<HTMLElement>>('deckListEl');
  private resizeObserver: ResizeObserver | null = null;

  /** Live gemessene Spaltenanzahl des Karten-Grids (1 auf dem Handy, mehr auf breiteren Bildschirmen). */
  readonly columnsPerRow = signal(1);

  /** Größte Seitengröße bis maximal 10, die ein Vielfaches der aktuellen Spaltenanzahl ist - so
   * bleibt die letzte Zeile im Mehrspalten-Grid immer voll (z.B. 9 statt 10 bei 3 Spalten, 8 bei 4
   * Spalten), ohne auf dem Handy (1 Spalte) von den gewohnten 10 abzuweichen. */
  readonly pageSize = computed(() => {
    const cols = this.columnsPerRow();
    if (cols <= 1) return PAGE_SIZE_CAP;
    return Math.max(cols, Math.floor(PAGE_SIZE_CAP / cols) * cols);
  });

  /** Kartenname (lowercase) -> Scryfall-Daten oder null (nicht gefunden). Nur für aktuell sichtbare Einträge geladen. */
  private readonly cardDetails = signal<Record<string, ScryfallCard | null>>({});

  constructor() {
    effect(() => {
      const owner = this.owner();
      this.loading.set(true);
      this.page.set(0);
      this.deckService.loadDecksForOwner(owner).then(async (decks) => {
        this.decks.set(decks);
        const deckIds = decks.map((d) => d.id);
        const [stats, storedCommanders] = await Promise.all([
          this.deckService.getDeckStatsForDecks(deckIds),
          this.deckService.getStoredCommanders(deckIds),
        ]);
        this.deckStats.set(stats);
        this.storedCommanders.set(storedCommanders);
        this.loading.set(false);
      });
    });

    effect(() => {
      // Anders als früher NICHT mehr auf "ohne bereits hinterlegtes Artwork" gefiltert - das
      // DB-Feld deck_cards.image_url speichert nie eine Rückseite, die kommt für Doppelkarten immer
      // erst aus dieser Namenssuche, auch wenn die Vorderseite schon aus der DB bekannt ist.
      const names = this.pagedDecks()
        .map((d) => d.commander)
        .filter((n): n is string => !!n);
      const cache = this.cardDetails();
      const missing = [...new Set(names)].filter((n) => !(n.toLowerCase() in cache));
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

    // Lädt die Liste neu, sobald die Detailansicht (Ansehen/Bearbeiten) wieder geschlossen wird -
    // dort können Name, EDHREC-Tag oder der markierte Commander geändert worden sein, die sich
    // sonst erst nach einem manuellen Neuladen der Seite in dieser Liste zeigen würden.
    let wasViewingDeck = false;
    effect(() => {
      const isViewing = this.viewer.viewingDeck() !== null;
      if (wasViewingDeck && !isViewing) this.refreshDecks();
      wasViewingDeck = isViewing;
    });

    // Beobachtet die tatsächliche Breite des Karten-Grids, um columnsPerRow live nachzuführen -
    // erscheint das Element erst später (z.B. weil die Liste anfangs noch "Lade Decks …" zeigt),
    // greift der Effect erneut, sobald viewChild() eine Referenz liefert.
    effect((onCleanup) => {
      const el = this.deckListEl()?.nativeElement;
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      if (!el) {
        this.columnsPerRow.set(1);
        return;
      }
      this.resizeObserver = new ResizeObserver(() => this.measureColumns(el));
      this.resizeObserver.observe(el);
      this.measureColumns(el);
      onCleanup(() => this.resizeObserver?.disconnect());
    });
  }

  private measureColumns(el: HTMLElement): void {
    if (window.innerWidth < gridBreakpointPx()) {
      this.columnsPerRow.set(1);
      return;
    }
    const cols = Math.max(1, Math.floor((el.clientWidth + GRID_GAP_PX) / (GRID_MIN_COLUMN_PX + GRID_GAP_PX)));
    this.columnsPerRow.set(cols);
  }

  /** Kartenbild für ein Deck - individuell gewähltes Artwork des Commanders hat Vorrang vor dem generischen Scryfall-Bild zum Namen. */
  /**
   * Bracket-Abzeichen der Kachel. Kommt ausschließlich aus den gespeicherten Spalten - die Liste
   * darf für ein Abzeichen nicht die Kartenlisten aller Decks nachladen. Gefüllt werden sie beim
   * Öffnen des jeweiligen Decks (siehe DeckViewerService.autoBracketPersist).
   */
  bracketOf(deck: DeckWithStats): { level: number; source: 'manual' | 'auto' } | null {
    return storedDeckBracket(deck);
  }

  commanderImage(deck: DeckWithStats): string | null {
    if (deck.commanderImageUrl) return deck.commanderImageUrl;
    if (!deck.commander) return null;
    return this.cardDetails()[deck.commander.toLowerCase()]?.imageUrl ?? null;
  }

  /** Rückseite bei Doppelkarten - kommt immer aus der Namenssuche, nie aus deck_cards.image_url (das speichert nie eine Rückseite). */
  commanderBackImage(deck: DeckWithStats): string | null {
    if (!deck.commander) return null;
    return this.cardDetails()[deck.commander.toLowerCase()]?.backImageUrl ?? null;
  }

  private readonly decksWithStats = computed<DeckWithStats[]>(() =>
    this.decks().map((d) => {
      const s = this.deckStats().get(d.id) ?? { games: 0, wins: 0, winRate: 0 };
      const stored = this.storedCommanders().get(d.id);
      // Markierter Commander (deck_cards.is_commander) hat Vorrang vor dem in Partien
      // hinterlegten Namen, da der markierte Commander die aktuelle Wahrheit ist und sich
      // nach der letzten Partie geändert haben kann.
      const commander = stored?.name ?? s.commander;
      return { ...d, ...s, commander, commanderImageUrl: stored?.imageUrl };
    })
  );

  readonly filteredSortedDecks = computed<DeckWithStats[]>(() => {
    const query = this.searchQuery().trim().toLowerCase();
    // Bei fremden Profilen (readonlyMode) private Decks komplett ausblenden - im eigenen Profil
    // sieht man natürlich weiterhin alle eigenen, auch die privat gestellten.
    let list = this.readonlyMode() ? this.decksWithStats().filter((d) => !d.isPrivate) : this.decksWithStats();
    // Entweder-oder statt nur Ausblenden: mit eingeschaltetem Schalter waren vorher alle Decks
    // gemischt zu sehen, wodurch man den Unterschied gar nicht erkannte. Jetzt zeigt der Schalter
    // ausschließlich die als Outdated markierten Decks.
    list = this.showOutdated()
      ? list.filter((d) => d.isOutdated)
      : list.filter((d) => !d.isOutdated);
    if (query) {
      list = list.filter((d) => d.name.toLowerCase().includes(query));
    }
    const format = this.formatFilter();
    if (format !== 'all') {
      list = list.filter((d) => d.format === format);
    }

    // Bei ausgeblendeten Stats zählt nur noch alphabetisch - sonst würde die reine Sortier-Reihenfolge
    // schon verraten, welches Deck besser abschneidet, auch ohne die Zahlen selbst anzuzeigen.
    const mode = this.hideStats() ? 'alpha' : this.sortMode();
    list = [...list];
    if (mode === 'alpha') {
      list.sort((a, b) => a.name.localeCompare(b.name));
    } else if (mode === 'winRate') {
      list.sort((a, b) => b.winRate - a.winRate || b.games - a.games);
    } else {
      list.sort((a, b) => b.games - a.games || b.winRate - a.winRate);
    }
    return list;
  });

  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.filteredSortedDecks().length / this.pageSize())));

  readonly pagedDecks = computed<DeckWithStats[]>(() => {
    const size = this.pageSize();
    const start = this.page() * size;
    return this.filteredSortedDecks().slice(start, start + size);
  });


  setSearchQuery(value: string): void {
    this.searchQuery.set(value);
    this.page.set(0);
  }

  setFormatFilter(format: DeckFormat | 'all'): void {
    this.formatFilter.set(format);
    this.page.set(0);
  }

  setSortMode(mode: DeckSortMode): void {
    this.sortMode.set(mode);
    this.page.set(0);
  }

  toggleShowOutdated(): void {
    this.showOutdated.update((v) => !v);
    this.page.set(0);
  }



  async refreshDecks(): Promise<void> {
    const decks = await this.deckService.loadDecksForOwner(this.owner());
    this.decks.set(decks);
    const deckIds = decks.map((d) => d.id);
    const [stats, storedCommanders] = await Promise.all([
      this.deckService.getDeckStatsForDecks(deckIds),
      this.deckService.getStoredCommanders(deckIds),
    ]);
    this.deckStats.set(stats);
    this.storedCommanders.set(storedCommanders);
  }

  openNewDeckDialog(): void {
    this.importService.openNewDeckDialog(this.owner(), () => this.refreshDecks());
  }

  openNewEmptyDeckDialog(): void {
    this.importService.openNewEmptyDeckDialog(this.owner(), async (deck) => {
      await this.refreshDecks();
      // Frisch angelegtes Deck hat noch kein groupId (nur relevant bei spielerbesitzten Decks,
      // siehe deck-import.service.ts createEmptyDeck) - die frisch geladene Zeile aus refreshDecks()
      // verwenden, falls vorhanden, damit canEditViewingDeck() sofort korrekt greift.
      const fresh = this.decks().find((d) => d.id === deck.id) ?? deck;
      await this.viewer.open(fresh);
      this.viewer.toggleEditMode();
    });
  }

  openPreconDialog(): void {
    this.importService.openPreconDialog(this.owner(), () => this.refreshDecks());
  }

  async deleteDeck(deck: Deck): Promise<void> {
    if (this.readonlyMode()) return;
    if (!(await this.dialog.confirm(this.i18n.t('deck.msg.confirmDelete', { name: deck.name })))) return;
    await this.deckService.deleteDeck(deck.id);
    if (this.viewer.viewingDeck()?.id === deck.id) this.viewer.close();
    await this.refreshDecks();
  }

  async toggleDeckPrivate(deck: Deck): Promise<void> {
    if (this.readonlyMode()) return;
    const ok = await this.deckService.setDeckPrivate(deck.id, !deck.isPrivate);
    if (ok) await this.refreshDecks();
  }

  openDeckDetail(deck: Deck): void {
    this.viewer.open(deck);
  }

  openGoldfish(deck: Deck): void {
    this.goldfish.open(deck);
  }
}
