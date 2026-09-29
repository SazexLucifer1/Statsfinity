import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe, CurrencyPipe } from '@angular/common';
import { PublicDeckService, PublicDeck, PublicDeckStats } from '../public-deck.service';
import { ScryfallCard, ScryfallService } from '../scryfall.service';
import { CardPreviewService } from '../card-preview.service';
import { I18nService } from '../i18n.service';
import { NavigationService } from '../navigation.service';
import { CardImage } from '../card-image/card-image';
import { PartnerCardImage } from '../partner-card-image/partner-card-image';
import { normalizeCardName } from '../array-utils';
import { BarChart } from '../ui/bar-chart/bar-chart';
import { ColorFilter } from '../ui/color-filter/color-filter';
import { DeckComments } from '../deck-comments/deck-comments';
import { DeckPrimer } from '../deck-primer/deck-primer';
import { DeckPrimerService } from '../deck-primer.service';
import {
  DeckSteckbrief,
  SteckbriefDeckinfo,
  SteckbriefKarte,
} from '../deck-steckbrief/deck-steckbrief';
import { DeckSteckbriefService } from '../deck-steckbrief.service';
import { ColorSelection, EMPTY_COLOR_SELECTION, FILTER_COLORS } from '../color-filter-match';
import { ReadonlyDeckAnalysis, ReadonlyDeckEntry, averageCmc } from '../deck-analyse';
import { DeckSocial } from '../deck-social/deck-social';
import { DeckSocialService } from '../deck-social.service';
import { BanlistService } from '../banlist.service';
import { ProfileService } from '../profile.service';
import { Icon } from '../ui/icon/icon';

/**
 * Öffentliche Decks anderer Nutzer durchsuchen (Name, Farbe, Archetyp, Kreaturtyp; sortiert nach
 * neu/Winrate) und lesend ansehen, auch ohne Account. Bewusst ohne DeckViewerService (Auth- und
 * Schreiblogik); Analyse und Filter kommen aus ReadonlyDeckAnalysis.
 */
@Component({
  selector: 'app-public-deck-browser',
  imports: [FormsModule, CardImage, PartnerCardImage, DecimalPipe, CurrencyPipe, BarChart, ColorFilter, DeckComments, DeckPrimer, DeckSocial, DeckSteckbrief, Icon],
  templateUrl: './public-deck-browser.html',
  styleUrl: './public-deck-browser.scss',
})
export class PublicDeckBrowser {
  private readonly publicDecks = inject(PublicDeckService);
  private readonly scryfall = inject(ScryfallService);
  private readonly cardPreview = inject(CardPreviewService);
  readonly i18n = inject(I18nService);
  private readonly navigation = inject(NavigationService);

  readonly nameFilter = signal('');
  readonly browseColors = signal<ColorSelection>(EMPTY_COLOR_SELECTION);
  readonly sort = signal<'recent' | 'winRate'>('recent');
  readonly archetype = signal<string | null>(null);
  readonly archetypeOptions = signal<string[]>([]);
  readonly creatureType = signal<string | null>(null);
  readonly creatureTypeOptions = signal<string[]>([]);
  readonly creatureTypesLoading = signal(false);

  readonly results = signal<PublicDeck[]>([]);
  readonly stats = signal<Map<string, PublicDeckStats>>(new Map());
  readonly commanderCardsByDeck = signal<Map<string, ScryfallCard[]>>(new Map());
  readonly busy = signal(false);
  readonly page = signal(0);

  private static readonly PAGE_SIZE = 30;

  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.results().length / PublicDeckBrowser.PAGE_SIZE)));
  readonly effectivePage = computed(() => Math.min(this.page(), this.totalPages() - 1));
  readonly pagedResults = computed(() => {
    const start = this.effectivePage() * PublicDeckBrowser.PAGE_SIZE;
    return this.results().slice(start, start + PublicDeckBrowser.PAGE_SIZE);
  });

  readonly primer = inject(DeckPrimerService);
  readonly social = inject(DeckSocialService);
  readonly banlist = inject(BanlistService);
  private readonly profileService = inject(ProfileService);
  readonly steckbriefTexte = inject(DeckSteckbriefService);
  /**
   * Offener Reiter des geöffneten Decks - hier immer nur lesend: Geändert werden Primer und
   * Steckbrief in der eigenen Deck-Ansicht, wo auch alles andere am Deck geändert wird.
   */
  readonly deckTab = signal<'cards' | 'steckbrief' | 'primer'>('cards');

  readonly selectedDeck = signal<PublicDeck | null>(null);
  readonly selectedDeckCommanderCards = signal<ScryfallCard[]>([]);
  readonly allCards = signal<ReadonlyDeckEntry[]>([]);

  /** Bannliste und Bauregeln für das geöffnete Deck: rot markierte Karten und Hinweiszeilen. */
  readonly pruefung = computed(() =>
    this.banlist.pruefe(
      this.selectedDeck()?.format ?? null,
      this.allCards().map((e) => ({
        cardName: e.card.name,
        quantity: e.quantity,
        typeLine: e.card.typeLine,
        oracleText: e.card.oracleText,
      })),
    ),
  );

  /** Hinweiszeilen zum Ausrufezeichen einer Kachel. */
  deckProbleme(deck: PublicDeck): string[] {
    return this.banlist.problemsFor(deck.id, deck.format);
  }
  readonly deckBusy = signal(false);

  readonly totalDeckPrice = signal<number | null>(null);
  readonly priceBusy = signal(false);

  readonly analyse = new ReadonlyDeckAnalysis(this.allCards, this.i18n);

  /**
   * Deck, dessen Steckbrief gerade als Popup über der Trefferliste liegt (Klick aufs
   * Commander-Bild einer Kachel). Eigener Zustand neben selectedDeck, weil die Liste darunter
   * stehen bleibt - erst „Deck ansehen" im Popup öffnet das Deck wirklich.
   */
  readonly passportDeck = signal<PublicDeck | null>(null);

  /**
   * Bei Decks mit zwei Commandern: welche Karte in der Kachel vorne liegt (Deck-ID → 0/1). Liegt
   * hier und nicht in partner-card-image, weil der Umschaltknopf in der Leiste unter dem Bild
   * sitzt, also außerhalb der Bild-Komponente.
   */
  readonly partnerFront = signal<ReadonlyMap<string, number>>(new Map());

  /**
   * Ob der vordere Commander einer Kachel gerade seine Rückseite zeigt (doppelseitige Karten).
   * Liegt aus demselben Grund hier wie partnerFront: Der Umdreh-Knopf sitzt in der Leiste.
   */
  readonly flipped = signal<ReadonlySet<string>>(new Set());
  readonly passportCards = signal<ReadonlyDeckEntry[]>([]);
  readonly passportBusy = signal(false);

  /** Gesetzt, wenn ein über den Deck-Link geöffnetes Deck nicht (mehr) öffentlich erreichbar ist. */
  readonly deckLinkLeer = signal(false);

  constructor() {
    this.publicDecks.archetypeOptions().then((options) => this.archetypeOptions.set(options));
    this.loadCreatureTypes();
    this.search();

    // Jemand hat einen Deck-Link aufgerufen, etwa den QR-Code eines Steckbriefs abgescannt
    // (siehe NavigationService.deckLink()). Das Deck steht in keiner Trefferliste - es wird
    // einzeln geholt und direkt geöffnet.
    effect(() => {
      const deckId = this.navigation.pendingPublicDeckId();
      if (!deckId) return;
      untracked(() => void this.openDeckById(deckId));
    });

    // Aufrufe, Likes und Besitzer nur für die sichtbare Seite, in einer Anfrage - nicht je Kachel.
    effect(() => {
      const ids = this.pagedResults().map((d) => d.id);
      untracked(() => void this.social.load(ids));
    });

    // Verbotene Karten ebenfalls seitenweise in einer Anfrage: Wer ein fremdes Deck nachbaut,
    // soll vorher sehen, dass es in seinem Format so gar nicht erlaubt ist.
    effect(() => {
      const ids = this.pagedResults().map((d) => d.id);
      untracked(() => void this.banlist.loadForDecks(ids));
    });

    // Bannliste des Formats für die rote Umrandung in der geöffneten Deck-Ansicht.
    effect(() => void this.banlist.loadFormat(this.selectedDeck()?.format ?? null));
  }

  /**
   * Öffnet ein Deck über seine ID statt über die Trefferliste. Die Commander-Kartenbilder müssen
   * dafür eigens nachgeladen werden: Die Karte im Kopf der Deck-Ansicht kommt aus der Zuordnung,
   * die sonst die Suche füllt, und in der steht dieses Deck nicht.
   */
  private async openDeckById(deckId: string): Promise<void> {
    this.navigation.pendingPublicDeckId.set(null);
    this.deckLinkLeer.set(false);
    this.deckBusy.set(true);

    const deck = await this.publicDecks.getPublicDeck(deckId);
    if (!deck) {
      this.deckBusy.set(false);
      this.deckLinkLeer.set(true);
      return;
    }

    const karten = await this.commanderKarten([deck]);
    this.commanderCardsByDeck.update((alt) => new Map([...alt, ...karten]));
    await this.openDeck(deck);
  }

  private async loadCreatureTypes(): Promise<void> {
    this.creatureTypesLoading.set(true);
    this.creatureTypeOptions.set(await this.scryfall.creatureTypes());
    this.creatureTypesLoading.set(false);
  }

  setSort(value: string): void {
    this.sort.set(value === 'winRate' ? 'winRate' : 'recent');
    this.search();
  }

  setArchetype(value: string): void {
    this.archetype.set(value === 'all' ? null : value);
  }

  setCreatureType(value: string): void {
    this.creatureType.set(value === 'all' ? null : value);
  }

  async search(): Promise<void> {
    this.busy.set(true);
    const { decks, stats } = await this.publicDecks.searchPublicDecks({
      name: this.nameFilter(),
      colors: [...this.browseColors().colors],
      archetype: this.archetype(),
      creatureType: this.creatureType(),
      sort: this.sort(),
    });

    this.results.set(decks);
    this.stats.set(stats);
    this.page.set(0);

    this.commanderCardsByDeck.set(await this.commanderKarten(decks));

    this.busy.set(false);
  }

  /**
   * Die Commander-Kartenbilder je Deck. Eigene Methode, weil sie zweimal gebraucht wird: für die
   * Trefferliste und für ein einzeln über den Deck-Link geöffnetes Deck, das in keiner Liste steht.
   */
  private async commanderKarten(decks: PublicDeck[]): Promise<Map<string, ScryfallCard[]>> {
    const namen = [...new Set(decks.flatMap((d) => d.commanders.map((c) => c.name)))];
    const cardMap = await this.scryfall.findCardsBulk(namen);
    const byDeck = new Map<string, ScryfallCard[]>();
    for (const deck of decks) {
      // Individuell gewähltes Artwork (deck_cards.image_url) hat Vorrang vor dem generischen
      // Scryfall-Bild zum Namen - gleiche Priorität wie deck-list.ts' commanderImage(), damit hier
      // dasselbe Bild wie in der eigentlichen Deck-Ansicht erscheint.
      const cards = deck.commanders
        .map((c) => {
          const base = cardMap.get(c.name.toLowerCase());
          if (!base) return undefined;
          return c.imageUrl ? { ...base, imageUrl: c.imageUrl } : base;
        })
        .filter((c): c is ScryfallCard => !!c);
      byDeck.set(deck.id, cards);
    }
    return byDeck;
  }

  resetFilters(): void {
    this.nameFilter.set('');
    this.browseColors.set(EMPTY_COLOR_SELECTION);
    this.archetype.set(null);
    this.creatureType.set(null);
    this.sort.set('recent');
    this.search();
  }

  statsFor(deckId: string): PublicDeckStats | null {
    return this.stats().get(deckId) ?? null;
  }

  commanderCardsFor(deckId: string): ScryfallCard[] {
    return this.commanderCardsByDeck().get(deckId) ?? [];
  }

  prevPage(): void {
    this.page.update((p) => Math.max(0, p - 1));
  }

  nextPage(): void {
    this.page.update((p) => Math.min(this.totalPages() - 1, p + 1));
  }

  async openDeck(deck: PublicDeck): Promise<void> {
    this.selectedDeck.set(deck);
    this.deckTab.set('cards');
    // Bewusst ohne await - der Primer hängt an keiner der anderen Ladeoperationen. Geladen wird er
    // trotzdem sofort: Ob es den Reiter gibt, hängt daran, ob dieses Deck einen Primer hat.
    this.primer.load(deck.id);
    this.steckbriefTexte.load(deck.id);
    this.selectedDeckCommanderCards.set(this.commanderCardsFor(deck.id));
    this.allCards.set([]);
    this.totalDeckPrice.set(null);
    this.analyse.resetCardFilters();
    this.deckBusy.set(true);

    const entries = await this.publicDecks.loadDeckCards(deck.id);
    const cardMap = await this.scryfall.findCardsBulk(entries.map((e) => e.name));

    const all: ReadonlyDeckEntry[] = [];
    for (const entry of entries) {
      const card = cardMap.get(entry.name.toLowerCase());
      if (card) all.push({ card, quantity: entry.quantity, isCommander: entry.isCommander });
    }

    this.allCards.set(all);
    this.deckBusy.set(false);

    this.loadCardPrices(all);
  }

  private async loadCardPrices(cards: ReadonlyDeckEntry[]): Promise<void> {
    this.priceBusy.set(true);
    const names = [...new Set(cards.map((c) => c.card.name))];
    // Nur die Preise; das incomplete-Flag wertet bislang allein die Deck-Ansicht aus ("ab X €",
    // siehe deckPriceIncomplete in deck-analysis.service.ts). Von der geduldigeren Wiederholung
    // in cheapestPrices() profitiert diese Ansicht trotzdem.
    const { prices } = await this.scryfall.cheapestPrices(names);
    let total = 0;
    for (const c of cards) {
      const price = prices.get(normalizeCardName(c.card.name.split(' // ')[0].trim()));
      if (price != null) total += price * c.quantity;
    }
    this.totalDeckPrice.set(total);
    this.priceBusy.set(false);
  }

  /**
   * Steckbrief eines Decks als Popup über der Liste. Die Karten werden dafür eigens geladen: Der
   * Steckbrief zählt daraus seine Wirkungs-Kacheln und braucht den Ø Manawert - beides steht in
   * der Trefferliste nicht. Aufgerufen wird der Steckbrief damit NICHT als Aufruf gezählt; das
   * passiert erst, wenn jemand über „Deck ansehen" das Deck selbst öffnet.
   */
  async openPassport(deck: PublicDeck): Promise<void> {
    this.passportDeck.set(deck);
    this.passportCards.set([]);
    this.passportBusy.set(true);
    this.steckbriefTexte.load(deck.id);

    const entries = await this.publicDecks.loadDeckCards(deck.id);
    const cardMap = await this.scryfall.findCardsBulk(entries.map((e) => e.name));
    // Inzwischen geschlossen oder ein anderes Deck geöffnet - diese Antwort gehört nicht mehr hierher.
    if (this.passportDeck()?.id !== deck.id) return;

    const all: ReadonlyDeckEntry[] = [];
    for (const entry of entries) {
      const card = cardMap.get(entry.name.toLowerCase());
      if (card) all.push({ card, quantity: entry.quantity, isCommander: entry.isCommander });
    }
    this.passportCards.set(all);
    this.passportBusy.set(false);
  }

  /** Tipp auf „von …“ unter einer Kachel: ins Profil des Besitzers, wie „Profil ansehen“ im Gruppen-Tab. */
  openOwnerProfile(userId: string): void {
    this.navigation.goToTab('profile');
    void this.profileService.viewProfile(userId);
    // Sonst bleibt die Scrollhöhe aus der Trefferliste stehen und das Profil öffnet mittendrin.
    window.scrollTo({ top: 0 });
  }

  partnerFrontFor(deckId: string): number {
    return this.partnerFront().get(deckId) ?? 0;
  }

  setPartnerFront(deckId: string, index: number): void {
    const next = new Map(this.partnerFront());
    next.set(deckId, index);
    this.partnerFront.set(next);
    // Der neu nach vorne geholte Commander liegt mit der Vorderseite oben.
    this.setFlipped(deckId, false);
  }

  /** Der Commander, der in der Kachel gerade vorne liegt - an ihm hängt der Umdreh-Knopf. */
  frontCardFor(deckId: string): ScryfallCard | null {
    const cards = this.commanderCardsFor(deckId);
    return cards[this.partnerFrontFor(deckId)] ?? cards[0] ?? null;
  }

  flippedFor(deckId: string): boolean {
    return this.flipped().has(deckId);
  }

  setFlipped(deckId: string, on: boolean): void {
    if (this.flippedFor(deckId) === on) return;
    const next = new Set(this.flipped());
    if (on) next.add(deckId);
    else next.delete(deckId);
    this.flipped.set(next);
  }

  swapPartner(deckId: string): void {
    this.setPartnerFront(deckId, 1 - this.partnerFrontFor(deckId));
  }

  closePassport(): void {
    this.passportDeck.set(null);
    this.passportCards.set([]);
    this.passportBusy.set(false);
    this.steckbriefTexte.zuruecksetzen();
  }

  /** „Deck ansehen" im Popup: Popup zu, Deck auf - wie ein Klick auf den Rest der Kachel. */
  openPassportDeck(): void {
    const deck = this.passportDeck();
    if (!deck) return;
    this.closePassport();
    void this.openDeck(deck);
  }

  backToList(): void {
    this.selectedDeck.set(null);
    this.deckTab.set('cards');
    this.primer.zuruecksetzen();
    this.steckbriefTexte.zuruecksetzen();
    this.selectedDeckCommanderCards.set([]);
    this.allCards.set([]);
  }

  openPreview(card: ScryfallCard): void {
    if (!card.imageUrl) return;
    this.cardPreview.open(card.imageUrl, card.backImageUrl, card.name);
  }

  // --- Steckbrief (siehe deck-steckbrief/) ---

  /**
   * Das geöffnete fremde Deck als Steckbrief-Angaben. Ohne Bracket: Die öffentliche Deck-Suche
   * lädt die Bracket-Spalten gar nicht erst (siehe PublicDeckService) und zeigt deshalb auch
   * sonst nirgends ein Bracket-Abzeichen - der Steckbrief soll hier nicht mehr behaupten als die
   * Ansicht drumherum weiß.
   */
  readonly steckbriefDeck = computed<SteckbriefDeckinfo | null>(() => {
    const deck = this.selectedDeck();
    return deck ? alsSteckbrief(deck) : null;
  });

  /** Die Karten des geöffneten Decks für den Steckbrief - er zählt daraus die Wirkungs-Kacheln. */
  readonly steckbriefKarten = computed<SteckbriefKarte[]>(() => alsSteckbriefKarten(this.allCards()));

  // Dasselbe für das Steckbrief-Popup über der Trefferliste.
  readonly passportSteckbrief = computed<SteckbriefDeckinfo | null>(() => {
    const deck = this.passportDeck();
    return deck ? alsSteckbrief(deck) : null;
  });
  readonly passportKarten = computed<SteckbriefKarte[]>(() => alsSteckbriefKarten(this.passportCards()));
  readonly passportAverageCmc = computed<number | null>(() => averageCmc(this.passportCards().map(alsAnalyseKarte)));
}

function alsSteckbrief(deck: PublicDeck): SteckbriefDeckinfo {
  return {
    id: deck.id,
    name: deck.name,
    formatLabel: deck.format,
    kreaturtyp: deck.commanderTypes[0] ?? null,
    farben: FILTER_COLORS.filter((c) => deck.colorIdentity.includes(c)),
    bracket: null,
    bracketQuelle: 'auto',
    commander: deck.commanders.map((c) => ({ name: c.name, imageUrl: c.imageUrl })),
    // Was hier ankommt, ist per RLS und Filter nicht privat - sonst stünde es nicht im
    // öffentlichen Stöbern.
    istPrivat: false,
  };
}

function alsSteckbriefKarten(entries: ReadonlyDeckEntry[]): SteckbriefKarte[] {
  return entries.map((e) => ({ name: e.card.name, quantity: e.quantity }));
}

function alsAnalyseKarte(e: ReadonlyDeckEntry) {
  return { quantity: e.quantity, cmc: e.card.cmc ?? 0, typeLine: e.card.typeLine };
}
