import { Injectable, inject, signal } from '@angular/core';
import { DeckService, Deck, DeckOwner } from './deck.service';
import { PreconService, PreconSummary } from './precon.service';
import { ScryfallService, ScryfallCard } from './scryfall.service';
import { EdhrecService, EdhrecTag } from './edhrec.service';
import { I18nService } from './i18n.service';
import { DeckFormat, DECK_FORMATS } from './models';

/** Precons sind immer fertige Commander-Produkte - kein Grund, hier eine Abfrage anzubieten. */
const PRECON_FORMAT = 'Commander';

/**
 * Hält den Zustand der Deck-Import-/Precon-Import-Dialoge global (statt lokal in DeckList), damit
 * die Dialoge als eigene, root-level gerenderte Komponente existieren können (analog
 * DeckViewerService) - nur so lässt sich echtes position:fixed über den ganzen Viewport erreichen,
 * ohne von einem `.glass-card`-Vorfahren mit backdrop-filter eingefangen zu werden.
 */
@Injectable({ providedIn: 'root' })
export class DeckImportService {
  private readonly deckService = inject(DeckService);
  private readonly preconService = inject(PreconService);
  private readonly scryfall = inject(ScryfallService);
  private readonly edhrec = inject(EdhrecService);
  readonly i18n = inject(I18nService);

  private owner: DeckOwner | null = null;
  private onSaved: (() => void) | null = null;

  // --- EDHREC-Theme-Tag - gemeinsam für beide Deck-anlegen-Dialoge (Import + Leeres Deck), da nie
  // beide gleichzeitig offen sind. Steuert später die EDHREC-Vorschläge im Bearbeiten-Modus. ---

  readonly availableCommanderTags = signal<EdhrecTag[]>([]);
  readonly commanderTagsBusy = signal(false);
  readonly selectedCommanderTag = signal<string | null>(null);
  private lastTagsCommander: string | null = null;

  setSelectedCommanderTag(slug: string | null): void {
    this.selectedCommanderTag.set(slug);
  }

  /** Lädt die verfügbaren EDHREC-Tags neu, wenn sich der (erkannte) Commander geändert hat - No-op sonst. */
  private async loadTagsForCommander(commanderName: string | null, keepTag: string | null = null): Promise<void> {
    if (commanderName === this.lastTagsCommander) return;
    this.lastTagsCommander = commanderName;
    this.selectedCommanderTag.set(keepTag);
    this.availableCommanderTags.set([]);
    if (!commanderName) return;

    this.commanderTagsBusy.set(true);
    const tags = await this.edhrec.getCommanderTags([commanderName]);
    this.commanderTagsBusy.set(false);

    let list = tags ?? [];
    // Gespeicherten Tag immer als Option anbieten, auch falls er in der frisch geladenen Liste
    // fehlen sollte (z.B. EDHREC hat den Tag seither umbenannt) - sonst würde die Auswahl im
    // <select> unsichtbar auf "nichts ausgewählt" zurückfallen, obwohl ein Wert gespeichert ist.
    if (keepTag && !list.some((t) => t.slug === keepTag)) {
      list = [{ slug: keepTag, value: keepTag, count: 0 }, ...list];
    }
    this.availableCommanderTags.set(list);
  }

  // --- Deck anlegen / aktualisieren ---

  readonly showImportDialog = signal(false);
  readonly editingDeckId = signal<string | null>(null);
  readonly deckName = signal('');
  readonly deckText = signal('');
  readonly deckFormats = DECK_FORMATS;
  readonly selectedFormat = signal<DeckFormat>('Commander');
  readonly importBusy = signal(false);
  readonly importMessage = signal('');
  private deckTextCommanderTimer: ReturnType<typeof setTimeout> | null = null;

  openNewDeckDialog(owner: DeckOwner, onSaved: () => void): void {
    this.owner = owner;
    this.onSaved = onSaved;
    this.editingDeckId.set(null);
    this.deckName.set('');
    this.deckText.set('');
    this.selectedFormat.set('Commander');
    this.importMessage.set('');
    this.lastTagsCommander = null;
    this.selectedCommanderTag.set(null);
    this.availableCommanderTags.set([]);
    this.showImportDialog.set(true);
  }

  async openEditDeckDialog(owner: DeckOwner, deck: Deck, onSaved: () => void): Promise<void> {
    this.owner = owner;
    this.onSaved = onSaved;
    this.editingDeckId.set(deck.id);
    this.deckName.set(deck.name);
    this.selectedFormat.set(deck.format ?? 'Commander');
    this.importMessage.set('');
    const cards = await this.deckService.loadDeckCards(deck.id);
    this.deckText.set(cards.map((c) => `${c.quantity} ${c.cardName}`).join('\n'));
    this.lastTagsCommander = null;
    const commander = cards.find((c) => c.isCommander)?.cardName ?? null;
    await this.loadTagsForCommander(commander, deck.edhrecTag);
    this.showImportDialog.set(true);
  }

  closeImportDialog(): void {
    this.showImportDialog.set(false);
  }

  /** Erkennt den Commander live aus der eingefügten Kartenliste (Abschnitt "Commander:"), um die passenden EDHREC-Tags anzubieten. */
  onDeckTextInput(value: string): void {
    this.deckText.set(value);
    if (this.deckTextCommanderTimer) clearTimeout(this.deckTextCommanderTimer);
    this.deckTextCommanderTimer = setTimeout(() => {
      const commander = this.deckService.parseDecklistText(value).find((p) => p.isCommander)?.name ?? null;
      this.loadTagsForCommander(commander);
    }, 400);
  }

  async saveDeck(): Promise<void> {
    const name = this.deckName().trim();
    if (!name || !this.deckText().trim() || !this.owner) return;

    this.importBusy.set(true);
    this.importMessage.set('');

    const ok = await this.deckService.saveDeck(
      this.owner,
      name,
      this.selectedFormat(),
      this.deckText(),
      this.editingDeckId(),
      false,
      this.selectedCommanderTag()
    );

    this.importBusy.set(false);

    if (ok) {
      this.showImportDialog.set(false);
      this.onSaved?.();
    } else {
      this.importMessage.set(this.i18n.t('importDialog.msg.saveFailed'));
    }
  }

  // --- Leeres Deck anlegen (Name + Commander, dann direkt in der Detailansicht per Hand
  // aufbauen statt eine ganze Kartenliste einzufügen) ---

  private onEmptyDeckCreated: ((deck: Deck) => void) | null = null;
  private emptyDeckCommanderSearchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly showNewEmptyDeckDialog = signal(false);
  readonly newDeckName = signal('');
  readonly newDeckCommanderQuery = signal('');
  readonly newDeckCommanderSuggestions = signal<string[]>([]);
  readonly newDeckCommanderSelected = signal<string | null>(null);
  readonly newDeckFormat = signal<DeckFormat>('Commander');
  readonly newDeckBusy = signal(false);
  readonly newDeckMessage = signal('');

  // --- Zweiter Commander (Partner) - das Feld erscheint nur, wenn der erste Commander laut seinen
  // Kartendaten überhaupt einen zweiten neben sich erlaubt (Partner, Partner with X,
  // Partner-Designator, Friends forever, Choose a Background, Doctor's companion). Ohne diesen
  // Weg landete ein Partner-Deck immer mit nur einem Commander in der Datenbank. ---

  /** Kartendaten des gewählten ersten Commanders - Grundlage für die Partner-Prüfung. */
  private newDeckCommanderCard: ScryfallCard | null = null;
  private partnerSearchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly newDeckPartnerAllowed = signal(false);
  readonly newDeckPartnerQuery = signal('');
  readonly newDeckPartnerSuggestions = signal<string[]>([]);
  readonly newDeckPartnerSelected = signal<string | null>(null);
  readonly newDeckPartnerBusy = signal(false);
  readonly newDeckPartnerError = signal<string | null>(null);

  openNewEmptyDeckDialog(owner: DeckOwner, onCreated: (deck: Deck) => void): void {
    this.owner = owner;
    this.onEmptyDeckCreated = onCreated;
    this.newDeckName.set('');
    this.newDeckCommanderQuery.set('');
    this.newDeckCommanderSuggestions.set([]);
    this.newDeckCommanderSelected.set(null);
    this.newDeckFormat.set('Commander');
    this.newDeckMessage.set('');
    this.newDeckCommanderCard = null;
    this.clearNewDeckPartner();
    this.newDeckPartnerAllowed.set(false);
    this.lastTagsCommander = null;
    this.selectedCommanderTag.set(null);
    this.availableCommanderTags.set([]);
    this.showNewEmptyDeckDialog.set(true);
  }

  closeNewEmptyDeckDialog(): void {
    this.showNewEmptyDeckDialog.set(false);
  }

  onNewDeckCommanderInput(value: string): void {
    this.newDeckCommanderQuery.set(value);
    this.newDeckCommanderSelected.set(null);
    this.newDeckCommanderCard = null;
    this.newDeckPartnerAllowed.set(false);
    this.clearNewDeckPartner();
    if (this.emptyDeckCommanderSearchTimer) clearTimeout(this.emptyDeckCommanderSearchTimer);
    this.emptyDeckCommanderSearchTimer = setTimeout(async () => {
      this.newDeckCommanderSuggestions.set(await this.scryfall.autocomplete(value));
    }, 250);
  }

  async selectNewDeckCommander(name: string): Promise<void> {
    this.newDeckCommanderSelected.set(name);
    this.newDeckCommanderQuery.set(name);
    this.newDeckCommanderSuggestions.set([]);
    this.newDeckCommanderCard = null;
    this.newDeckPartnerAllowed.set(false);
    this.clearNewDeckPartner();
    this.loadTagsForCommander(name);

    const card = await this.scryfall.findCard(name);
    // Zwischenzeitlich einen anderen Commander gewählt? Dann gehört dieses (langsamere) Ergebnis
    // nicht mehr zur aktuellen Auswahl und wird verworfen.
    if (this.newDeckCommanderSelected() !== name) return;
    this.newDeckCommanderCard = card;
    this.newDeckPartnerAllowed.set(!!card && this.scryfall.allowsSecondCommander(card));
  }

  onNewDeckPartnerInput(value: string): void {
    this.newDeckPartnerQuery.set(value);
    this.newDeckPartnerSelected.set(null);
    this.newDeckPartnerError.set(null);
    if (this.partnerSearchTimer) clearTimeout(this.partnerSearchTimer);
    this.partnerSearchTimer = setTimeout(async () => {
      this.newDeckPartnerSuggestions.set(await this.scryfall.autocompleteSecondCommander(value));
    }, 250);
  }

  /**
   * Übernimmt den zweiten Commander - aber nur, wenn er mit dem ersten zusammen ein regelkonformes
   * Paar bildet. Sonst bleibt die Auswahl leer und der Grund steht als Fehlermeldung im Dialog
   * (dieselbe Prüfung wie beim nachträglichen Markieren im Deck-Editor, siehe
   * DeckViewerService.toggleCommanderMark()).
   */
  async selectNewDeckPartner(name: string): Promise<void> {
    this.newDeckPartnerQuery.set(name);
    this.newDeckPartnerSuggestions.set([]);
    this.newDeckPartnerSelected.set(null);
    this.newDeckPartnerError.set(null);

    const first = this.newDeckCommanderCard;
    if (!first) return;

    this.newDeckPartnerBusy.set(true);
    const card = await this.scryfall.findCard(name);
    this.newDeckPartnerBusy.set(false);
    if (this.newDeckPartnerQuery() !== name) return;

    if (!card) {
      this.newDeckPartnerError.set(this.i18n.t('importDialog.msg.partnerNotFound'));
      return;
    }
    if (!this.scryfall.canBeCommanderPair(first, card)) {
      this.newDeckPartnerError.set(
        this.i18n.t('importDialog.msg.partnerInvalid', { existing: first.name, card: card.name })
      );
      return;
    }

    this.newDeckPartnerSelected.set(card.name);
    this.newDeckPartnerQuery.set(card.name);
  }

  clearNewDeckPartner(): void {
    if (this.partnerSearchTimer) clearTimeout(this.partnerSearchTimer);
    this.newDeckPartnerQuery.set('');
    this.newDeckPartnerSuggestions.set([]);
    this.newDeckPartnerSelected.set(null);
    this.newDeckPartnerBusy.set(false);
    this.newDeckPartnerError.set(null);
  }

  async createEmptyDeck(): Promise<void> {
    const name = this.newDeckName().trim();
    const commander = this.newDeckCommanderSelected();
    if (!name || !commander || !this.owner) return;

    this.newDeckBusy.set(true);
    this.newDeckMessage.set('');

    const tag = this.selectedCommanderTag();
    const format = this.newDeckFormat();
    // Beide Commander stehen unter derselben "Commander:"-Überschrift - parseDecklistText()
    // markiert dadurch beide Zeilen als Commander (is_commander), genau wie bei einem Import einer
    // Partner-Decklist.
    const partner = this.newDeckPartnerAllowed() ? this.newDeckPartnerSelected() : null;
    const commanderSection = partner ? `Commander:\n1 ${commander}\n1 ${partner}` : `Commander:\n1 ${commander}`;
    const deckId = await this.deckService.saveDeck(this.owner, name, format, commanderSection, null, false, tag);

    this.newDeckBusy.set(false);

    if (deckId) {
      this.showNewEmptyDeckDialog.set(false);
      this.onEmptyDeckCreated?.({
        id: deckId,
        userId: this.owner.kind === 'user' ? this.owner.userId : null,
        playerId: this.owner.kind === 'player' ? this.owner.playerId : null,
        groupId: null,
        name,
        format,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        isPrecon: false,
        preconReleaseYear: null,
        edhrecTag: tag,
        isPrivate: false,
        isOutdated: false,
        creatureType: null,
        // Ein frisch angelegtes leeres Deck hat noch keine Karten - es gibt also weder etwas
        // festzulegen noch etwas zu berechnen. Beides füllt sich, sobald das Deck geöffnet wird.
        bracket: null,
        bracketAuto: null,
        bracketAutoAt: null,
      });
    } else {
      this.newDeckMessage.set(this.i18n.t('importDialog.msg.createFailed'));
    }
  }

  // --- Precon-Import ---

  readonly showPreconDialog = signal(false);
  readonly preconYear = signal<number>(new Date().getFullYear());
  readonly preconOptions = signal<PreconSummary[]>([]);
  readonly selectedPreconFileNames = signal<Set<string>>(new Set());
  readonly preconSearchBusy = signal(false);
  readonly preconImportBusy = signal(false);
  readonly preconImportProgress = signal<{ done: number; total: number } | null>(null);
  readonly preconMessage = signal('');

  async openPreconDialog(owner: DeckOwner, onSaved: () => void): Promise<void> {
    this.owner = owner;
    this.onSaved = onSaved;
    this.showPreconDialog.set(true);
    this.preconMessage.set('');
    this.selectedPreconFileNames.set(new Set());
    await this.searchPreconsForYear();
  }

  closePreconDialog(): void {
    this.showPreconDialog.set(false);
    this.preconOptions.set([]);
    this.selectedPreconFileNames.set(new Set());
  }

  setPreconYear(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isNaN(value)) this.preconYear.set(value);
  }

  async searchPreconsForYear(): Promise<void> {
    this.preconSearchBusy.set(true);
    this.preconMessage.set('');
    this.selectedPreconFileNames.set(new Set());
    this.preconOptions.set(await this.preconService.getPreconsForYear(this.preconYear()));
    this.preconSearchBusy.set(false);
  }

  isPreconSelected(fileName: string): boolean {
    return this.selectedPreconFileNames().has(fileName);
  }

  togglePreconSelected(fileName: string): void {
    this.selectedPreconFileNames.update((set) => {
      const next = new Set(set);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  }

  toggleAllPrecons(): void {
    const all = this.preconOptions();
    this.selectedPreconFileNames.set(
      this.selectedPreconFileNames().size === all.length ? new Set() : new Set(all.map((p) => p.fileName))
    );
  }

  async importSelectedPrecons(): Promise<void> {
    const selected = this.preconOptions().filter((p) => this.selectedPreconFileNames().has(p.fileName));
    if (selected.length === 0 || !this.owner) return;

    this.preconImportBusy.set(true);
    this.preconMessage.set('');
    this.preconImportProgress.set({ done: 0, total: selected.length });

    let failed = 0;
    for (const precon of selected) {
      const text = await this.preconService.loadPreconAsText(precon.fileName);
      const ok =
        text !== null &&
        (await this.deckService.saveDeck(
          this.owner,
          precon.name,
          PRECON_FORMAT,
          text,
          null,
          true,
          null,
          precon.releaseYear
        ));
      if (!ok) failed++;
      this.preconImportProgress.update((p) => (p ? { ...p, done: p.done + 1 } : p));
    }

    this.preconImportBusy.set(false);
    this.preconImportProgress.set(null);
    this.onSaved?.();

    this.preconMessage.set(
      failed === 0
        ? this.i18n.t('importDialog.msg.allImported', { count: selected.length })
        : this.i18n.t('importDialog.msg.partialImported', {
            success: selected.length - failed,
            total: selected.length,
            failed,
          })
    );
    this.selectedPreconFileNames.set(new Set());
  }
}
