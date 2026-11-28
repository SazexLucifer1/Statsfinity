import { describe, expect, it } from 'vitest';
import { Match } from './models';
import { draftPods, generateYearQuiz, quizRanking, quizScores } from './year-quiz';

function match(date: string, winner: string, players: [string, string][]): Match {
  return {
    id: date + winner,
    date,
    mode: 'Normal',
    format: 'Commander',
    winner,
    countsInGeneralStats: true,
    players: players.map(([name, commander]) => ({ name, commander })),
  } as Match;
}

const t = (key: string, vars?: Record<string, string | number>) =>
  key + (vars ? JSON.stringify(vars) : '');

describe('year-quiz', () => {
  const matches = [
    match('2026-03-01T20:00:00Z', 'Anna', [
      ['Anna', 'Atraxa'],
      ['Ben', 'Edgar'],
      ['Cem', 'Krenko'],
    ]),
    match('2026-03-08T20:00:00Z', 'Anna', [
      ['Anna', 'Atraxa'],
      ['Ben', 'Edgar'],
      ['Cem', 'Krenko'],
    ]),
    match('2026-04-08T20:00:00Z', 'Ben', [
      ['Anna', 'Atraxa'],
      ['Ben', 'Edgar'],
      ['Dora', 'Ur-Dragon'],
    ]),
    match('2025-04-08T20:00:00Z', 'Cem', [
      ['Cem', 'Krenko'],
      ['Ben', 'Edgar'],
    ]),
  ];

  it('erzeugt Fragen mit eindeutiger, enthaltener Lösung', () => {
    const qs = generateYearQuiz(matches, 2026, t, 'de', () => 0.3);
    const wins = qs.find((q) => q.kind === 'mostWins')!;
    expect(wins.options[wins.correct]).toBe('Anna');
    expect(new Set(wins.options).size).toBe(wins.options.length);
    const total = qs.find((q) => q.kind === 'totalGames')!;
    expect(total.options[total.correct]).toBe('3');
    for (const q of qs) expect(q.correct).toBeGreaterThanOrEqual(0);
  });

  it('lässt Fragen mit Gleichstand an der Spitze weg', () => {
    const qs = generateYearQuiz(matches, 2026, t, 'de');
    // Atraxa, Edgar: je 3 Partien - kein eindeutiger meistgespielter Commander
    expect(qs.some((q) => q.kind === 'topCommander')).toBe(false);
  });

  it('zählt Punkte und vergibt gleiche Plätze bei Gleichstand', () => {
    const scores = quizScores(
      ['A', 'B', 'C'],
      [
        { participant: 'A', questionIndex: 0, choice: 1 },
        { participant: 'B', questionIndex: 0, choice: 1 },
        { participant: 'C', questionIndex: 0, choice: 0 },
        { participant: 'A', questionIndex: 1, choice: 2 },
      ],
      [1, 2],
    );
    expect(quizRanking(scores)).toEqual([
      { name: 'A', points: 2, place: 1 },
      { name: 'B', points: 1, place: 2 },
      { name: 'C', points: 0, place: 3 },
    ]);
  });

  it('teilt 12 Spieler im Schlangenmuster auf 2 Pods zu je 6', () => {
    const names = Array.from({ length: 12 }, (_, i) => `P${i + 1}`);
    const pods = draftPods(names, 2);
    expect(pods.map((p) => p.length)).toEqual([6, 6]);
    expect(pods[0]).toEqual(['P1', 'P4', 'P5', 'P8', 'P9', 'P12']);
    expect(pods[1]).toEqual(['P2', 'P3', 'P6', 'P7', 'P10', 'P11']);
  });
});
