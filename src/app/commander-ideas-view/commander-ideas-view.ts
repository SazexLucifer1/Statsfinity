import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../i18n.service';
import { AuthService } from '../auth.service';
import { CardDataService } from '../card-data.service';
import { ScryfallService } from '../scryfall.service';
import { CommanderIdea, CommanderIdeasService } from '../commander-ideas.service';
import { DeckImportService } from '../deck-import.service';
import { DeckViewerService } from '../deck-viewer.service';
import { CardThumb } from '../ui/card-thumb/card-thumb';
import { Icon } from '../ui/icon/icon';
import { InfoToggle } from '../ui/info-toggle/info-toggle';

/**
 * Commander-Ideen als eigene Seite (Wunsch eines Spielers, 22.10.2026): eine private Merkliste,
 * damit sie im Profil keinen Platz wegnimmt. Hinzufügen per Namenssuche (nur Karten, die Commander
 * sein dürfen) oder aus jeder Kartenvorschau; je Idee Partner, Notiz, Reihenfolge und "Deck anlegen"
 * (öffnet den gewohnten Dialog mit Commander und Partner vorausgefüllt).
 */
@Component({
  selector: 'app-commander-ideas-view',
  imports: [FormsModule, CardThumb, Icon, InfoToggle],
  templateUrl: './commander-ideas-view.html',
  styleUrl: './commander-ideas-view.scss',
})
export class CommanderIdeasView {
  readonly i18n = inject(I18nService);
  readonly ideas = inject(CommanderIdeasService);
  private readonly auth = inject(AuthService);
  private readonly cardData = inject(CardDataService);
  private readonly scryfall = inject(ScryfallService);
  private readonly importService = inject(DeckImportService);
  private readonly viewer = inject(DeckViewerService);

  readonly query = signal('');
  readonly suggestions = signal<string[]>([]);
  readonly message = signal<string | null>(null);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  /** Idee, an der gerade ein Partner gesucht wird. */
  readonly partnerFor = signal<string | null>(null);
  readonly partnerQuery = signal('');
  readonly partnerSuggestions = signal<string[]>([]);
  readonly partnerError = signal<string | null>(null);
  /** Ideen, deren Commander einen zweiten Commander erlaubt (Partner, Background, Doctor …). */
  readonly allowsPartner = signal<ReadonlySet<string>>(new Set());

  constructor() {
    void this.ideas.ensureLoaded().then(() => this.checkPartners());
  }

  close(): void {
    this.ideas.closeView();
  }

  onSearchInput(value: string): void {
    this.query.set(value);
    this.message.set(null);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(async () => {
      this.suggestions.set(await this.scryfall.autocomplete(value));
    }, 250);
  }

  async addIdea(name: string): Promise<void> {
    this.suggestions.set([]);
    this.query.set('');
    const ok = await this.ideas.add(name);
    this.message.set(ok ? null : this.i18n.t('profile.ideas.exists', { name }));
    await this.checkPartners();
  }

  /** Welche Commander einen Partner zulassen - einmal über den Karten-Cache. */
  private async checkPartners(): Promise<void> {
    const names = (this.ideas.ideas() ?? []).map((i) => i.commander);
    if (!names.length) return;
    const cards = await this.cardData.findCardsBulk(names);
    const allowed = new Set<string>();
    for (const name of names) {
      const card = cards.get(name.toLowerCase());
      if (card && this.scryfall.allowsSecondCommander(card)) allowed.add(name.toLowerCase());
    }
    this.allowsPartner.set(allowed);
  }

  canAddPartner(idea: CommanderIdea): boolean {
    return !idea.partner && this.allowsPartner().has(idea.commander.toLowerCase());
  }

  startPartner(idea: CommanderIdea): void {
    this.partnerFor.set(this.partnerFor() === idea.id ? null : idea.id);
    this.partnerQuery.set('');
    this.partnerSuggestions.set([]);
    this.partnerError.set(null);
  }

  onPartnerInput(value: string): void {
    this.partnerQuery.set(value);
    this.partnerError.set(null);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(async () => {
      this.partnerSuggestions.set(await this.scryfall.autocompleteSecondCommander(value));
    }, 250);
  }

  /** Nur regelkonforme Paare - dieselbe Prüfung wie beim Anlegen eines Decks. */
  async choosePartner(idea: CommanderIdea, name: string): Promise<void> {
    this.partnerSuggestions.set([]);
    const [first, second] = await Promise.all([
      this.cardData.findCard(idea.commander),
      this.cardData.findCard(name),
    ]);
    if (!first || !second || !this.scryfall.canBeCommanderPair(first, second)) {
      this.partnerError.set(
        this.i18n.t('importDialog.msg.partnerInvalid', { existing: idea.commander, card: name }),
      );
      return;
    }
    if (await this.ideas.update(idea.id, { partner: second.name })) this.partnerFor.set(null);
  }

  removePartner(idea: CommanderIdea): void {
    void this.ideas.update(idea.id, { partner: null });
  }

  saveNote(idea: CommanderIdea, note: string): void {
    const trimmed = note.trim().slice(0, 200);
    if (trimmed !== idea.note) void this.ideas.update(idea.id, { note: trimmed });
  }

  move(idea: CommanderIdea, direction: -1 | 1): void {
    void this.ideas.move(idea.id, direction);
  }

  remove(idea: CommanderIdea): void {
    void this.ideas.remove(idea.id);
  }

  /** Der gewohnte Dialog "Neues Deck", Commander und Partner schon eingetragen. */
  async createDeck(idea: CommanderIdea): Promise<void> {
    const userId = this.auth.currentUser()?.id;
    if (!userId) return;
    this.importService.openNewEmptyDeckDialog({ kind: 'user', userId }, async (deck) => {
      await this.viewer.open(deck);
      this.viewer.toggleEditMode();
    });
    this.importService.newDeckName.set(idea.commander.split(',')[0].split(' // ')[0]);
    await this.importService.selectNewDeckCommander(idea.commander);
    if (idea.partner) await this.importService.selectNewDeckPartner(idea.partner);
  }
}
