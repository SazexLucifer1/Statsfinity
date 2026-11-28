import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { GroupService } from './group.service';
import { PageVisibilityService } from './page-visibility.service';
import { QuizQuestion, QuizQuestionDraft } from './year-quiz';

export type QuizStatus = 'lobby' | 'question' | 'reveal' | 'review' | 'finished';

export interface YearQuiz {
  id: string;
  groupId: string;
  createdBy: string;
  title: string;
  questions: QuizQuestion[];
  status: QuizStatus;
  currentIndex: number;
  /** Aufgedeckte Lösungen je Frage, null = noch nicht aufgedeckt. */
  revealed: (number | null)[];
  createdAt: string;
}

export interface QuizParticipant {
  name: string;
  userId: string | null;
}

export interface QuizAnswer {
  participant: string;
  questionIndex: number;
  choice: number;
}

/** Fehlende Tabelle bzw. Funktion: Migration nicht ausgeführt. */
const MISSING = new Set(['42P01', 'PGRST205', 'PGRST202', '42883']);

/** Rückfall, falls Realtime nicht durchkommt - nur solange die Quiz-Seite offen ist. */
const POLL_MS = 4000;

/**
 * Jahresquiz (sql/jahresquiz-2026-11-28.sql): eigene Seite wie Sammlung und Cubes (`view`), geöffnet
 * aus dem Statistik-Tab. Je Gruppe gilt das neueste Quiz. Der Quizmaster (created_by) steuert und
 * liest als Einziger die Lösungen, Teilnehmer antworten am eigenen Handy, wer keins hat, wird vom
 * Quizmaster eingetragen. Änderungen kommen per Realtime, dazu ein Poll, solange die Seite offen ist.
 * Fehlt die Migration, schaltet sich alles beim ersten Fehler ab (`available`).
 */
@Injectable({ providedIn: 'root' })
export class YearQuizService {
  private readonly auth = inject(AuthService);
  private readonly groups = inject(GroupService);
  private readonly visibility = inject(PageVisibilityService);

  readonly available = signal(true);
  readonly view = signal(false);
  readonly loading = signal(false);
  readonly quiz = signal<YearQuiz | null>(null);
  readonly participants = signal<QuizParticipant[]>([]);
  readonly answers = signal<QuizAnswer[]>([]);
  /** Nur für den Quizmaster gefüllt. */
  readonly solutions = signal<number[]>([]);
  readonly error = signal<string | null>(null);

  readonly isHost = computed(() => {
    const uid = this.auth.currentUser()?.id;
    return !!uid && this.quiz()?.createdBy === uid;
  });

  readonly me = computed(() => {
    const uid = this.auth.currentUser()?.id;
    return this.participants().find((p) => p.userId === uid) ?? null;
  });

  /** Läuft in der aktiven Gruppe gerade ein Quiz (noch nicht ausgewertet)? Für den Hinweis im Statistik-Tab. */
  readonly running = computed(() => {
    const q = this.quiz();
    return !!q && q.status !== 'finished';
  });

  private channel: RealtimeChannel | null = null;
  private channelKey = '';
  private poll: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private reloading = false;
  private reloadAgain = false;

  constructor() {
    effect(() => {
      const groupId = this.groups.groupId();
      const uid = this.auth.currentUser()?.id ?? null;
      if (!groupId || !uid) {
        this.clear();
        this.view.set(false);
        return;
      }
      void this.reload();
    });
    effect(() => {
      if (this.view() && this.visibility.visible()) this.startPoll();
      else this.stopPoll();
    });
  }

  openView(): void {
    this.view.set(true);
    void this.reload();
  }

  closeView(): void {
    this.view.set(false);
  }

  private clear(): void {
    this.quiz.set(null);
    this.participants.set([]);
    this.answers.set([]);
    this.solutions.set([]);
    this.watch(null);
  }

  private fail(error: { code?: string; message?: string } | null): boolean {
    if (!error) return false;
    if (error.code && MISSING.has(error.code)) {
      this.available.set(false);
      this.clear();
    } else {
      this.error.set(error.message ?? String(error));
    }
    return true;
  }

  /** Lädt das neueste Quiz der aktiven Gruppe samt Teilnehmern und Antworten. */
  async reload(): Promise<void> {
    if (!this.available()) return;
    if (this.reloading) {
      this.reloadAgain = true;
      return;
    }
    const groupId = this.groups.groupId();
    if (!groupId || !this.auth.currentUser()) return;
    this.reloading = true;
    this.loading.set(this.quiz() === null);
    try {
      const { data, error } = await supabase
        .from('year_quizzes')
        .select('*')
        .eq('group_id', groupId)
        .order('created_at', { ascending: false })
        .limit(1);
      if (this.fail(error)) return;
      const row = data?.[0];
      if (!row || groupId !== this.groups.groupId()) {
        if (!row) this.clear();
        this.watch(groupId);
        return;
      }
      const quiz: YearQuiz = {
        id: row.id,
        groupId: row.group_id,
        createdBy: row.created_by,
        title: row.title,
        questions: (row.questions ?? []) as QuizQuestion[],
        status: row.status,
        currentIndex: row.current_index,
        revealed: (row.revealed ?? []) as (number | null)[],
        createdAt: row.created_at,
      };
      const [parts, answers, solutions] = await Promise.all([
        supabase
          .from('year_quiz_participants')
          .select('name, user_id')
          .eq('quiz_id', quiz.id)
          .order('joined_at'),
        supabase
          .from('year_quiz_answers')
          .select('participant, question_index, choice')
          .eq('quiz_id', quiz.id),
        quiz.createdBy === this.auth.currentUser()?.id
          ? supabase
              .from('year_quiz_solutions')
              .select('solutions')
              .eq('quiz_id', quiz.id)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      if (this.fail(parts.error) || this.fail(answers.error) || this.fail(solutions.error)) return;
      if (JSON.stringify(this.quiz()) !== JSON.stringify(quiz)) this.quiz.set(quiz);
      this.setIfChanged(
        this.participants,
        (parts.data ?? []).map((p) => ({ name: p.name, userId: p.user_id })),
      );
      this.setIfChanged(
        this.answers,
        (answers.data ?? []).map((a) => ({
          participant: a.participant,
          questionIndex: a.question_index,
          choice: a.choice,
        })),
      );
      const sol = (solutions.data as { solutions?: number[] } | null)?.solutions;
      if (sol) this.setIfChanged(this.solutions, sol);
      this.watch(groupId, quiz.id);
    } finally {
      this.loading.set(false);
      this.reloading = false;
      if (this.reloadAgain) {
        this.reloadAgain = false;
        void this.reload();
      }
    }
  }

  private setIfChanged<T>(target: { (): T; set(v: T): void }, value: T): void {
    if (JSON.stringify(target()) !== JSON.stringify(value)) target.set(value);
  }

  // --- Realtime ---

  private watch(groupId: string | null, quizId?: string): void {
    const key = groupId ? `${groupId}|${quizId ?? ''}` : '';
    if (key === this.channelKey) return;
    if (this.channel) void supabase.removeChannel(this.channel);
    this.channel = null;
    this.channelKey = key;
    if (!groupId) return;
    let channel = supabase
      .channel(`year-quiz:${key}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'year_quizzes', filter: `group_id=eq.${groupId}` },
        () => this.changed(),
      );
    if (quizId) {
      for (const table of ['year_quiz_participants', 'year_quiz_answers']) {
        channel = channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table, filter: `quiz_id=eq.${quizId}` },
          () => this.changed(),
        );
      }
    }
    this.channel = channel.subscribe();
  }

  private changed(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.reload();
    }, 200);
  }

  private startPoll(): void {
    if (this.poll) return;
    this.poll = setInterval(() => {
      const status = this.quiz()?.status;
      if (status && status !== 'finished') void this.reload();
    }, POLL_MS);
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  // --- Quizmaster ---

  async create(title: string, drafts: readonly QuizQuestionDraft[]): Promise<boolean> {
    const groupId = this.groups.groupId();
    if (!groupId || drafts.length === 0) return false;
    this.error.set(null);
    const { data, error } = await supabase
      .from('year_quizzes')
      .insert({
        group_id: groupId,
        title,
        questions: drafts.map((d) => ({ text: d.text, options: d.options })),
        revealed: drafts.map(() => null),
      })
      .select('id')
      .single();
    if (this.fail(error) || !data) return false;
    const sol = await supabase
      .from('year_quiz_solutions')
      .insert({ quiz_id: data.id, solutions: drafts.map((d) => d.correct) });
    if (this.fail(sol.error)) return false;
    await this.reload();
    return true;
  }

  private async update(patch: Record<string, unknown>): Promise<void> {
    const quiz = this.quiz();
    if (!quiz) return;
    this.error.set(null);
    const { error } = await supabase.from('year_quizzes').update(patch).eq('id', quiz.id);
    this.fail(error);
    await this.reload();
  }

  start(): Promise<void> {
    return this.update({ status: 'question', current_index: 0 });
  }

  reveal(): Promise<void> {
    const quiz = this.quiz();
    if (!quiz) return Promise.resolve();
    const revealed = quiz.questions.map((_, i) => quiz.revealed[i] ?? null);
    revealed[quiz.currentIndex] = this.solutions()[quiz.currentIndex] ?? null;
    return this.update({ status: 'reveal', revealed });
  }

  next(): Promise<void> {
    const quiz = this.quiz();
    if (!quiz) return Promise.resolve();
    if (quiz.currentIndex + 1 >= quiz.questions.length) return this.update({ status: 'review' });
    return this.update({ status: 'question', current_index: quiz.currentIndex + 1 });
  }

  /** Auswerten: alle Lösungen aufdecken und Ergebnis zeigen. */
  finish(): Promise<void> {
    const quiz = this.quiz();
    if (!quiz) return Promise.resolve();
    return this.update({
      status: 'finished',
      revealed: quiz.questions.map((_, i) => this.solutions()[i] ?? null),
    });
  }

  backToReview(): Promise<void> {
    return this.update({ status: 'review' });
  }

  async remove(): Promise<void> {
    const quiz = this.quiz();
    if (!quiz) return;
    const { error } = await supabase.from('year_quizzes').delete().eq('id', quiz.id);
    if (this.fail(error)) return;
    this.clear();
    await this.reload();
  }

  /** Teilnehmer ohne Handy (ohne Konto) hinzufügen. */
  async addParticipant(name: string): Promise<void> {
    const quiz = this.quiz();
    const clean = name.trim();
    if (!quiz || !clean) return;
    this.error.set(null);
    const { error } = await supabase
      .from('year_quiz_participants')
      .insert({ quiz_id: quiz.id, name: clean });
    this.fail(error);
    await this.reload();
  }

  async removeParticipant(name: string): Promise<void> {
    const quiz = this.quiz();
    if (!quiz) return;
    const { error } = await supabase
      .from('year_quiz_participants')
      .delete()
      .eq('quiz_id', quiz.id)
      .eq('name', name);
    this.fail(error);
    await this.reload();
  }

  /** Antwort setzen (choice) oder löschen (null) - als Quizmaster für jeden. */
  async setAnswer(
    participant: string,
    questionIndex: number,
    choice: number | null,
  ): Promise<void> {
    const quiz = this.quiz();
    if (!quiz) return;
    this.error.set(null);
    // sofort anzeigen, nicht erst nach dem Nachladen
    this.answers.update((list) => {
      const rest = list.filter(
        (a) => !(a.participant === participant && a.questionIndex === questionIndex),
      );
      return choice === null ? rest : [...rest, { participant, questionIndex, choice }];
    });
    const { error } =
      choice === null
        ? await supabase
            .from('year_quiz_answers')
            .delete()
            .eq('quiz_id', quiz.id)
            .eq('participant', participant)
            .eq('question_index', questionIndex)
        : await supabase.from('year_quiz_answers').upsert(
            {
              quiz_id: quiz.id,
              participant,
              question_index: questionIndex,
              choice,
              answered_at: new Date().toISOString(),
            },
            { onConflict: 'quiz_id,participant,question_index' },
          );
    this.fail(error);
    await this.reload();
  }

  // --- Teilnehmer ---

  async join(name: string): Promise<void> {
    const quiz = this.quiz();
    const uid = this.auth.currentUser()?.id;
    const clean = name.trim();
    if (!quiz || !uid || !clean) return;
    this.error.set(null);
    const { error } = await supabase
      .from('year_quiz_participants')
      .insert({ quiz_id: quiz.id, name: clean, user_id: uid });
    if (error?.code === '23505') this.error.set('duplicate');
    else this.fail(error);
    await this.reload();
  }

  async leave(): Promise<void> {
    const me = this.me();
    if (me) await this.removeParticipant(me.name);
  }

  answer(choice: number): Promise<void> {
    const quiz = this.quiz();
    const me = this.me();
    if (!quiz || !me || quiz.status !== 'question') return Promise.resolve();
    return this.setAnswer(me.name, quiz.currentIndex, choice);
  }
}
