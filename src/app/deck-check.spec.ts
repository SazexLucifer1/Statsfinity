import {
  atLeast,
  between,
  colorPips,
  colorRequirements,
  deckCheckItems,
  deckHealthScore,
  deckOdds,
  hypergeometric,
  categoryTarget,
  curveStyle,
  effectiveLands,
  influencesFor,
  mdfcCanEnterUntapped,
  recommendedLands60,
  requiredSources,
  groupWinCons,
  isWinningResult,
} from './deck-check';

describe('deck-check', () => {
  it('startet in der Mitte der Spanne und verschiebt das Ziel je Spielweise', () => {
    expect(categoryTarget('boardwipe', [])).toMatchObject({ target: 4, min: 0, max: 8 });
    expect(categoryTarget('boardwipe', ['control'])).toMatchObject({
      target: 6,
      more: ['control'],
    });
    expect(categoryTarget('boardwipe', ['creatures', 'aggro'])).toMatchObject({ target: 0 });
    // Gegenläufige Spielweisen heben sich auf, über die Spanne hinaus geht es nie.
    expect(categoryTarget('draw', ['combo', 'aggro']).target).toBe(11);
    expect(categoryTarget('ramp', ['landfall', 'highCurve', 'landfall' as never]).target).toBe(17);
  });

  it('liest die Kurve aus dem Ø Manawert', () => {
    expect(curveStyle(2.6)).toBe('lowCurve');
    expect(curveStyle(3.2)).toBeNull();
    expect(curveStyle(3.9)).toBe('highCurve');
    expect(influencesFor({ playStyles: ['control'], averageCmc: 3.9 })).toEqual([
      'control',
      'highCurve',
    ]);
  });

  it('zählt doppelseitige Länder voll, wenn sie ungetappt kommen können, sonst 0,38', () => {
    expect(
      mdfcCanEnterUntapped(
        "As this land enters, you may pay 3 life. If you don't, it enters tapped.",
      ),
    ).toBe(true);
    expect(mdfcCanEnterUntapped('This land enters tapped.\n{T}: Add {G}.')).toBe(false);
    expect(mdfcCanEnterUntapped(null)).toBe(false);
    const info = effectiveLands([
      { typeLine: 'Basic Land — Forest', quantity: 30 },
      { typeLine: 'Land // Land', quantity: 1 },
      {
        typeLine: 'Sorcery // Land',
        quantity: 1,
        backOracleText: 'As this land enters, you may pay 3 life.',
      },
      {
        typeLine: 'Creature — Elephant // Land',
        quantity: 2,
        backOracleText: 'This land enters tapped.',
      },
      { typeLine: 'Creature — Elf', quantity: 1 },
    ]);
    expect(info).toEqual({ lands: 31, mdfcUntapped: 1, mdfcTapped: 2, value: 32.8 });
  });

  it('bewertet Kategorien als gut, knapp oder schlecht', () => {
    const items = deckCheckItems({
      isCommanderFormat: true,
      lands: 33,
      averageCmc: 3.2,
      ramp: 13,
      draw: 9,
      removal: 3,
      boardwipe: 4,
    });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i.level]));
    expect(byKey).toEqual({
      lands: 'good',
      ramp: 'good',
      draw: 'good',
      removal: 'bad',
      boardwipe: 'good',
    });
    expect(deckHealthScore(items)).toBe(80);
  });

  it('prüft in 60-Karten-Formaten nur die Länder nach Karsten', () => {
    const items = deckCheckItems({
      isCommanderFormat: false,
      lands: 24,
      averageCmc: 2.5,
      ramp: 0,
      draw: 0,
      removal: 0,
      boardwipe: 0,
    });
    expect(items.map((i) => [i.key, i.target, i.level])).toEqual([['lands', 24, 'good']]);
    expect(recommendedLands60(2.5, 0)).toBe(24);
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

  it('erkennt Spellbooks "Infinite lifeloss" als Sieg, Schaden auf Kreaturen nicht', () => {
    expect(isWinningResult('Infinite lifeloss')).toBe(true);
    expect(isWinningResult('Infinite damage to opponents')).toBe(true);
    expect(isWinningResult('Infinite damage to creatures')).toBe(false);
    expect(isWinningResult('Infinite death triggers')).toBe(false);
    expect(isWinningResult('Infinite colorless mana')).toBe(false);
  });

  it('fasst Varianten derselben Combo zu einer Win Con zusammen', () => {
    const groups = groupWinCons([
      { cardNames: ['Warren Soultrader', 'Gravecrawler', 'Zulaport Cutthroat'] },
      { cardNames: ['Warren Soultrader', 'Gravecrawler', 'Blood Artist'] },
      {
        cardNames: [
          'Warren Soultrader',
          'Pitiless Plunderer',
          'Reassembling Skeleton',
          'Blood Artist',
        ],
      },
      { cardNames: ["Thassa's Oracle", 'Demonic Consultation'] },
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0]).toEqual({
      cardNames: ['Warren Soultrader', 'Gravecrawler', 'Zulaport Cutthroat'],
      variants: 3,
    });
    expect(groups[1].variants).toBe(1);
  });
});
