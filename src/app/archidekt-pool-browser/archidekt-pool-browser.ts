import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ArchidektPoolService, PoolDeck } from '../archidekt-pool.service';
import { CardImage } from '../card-image/card-image';
import { CardPreviewService } from '../card-preview.service';
import { I18nService } from '../i18n.service';
import { PartnerCardImage } from '../partner-card-image/partner-card-image';
import { ScryfallCard, ScryfallService } from '../scryfall.service';
import { BracketBadge } from '../ui/bracket-badge/bracket-badge';
import { MultiSelect } from '../ui/multi-select/multi-select';

/** Eine Karte der geöffneten Deckliste, angereichert um die Scryfall-Daten (vor allem das Bild). */
interface PoolCardEntry {
  card: ScryfallCard;
  quantity: number;
  isCommander: boolean;
}

/** Die fünf offiziellen Bracket-Stufen als Filteroptionen. */
const BRACKETS = ['1', '2', '3', '4', '5'] as const;

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
  imports: [FormsModule, CardImage, PartnerCardImage, BracketBadge, MultiSelect],
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
  /**
   * Startet mit allen Stufen - gleiche Konvention wie selectedModes in stats-tab.ts. Wichtig, weil
   * MultiSelect eine VOLLSTÄNDIGE Auswahl als "Alle" beschriftet und eine leere als "Keine
   * Auswahl": Würde hier leer für "alle" stehen, widerspräche der Knopf dem, was die Liste zeigt.
   */
  readonly bracketFilter = signal<Set<string>>(new Set(BRACKETS));

  readonly selected = signal<PoolDeck | null>(null);
  readonly cards = signal<PoolCardEntry[]>([]);
  readonly deckBusy = signal(false);
  readonly deckFailed = signal(false);

  /** Nach Name und Commander, beides klein geschrieben verglichen. Rein im Browser, ohne Nachladen. */
  readonly filteredDecks = computed(() => {
    const begriff = this.search().trim().toLowerCase();
    const stufen = this.bracketFilter();

    return this.pool.decks().filter((deck) => {
      if (!stufen.has(String(deck.creatorBracket))) return false;
      if (!begriff) return true;
      return (
        deck.name.toLowerCase().includes(begriff) ||
        deck.commanderNames.some((c) => c.toLowerCase().includes(begriff))
      );
    });
  });

  /** Für die Kopfzeile: "3 von 12" macht sichtbar, dass ein Filter gerade etwas ausblendet. */
  readonly totalCount = computed(() => this.pool.decks().length);

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
