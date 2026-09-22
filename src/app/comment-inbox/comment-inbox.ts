import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { DeckCommentInboxService, InboxEntry } from '../deck-comment-inbox.service';
import { DeckCommentService } from '../deck-comment.service';
import { DeckService } from '../deck.service';
import { DeckViewerService } from '../deck-viewer.service';
import { I18nService } from '../i18n.service';
import { PlayerAvatar } from '../player-avatar/player-avatar';
import { Icon } from '../ui/icon/icon';

/**
 * Das Postfach oben im Profil: Kommentare auf eigene Decks und Antworten auf eigene Kommentare.
 *
 * Eingeklappt, solange nichts Ungelesenes da ist - eine dauerhaft ausgeklappte, meist leere Liste
 * schiebt im Profil nur alles nach unten. Der Zähler an der Tab-Leiste (siehe app.html) ist die
 * eigentliche Benachrichtigung, das hier ist, wo man nachsieht.
 */
@Component({
  selector: 'app-comment-inbox',
  imports: [DatePipe, PlayerAvatar, Icon],
  templateUrl: './comment-inbox.html',
  styleUrl: './comment-inbox.scss',
})
export class CommentInbox {
  readonly inbox = inject(DeckCommentInboxService);
  readonly i18n = inject(I18nService);

  private readonly comments = inject(DeckCommentService);
  private readonly deckService = inject(DeckService);
  private readonly viewer = inject(DeckViewerService);

  readonly offen = signal(false);
  readonly oeffnenBusy = signal(false);

  constructor() {
    // Beim Betreten des Profils den Zähler auffrischen - man kommt oft genau deswegen hierher.
    void this.inbox.refreshCount();
  }

  async toggle(): Promise<void> {
    const naechster = !this.offen();
    this.offen.set(naechster);
    if (naechster) await this.inbox.loadEntries();
  }

  /**
   * Nachricht antippen: als gelesen markieren, das Deck öffnen und dort zum Kommentar springen.
   *
   * Das Sprungziel wird VOR dem Öffnen gesetzt - die Kommentarliste im Deck lädt asynchron, und
   * der Abschnitt dort greift das Ziel auf, sobald seine Liste steht (siehe deck-comments.ts).
   */
  async open(entry: InboxEntry): Promise<void> {
    if (this.oeffnenBusy()) return;
    this.oeffnenBusy.set(true);

    void this.inbox.markAsRead(entry);
    this.comments.highlightCommentId.set(entry.commentId);

    const deck = await this.deckService.getDeckById(entry.deckId);
    this.oeffnenBusy.set(false);

    if (!deck) {
      // Deck zwischenzeitlich gelöscht oder nicht mehr sichtbar - dann wenigstens nicht mit einem
      // gesetzten Sprungziel zurücklassen, das beim nächsten Deck zuschlagen würde.
      this.comments.highlightCommentId.set(null);
      return;
    }
    await this.viewer.open(deck);
  }

  /** Anzeigename, oder ein neutraler Platzhalter, wenn das Profil hinter der Nachricht nicht mehr existiert. */
  nameOf(entry: InboxEntry): string {
    return entry.displayName?.trim() || this.i18n.t('deckComment.unknownAuthor');
  }

  /** Eine Zeile Kontext über der Nachricht: wer wo geschrieben hat. */
  betreff(entry: InboxEntry): string {
    const key = entry.art === 'reply' ? 'inbox.subjectReply' : 'inbox.subjectDeck';
    return this.i18n.t(key, { name: this.nameOf(entry), deck: entry.deckName });
  }
}
