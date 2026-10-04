import {
  deckMatchups,
  durationMinutes,
  durationStats,
  favoriteVictim,
  monthlyWinRate,
  nemesis,
  opponentStats,
  recentForm,
  turnOrderStats,
  yearReview,
} from './match-insights';
import { ARCHENEMY_OTHERS, DRAW } from './match-utils';
import { GameMode, Match, MatchPlayer } from './models';

let id = 0;
function match(
  winner: string,
  players: MatchPlayer[],
  extra: Partial<Match> = {},
  mode: GameMode = 'Normal',
): Match {
  return {
    id: `m${++id}`,
    date: '2026-08-01T20:00:00Z',
    mode,
    format: 'Commander',
    players,
    winner,
    countsInGeneralStats: true,
    ...extra,
  } as Match;
}
const p = (name: string, extra: Partial<MatchPlayer> = {}): MatchPlayer => ({ name, ...extra });

describe('match-insights', () => {
  it('rechnet die Winrate je Platz der Zugreihenfolge und ignoriert Partien ohne Reihenfolge', () => {
    const matches = [
      match('A', [p('A', { turnOrder: 1 }), p('B', { turnOrder: 2 })]),
      match('B', [p('A', { turnOrder: 2 }), p('B', { turnOrder: 1 })]),
      match('A', [p('A', { turnOrder: 1 }), p('B', { turnOrder: 2 })]),
      match('A', [p('A'), p('B')]),
    ];
    const seats = turnOrderStats(matches);
    expect(seats.map((s) => [s.seat, s.games, s.wins])).toEqual([
      [1, 3, 3],
      [2, 3, 0],
    ]);
    expect(turnOrderStats(matches, 'B').map((s) => [s.seat, s.wins])).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });

  it('verwirft unplausible Spieldauern und rechnet den Schnitt je Deck ab zwei Partien', () => {
    expect(durationMinutes({ date: '2026-08-01T20:01:00Z', startedAt: '2026-08-01T20:00:00Z' })).toBeNull();
    expect(durationMinutes({ date: '2026-08-02T20:00:00Z', startedAt: '2026-08-01T20:00:00Z' })).toBeNull();
    const deck = { deckId: 'd1', deckName: 'Atraxa' };
    const stats = durationStats([
      match('A', [p('A', deck), p('B')], { startedAt: '2026-08-01T19:00:00Z' }),
      match('A', [p('A', deck), p('B')], { startedAt: '2026-08-01T19:30:00Z' }),
      match('A', [p('A'), p('B')]),
    ])!;
    expect(stats.games).toBe(2);
    expect(stats.avgMinutes).toBe(45);
    expect(stats.longest.minutes).toBe(60);
    expect(stats.byDeck).toEqual([{ label: 'Atraxa', games: 2, avgMinutes: 45 }]);
  });

  it('findet Nemesis und Lieblingsopfer erst ab drei gemeinsamen Partien', () => {
    const matches = [
      match('B', [p('A'), p('B'), p('C')]),
      match('B', [p('A'), p('B'), p('C')]),
      match('A', [p('A'), p('B'), p('C')]),
      match('A', [p('A'), p('D')]),
    ];
    const stats = opponentStats(matches, 'A');
    expect(stats.find((s) => s.name === 'B')).toEqual({ name: 'B', games: 3, lostTo: 2, beat: 1 });
    expect(stats.find((s) => s.name === 'C')).toEqual({ name: 'C', games: 3, lostTo: 0, beat: 1 });
    expect(nemesis(stats)?.name).toBe('B');
    // D wurde öfter (anteilig) besiegt, hat aber nur eine Partie - zählt nicht.
    expect(favoriteVictim(stats)?.name).toBe('B');
  });

  it('zählt Teamkollegen und Verbündete gegen den Archenemy nicht als Gegner', () => {
    const twoHg = match(
      'Team 1',
      [p('A', { team: 'Team 1' }), p('B', { team: 'Team 1' }), p('C', { team: 'Team 2' }), p('D', { team: 'Team 2' })],
      {},
      'Two-Headed Giant',
    );
    expect(opponentStats([twoHg], 'A').map((s) => s.name)).toEqual(['C', 'D']);
    const arch = match(ARCHENEMY_OTHERS, [p('X', { isArchenemy: true }), p('A'), p('B')], {}, 'Archenemy');
    expect(opponentStats([arch], 'A')).toEqual([{ name: 'X', games: 1, lostTo: 0, beat: 1 }]);
  });

  it('stellt Decks paarweise gegeneinander, mit Spieler steht sein Deck links', () => {
    const a = { deckId: 'a', deckName: 'Alpha' };
    const b = { deckId: 'b', deckName: 'Beta' };
    const matches = [
      match('B', [p('B', b), p('A', a)]),
      match('A', [p('A', a), p('B', b)]),
      match('A', [p('A', a), p('B', b)]),
    ];
    expect(deckMatchups(matches)).toEqual([{ a: 'Alpha', b: 'Beta', games: 3, aWins: 2, bWins: 1 }]);
    expect(deckMatchups(matches, 'B')).toEqual([{ a: 'Beta', b: 'Alpha', games: 3, aWins: 1, bWins: 2 }]);
  });

  it('liefert Form neueste zuerst und Monatswerte älteste zuerst', () => {
    const matches = [
      match('A', [p('A'), p('B')], { date: '2026-07-10T20:00:00Z' }),
      match('B', [p('A'), p('B')], { date: '2026-08-10T20:00:00Z' }),
      match(DRAW, [p('A'), p('B')], { date: '2026-08-20T20:00:00Z' }),
    ];
    expect(recentForm(matches, 'A').map((f) => f.result)).toEqual(['D', 'L', 'W']);
    expect(monthlyWinRate(matches, 'A').map((m) => [m.month, m.games, m.wins])).toEqual([
      ['2026-07', 1, 1],
      ['2026-08', 2, 0],
    ]);
  });

  it('fasst ein Jahr zusammen inklusive längster Siegesserie', () => {
    const deck = { deckId: 'a', deckName: 'Alpha' };
    const matches = [
      match('A', [p('A', deck), p('B')], { date: '2026-01-01T20:00:00Z' }),
      match('A', [p('A', deck), p('B')], { date: '2026-02-01T20:00:00Z' }),
      match('B', [p('A', deck), p('B')], { date: '2026-03-01T20:00:00Z' }),
      match('A', [p('A'), p('B')], { date: '2025-03-01T20:00:00Z' }),
    ];
    const review = yearReview(matches, 'A', 2026)!;
    expect(review.games).toBe(3);
    expect(review.wins).toBe(2);
    expect(review.bestStreak).toBe(2);
    expect(review.topDeck?.label).toBe('Alpha');
    expect(review.bestDeck?.label).toBe('Alpha');
    expect(yearReview(matches, 'A', 2024)).toBeNull();
  });
});
