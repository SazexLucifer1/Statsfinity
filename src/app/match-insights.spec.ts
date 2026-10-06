import {
  commanderRecords,
  deckOpponents,
  headToHeadRecord,
  mergePeopleMatches,
  peopleRecords,
  durationMinutes,
  durationStats,
  eliminationStats,
  favoriteVictim,
  monthlyGames,
  monthlyWinRate,
  nemesis,
  opponentStats,
  recentForm,
  turnOrderStats,
  yearReview,
  average,
  commanderMatchups,
  compareLatestVersions,
  deckPerformance,
  deckVersionStats,
  overallSummary,
  performanceSummary,
  pickDeck,
  pickPlayer,
  placementOf,
  sampleSize,
  winConditionStats,
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

describe('eliminationStats', () => {
  it('zählt Rauswürfe je Spieler, eigener Name = selbst rausgeflogen', () => {
    const matches = [
      match('A', [p('A'), p('B', { eliminatedBy: 'A' }), p('C', { eliminatedBy: 'B' })]),
      match('B', [p('A', { eliminatedBy: 'A' }), p('B'), p('C', { eliminatedBy: 'B' })]),
      match('C', [p('A'), p('B'), p('C')]),
    ];
    const stats = eliminationStats(matches);
    expect(stats.map((s) => [s.name, s.kills, s.deaths])).toEqual([
      ['B', 2, 1],
      ['A', 1, 1],
      ['C', 0, 2],
    ]);
    const b = stats.find((s) => s.name === 'B')!;
    expect(b.victims).toEqual([{ name: 'C', count: 2 }]);
    expect(b.killers).toEqual([{ name: 'A', count: 1 }]);
    expect(stats.find((s) => s.name === 'A')!.selfDeaths).toBe(1);
  });

  it('benennt den Werfer beim Zusammenführen mit um', () => {
    const m = match('Fabi', [p('Fabi'), p('B', { eliminatedBy: 'Fabi' })]);
    const merged = mergePeopleMatches([
      { userId: 'u1', name: 'Fabian', entries: [{ match: m, selfName: 'Fabi' }] },
    ]);
    expect(merged[0].players[1].eliminatedBy).toBe('Fabian');
  });
});

describe('match-insights: Performance', () => {
  const atraxa = { deckId: 'atraxa', deckName: 'Atraxa', commander: "Atraxa, Praetors' Voice" };
  const korvold = { deckId: 'korvold', deckName: 'Korvold', commander: 'Korvold, Fae-Cursed King' };

  it('liefert bei 0 Partien Nullen und null statt NaN', () => {
    const s = performanceSummary([], pickPlayer('A'));
    expect(s).toEqual({
      games: 0,
      wins: 0,
      winRate: null,
      avgPlacement: null,
      placementGames: 0,
      avgWinTurn: null,
      winTurnGames: 0,
      avgMinutes: null,
      durationGames: 0,
    });
    expect(average([])).toBeNull();
    const o = overallSummary([]);
    expect(o.games).toBe(0);
    expect(o.avgTurn).toBeNull();
    expect(o.avgMinutes).toBeNull();
    expect(deckPerformance([])).toEqual([]);
    expect(commanderMatchups([], pickPlayer('A'))).toEqual([]);
    expect(deckVersionStats([], 'atraxa')).toEqual([]);
    expect(winConditionStats([]).every((w) => w.count === 0)).toBe(true);
    expect(sampleSize(0)).toBe('none');
  });

  it('rechnet eine einzelne Partie', () => {
    const s = performanceSummary(
      [match('A', [p('A', atraxa), p('B', korvold)], { winTurn: 7, winCondition: 'combat' })],
      pickDeck('atraxa'),
    );
    expect(s.games).toBe(1);
    expect(s.wins).toBe(1);
    expect(s.winRate).toBe(100);
    expect(s.avgWinTurn).toBe(7);
    expect(s.avgPlacement).toBe(1);
  });

  it('kennt 100 % und 0 % Siegquote', () => {
    const matches = [match('A', [p('A'), p('B')]), match('A', [p('A'), p('B')])];
    expect(performanceSummary(matches, pickPlayer('A')).winRate).toBe(100);
    expect(performanceSummary(matches, pickPlayer('B')).winRate).toBe(0);
    expect(performanceSummary(matches, pickPlayer('B')).avgPlacement).toBe(2);
  });

  it('rechnet gemischte Ergebnisse und zählt ein Unentschieden als Partie ohne Sieg', () => {
    const matches = [
      match('A', [p('A'), p('B'), p('C')]),
      match('B', [p('A'), p('B'), p('C')]),
      match(DRAW, [p('A'), p('B'), p('C')]),
      match('A', [p('A'), p('B'), p('C')]),
    ];
    const s = performanceSummary(matches, pickPlayer('A'));
    expect(s.games).toBe(4);
    expect(s.wins).toBe(2);
    expect(s.winRate).toBe(50);
  });

  it('rechnet Schnitte nur über Partien mit erfasstem Wert - fehlend ist nicht 0', () => {
    const matches = [
      match('A', [p('A'), p('B'), p('C')], { winTurn: 8 }),
      match('A', [p('A'), p('B'), p('C')], { winTurn: 10 }),
      match('A', [p('A'), p('B'), p('C')]),
      match('A', [p('A'), p('B'), p('C')]),
      match('B', [p('A'), p('B'), p('C')], { winTurn: 4 }),
    ];
    const s = performanceSummary(matches, pickPlayer('A'));
    expect(s.wins).toBe(4);
    expect(s.winTurnGames).toBe(2);
    expect(s.avgWinTurn).toBe(9);
    // In 3er-Runden ohne Eintrag ist der Platz unbekannt, auch für den Sieger.
    expect(s.placementGames).toBe(0);
    expect(s.avgPlacement).toBeNull();
    expect(s.durationGames).toBe(0);
    expect(s.avgMinutes).toBeNull();
    const o = overallSummary(matches);
    expect(o.turnGames).toBe(3);
    expect(o.avgTurn).toBeCloseTo(22 / 3);
  });

  it('rechnet den Ø Platz aus eingetragenen Platzierungen', () => {
    const four = (placements: number[]) =>
      ['A', 'B', 'C', 'D'].map((n, i) => p(n, { placement: placements[i] }));
    const matches = [
      match('A', four([1, 2, 3, 4])),
      match('B', four([2, 1, 4, 3])),
      match('C', four([3, 4, 1, 2])),
      match('D', [p('A'), p('B'), p('C'), p('D')]),
    ];
    const s = performanceSummary(matches, pickPlayer('A'));
    expect(s.games).toBe(4);
    expect(s.placementGames).toBe(3);
    expect(s.avgPlacement).toBe(2);
    expect(s.wins).toBe(1);
    expect(placementOf(matches[3], matches[3].players[0])).toBeNull();
  });

  it('verteilt Siegarten und zählt fehlende als unbekannt', () => {
    const matches = [
      match('A', [p('A'), p('B')], { winCondition: 'combat' }),
      match('A', [p('A'), p('B')], { winCondition: 'combo' }),
      match('B', [p('A'), p('B')], { winCondition: 'commander_damage' }),
      match('A', [p('A'), p('B')]),
      match(DRAW, [p('A'), p('B')], { winCondition: 'mill' }),
    ];
    const all = Object.fromEntries(winConditionStats(matches).map((w) => [w.condition, w.count]));
    expect(all).toEqual({
      combat: 1,
      combo: 1,
      commander_damage: 1,
      mill: 0,
      other: 0,
      unknown: 1,
    });
    const a = Object.fromEntries(
      winConditionStats(matches, pickPlayer('A')).map((w) => [w.condition, w.count]),
    );
    expect(a).toEqual({ combat: 1, combo: 1, commander_damage: 0, mill: 0, other: 0, unknown: 1 });
  });

  it('trennt Deck-Versionen und hält Partien ohne Version getrennt', () => {
    const v = (version?: number) => ({ ...atraxa, deckVersion: version });
    const matches = [
      match('A', [p('A', v()), p('B')]),
      match('B', [p('A', v(1)), p('B')]),
      match('A', [p('A', v(1)), p('B')]),
      match('A', [p('A', v(2)), p('B')]),
      match('A', [p('A', v(2)), p('B')]),
    ];
    const stats = deckVersionStats(matches, 'atraxa');
    expect(stats.map((s) => [s.version, s.summary.games, s.summary.wins])).toEqual([
      [2, 2, 2],
      [1, 2, 1],
      [null, 1, 1],
    ]);
    const cmp = compareLatestVersions(stats);
    expect(cmp?.newer.version).toBe(2);
    expect(cmp?.older.version).toBe(1);
    expect(cmp?.direction).toBe('higher');
    expect(compareLatestVersions(stats.slice(1))).toBeNull();
  });

  it('zählt Matchups gegen Commander, Siege Dritter weder als Sieg noch als Niederlage', () => {
    const matches = [
      match('A', [p('A', atraxa), p('B', korvold), p('C')]),
      match('B', [p('A', atraxa), p('B', korvold), p('C')]),
      match('C', [p('A', atraxa), p('B', korvold), p('C')]),
      match('A', [p('A', atraxa), p('B', korvold)]),
    ];
    const [vsKorvold] = commanderMatchups(matches, pickDeck('atraxa'));
    expect(vsKorvold.label).toBe(korvold.commander);
    expect([vsKorvold.games, vsKorvold.wins, vsKorvold.losses]).toEqual([4, 2, 1]);
    expect(vsKorvold.winRate).toBe(50);
  });

  it('wertet Decks einzeln und mit Commander-Rückfall ohne Deck', () => {
    const rows = deckPerformance(
      [
        match('A', [p('A', atraxa), p('B', { commander: 'Sol Ring Guy' })]),
        match('B', [p('A', atraxa), p('B', { commander: 'Sol Ring Guy' })]),
        match('A', [p('A', atraxa), p('B', korvold)]),
      ],
      null,
    );
    expect(rows.map((r) => [r.label, r.summary.games, r.summary.wins])).toEqual([
      ['Atraxa', 3, 2],
      ['Sol Ring Guy', 2, 1],
      ['Korvold', 1, 0],
    ]);
    expect(deckPerformance([match('A', [p('A', atraxa), p('B', korvold)])], 'B')).toHaveLength(1);
  });

  it('wertet alte Partien ohne die neuen Felder aus', () => {
    const old = {
      id: 'old',
      date: '2025-01-01T20:00:00Z',
      mode: 'Normal',
      format: 'Commander',
      winner: 'A',
      countsInGeneralStats: true,
      players: [{ name: 'A', deckId: 'atraxa' }, { name: 'B' }],
    } as Match;
    const s = performanceSummary([old], pickDeck('atraxa'));
    expect([s.games, s.wins, s.winRate, s.avgWinTurn, s.avgMinutes]).toEqual([
      1,
      1,
      100,
      null,
      null,
    ]);
    expect(winConditionStats([old]).find((w) => w.condition === 'unknown')?.count).toBe(1);
    expect(deckVersionStats([old], 'atraxa')[0].version).toBeNull();
  });

  it('gibt eine grobe Orientierung zur Stichprobe', () => {
    expect([1, 4, 5, 9, 10, 100].map(sampleSize)).toEqual([
      'veryLow',
      'veryLow',
      'trend',
      'trend',
      'more',
      'more',
    ]);
  });
});
