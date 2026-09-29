import { auc, auswerten, BenchmarkDeck, MERKMALE, MIN_DECKS_JE_STUFE } from './bracket-benchmark';
import type { BracketLevel } from './bracket';

function deck(bracket: BracketLevel, gameChanger: number): BenchmarkDeck {
  const werte = Object.fromEntries(MERKMALE.map((m) => [m, 0])) as BenchmarkDeck['werte'];
  werte.gameChanger = gameChanger;
  return { bracket, werte };
}

describe('auc', () => {
  it('ist 1, wenn jedes höhere Deck größer ist', () => {
    expect(auc([0, 1, 2], [3, 4])).toBe(1);
  });

  it('ist 0,5 bei gleichen Werten', () => {
    expect(auc([2, 2], [2, 2])).toBe(0.5);
  });

  it('ist 0, wenn es genau andersherum trennt', () => {
    expect(auc([5, 6], [1, 2])).toBe(0);
  });

  it('ist null ohne Decks auf einer Seite', () => {
    expect(auc([], [1])).toBeNull();
  });
});

describe('auswerten', () => {
  it('zählt je Stufe und rechnet 2 gegen 4', () => {
    const decks = [
      ...Array.from({ length: MIN_DECKS_JE_STUFE }, () => deck(2, 0)),
      ...Array.from({ length: MIN_DECKS_JE_STUFE }, () => deck(4, 3)),
      deck(3, 1),
    ];
    const e = auswerten(decks);
    expect(e.anzahl[2]).toBe(MIN_DECKS_JE_STUFE);
    expect(e.anzahl[3]).toBe(1);
    expect(e.auc.gameChanger).toBe(1);
    expect(e.auc.tutoren).toBe(0.5);
  });

  it('zeigt keine Zahl bei zu wenig Decks in Stufe 2 oder 4', () => {
    const decks = [deck(2, 0), deck(4, 3)];
    expect(auswerten(decks).auc.gameChanger).toBeNull();
  });
});
