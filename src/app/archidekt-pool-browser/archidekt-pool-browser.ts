import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ArchidektPoolService, PoolDeck } from '../archidekt-pool.service';
import { CardImage } from '../card-image/card-image';
import { CardPreviewService } from '../card-preview.service';
import { I18nService } from '../i18n.service';
import { PartnerCardImage } from '../partner-card-image/partner-card-image';
import { ScryfallCard, ScryfallService } from '../scryfall.service';
import { BracketBadge } from '../ui/bracket-badge/bracket-badge';

/** Eine Karte der geöffneten Deckliste, angereichert um die Scryfall-Daten (vor allem das Bild). */
interface PoolCardEntry {
  card: ScryfallCard;
  quantity: number;
  isCommander: boolean;
}

/** Die fünf offiziellen Bracket-Stufen als Filteroptionen. */
const BRACKETS = [1, 2, 3, 4, 5] as const;

/**
 * Developer-Ansicht auf den Archidekt-Deckvorrat (Tabellen in
 * sql/archidekt-deck-pool-2026-09-15.sql, gefüllt von scripts/import-archidekt-decks.js).
 *
 * Eine eigene Seite im Inhaltsbereich, kein Vollbild-Popup - denselben Weg ist
 * deck-detail-view schon gegangen und wieder zurückgebaut worden: Ein position:fixed-Overlay
 * ergibt zwei gleichzeitig scrollbare Ebenen, und auf dem iPhone landet das Wischen dann
 * regelmäßig auf der falschen. Geöffnet über ArchidektPoolService.isOpen(), ausgewertet in
 * app.html.
 *
 * Aufbau bewusst wie precon-browser: Liste, Klick öffnet die Deckansicht innerhalb derselben
 * Komponente, Kartenbilder über scryfall.findCardsBulk(), Antippen öffnet die große Vorschau.
 */
@Component({
  selector: 'app-archidekt-pool-browser',
  imports: [FormsModule, CardImage, PartnerCardImage, BracketBadge],
  templateUrl: './archidekt-pool-browser.html',
  styleUrl: './archidekt-pool-browser.scss',
})
export class ArchidektPoolBrowser {
  readonly pool = inject(ArchidektPoolService);
  readonly i18n = inject(I18nService);
  private readonly scryfall = inject(ScryfallService);
  private readonly cardPreview = inject(CardPreviewService);

  readonly brackets = BRACKETS;

  readonly search = signal('');
  /** Genau eine Stufe ist immer gewählt - siehe PoolFilter. Startwert ist die unterste. */
  readonly bracket = signal<number>(1);

  /** Läuft beim Tippen, damit nicht jeder Tastendruck eine eigene Abfrage auslöst. */
  private suchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // app.html hängt die Komponente nur bei isOpen() ein, es gibt also je Öffnen eine frische
    // Instanz - hier zu laden heißt: die Liste ist beim Öffnen immer aktuell.
    void this.neuLaden();
  }

  setSearch(wert: string): void {
    this.search.set(wert);
    if (this.suchTimer) clearTimeout(this.suchTimer);
    this.suchTimer = setTimeout(() => void this.neuLaden(), 300);
  }

  setBracket(stufe: number): void {
    if (stufe === this.bracket()) return;
    this.bracket.set(stufe);
    void this.neuLaden();
  }

  /**
   * Ob gerade gesucht wird. Entscheidet bei null Treffern zwischen "nichts gefunden" und "in
   * dieser Stufe liegt noch nichts" - zwei sehr verschiedene Aussagen. Eine Stufe ist immer
   * gewählt, deshalb zählt hier nur der Suchbegriff.
   */
  readonly eingegrenzt = computed(() => this.search().trim().length > 0);

  private neuLaden(): Promise<void> {
    return this.pool.loadDecks({
      search: this.search(),
      bracket: this.bracket(),
    });
  }

  readonly selected = signal<PoolDeck | null>(null);
  readonly cards = signal<PoolCardEntry[]>([]);
  readonly deckBusy = signal(false);
  readonly deckFailed = signal(false);

  readonly commanderCards = computed(() =>
    this.cards()
      .filter((e) => e.isCommander)
      .map((e) => e.card),
  );

  readonly mainCards = computed(() => this.cards().filter((e) => !e.isCommander));

  /**
   * Summe der Mengen, nicht die Zahl der Kacheln: Mehrfach enthaltene Karten - in der Praxis fast
   * immer Standardländer - stehen als EINE Zeile mit ihrer Menge da (der Primärschlüssel der
   * Kartentabelle ist (deck_id, name_normalized)). Die Kachelzahl wäre deshalb kleiner als das
   * Deck und widerspräche der Kartenzahl in der Kopfzeile: "8x Forest" sind acht Karten, eine
   * Kachel. Ohne diese Summe stand über einem vollständigen Deck "Deck (92)" statt "Deck (99)".
   */
  readonly mainCardCount = computed(() =>
    this.mainCards().reduce((summe, e) => summe + e.quantity, 0),
  );

  async openDeck(deck: PoolDeck): Promise<void> {
    this.selected.set(deck);
    this.cards.set([]);
    this.deckFailed.set(false);
    this.deckBusy.set(true);

    const geladen = await this.pool.loadCards(deck.id);
    if (!geladen) {
      this.deckBusy.set(false);
      this.deckFailed.set(true);
      return;
    }

    // Eine Sammelanfrage für alle Namen statt einer je Karte. Namen, die Scryfall nicht kennt,
    // fehlen in der Map - dafür steht im Template die Namens-Kachel als Rückfallebene.
    const kartenMap = await this.scryfall.findCardsBulk(geladen.map((k) => k.name));

    this.cards.set(
      geladen.map((k) => ({
        // findCardsBulk legt jede Karte unter dem KLEINGESCHRIEBENEN Originalnamen ab (siehe
        // scryfall.service.ts: `original?.toLowerCase()`), nicht unter dem Namen, wie er
        // hineingereicht wurde. Ohne toLowerCase() geht jeder Treffer daneben und jede Karte
        // fällt stillschweigend auf die Namens-Kachel zurück - genau so nachgeschlagen wie in
        // precon-browser.ts. Das trim() deckt zusätzlich ab, dass die Map ihre Schlüssel aus den
        // getrimmten Namen baut, die Namen hier aber unverändert aus der Datenbank kommen.
        card: kartenMap.get(k.name.trim().toLowerCase()) ?? { name: k.name },
        quantity: k.quantity,
        isCommander: k.isCommander,
      })),
    );
    this.deckBusy.set(false);
  }

  backToList(): void {
    this.selected.set(null);
    this.cards.set([]);
  }

  openPreview(card: ScryfallCard): void {
    if (!card.imageUrl) return;
    this.cardPreview.open(card.imageUrl, card.backImageUrl, card.name);
  }

  archidektUrl(deck: PoolDeck): string {
    return `https://archidekt.com/decks/${deck.archidektId}`;
  }

  close(): void {
    this.backToList();
    this.pool.close();
  }
}
