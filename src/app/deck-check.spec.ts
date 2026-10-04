import {
  atLeast,
  between,
  colorPips,
  colorRequirements,
  deckCheckItems,
  deckHealthScore,
  deckOdds,
  hypergeometric,
  recommendedLands,
  requiredSources,
} from './deck-check';

describe('deck-check', () => {
  it('rechnet die Länderzahl nach Karsten', () => {
    expect(recommendedLands({ isCommanderFormat: true, averageCmc: 3, ramp: 0, draw: 0 })).toBe(41);
    expect(recommendedLands({ isCommanderFormat: true, averageCmc: 3, ramp: 10, draw: 10 })).toBe(
      38,
    );
    expect(recommendedLands({ isCommanderFormat: false, averageCmc: 2.5, ramp: 0, draw: 0 })).toBe(
      24,
    );
  });

  it('bewertet Kategorien als gut, knapp oder schlecht', () => {
    const items = deckCheckItems({
      librarySize: 99,
      isCommanderFormat: true,
      lands: 38,
      averageCmc: 3,
      ramp: 10,
      draw: 10,
      removal: 5,
      boardwipe: 1,
    });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i.level]));
    expect(byKey).toEqual({
      lands: 'good',
      ramp: 'good',
      draw: 'good',
      removal: 'bad',
      boardwipe: 'warn',
    });
    expect(deckHealthScore(items)).toBe(70);
  });

  it('prüft in 60-Karten-Formaten nur die Länder', () => {
    const items = deckCheckItems({
      librarySize: 60,
      isCommanderFormat: false,
      lands: 24,
      averageCmc: 2.5,
      ramp: 0,
      draw: 0,
      removal: 0,
      boardwipe: 0,
    });
    expect(items.map((i) => i.key)).toEqual(['lands']);
  });

  it('zählt farbige Symbole ohne Hybrid und findet die anspruchsvollste Karte', () => {
    expect(colorPips('{2}{G}{G}')).toEqual({ G: 2 });
    expect(colorPips('{W/U}{B}')).toEqual({ B: 1 });
    expect(requiredSources(2, 3, true)).toBe(28);
    expect(requiredSources(1, 9, true)).toBe(14);
    const reqs = colorRequirements(
      [
        { name: 'Llanowar Elves', cmc: 1, manaCost: '{G}' },
        { name: 'Beast Whisperer', cmc: 4, manaCost: '{2}{G}{G}' },
        { name: 'Counterspell', cmc: 2, manaCost: '{U}{U}' },
      ],
      { G: 25, U: 12 },
      true,
    );
    expect(reqs.map((r) => [r.color, r.card, r.required, r.level])).toEqual([
      ['U', 'Counterspell', 30, 'bad'],
      ['G', 'Beast Whisperer', 26, 'good'],
    ]);
  });

  it('rechnet hypergeometrisch exakt', () => {
    let sum = 0;
    for (let k = 0; k <= 7; k++) sum += hypergeometric(99, 37, 7, k);
    expect(sum).toBeCloseTo(1, 10);
    expect(atLeast(60, 4, 7, 1)).toBeCloseTo(0.3995, 3);
    expect(between(99, 37, 7, 0, 7)).toBeCloseTo(1, 10);
    const odds = deckOdds(99, 37, 10, null);
    expect(odds.keepableHand).toBeGreaterThan(0.7);
    expect(odds.drawByTurn4).toBeNull();
  });
});
