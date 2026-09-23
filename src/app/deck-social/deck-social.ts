import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { AuthService } from '../auth.service';
import { DeckSocialService } from '../deck-social.service';
import { I18nService } from '../i18n.service';
import { Icon } from '../ui/icon/icon';

/**
 * Aufrufe und Likes eines Decks: Auge mit Zahl, Herz mit Zahl. In der Deck-Ansicht und im
 * öffentlichen Stöbern (countView = true) zählt das Öffnen als Aufruf und das Herz ist ein Knopf;
 * in der Deckliste (compact) ist es nur eine Anzeige - dort lädt deck-list die Zahlen gebündelt
 * für die ganze Seite, statt dass jede Zeile einzeln fragt.
 *
 * Liken darf, wer eingeloggt ist und nicht selbst der Besitzer ist. Für alle anderen bleibt das
 * Herz sichtbar (die Zahl interessiert trotzdem), aber als reine Anzeige mit Hinweis im title.
 */
@Component({
  selector: 'app-deck-social',
  imports: [Icon],
  templateUrl: './deck-social.html',
  styleUrl: './deck-social.scss',
})
export class DeckSocial {
  readonly social = inject(DeckSocialService);
  readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthService);

  readonly deckId = input.required<string>();
  /** Account des Besitzers - null bei Decks accountloser Spieler. */
  readonly ownerUserId = input<string | null>(null);
  readonly isPrivate = input(false);
  /** true = Öffnen zählt als Aufruf (Deck-Ansichten); false = nur anzeigen (Deckliste). */
  readonly countView = input(false);
  /** Kleine Darstellung für die Deckliste, ohne Like-Knopf. */
  readonly compact = input(false);

  readonly stats = computed(() => this.social.statsFor(this.deckId()));
  readonly canLike = computed(() => !this.compact() && this.social.canLike(this.ownerUserId()));
  readonly busy = computed(() => this.social.busy().has(this.deckId()));

  readonly likeHint = computed(() => {
    const s = this.stats();
    if (this.canLike()) return this.i18n.t(s?.likedByMe ? 'deckSocial.unlike' : 'deckSocial.like');
    if (!this.auth.currentUser()) return this.i18n.t('deckSocial.likeLoginHint');
    return this.i18n.t('deckSocial.ownDeckHint');
  });

  constructor() {
    // Deck-Wechsel in einer Ansicht = neuer Aufruf. Der Service zählt je Sitzung nur einmal je Deck.
    effect(() => {
      const id = this.deckId();
      if (!this.countView() || !id) return;
      const owner = this.ownerUserId();
      const priv = this.isPrivate();
      untracked(() => void this.social.registerView({ id, userId: owner, isPrivate: priv }));
    });
  }

  toggle(): void {
    if (this.canLike()) void this.social.toggleLike(this.deckId());
  }
}
