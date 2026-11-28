import { Match } from './models';
import { countsForPlayers, isImportLossDuplicate } from './match-utils';
import {
  didWin,
  durationMinutes,
  eliminationStats,
  nemesis,
  opponentStats,
} from './match-insights';

/**
 * Jahresquiz: reine Funktionen (Fragen aus den Partien eines Jahres, Punkte, Pod-Einteilung für den
 * anschließenden Draft). Zustand und Datenbank liegen in year-quiz.service.ts.
 */

/** Eine Frage samt Lösung - so baut der Quizmaster sie, gespeichert wird die Lösung getrennt. */
export interface QuizQuestionDraft {
  /** 'custom' oder der Schlüssel des Generators, z. B. 'mostWins'. */
  kind: string;
  text: string;
  options: string[];
  correct: number;
}

/** Frage, wie die Teilnehmer sie sehen (ohne Lösung). */
export interface QuizQuestion {
  text: string;
  options: string[];
}

/** Übersetzer mit Platzhaltern, wie I18nService.t(). */
export type QuizTranslate = (key: string, vars?: Record<string, string | number>) => string;

export const QUIZ_OPTION_COUNT = 4;

/** Mindestpartien für Winrate-Fragen - sonst gewinnt, wer einmal gespielt und gewonnen hat. */
const MIN_GAMES_FOR_RATE = 5;

/** Partien eines Jahres, die in die Statistik zählen. */
export function matchesOfYear(matches: readonly Match[], year: number): Match[] {
  return matches.filter(
    (m) => m.countsInGeneralStats !== false && new Date(m.date).getFullYear() === year,
  );
}

/** Jahre, in denen es Partien gibt, neuestes zuerst. */
export function quizYears(matches: readonly Match[]): number[] {
  return [...new Set(matches.map((m) => new Date(m.date).getFullYear()))]
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => b - a);
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Nach Wert absteigend sortierte Einträge. */
function ranked(map: Map<string, number>): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function inc(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * Antwortmöglichkeiten: die richtige plus Ablenker (zuerst die knapp dahinter, dann der Rest),
 * gemischt. null, wenn es keinen eindeutigen Ersten oder keinen einzigen Ablenker gibt.
 */
function choiceQuestion(
  kind: string,
  text: string,
  list: [string, number][],
  random: () => number,
  pool: readonly string[] = [],
): QuizQuestionDraft | null {
  if (list.length === 0) return null;
  const [top, second] = list;
  if (second && second[1] === top[1]) return null;
  const others = [...list.slice(1).map(([name]) => name), ...pool].filter(
    (n, i, all) => n !== top[0] && all.indexOf(n) === i,
  );
  if (others.length === 0) return null;
  const close = others.slice(0, 2);
  const rest = shuffle(others.slice(2), random);
  const options = shuffle([top[0], ...[...close, ...rest].slice(0, QUIZ_OPTION_COUNT - 1)], random);
  return { kind, text, options, correct: options.indexOf(top[0]) };
}

/** Zahlenfrage: richtige Zahl plus drei plausible Nachbarn. */
function numberQuestion(
  kind: string,
  text: string,
  value: number,
  random: () => number,
  unit = '',
): QuizQuestionDraft {
  const step = Math.max(1, Math.round(value * 0.15));
  const candidates = [-3, -2, -1, 1, 2, 3]
    .map((k) => value + k * step)
    .filter((n) => n > 0 && n !== value);
  const picks = shuffle(candidates, random).slice(0, QUIZ_OPTION_COUNT - 1);
  const numbers = shuffle([value, ...picks], random);
  return {
    kind,
    text,
    options: numbers.map((n) => `${n}${unit}`),
    correct: numbers.indexOf(value),
  };
}

/**
 * Fragen zu den Partien eines Jahres. Jede Frage hat eine eindeutige Antwort - bei Gleichstand
 * an der Spitze entfällt sie. `lang` nur für die Monatsnamen.
 */
export function generateYearQuiz(
  allMatches: readonly Match[],
  year: number,
  t: QuizTranslate,
  lang: string,
  random: () => number = Math.random,
): QuizQuestionDraft[] {
  const matches = matchesOfYear(allMatches, year);
  const personal = matches.filter(countsForPlayers);
  const games = matches.filter((m) => !isImportLossDuplicate(m));
  const out: (QuizQuestionDraft | null)[] = [];
  if (games.length === 0) return [];

  const played = new Map<string, number>();
  const wins = new Map<string, number>();
  const losses = new Map<string, number>();
  const commanderGames = new Map<string, number>();
  const commanderWins = new Map<string, number>();
  const commandersBy = new Map<string, Set<string>>();
  for (const m of personal) {
    for (const p of m.players) {
      inc(played, p.name);
      const won = didWin(m, p.name);
      if (won) inc(wins, p.name);
      else inc(losses, p.name);
      if (p.commander) {
        inc(commanderGames, p.commander);
        if (won) inc(commanderWins, p.commander);
        const set = commandersBy.get(p.name) ?? new Set<string>();
        set.add(p.commander);
        commandersBy.set(p.name, set);
      }
    }
  }
  const players = ranked(played).map(([n]) => n);
  const commanders = ranked(commanderGames).map(([n]) => n);
  const y = { year };

  out.push(choiceQuestion('mostWins', t('quiz.q.mostWins', y), ranked(wins), random, players));
  out.push(choiceQuestion('mostGames', t('quiz.q.mostGames', y), ranked(played), random));
  out.push(
    choiceQuestion('mostLosses', t('quiz.q.mostLosses', y), ranked(losses), random, players),
  );

  const rates = new Map<string, number>();
  for (const [name, n] of played) {
    if (n >= MIN_GAMES_FOR_RATE) rates.set(name, (wins.get(name) ?? 0) / n);
  }
  out.push(
    choiceQuestion(
      'bestWinRate',
      t('quiz.q.bestWinRate', { year, min: MIN_GAMES_FOR_RATE }),
      ranked(rates),
      random,
    ),
  );

  out.push(numberQuestion('totalGames', t('quiz.q.totalGames', y), games.length, random));

  out.push(
    choiceQuestion('topCommander', t('quiz.q.topCommander', y), ranked(commanderGames), random),
  );
  out.push(
    choiceQuestion(
      'topCommanderWins',
      t('quiz.q.topCommanderWins', y),
      ranked(commanderWins),
      random,
      commanders,
    ),
  );

  const variety = new Map([...commandersBy].map(([name, set]) => [name, set.size] as const));
  out.push(
    choiceQuestion('mostCommanders', t('quiz.q.mostCommanders', y), ranked(variety), random),
  );

  // Monat mit den meisten Partien
  const months = new Map<string, number>();
  const monthName = new Intl.DateTimeFormat(lang, { month: 'long' });
  for (const m of games) inc(months, monthName.format(new Date(m.date)));
  const allMonths = Array.from({ length: 12 }, (_, i) => monthName.format(new Date(year, i, 15)));
  out.push(
    choiceQuestion('busiestMonth', t('quiz.q.busiestMonth', y), ranked(months), random, allMonths),
  );

  // Häufigste Siegart ("Anderes"/unbekannt zählt nicht - das wäre keine Antwort)
  const conditions = new Map<string, number>();
  for (const m of games) {
    if (m.winCondition && m.winCondition !== 'other') {
      inc(conditions, t(`stats.winCondition.${m.winCondition}`));
    }
  }
  const allConditions = ['combat', 'commander_damage', 'combo', 'poison', 'mill'].map((k) =>
    t(`stats.winCondition.${k}`),
  );
  if ([...conditions.values()].reduce((a, b) => a + b, 0) >= 5) {
    out.push(
      choiceQuestion(
        'topWinCondition',
        t('quiz.q.topWinCondition', y),
        ranked(conditions),
        random,
        allConditions,
      ),
    );
  }

  // Längste Siegesserie
  const streaks = new Map<string, number>();
  const chronological = [...personal].sort((a, b) => a.date.localeCompare(b.date));
  for (const name of players) {
    let streak = 0;
    let best = 0;
    for (const m of chronological) {
      if (!m.players.some((p) => p.name === name)) continue;
      streak = didWin(m, name) ? streak + 1 : 0;
      best = Math.max(best, streak);
    }
    if (best > 0) streaks.set(name, best);
  }
  out.push(
    choiceQuestion('longestStreak', t('quiz.q.longestStreak', y), ranked(streaks), random, players),
  );

  // Rauswürfe
  const kills = new Map(
    eliminationStats(games)
      .filter((s) => s.kills > 0)
      .map((s) => [s.name, s.kills] as const),
  );
  if (kills.size >= 2) {
    out.push(choiceQuestion('mostKills', t('quiz.q.mostKills', y), ranked(kills), random, players));
  }

  // Längste Partie: wer hat sie gewonnen?
  const timed = games
    .map((m) => ({ m, minutes: durationMinutes(m) }))
    .filter((x): x is { m: Match; minutes: number } => x.minutes !== null && x.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes);
  const longest = timed[0];
  if (longest && longest.m.players.length >= 2) {
    const winners = longest.m.players.filter((p) => didWin(longest.m, p.name)).map((p) => p.name);
    if (winners.length === 1) {
      const options = shuffle(
        [
          winners[0],
          ...shuffle(
            longest.m.players.map((p) => p.name).filter((n) => n !== winners[0]),
            random,
          ).slice(0, 3),
        ],
        random,
      );
      out.push({
        kind: 'longestGame',
        text: t('quiz.q.longestGame', { year, minutes: Math.round(longest.minutes) }),
        options,
        correct: options.indexOf(winners[0]),
      });
    }
  }

  // Schnellster Sieg (nach Zug)
  const fastest = games
    .filter((m) => typeof m.winTurn === 'number' && m.winTurn > 0)
    .sort((a, b) => a.winTurn! - b.winTurn!);
  if (fastest.length > 0 && (fastest.length === 1 || fastest[1].winTurn !== fastest[0].winTurn)) {
    const m = fastest[0];
    const winners = m.players.filter((p) => didWin(m, p.name)).map((p) => p.name);
    if (winners.length === 1) {
      const others = m.players.map((p) => p.name).filter((n) => n !== winners[0]);
      const pool = [...others, ...players.filter((n) => !others.includes(n) && n !== winners[0])];
      const options = shuffle([winners[0], ...pool.slice(0, 3)], random);
      if (options.length >= 2) {
        out.push({
          kind: 'fastestWin',
          text: t('quiz.q.fastestWin', { year, turn: m.winTurn! }),
          options,
          correct: options.indexOf(winners[0]),
        });
      }
    }
  }

  // Durchschnittlicher Siegzug
  const turns = games
    .map((m) => m.winTurn)
    .filter((n): n is number => typeof n === 'number' && n > 0);
  if (turns.length >= 5) {
    const avg = Math.round(turns.reduce((a, b) => a + b, 0) / turns.length);
    out.push(numberQuestion('avgWinTurn', t('quiz.q.avgWinTurn', y), avg, random));
  }

  // Nemesis des Spielers mit den meisten Siegen
  const topWinner = ranked(wins)[0]?.[0];
  if (topWinner) {
    const opponents = opponentStats(personal, topWinner);
    const nem = nemesis(opponents);
    if (nem) {
      const list = opponents
        .filter((o) => o.name !== nem.name)
        .map((o) => [o.name, 0] as [string, number]);
      const q = choiceQuestion(
        'nemesis',
        t('quiz.q.nemesis', { year, name: topWinner }),
        [[nem.name, 1], ...list],
        random,
      );
      out.push(q);
    }
  }

  return out.filter((q): q is QuizQuestionDraft => q !== null && q.options.length >= 2);
}

/** Punkte je Teilnehmer: eine je richtiger Antwort. Unbekannte Lösungen (null) zählen nicht. */
export function quizScores(
  participants: readonly string[],
  answers: readonly { participant: string; questionIndex: number; choice: number }[],
  solutions: readonly (number | null)[],
): Map<string, number> {
  const scores = new Map(participants.map((p) => [p, 0] as [string, number]));
  for (const a of answers) {
    if (!scores.has(a.participant)) continue;
    const correct = solutions[a.questionIndex];
    if (correct !== null && correct !== undefined && correct === a.choice)
      inc(scores, a.participant);
  }
  return scores;
}

export interface QuizRank {
  name: string;
  points: number;
  /** Platz, gleiche Punkte = gleicher Platz. */
  place: number;
}

export function quizRanking(scores: Map<string, number>): QuizRank[] {
  const list = ranked(scores);
  const out: QuizRank[] = [];
  list.forEach(([name, points], i) => {
    const place = i > 0 && list[i - 1][1] === points ? out[i - 1].place : i + 1;
    out.push({ name, points, place });
  });
  return out;
}

/**
 * Einteilung in Draft-Pods nach der Quiz-Rangliste, im Schlangenmuster (1-2, 4-3, 5-6 …), damit
 * kein Pod alle Quiz-Sieger bekommt. Innerhalb des Pods stehen die Spieler in Rangfolge: der
 * Beste wählt zuerst seinen Platz.
 */
export function draftPods(ranking: readonly string[], podCount = 2): string[][] {
  const count = Math.max(1, Math.min(podCount, ranking.length));
  const pods: string[][] = Array.from({ length: count }, () => []);
  ranking.forEach((name, i) => {
    const round = Math.floor(i / count);
    const pos = i % count;
    pods[round % 2 === 0 ? pos : count - 1 - pos].push(name);
  });
  return pods;
}
