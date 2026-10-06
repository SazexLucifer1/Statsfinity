import {
  commanderRecords,
  deckOpponents,
  headToHeadRecord,
  mergePeopleMatches,
  peopleRecords,
  durationMinutes,
  durationStats,
  favoriteVictim,
  monthlyGames,
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
    expect(
      durationMinutes({ date: '2026-08-01T20:01:00Z', startedAt: '2026-08-01T20:00:00Z' }),
    ).toBeNull();
    expect(
      durationMinutes({ date: '2026-08-02T20:00:00Z', startedAt: '2026-08-01T20:00:00Z' }),
    ).toBeNull();
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
      [
        p('A', { team: 'Team 1' }),
        p('B', { team: 'Team 1' }),
        p('C', { team: 'Team 2' }),
        p('D', { team: 'Team 2' }),
      ],
      {},
      'Two-Headed Giant',
    );
    expect(opponentStats([twoHg], 'A').map((s) => s.name)).toEqual(['C', 'D']);
    const arch = match(
      ARCHENEMY_OTHERS,
      [p('X', { isArchenemy: true }), p('A'), p('B')],
      {},
      'Archenemy',
    );
    expect(opponentStats([arch], 'A')).toEqual([{ name: 'X', games: 1, lostTo: 0, beat: 1 }]);
  });

  it('zeigt aus Sicht eines Decks, gegen welche Decks es wie oft gewonnen und verloren hat', () => {
    const a = { deckId: 'a', deckName: 'Alpha' };
    const b = { deckId: 'b', deckName: 'Beta' };
    const matches = [
      match('B', [p('B', b), p('A', a)]),
      match('A', [p('A', a), p('B', b), p('C', { commander: 'Atraxa' })]),
      match('C', [p('A', a), p('B', b), p('C', { commander: 'Atraxa' })]),
    ];
    expect(deckOpponents(matches, 'a')).toEqual([
      {
        label: 'Beta',
        commander: null,
        deckId: 'b',
        ownerUserId: null,
        ownerPlayerId: null,
        games: 3,
        wins: 1,
        losses: 1,
      },
      {
        label: 'Atraxa',
        commander: 'Atraxa',
        deckId: null,
        ownerUserId: null,
        ownerPlayerId: null,
        games: 2,
        wins: 1,
        losses: 1,
      },
    ]);
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

  it('zählt Spiele je Monat neben allen Spielen der Gruppe', () => {
    const matches = [
      match('A', [p('A'), p('B')], { date: '2026-07-03T20:00:00Z' }),
      match('B', [p('B'), p('C')], { date: '2026-07-04T20:00:00Z' }),
      match('B', [p('B'), p('C')], { date: '2026-08-04T20:00:00Z' }),
    ];
    expect(monthlyGames(matches, 'A').map((m) => [m.month, m.games, m.total])).toEqual([
      ['2026-07', 1, 2],
      ['2026-08', 0, 1],
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

  it('führt Partien mehrerer Freunde zusammen: jede Partie einmal, jede Person unter ihrem Profilnamen', () => {
    const shared = match('Fabi', [p('Fabi', { commander: 'Atraxa' }), p('Ben')], { id: 'g1' });
    const other = match('B. Müller', [p('Fabian'), p('B. Müller')], { id: 'g2' });
    const friendGame = match('Ben', [p('Ben', { userId: 'u2' }), p('Fabian', { userId: 'u1' })], {
      id: 'f1',
    });
    const merged = mergePeopleMatches(
      [
        {
          userId: 'u1',
          name: 'Fabian',
          entries: [
            { match: shared, selfName: 'Fabi' },
            { match: other, selfName: 'Fabian' },
          ],
        },
        {
          userId: 'u2',
          name: 'Bene',
          entries: [
            { match: shared, selfName: 'Ben' },
            { match: other, selfName: 'B. Müller' },
          ],
        },
      ],
      [friendGame],
    );
    expect(merged.length).toBe(3);
    const g1 = merged.find((m) => m.id === 'g1')!;
    expect(g1.players.map((x) => x.name)).toEqual(['Fabian', 'Bene']);
    expect(g1.winner).toBe('Fabian');
    expect(merged.find((m) => m.id === 'g2')!.winner).toBe('Bene');
    expect(merged.find((m) => m.id === 'f1')!.winner).toBe('Bene');

    expect(peopleRecords(merged, ['Fabian', 'Bene'])).toEqual([
      { name: 'Fabian', games: 3, wins: 1, winRate: (1 / 3) * 100 },
      { name: 'Bene', games: 3, wins: 2, winRate: (2 / 3) * 100 },
    ]);
    expect(headToHeadRecord(merged, 'Fabian', 'Bene')).toEqual({ games: 3, aWins: 1, bWins: 2 });
    expect(commanderRecords(merged, 'Fabian')).toEqual([
      { commander: 'Atraxa', games: 1, wins: 1 },
    ]);
  });
});
