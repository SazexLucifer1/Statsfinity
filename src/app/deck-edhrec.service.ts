import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Deck } from './deck.service';
import { ScryfallCard } from './scryfall.service';
import { CardDataService } from './card-data.service';
import { EdhrecService, EdhrecCardlist, EdhrecTag } from './edhrec.service';
import { ProfileService } from './profile.service';
import { DeckViewerState } from './deck-viewer-state.service';

/**
 * EDHREC-Vorschläge und Themen-Tags beim Karten-Hinzufügen (nur Alpha-Tester, siehe edhrecEnabled).
 */
@Injectable({ providedIn: 'root' })
export class DeckEdhrecService {
  private readonly cardData = inject(CardDataService);
  private readonly edhrec = inject(EdhrecService);
  private readonly profileService = inject(ProfileService);
  private readonly state = inject(DeckViewerState);

  // EDHREC-Vorschläge im Add-Karten-Panel
  readonly addCardMode = signal<'search' | 'edhrec'>('search');

  /** EDHREC-Vorschläge und -Tags nur für Alpha-Tester (siehe ProfileService.isAlphaTester). */
  readonly edhrecEnabled = computed(() => this.profileService.isAlphaTester());
  readonly edhrecLists = signal<EdhrecCardlist[] | null>(null);
  readonly edhrecBusy = signal(false);
  readonly edhrecFailed = signal(false);
  /** Kartenname (lowercase) -> Scryfall-Daten (Bild, Typenzeile) für alle EDHREC-Vorschläge, damit man die Karte ansehen kann. */
  readonly edhrecCardDetails = signal<Map<string, ScryfallCard>>(new Map());
  /**
   * Alle markierten Commander (0-2) aus editedDeckCards(), damit eine ungespeicherte Markierung
   * sofort neue Vorschläge lädt.
   */
  readonly edhrecCommanderNames = computed(
    () =>
      this.state
        .editedDeckCards()
        .filter((c) => c.isCommander)
        .map((c) => c.cardName),
    // Inhaltlicher Vergleich, sonst lädt edhrecListsAutoLoad bei jeder Kartenänderung neu
    // (sichtbarer Scroll-Sprung).
    { equal: (a, b) => a.length === b.length && a.every((name, i) => name === b[i]) },
  );
  /** Anzeige-Name für die EDHREC-Hinweistexte - bei einem Paar beide Namen kombiniert. */
  readonly edhrecCommanderName = computed(() => {
    const names = this.edhrecCommanderNames();
    return names.length ? names.join(' & ') : null;
  });
  /** Beim Deck-Anlegen gewählter EDHREC-Theme-Tag (z.B. "ramp") - kombiniert die Vorschläge mit dem Commander statt nur Commander allein. */
  readonly edhrecTagSlug = computed(() => this.state.viewingDeck()?.edhrecTag ?? null);

  // Tag-Wechsel nur zum Stöbern, ändert nicht den gespeicherten Deck-Tag.
  readonly edhrecBrowseTagActive = signal(false);
  readonly edhrecBrowseTag = signal<string | null>(null);
  readonly edhrecAvailableTags = signal<EdhrecTag[]>([]);
  readonly edhrecTagsBusy = signal(false);

  /** Der gerade tatsächlich für die Vorschläge verwendete Tag - Browse-Override hat Vorrang vor dem gespeicherten Deck-Tag. */
  readonly effectiveEdhrecTag = computed(() =>
    this.edhrecBrowseTagActive() ? this.edhrecBrowseTag() : this.edhrecTagSlug(),
  );

  /** Grob lesbarer Name aus dem Tag-Slug, ohne extra Netzwerk-Anfrage (z.B. "group-hug" -> "Group Hug"). */
  readonly edhrecTagLabel = computed(() => {
    const slug = this.effectiveEdhrecTag();
    if (!slug) return null;
    return slug
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  });

  setAddCardMode(mode: 'search' | 'edhrec'): void {
    this.addCardMode.set(mode);
  }

  /**
   * Auslöser-Zähler: wird bei jedem Reset der EDHREC-Anzeige erhöht, damit die Auto-Load-Effekte
   * sicher neu laufen (ein nicht-reaktives Feld tat das nicht).
   */
  private readonly edhrecRefreshTick = signal(0);

  /** Lädt EDHREC-Vorschläge neu, sobald der Tab offen ist und sich der Commander ändert. */
  private readonly edhrecListsAutoLoad = effect(() => {
    const mode = this.addCardMode();
    const commanders = this.edhrecCommanderNames();
    this.edhrecRefreshTick();
    if (mode !== 'edhrec') return;
    if (!this.edhrecEnabled()) {
      // Z.B. abgemeldet, während der EDHREC-Modus offen war - zurück zur normalen Suche.
      this.addCardMode.set('search');
      return;
    }
    this.edhrecLists.set(null);
    this.edhrecFailed.set(false);
    this.edhrecBrowseTagActive.set(false);
    this.edhrecBrowseTag.set(null);
    if (commanders.length === 0) {
      this.edhrecFailed.set(true);
      return;
    }
    this.loadEdhrecRecommendations();
  });

  /** Lädt die EDHREC-Tags bei Commander-Wechsel (auch für die Tag-Auswahl im Kopf). */
  private readonly edhrecTagsAutoLoad = effect(() => {
    const commanders = this.edhrecCommanderNames();
    this.edhrecRefreshTick();
    this.edhrecAvailableTags.set([]);
    if (commanders.length === 0 || !this.edhrecEnabled()) return;
    this.loadEdhrecAvailableTags(commanders);
  });

  /** Wechselt die angezeigten Vorschläge testweise auf einen anderen Tag - nur für diese Sitzung, nicht gespeichert. */
  setEdhrecBrowseTag(slug: string | null): void {
    this.edhrecBrowseTagActive.set(true);
    this.edhrecBrowseTag.set(slug);
    this.edhrecLists.set(null);
    this.edhrecFailed.set(false);
    this.loadEdhrecRecommendations();
  }

  /** Zurück zum dauerhaft im Deck gespeicherten Tag. */
  resetEdhrecBrowseTag(): void {
    if (!this.edhrecBrowseTagActive()) return;
    this.edhrecBrowseTagActive.set(false);
    this.edhrecBrowseTag.set(null);
    this.edhrecLists.set(null);
    this.edhrecFailed.set(false);
    this.loadEdhrecRecommendations();
  }

  private async loadEdhrecAvailableTags(commanders: string[]): Promise<void> {
    this.edhrecTagsBusy.set(true);
    const tags = await this.edhrec.getCommanderTags(commanders);
    this.edhrecTagsBusy.set(false);

    let list = tags ?? [];
    // Gespeicherten Tag immer anbieten, auch wenn EDHREC ihn umbenannt hat.
    const keepTag = this.state.deckTagDraft() ?? this.state.viewingDeck()?.edhrecTag ?? null;
    if (keepTag && !list.some((t) => t.slug === keepTag)) {
      list = [{ slug: keepTag, value: keepTag, count: 0 }, ...list];
    }
    this.edhrecAvailableTags.set(list);
  }

  private async loadEdhrecRecommendations(): Promise<void> {
    const commanders = this.edhrecCommanderNames();
    if (commanders.length === 0) {
      this.edhrecFailed.set(true);
      return;
    }
    this.edhrecBusy.set(true);
    this.edhrecFailed.set(false);
    const tag = this.effectiveEdhrecTag();
    let lists = await this.edhrec.getCommanderRecommendations(commanders, tag);
    if (lists === null && tag) {
      // Commander(-Paar)+Tag-Kombo evtl. nicht verfügbar (zu seltene Kombination) - auf reine
      // Commander-Vorschläge zurückfallen statt gar nichts anzuzeigen.
      lists = await this.edhrec.getCommanderRecommendations(commanders);
    }
    if (lists === null && commanders.length > 1) {
      // EDHREC hat evtl. keine eigene Seite für diese konkrete Partner-/Background-Kombi - auf den
      // ersten Commander allein zurückfallen statt gar nichts anzuzeigen.
      lists = await this.edhrec.getCommanderRecommendations([commanders[0]], tag);
      if (lists === null && tag) {
        lists = await this.edhrec.getCommanderRecommendations([commanders[0]]);
      }
    }
    this.edhrecLists.set(lists);
    this.edhrecFailed.set(lists === null);
    this.edhrecBusy.set(false);
    // Bilder lädt erst loadEdhrecCategoryImages() beim Aufklappen einer Kategorie - alle ~300 auf
    // einmal machten den Tab langsam.
  }

  readonly edhrecCategoryImagesBusy = signal<Set<string>>(new Set());

  /** Lädt Bilder nur für die Karten EINER Kategorie nach, sobald sie aufgeklappt wird - bereits geladene Karten werden übersprungen. */
  async loadEdhrecCategoryImages(tag: string, cardNames: string[]): Promise<void> {
    const known = this.edhrecCardDetails();
    const missing = cardNames.filter((n) => !known.has(n.toLowerCase()));
    if (missing.length === 0) return;

    this.edhrecCategoryImagesBusy.update((set) => new Set(set).add(tag));
    const found = await this.cardData.findCardsBulk(missing);
    this.edhrecCardDetails.update((current) => new Map([...current, ...found]));
    this.edhrecCategoryImagesBusy.update((set) => {
      const next = new Set(set);
      next.delete(tag);
      return next;
    });
  }

  isEdhrecCategoryImagesBusy(tag: string): boolean {
    return this.edhrecCategoryImagesBusy().has(tag);
  }

  edhrecCardImage(cardName: string): string | null {
    return this.edhrecCardDetails().get(cardName.toLowerCase())?.imageUrl ?? null;
  }

  edhrecCardBackImage(cardName: string): string | null {
    return this.edhrecCardDetails().get(cardName.toLowerCase())?.backImageUrl ?? null;
  }

  /** Vorschläge und Tags verwerfen; der Zähler lässt die Auto-Load-Effekte sicher neu laufen. */
  reset(): void {
    this.addCardMode.set('search');
    this.edhrecRefreshTick.update((v) => v + 1);
    this.edhrecLists.set(null);
    this.edhrecCardDetails.set(new Map());
    this.edhrecCategoryImagesBusy.set(new Set());
    this.edhrecBrowseTagActive.set(false);
    this.edhrecBrowseTag.set(null);
    this.edhrecAvailableTags.set([]);
    this.edhrecTagsBusy.set(false);
    this.edhrecBusy.set(false);
    this.edhrecFailed.set(false);
  }
}
