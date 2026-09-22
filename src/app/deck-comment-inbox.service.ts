import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { PageVisibilityService } from './page-visibility.service';

export type InboxArt = 'deck' | 'reply';

export interface InboxEntry {
  commentId: string;
  deckId: string;
  deckName: string;
  /** 'deck' = jemand hat mein Deck kommentiert, 'reply' = jemand hat auf meinen Kommentar geantwortet. */
  art: InboxArt;
  authorId: string;
  displayName: string | null;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
  gelesen: boolean;
}

/** So viele Nachrichten zeigt das Postfach. Der Zähler rechnet serverseitig über ALLE (siehe die Migration). */
const INBOX_LIMIT = 50;

/**
 * Postfach für Deck-Kommentare (siehe sql/deck-kommentar-postfach-2026-09-22.sql): Kommentare auf
 * eigene Decks und Antworten auf eigene Kommentare, mit Zähler für die ungelesenen.
 *
 * Der Zähler kommt aus einer eigenen Abfrage, nicht aus `entries().filter(...)`: die Liste ist auf
 * INBOX_LIMIT begrenzt, ein Zähler daraus bliebe bei 50 stehen. Beide Abfragen laufen beim Start,
 * beim Login und wenn der Tab aus dem Hintergrund zurückkommt - kein Polling, denn ein
 * Hintergrund-Tab wird vom Browser ohnehin gedrosselt (siehe PageVisibilityService).
 */
@Injectable({ providedIn: 'root' })
export class DeckCommentInboxService {
  private readonly auth = inject(AuthService);
  private readonly pageVisibility = inject(PageVisibilityService);

  readonly entries = signal<InboxEntry[]>([]);
  readonly unreadCount = signal(0);
  readonly loading = signal(false);
  readonly loadFailed = signal(false);

  /** Wie in DeckCommentService: fehlt die Migration, verschwindet das Postfach still, statt zu meckern. */
  readonly verfuegbar = signal(true);

  readonly hatUngelesene = computed(() => this.unreadCount() > 0);

  constructor() {
    // Login/Logout: frisch zählen bzw. alles wegwerfen. Ohne das zeigte das Abzeichen nach einem
    // Kontowechsel weiter die Zahl des vorigen Kontos.
    effect(() => {
      if (this.auth.currentUser()) void this.refreshCount();
      else this.reset();
    });

    // Rückkehr aus dem Hintergrund - der übliche Weg, auf dem man am iPhone zur App zurückkommt.
    effect(() => {
      if (this.pageVisibility.visible() && this.auth.currentUser()) void this.refreshCount();
    });
  }

  private reset(): void {
    this.entries.set([]);
    this.unreadCount.set(0);
    this.loadFailed.set(false);
  }

  /** Nur der Zähler fürs Abzeichen - eine Zahl, keine Liste. */
  async refreshCount(): Promise<void> {
    if (!this.verfuegbar() || !this.auth.currentUser()) return;

    const { data, error } = await supabase.rpc('deck_comment_unread_count');
    if (error) {
      if (this.istFehlendeMigration(error)) return;
      console.error('Konnte ungelesene Kommentare nicht zählen:', error);
      return;
    }
    this.unreadCount.set(typeof data === 'number' ? data : 0);
  }

  /** Die Liste fürs geöffnete Postfach. Zählt den Zähler gleich mit neu, damit beides zusammenpasst. */
  async loadEntries(): Promise<void> {
    if (!this.verfuegbar() || !this.auth.currentUser()) return;

    this.loading.set(true);
    this.loadFailed.set(false);

    const { data, error } = await supabase.rpc('deck_comment_inbox', { p_limit: INBOX_LIMIT });

    this.loading.set(false);

    if (error) {
      if (this.istFehlendeMigration(error)) return;
      console.error('Konnte das Postfach nicht laden:', error);
      this.loadFailed.set(true);
      return;
    }

    this.entries.set(
      ((data as InboxRow[] | null) ?? []).map((row) => ({
        commentId: row.comment_id,
        deckId: row.deck_id,
        deckName: row.deck_name,
        art: row.art === 'reply' ? 'reply' : 'deck',
        authorId: row.author_id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        body: row.body,
        createdAt: row.created_at,
        gelesen: row.gelesen,
      })),
    );
    await this.refreshCount();
  }

  /**
   * Markiert eine Nachricht als gelesen. Die Anzeige wird sofort umgestellt und erst danach
   * geschrieben: das Antippen öffnet gleichzeitig das Deck, und bis die Zeile in der Datenbank
   * steht, ist die Liste längst aus dem Blick. Scheitert das Schreiben, wird der Schritt
   * zurückgenommen - sonst zeigte die App "gelesen" an, ohne dass es jemand erfahren hat.
   */
  async markAsRead(entry: InboxEntry): Promise<void> {
    const user = this.auth.currentUser();
    if (!user || entry.gelesen) return;

    this.setzeGelesen(entry.commentId, true);

    const { error } = await supabase
      .from('deck_comment_reads')
      .upsert(
        { user_id: user.id, comment_id: entry.commentId },
        { onConflict: 'user_id,comment_id' },
      );

    if (error) {
      console.error('Konnte Nachricht nicht als gelesen markieren:', error);
      this.setzeGelesen(entry.commentId, false);
    }
  }

  /** Alles auf gelesen - der übliche "Posteingang leeren"-Knopf. */
  async markAllAsRead(): Promise<void> {
    const user = this.auth.currentUser();
    const offen = this.entries().filter((e) => !e.gelesen);
    if (!user || offen.length === 0) return;

    const vorher = this.entries();
    const vorherCount = this.unreadCount();
    this.entries.set(vorher.map((e) => ({ ...e, gelesen: true })));
    this.unreadCount.set(Math.max(0, vorherCount - offen.length));

    const { error } = await supabase.from('deck_comment_reads').upsert(
      offen.map((e) => ({ user_id: user.id, comment_id: e.commentId })),
      { onConflict: 'user_id,comment_id' },
    );

    if (error) {
      console.error('Konnte Nachrichten nicht als gelesen markieren:', error);
      this.entries.set(vorher);
      this.unreadCount.set(vorherCount);
    }
  }

  private setzeGelesen(commentId: string, gelesen: boolean): void {
    this.entries.update((list) =>
      list.map((e) => (e.commentId === commentId ? { ...e, gelesen } : e)),
    );
    this.unreadCount.update((n) => Math.max(0, gelesen ? n - 1 : n + 1));
  }

  /** true = die Migration fehlt noch; das Postfach bleibt für den Rest der Sitzung aus. */
  private istFehlendeMigration(error: { code?: string; message?: string }): boolean {
    if (error.code !== 'PGRST202' && error.code !== '42883') return false;
    console.warn(
      'Postfach-Funktionen fehlen noch - sql/deck-kommentar-postfach-2026-09-22.sql im Supabase-SQL-Editor ausführen. Bis dahin gibt es keine Benachrichtigungen.',
    );
    this.verfuegbar.set(false);
    return true;
  }
}

/** Rohform einer Zeile aus deck_comment_inbox(). */
interface InboxRow {
  comment_id: string;
  deck_id: string;
  deck_name: string;
  art: string;
  author_id: string;
  display_name: string | null;
  avatar_url: string | null;
  body: string;
  created_at: string;
  gelesen: boolean;
}
