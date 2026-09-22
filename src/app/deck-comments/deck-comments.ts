import { Component, OnDestroy, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DeckComment, DeckCommentService, DECK_COMMENT_MAX_LENGTH } from '../deck-comment.service';
import { AuthService } from '../auth.service';
import { I18nService } from '../i18n.service';
import { PlayerAvatar } from '../player-avatar/player-avatar';
import { LoginRequired } from '../login-required/login-required';
import { Icon } from '../ui/icon/icon';

/**
 * Kommentarabschnitt unter einem Deck - eine Ebene Antworten, sonst eine schlichte chronologische
 * Liste. Wird an BEIDEN Stellen eingehängt, an denen man sich ein fremdes Deck ansieht: in der
 * Deck-Detailansicht (deck-detail-view, Decks der eigenen Gruppe) und im öffentlichen Deck-Stöbern
 * (public-deck-browser, Decks aller Nutzer). Die beiden Ansichten teilen sonst keinen Zustand
 * (siehe Klassenkommentar in public-deck-browser.ts), deshalb liegt hier bewusst keine eigene
 * Lade-/Schreiblogik, sondern nur die Oberfläche - alles andere steht im DeckCommentService.
 *
 * Lesen darf jeder, auch ohne Account (öffentliche Decks sind es selbst auch). Zum Schreiben
 * erscheint statt des Eingabefelds der übliche Login-Hinweis.
 */
@Component({
  selector: 'app-deck-comments',
  imports: [DatePipe, FormsModule, PlayerAvatar, LoginRequired, Icon],
  templateUrl: './deck-comments.html',
  styleUrl: './deck-comments.scss',
})
export class DeckComments implements OnDestroy {
  readonly comments = inject(DeckCommentService);
  readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthService);

  readonly deckId = input.required<string>();
  /** Besitzer des Decks - darf unter seinem eigenen Deck jeden Kommentar löschen. Null bei Decks accountloser Spieler (dort gibt es keinen Account, der Besitzer sein könnte). */
  readonly ownerUserId = input<string | null>(null);

  readonly maxLength = DECK_COMMENT_MAX_LENGTH;

  readonly loggedIn = computed(() => !!this.auth.currentUser());

  /** Text des Haupt-Eingabefelds. */
  readonly draft = signal('');
  /** Kommentar, unter dem gerade ein Antwortfeld offen steht - höchstens eines gleichzeitig. */
  readonly replyingTo = signal<string | null>(null);
  readonly replyDraft = signal('');

  constructor() {
    // Deck-Wechsel (anderes Deck geöffnet) lädt die Liste neu und verwirft angefangene Entwürfe -
    // ein halb getippter Kommentar gehört zu dem Deck, unter dem er getippt wurde.
    effect(() => {
      const id = this.deckId();
      this.draft.set('');
      this.replyingTo.set(null);
      this.replyDraft.set('');
      if (id) void this.comments.load(id);
    });
  }

  /**
   * Beim Schließen der Deck-Ansicht die Liste verwerfen: der Zustand liegt am Service und würde
   * sonst beim nächsten geöffneten Deck für einen Wimpernschlag die Kommentare des vorigen zeigen.
   */
  ngOnDestroy(): void {
    this.comments.clear();
  }

  async submit(): Promise<void> {
    if (await this.comments.add(this.deckId(), this.draft())) this.draft.set('');
  }

  toggleReply(comment: DeckComment): void {
    const offen = this.replyingTo() === comment.id;
    this.replyingTo.set(offen ? null : comment.id);
    this.replyDraft.set('');
  }

  async submitReply(comment: DeckComment): Promise<void> {
    if (await this.comments.add(this.deckId(), this.replyDraft(), comment.id)) {
      this.replyingTo.set(null);
      this.replyDraft.set('');
    }
  }

  canDelete(comment: DeckComment): boolean {
    return this.comments.canDelete(comment, this.ownerUserId());
  }

  async remove(comment: DeckComment): Promise<void> {
    await this.comments.remove(this.deckId(), comment.id);
  }

  /** Anzeigename, oder ein neutraler Platzhalter, wenn das Profil hinter dem Kommentar nicht mehr existiert. */
  nameOf(comment: DeckComment): string {
    return comment.displayName?.trim() || this.i18n.t('deckComment.unknownAuthor');
  }
}
