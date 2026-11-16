import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { ProfileService } from './profile.service';
import { I18nService } from './i18n.service';
import { PageVisibilityService } from './page-visibility.service';

export type FeedbackCategory = 'bug' | 'idea';
export type FeedbackStatus = 'open' | 'done';

export interface FeedbackEntry {
  id: string;
  displayName: string;
  category: FeedbackCategory;
  message: string;
  status: FeedbackStatus;
  createdAt: string;
  /** Antwort an die Person, die das Feedback geschrieben hat (null = keine geschickt). */
  replyText: string | null;
}

/** Eine Antwort auf eigenes Feedback, wie sie im Postfach steht. */
export interface FeedbackReply {
  id: string;
  category: FeedbackCategory;
  message: string;
  replyText: string;
  repliedAt: string;
  gelesen: boolean;
}

/** Fehlt sql/feedback-antwort-2026-11-16.sql noch? */
function fehltAntwortMigration(error: { code?: string } | null): boolean {
  return !!error && ['PGRST202', '42883', '42703', 'PGRST204'].includes(error.code ?? '');
}

/**
 * Bugreport-/Feedback-Formular (für alle Nutzer) + Verwaltungsansicht (nur für Accounts mit
 * profiles.is_developer) - hält den Zustand global, damit der Einreichen-Dialog als eigene,
 * root-level gerenderte Komponente existieren kann (analog DeckPdfService).
 */
@Injectable({ providedIn: 'root' })
export class FeedbackService {
  private readonly auth = inject(AuthService);
  private readonly profileService = inject(ProfileService);
  private readonly i18n = inject(I18nService);
  private readonly pageVisibility = inject(PageVisibilityService);

  constructor() {
    // Antworten auf eigenes Feedback: wie das Postfach beim Login und bei Rückkehr aus dem
    // Hintergrund auffrischen, kein Polling.
    effect(() => {
      if (this.auth.currentUser() && this.pageVisibility.visible()) void this.refreshReplyCount();
      if (!this.auth.currentUser()) {
        this.replies.set([]);
        this.replyUnreadCount.set(0);
      }
    });
  }

  // --- Einreichen-Dialog (für alle Nutzer) ---

  readonly showDialog = signal(false);
  readonly category = signal<FeedbackCategory>('bug');
  readonly message = signal('');
  readonly busy = signal(false);
  readonly resultMessage = signal('');
  readonly resultIsError = signal(false);

  open(): void {
    this.category.set('bug');
    this.message.set('');
    this.resultMessage.set('');
    this.resultIsError.set(false);
    this.showDialog.set(true);
  }

  close(): void {
    this.showDialog.set(false);
  }

  setCategory(category: FeedbackCategory): void {
    this.category.set(category);
  }

  setMessage(value: string): void {
    this.message.set(value);
  }

  async submit(): Promise<void> {
    const text = this.message().trim();
    const user = this.auth.currentUser();
    if (!text || !user) return;

    this.busy.set(true);
    this.resultMessage.set('');

    const { error } = await supabase.from('feedback').insert({
      user_id: user.id,
      display_name: this.profileService.profile()?.displayName ?? user.email ?? 'Unbekannt',
      category: this.category(),
      message: text,
    });

    this.busy.set(false);

    if (error) {
      console.error('Konnte Feedback nicht senden:', error);
      this.resultIsError.set(true);
      this.resultMessage.set(this.i18n.t('feedback.msg.sendFailed'));
      return;
    }

    this.resultIsError.set(false);
    this.resultMessage.set(this.i18n.t('feedback.msg.sent'));
    this.message.set('');
    setTimeout(() => this.showDialog.set(false), 1500);
  }

  // --- Verwaltungsansicht (nur App-Admins) ---

  readonly entries = signal<FeedbackEntry[]>([]);
  readonly entriesLoading = signal(false);
  readonly entriesLoaded = signal(false);
  readonly showDoneEntries = signal(false);

  async loadEntries(): Promise<void> {
    if (!this.profileService.profile()?.isDeveloper) return;

    this.entriesLoading.set(true);
    const { data, error } = await supabase
      .from('feedback')
      .select<string, FeedbackRow>(
        this.replyAvailable() ? `${ENTRY_COLUMNS}, reply_text` : ENTRY_COLUMNS,
      )
      .order('created_at', { ascending: false });

    // Ohne die Antwort-Migration fehlt reply_text - dann ohne die Spalte noch einmal.
    if (error && fehltAntwortMigration(error)) {
      this.replyAvailable.set(false);
      return this.loadEntries();
    }

    this.entriesLoading.set(false);
    this.entriesLoaded.set(true);

    if (error || !data) {
      console.error('Konnte Feedback-Einträge nicht laden:', error);
      this.entries.set([]);
      return;
    }

    this.entries.set(
      data.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        category: row.category as FeedbackCategory,
        message: row.message,
        status: row.status as FeedbackStatus,
        createdAt: row.created_at,
        replyText: row.reply_text ?? null,
      })),
    );
  }

  toggleShowDone(): void {
    this.showDoneEntries.update((v) => !v);
  }

  async setStatus(id: string, status: FeedbackStatus): Promise<void> {
    if (!this.profileService.profile()?.isDeveloper) return;

    const { error } = await supabase.from('feedback').update({ status }).eq('id', id);
    if (error) {
      console.error('Konnte Feedback-Status nicht ändern:', error);
      return;
    }
    this.entries.update((list) => list.map((e) => (e.id === id ? { ...e, status } : e)));
  }

  // --- Erledigt markieren mit Antwort (nur App-Admins) ---

  /** false = sql/feedback-antwort-2026-11-16.sql fehlt noch: dann nur der Status, keine Antwort. */
  readonly replyAvailable = signal(true);
  /** Das Feedback, zu dem gerade das Antwort-Blatt offen ist. */
  readonly resolving = signal<FeedbackEntry | null>(null);
  readonly replyDraft = signal('');
  readonly resolveBusy = signal(false);

  /** "Als erledigt markieren": öffnet das Blatt mit dem Standardtext, der sich je Nachricht ändern lässt. */
  startResolve(entry: FeedbackEntry): void {
    if (!this.replyAvailable()) {
      void this.setStatus(entry.id, 'done');
      return;
    }
    this.replyDraft.set(this.i18n.t('feedback.reply.default', { name: entry.displayName }));
    this.resolving.set(entry);
  }

  cancelResolve(): void {
    this.resolving.set(null);
  }

  /** withReply = false: nur erledigt, ohne Nachricht. */
  async confirmResolve(withReply: boolean): Promise<void> {
    const entry = this.resolving();
    if (!entry || !this.profileService.profile()?.isDeveloper) return;
    const reply = withReply ? this.replyDraft().trim() : '';

    this.resolveBusy.set(true);
    const { error } = await supabase.rpc('feedback_resolve', { p_id: entry.id, p_reply: reply });
    this.resolveBusy.set(false);

    if (error) {
      if (fehltAntwortMigration(error)) {
        console.warn(
          'Feedback-Antworten fehlen noch - sql/feedback-antwort-2026-11-16.sql ausführen.',
        );
        this.replyAvailable.set(false);
        this.resolving.set(null);
        await this.setStatus(entry.id, 'done');
        return;
      }
      console.error('Konnte Feedback nicht beantworten:', error);
      return;
    }
    this.entries.update((list) =>
      list.map((e) =>
        e.id === entry.id ? { ...e, status: 'done', replyText: reply || e.replyText } : e,
      ),
    );
    this.resolving.set(null);
  }

  // --- Antworten auf eigenes Feedback (für alle Nutzer, im Postfach) ---

  readonly replies = signal<FeedbackReply[]>([]);
  /** Eigene Zählabfrage wie beim Postfach - die Liste ist begrenzt. */
  readonly replyUnreadCount = signal(0);
  readonly hasReplies = computed(() => this.replies().length > 0);

  async refreshReplyCount(): Promise<void> {
    if (!this.replyAvailable() || !this.auth.currentUser()) return;
    const { data, error } = await supabase.rpc('feedback_reply_unread_count');
    if (error) {
      if (fehltAntwortMigration(error)) this.replyAvailable.set(false);
      else console.error('Konnte Feedback-Antworten nicht zählen:', error);
      return;
    }
    this.replyUnreadCount.set(typeof data === 'number' ? data : 0);
  }

  async loadReplies(): Promise<void> {
    if (!this.replyAvailable() || !this.auth.currentUser()) return;
    const { data, error } = await supabase.rpc('feedback_my_replies', { p_limit: 20 });
    if (error) {
      if (fehltAntwortMigration(error)) this.replyAvailable.set(false);
      else console.error('Konnte Feedback-Antworten nicht laden:', error);
      return;
    }
    this.replies.set(
      ((data as ReplyRow[] | null) ?? []).map((row) => ({
        id: row.id,
        category: row.category === 'idea' ? 'idea' : 'bug',
        message: row.message,
        replyText: row.reply_text,
        repliedAt: row.replied_at,
        gelesen: row.gelesen,
      })),
    );
    await this.refreshReplyCount();
  }

  /** Antippen einer Antwort im Postfach. Anzeige sofort, bei Fehler zurück. */
  async markReplyRead(reply: FeedbackReply): Promise<void> {
    if (reply.gelesen) return;
    this.setReplyRead(reply.id, true);
    const { error } = await supabase.rpc('feedback_mark_replies_read', { p_ids: [reply.id] });
    if (error) {
      console.error('Konnte Antwort nicht als gelesen markieren:', error);
      this.setReplyRead(reply.id, false);
    }
  }

  private setReplyRead(id: string, gelesen: boolean): void {
    this.replies.update((list) => list.map((r) => (r.id === id ? { ...r, gelesen } : r)));
    this.replyUnreadCount.update((n) => Math.max(0, gelesen ? n - 1 : n + 1));
  }
}

const ENTRY_COLUMNS = 'id, display_name, category, message, status, created_at';

interface FeedbackRow {
  id: string;
  display_name: string;
  category: string;
  message: string;
  status: string;
  created_at: string;
  reply_text?: string | null;
}

interface ReplyRow {
  id: string;
  category: string;
  message: string;
  reply_text: string;
  replied_at: string;
  gelesen: boolean;
}
