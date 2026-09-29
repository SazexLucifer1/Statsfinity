import {
  ELO_K_PROVISIONAL,
  ELO_START,
  eloRanking,
  expectedScore,
  isRatedMatch,
  ratedModes,
  seatsOf,
} from './elo';
import { ARCHENEMY_OTHERS, DRAW, IMPORT_LOSS_PLACEHOLDER } from './match-utils';
import { GameMode, Match, MatchPlayer } from './models';

let id = 0;
function match(
  mode: GameMode,
  winner: string,
  players: MatchPlayer[],
  date = '2026-08-01T20:00:00Z',
): Match {
  return { id: `m${++id}`, date, mode, format: 'Commander', players, winner } as Match;
}
const p = (name: string, extra: Partial<MatchPlayer> = {}): MatchPlayer => ({ name, ...extra });

describe('elo', () => {
  it('erwartet 50 % bei gleicher Wertung und mehr gegen Schwächere', () => {
    expect(expectedScore(1000, 1000)).toBe(0.5);
    expect(expectedScore(1200, 1000)).toBeGreaterThan(0.75);
  });

  it('verteilt einen Pod-Sieg auf alle Gegner, Summe bleibt null', () => {
    const [a, b, c, d] = eloRanking(
      [match('Normal', 'A', [p('A'), p('B'), p('C'), p('D')])],
      'Normal',
    );
    expect(a.name).toBe('A');
    expect(a.rating - ELO_START).toBeCloseTo(ELO_K_PROVISIONAL / 2);
    expect(a.wins).toBe(1);
    const sum = [a, b, c, d].reduce((s, e) => s + e.rating - ELO_START, 0);
    expect(sum).toBeCloseTo(0);
  });

  it('belohnt eine gute Platzierung auch ohne Sieg', () => {
    const ranking = eloRanking(
      [
        match('Normal', 'A', [
          p('A'),
          p('B', { placement: 2 }),
          p('C', { placement: 3 }),
          p('D', { placement: 4 }),
        ]),
      ],
      'Normal',
    );
    const byName = Object.fromEntries(ranking.map((e) => [e.name, e.rating - ELO_START]));
    expect(byName['B']).toBeGreaterThan(0);
    expect(byName['C']).toBeLessThan(0);
    expect(byName['D']).toBeLessThan(byName['C']);
  });

  it('gibt für einen Sieg gegen einen Starken mehr als gegen einen Schwachen', () => {
    const history = [
      match('Normal', 'Stark', [p('Stark'), p('X')], '2026-08-01T00:00:00Z'),
      match('Normal', 'Stark', [p('Stark'), p('Y')], '2026-08-02T00:00:00Z'),
    ];
    const gegenStark = eloRanking(
      [...history, match('Normal', 'A', [p('A'), p('Stark')], '2026-08-03T00:00:00Z')],
      'Normal',
    );
    const gegenSchwach = eloRanking(
      [...history, match('Normal', 'A', [p('A'), p('X')], '2026-08-03T00:00:00Z')],
      'Normal',
    );
    const a = (r: typeof gegenStark) => r.find((e) => e.name === 'A')!.lastChange;
    expect(a(gegenStark)).toBeGreaterThan(a(gegenSchwach));
  });

  it('lässt Teamkollegen und Archenemy-Verbündete nicht gegeneinander spielen', () => {
    const twoHg = seatsOf(
      match('Two-Headed Giant', 'Team 1', [
        p('A', { team: 'Team 1' }),
        p('B', { team: 'Team 1' }),
        p('C', { team: 'Team 2' }),
        p('D', { team: 'Team 2' }),
      ]),
    );
    expect(twoHg.map((s) => s.rank)).toEqual([1, 1, 2, 2]);
    const [a, b] = eloRanking(
      [
        match('Two-Headed Giant', 'Team 1', [
          p('A', { team: 'Team 1' }),
          p('B', { team: 'Team 1' }),
          p('C', { team: 'Team 2' }),
          p('D', { team: 'Team 2' }),
        ]),
      ],
      'Two-Headed Giant',
    );
    expect(a.rating).toBeCloseTo(b.rating);

    const arch = seatsOf(
      match('Archenemy', ARCHENEMY_OTHERS, [p('E', { isArchenemy: true }), p('F'), p('G')]),
    );
    expect(arch.map((s) => [s.rank, s.side])).toEqual([
      [2, 'archenemy'],
      [1, 'others'],
      [1, 'others'],
    ]);
  });

  it('wertet Remis ohne Gewinner und keine Alt-/Import-/Turnier-ausgeschlossenen Partien', () => {
    const draw = eloRanking([match('Normal', DRAW, [p('A'), p('B')])], 'Normal');
    expect(draw.every((e) => e.rating === ELO_START)).toBe(true);
    expect(isRatedMatch(match('Normal', 'A', [p('A'), p('B')], '2025-12-31T00:00:00Z'))).toBe(
      false,
    );
    expect(isRatedMatch(match('Normal', IMPORT_LOSS_PLACEHOLDER, [p('A')]))).toBe(false);
    expect(
      isRatedMatch({ ...match('Normal', 'A', [p('A'), p('B')]), countsInGeneralStats: false }),
    ).toBe(false);
    expect(ratedModes([match('Cube', 'A', [p('A'), p('B')])], ['Normal', 'Cube'])).toEqual([
      'Cube',
    ]);
  });
});
