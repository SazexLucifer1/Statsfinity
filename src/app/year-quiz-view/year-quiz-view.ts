import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../i18n.service';
import { MtgService } from '../mtg.service';
import { ProfileService } from '../profile.service';
import { DialogService } from '../dialog.service';
import { GroupService } from '../group.service';
import { YearQuizService } from '../year-quiz.service';
import {
  QUIZ_OPTION_COUNT,
  QuizQuestionDraft,
  draftPods,
  generateYearQuiz,
  quizRanking,
  quizScores,
  quizYears,
} from '../year-quiz';
import { InfoToggle } from '../ui/info-toggle/info-toggle';
import { Podium, PodiumEntry } from '../ui/podium/podium';
import { Icon } from '../ui/icon/icon';

interface DraftRow {
  question: QuizQuestionDraft;
  include: boolean;
}

/**
 * Jahresquiz als eigene Seite (Wunsch des Users, 28.11.2026). Ein Bildschirm für alle Rollen,
 * entschieden über den Ablauf (`status`) und ob man Quizmaster ist:
 * Erstellen → Lobby → Frage/Auflösung je Frage → Prüfen (nur Quizmaster) → Ergebnis + Draft-Pods.
 */
@Component({
  selector: 'app-year-quiz-view',
  imports: [FormsModule, InfoToggle, Podium, Icon],
  templateUrl: './year-quiz-view.html',
  styleUrl: './year-quiz-view.scss',
})
export class YearQuizView {
  readonly i18n = inject(I18nService);
  readonly quizService = inject(YearQuizService);
  private readonly mtg = inject(MtgService);
  private readonly profiles = inject(ProfileService);
  private readonly dialog = inject(DialogService);
  readonly groups = inject(GroupService);

  readonly letters = ['A', 'B', 'C', 'D'];

  // --- Erstellen ---
  readonly years = computed(() => {
    const list = quizYears(this.mtg.history());
    const now = new Date().getFullYear();
    return list.includes(now) ? list : [now, ...list];
  });
  readonly year = signal(new Date().getFullYear());
  readonly title = signal('');
  readonly rows = signal<DraftRow[]>([]);
  /** true = Quizmaster will trotz vorhandenem Quiz ein neues anlegen. */
  readonly creating = signal(false);
  readonly busy = signal(false);

  readonly customText = signal('');
  readonly customOptions = signal<string[]>(['', '', '', '']);
  readonly customCorrect = signal(0);

  readonly selectedCount = computed(() => this.rows().filter((r) => r.include).length);

  readonly showSetup = computed(() => {
    const quiz = this.quizService.quiz();
    return !quiz || this.creating();
  });

  // --- Mitmachen ---
  readonly joinName = signal('');
  readonly offlineName = signal('');

  // --- Ergebnis ---
  readonly podCount = signal(2);

  constructor() {
    effect(() => {
      // Fragen neu erzeugen, wenn sich Jahr, Sprache oder Partien ändern
      this.year();
      this.i18n.lang();
      this.mtg.history();
      untracked(() => this.regenerate());
    });
    effect(() => {
      if (!this.joinName()) {
        const name = this.mtg.myPlayerName() ?? this.profiles.profile()?.displayName ?? '';
        if (name) untracked(() => this.joinName.set(name));
      }
    });
  }

  close(): void {
    this.quizService.closeView();
  }

  regenerate(): void {
    const year = this.year();
    const generated = generateYearQuiz(
      this.mtg.history(),
      year,
      (k, v) => this.i18n.t(k, v),
      this.i18n.lang(),
    );
    const custom = this.rows().filter((r) => r.question.kind === 'custom');
    this.rows.set([...generated.map((question) => ({ question, include: true })), ...custom]);
    this.title.set(this.i18n.t('quiz.setup.defaultTitle', { year }));
  }

  toggleRow(index: number): void {
    this.rows.update((list) =>
      list.map((r, i) => (i === index ? { ...r, include: !r.include } : r)),
    );
  }

  removeRow(index: number): void {
    this.rows.update((list) => list.filter((_, i) => i !== index));
  }

  setCustomOption(index: number, value: string): void {
    this.customOptions.update((list) => list.map((o, i) => (i === index ? value : o)));
  }

  readonly customValid = computed(() => {
    const options = this.customOptions();
    const filled = options.filter((o) => o.trim()).length;
    return !!this.customText().trim() && filled >= 2 && !!options[this.customCorrect()]?.trim();
  });

  addCustom(): void {
    if (!this.customValid()) return;
    const all = this.customOptions().map((o) => o.trim());
    const correctText = all[this.customCorrect()];
    const options = all.filter((o) => o);
    this.rows.update((list) => [
      ...list,
      {
        include: true,
        question: {
          kind: 'custom',
          text: this.customText().trim(),
          options,
          correct: options.indexOf(correctText),
        },
      },
    ]);
    this.customText.set('');
    this.customOptions.set(Array.from({ length: QUIZ_OPTION_COUNT }, () => ''));
    this.customCorrect.set(0);
  }

  async create(): Promise<void> {
    const questions = this.rows()
      .filter((r) => r.include)
      .map((r) => r.question);
    if (questions.length === 0 || this.busy()) return;
    this.busy.set(true);
    try {
      const ok = await this.quizService.create(
        this.title().trim() || this.i18n.t('quiz.title'),
        questions,
      );
      if (ok) this.creating.set(false);
    } finally {
      this.busy.set(false);
    }
  }

  // --- Ablauf ---
  readonly current = computed(() => {
    const quiz = this.quizService.quiz();
    return quiz ? (quiz.questions[quiz.currentIndex] ?? null) : null;
  });

  readonly currentAnswers = computed(() => {
    const quiz = this.quizService.quiz();
    if (!quiz) return [];
    return this.quizService.answers().filter((a) => a.questionIndex === quiz.currentIndex);
  });

  readonly myChoice = computed(() => {
    const me = this.quizService.me();
    if (!me) return null;
    return this.currentAnswers().find((a) => a.participant === me.name)?.choice ?? null;
  });

  /** Richtige Antwort der aktuellen Frage: Quizmaster immer, alle anderen erst nach dem Auflösen. */
  readonly currentCorrect = computed(() => {
    const quiz = this.quizService.quiz();
    if (!quiz) return null;
    if (this.quizService.isHost()) return this.quizService.solutions()[quiz.currentIndex] ?? null;
    return quiz.status === 'reveal' ? (quiz.revealed[quiz.currentIndex] ?? null) : null;
  });

  votes(option: number): number {
    return this.currentAnswers().filter((a) => a.choice === option).length;
  }

  async run(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await action();
    } finally {
      this.busy.set(false);
    }
  }

  join(): void {
    void this.run(() => this.quizService.join(this.joinName()));
  }

  addOffline(): void {
    const name = this.offlineName();
    this.offlineName.set('');
    void this.run(() => this.quizService.addParticipant(name));
  }

  answer(choice: number): void {
    void this.quizService.answer(choice);
  }

  // --- Prüfen ---
  answerOf(participant: string, questionIndex: number): number | null {
    return (
      this.quizService
        .answers()
        .find((a) => a.participant === participant && a.questionIndex === questionIndex)?.choice ??
      null
    );
  }

  setReviewAnswer(participant: string, questionIndex: number, value: string): void {
    void this.quizService.setAnswer(
      participant,
      questionIndex,
      value === '' ? null : Number(value),
    );
  }

  /** Lösungen für die Punkte: Quizmaster kennt alle, sonst nur die aufgedeckten. */
  private readonly knownSolutions = computed(() => {
    const quiz = this.quizService.quiz();
    if (!quiz) return [];
    return this.quizService.isHost()
      ? quiz.questions.map((_, i) => this.quizService.solutions()[i] ?? null)
      : quiz.revealed;
  });

  readonly scores = computed(() =>
    quizScores(
      this.quizService.participants().map((p) => p.name),
      this.quizService.answers(),
      this.knownSolutions(),
    ),
  );

  readonly ranking = computed(() => quizRanking(this.scores()));

  readonly podium = computed<PodiumEntry[]>(() => {
    const total = this.quizService.quiz()?.questions.length ?? 0;
    return this.ranking()
      .slice(0, 3)
      .map((r) => ({
        key: r.name,
        name: r.name,
        value: String(r.points),
        detail: this.i18n.t('quiz.result.pointsDetail', { n: r.points, total }),
      }));
  });

  readonly pods = computed(() =>
    draftPods(
      this.ranking().map((r) => r.name),
      this.podCount(),
    ),
  );

  async remove(): Promise<void> {
    if (!(await this.dialog.confirm(this.i18n.t('quiz.result.deleteConfirm')))) return;
    await this.run(() => this.quizService.remove());
  }

  newQuiz(): void {
    this.creating.set(true);
    this.regenerate();
  }
}
