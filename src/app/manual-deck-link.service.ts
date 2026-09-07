import { Injectable, computed, inject, signal } from '@angular/core';
import { BorrowedDeckInfo, DeckService, Deck, DeckOwner, UnassignedCommanderStats } from './deck.service';
import { I18nService } from './i18n.service';

function linkableCommanders(stats: UnassignedCommanderStats[]): UnassignedCommanderStats[] {
  return stats.filter((c) => c.category !== 'cube');
}

/**
 * Manuelles Verlinken/Entlinken von "Commander ohne Deck"-Einträgen (alte Spiele, bei denen nur ein
 * Commander-Freitext statt einer echten deck_id gespeichert wurde) - global als Singleton-Dialog
 * gehalten (analog DeckPdfService/DeckImportService), damit er sowohl vom eigenen Profil als auch
 * vom Admin für ein fremdes Profil oder einen virtuellen Spieler geöffnet werden kann.
 */
@Injectable({ providedIn: 'root' })
export class ManualDeckLinkService {
  private readonly deckService = inject(DeckService);
  private readonly i18n = inject(I18nService);

  readonly showDialog = signal(false);
  private owner: DeckOwner | null = null;
  private onChanged: (() => void) | null = null;

  /**
   * Nur die tatsächlich verlinkbaren Commander (Kategorie 'none'/'borrowed'). Commander aus
   * Cube-/Draft-Runden sind bewusst NICHT dabei: zu ihnen wird es nie ein Deck geben, und ein
   * Verlinken wäre dort immer falsch (dieselbe Regel wie in eligibleMatchIdsExcludingCubeDraft).
   */
  readonly unassignedCommanderStats = signal<UnassignedCommanderStats[]>([]);
  readonly decksForLinking = signal<Deck[]>([]);

  readonly linkCommanderChoice = signal('');
  readonly linkDeckChoice = signal('');
  readonly linkBusy = signal(false);
  readonly linkMessage = signal('');

  /**
   * Geliehene Decks, an denen eigene Partien haengen. Sie stehen nur beim Lösen zur Auswahl, nicht
   * beim Verlinken: Verknüpfen kann man nur mit einem eigenen Deck, lösen muss man aber auch eine
   * automatisch erkannte Leihe können, die daneben lag.
   */
  readonly borrowedDecksForUnlinking = computed<BorrowedDeckInfo[]>(() => {
    const byId = new Map<string, BorrowedDeckInfo>();
    for (const c of this.unassignedCommanderStats()) {
      if (c.borrowedDeck && !byId.has(c.borrowedDeck.id)) byId.set(c.borrowedDeck.id, c.borrowedDeck);
    }
    return [...byId.values()];
  });

  readonly unlinkDeckChoice = signal('');
  readonly unlinkBusy = signal(false);
  readonly unlinkMessage = signal('');

  /** onChanged wird nach einem erfolgreichen Link/Unlink aufgerufen, damit der Aufrufer z.B. seine eigene "Commander ohne Deck"-Anzeige neu lädt. */
  async open(owner: DeckOwner, onChanged?: () => void): Promise<void> {
    this.owner = owner;
    this.onChanged = onChanged ?? null;

    this.linkCommanderChoice.set('');
    this.linkDeckChoice.set('');
    this.linkMessage.set('');
    this.unlinkDeckChoice.set('');
    this.unlinkMessage.set('');

    const [stats, decks] = await Promise.all([
      this.deckService.getUnassignedCommanderStats(owner),
      this.deckService.loadDecksForOwner(owner),
    ]);
    this.unassignedCommanderStats.set(linkableCommanders(stats));
    this.decksForLinking.set(decks);
    this.showDialog.set(true);
  }

  close(): void {
    this.showDialog.set(false);
  }

  private async refreshUnassigned(): Promise<void> {
    if (!this.owner) return;
    this.unassignedCommanderStats.set(linkableCommanders(await this.deckService.getUnassignedCommanderStats(this.owner)));
  }

  async confirmLink(): Promise<void> {
    const owner = this.owner;
    const commander = this.linkCommanderChoice();
    const deckId = this.linkDeckChoice();
    if (!owner || !commander || !deckId) return;

    this.linkBusy.set(true);
    this.linkMessage.set('');

    const ok = await this.deckService.linkCommanderToDeck(owner, commander, deckId);

    this.linkBusy.set(false);

    if (ok) {
      this.linkMessage.set(this.i18n.t('profile.msg.linked'));
      this.linkCommanderChoice.set('');
      this.linkDeckChoice.set('');
      await this.refreshUnassigned();
      this.onChanged?.();
    } else {
      this.linkMessage.set(this.i18n.t('profile.msg.linkFailed'));
    }
  }

  async confirmUnlink(): Promise<void> {
    const owner = this.owner;
    const deckId = this.unlinkDeckChoice();
    if (!owner || !deckId) return;

    this.unlinkBusy.set(true);
    this.unlinkMessage.set('');

    const ok = await this.deckService.unlinkDeckMatches(owner, deckId);

    this.unlinkBusy.set(false);

    if (ok) {
      this.unlinkMessage.set(this.i18n.t('profile.msg.unlinked'));
      this.unlinkDeckChoice.set('');
      await this.refreshUnassigned();
      this.onChanged?.();
    } else {
      this.unlinkMessage.set(this.i18n.t('profile.msg.unlinkFailed'));
    }
  }
}
