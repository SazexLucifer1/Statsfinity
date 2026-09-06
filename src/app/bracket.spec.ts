import {
  AUTO_BRACKET_MAX,
  BracketCard,
  BracketInput,
  CEDH_TUNING_HINT,
  analyzeBracket,
  powerLevel,
  presentCombos,
  rulesVerdict,
  spellbookVerdict,
  tuningParts,
  tuningVerdict,
} from './bracket';
import type { SpellbookCardFlags, SpellbookTwoCardCombo } from './card-data.service';

/**
 * Die Bracket-Einstufung ist reine Rechnerei über Kartenlisten - ohne Test würde eine verschobene
 * Schwelle erst dann auffallen, wenn ein Deck in der Oberfläche eine Stufe zu hoch oder zu tief
 * steht, und selbst dann kaum. Deshalb hier je Regelzeile ein Fall.
 */

const karte = (name: string, extra: Partial<BracketCard> = {}): BracketCard => ({
  name,
  key: name.toLowerCase(),
  quantity: 1,
  cmc: 2,
  gameChanger: false,
  isCommander: false,
  ...extra,
});

const combo = (
  a: string,
  b: string,
  extra: Partial<SpellbookTwoCardCombo> = {},
): SpellbookTwoCardCombo => ({
  id: `${a}-${b}`,
  cardA: a.toLowerCase(),
  cardB: b.toLowerCase(),
  aMustBeCommander: false,
  bMustBeCommander: false,
  manaValueNeeded: 0,
  bracketTag: 'S',
  popularity: 1000,
  ...extra,
});

const flags = (
  eintraege: Record<string, Partial<SpellbookCardFlags>>,
): Map<string, SpellbookCardFlags> =>
  new Map(
    Object.entries(eintraege).map(([name, f]) => [
      name.toLowerCase(),
      { massLandDenial: false, extraTurn: false, tutor: false, ...f },
    ]),
  );

/** Unauffälliges Deck: nichts, was ein hartes Kriterium auslöst, und mittelmäßig gebaut. */
const basis = (extra: Partial<BracketInput> = {}): BracketInput => ({
  cards: [karte('Llanowar Elves'), karte('Forest')],
  flags: new Map(),
  combos: [],
  spellbookTag: null,
  isPrecon: false,
  averageCmc: 3.4,
  nonBasicLandPercent: 30,
  tutorCount: 0,
  totalCards: 100,
  ...extra,
});

describe('bracket - Urteil A: offizielle Ausschlusskriterien', () => {
  it('stuft ein Deck ohne jeden Befund als Bracket 2 ein', () => {
    const { level, reasons } = rulesVerdict(basis());
    expect(level).toBe(2);
    expect(reasons.map((r) => r.key)).toEqual(['nothing']);
  });

  it('hebt Mass Land Denial auf Bracket 4', () => {
    const { level, reasons } = rulesVerdict(
      basis({
        cards: [karte('Armageddon'), karte('Forest')],
        flags: flags({ Armageddon: { massLandDenial: true } }),
      }),
    );
    expect(level).toBe(4);
    expect(reasons.find((r) => r.key === 'massLandDenial')?.cards).toEqual(['Armageddon']);
  });

  it('erlaubt bis zu drei Game Changer in Bracket 3 und hebt ab vier auf Bracket 4', () => {
    const gc = (n: number) =>
      Array.from({ length: n }, (_, i) => karte(`GC${i}`, { gameChanger: true }));

    expect(rulesVerdict(basis({ cards: gc(0) })).level).toBe(2);
    expect(rulesVerdict(basis({ cards: gc(1) })).level).toBe(3);
    expect(rulesVerdict(basis({ cards: gc(3) })).level).toBe(3);
    expect(rulesVerdict(basis({ cards: gc(4) })).level).toBe(4);
  });

  it('zählt Game Changer nach Menge, nicht nach Zeilen', () => {
    const vier = [karte('GC', { gameChanger: true, quantity: 4 })];
    expect(rulesVerdict(basis({ cards: vier })).level).toBe(4);
  });

  it('hebt eine schnelle Zwei-Karten-Combo (bis 5 Mana) auf Bracket 4', () => {
    const input = basis({
      cards: [karte('Thoracle', { cmc: 2 }), karte('Consult', { cmc: 1 })],
      combos: [combo('Thoracle', 'Consult', { bracketTag: 'S', manaValueNeeded: 0 })],
    });
    const { level, reasons } = rulesVerdict(input);
    expect(level).toBe(4);
    expect(reasons.find((r) => r.key === 'comboFast')?.cards).toEqual(['Thoracle + Consult']);
  });

  it('lässt eine langsame Combo (über 5 Mana) bei Bracket 3', () => {
    const input = basis({
      cards: [karte('Teil A', { cmc: 4 }), karte('Teil B', { cmc: 4 })],
      combos: [combo('Teil A', 'Teil B', { bracketTag: 'S' })],
    });
    expect(rulesVerdict(input).level).toBe(3);
  });

  it('rechnet das zusätzlich nötige Mana in die Combo-Geschwindigkeit ein', () => {
    const cards = [karte('Teil A', { cmc: 2 }), karte('Teil B', { cmc: 2 })];
    // 2 + 2 + 1 = 5 -> noch schnell; 2 + 2 + 2 = 6 -> nicht mehr.
    expect(
      rulesVerdict(basis({ cards, combos: [combo('Teil A', 'Teil B', { manaValueNeeded: 1 })] }))
        .level,
    ).toBe(4);
    expect(
      rulesVerdict(basis({ cards, combos: [combo('Teil A', 'Teil B', { manaValueNeeded: 2 })] }))
        .level,
    ).toBe(3);
  });

  it('hebt eine als "ruthless" benotete Combo auch dann auf Bracket 4, wenn sie langsam ist', () => {
    const input = basis({
      cards: [karte('Teil A', { cmc: 5 }), karte('Teil B', { cmc: 5 })],
      combos: [combo('Teil A', 'Teil B', { bracketTag: 'R' })],
    });
    expect(rulesVerdict(input).level).toBe(4);
  });

  it('lässt milde benotete Combos (E/C/O) ohne Aufschlag', () => {
    const input = basis({
      cards: [karte('Teil A', { cmc: 4 }), karte('Teil B', { cmc: 4 })],
      combos: [combo('Teil A', 'Teil B', { bracketTag: 'O' })],
    });
    expect(rulesVerdict(input).level).toBe(2);
  });

  it('wertet einzelne Extra-Turn-Karten nicht, eine Zugschleife dagegen als Bracket 4', () => {
    const nurKarte = basis({
      cards: [karte('Time Warp'), karte('Forest')],
      flags: flags({ 'Time Warp': { extraTurn: true } }),
    });
    expect(rulesVerdict(nurKarte).level).toBe(2);

    const schleife = basis({
      cards: [karte('Time Warp', { cmc: 5 }), karte('Partner', { cmc: 5 })],
      flags: flags({ 'Time Warp': { extraTurn: true } }),
      combos: [combo('Time Warp', 'Partner', { bracketTag: 'O' })],
    });
    const { level, reasons } = rulesVerdict(schleife);
    expect(level).toBe(4);
    expect(reasons.some((r) => r.key === 'extraTurnLoop')).toBe(true);
  });
});

describe('bracket - vollständige Combos erkennen', () => {
  it('zählt eine Combo nur, wenn beide Karten im Deck liegen', () => {
    const cards = [karte('Teil A')];
    expect(presentCombos(cards, [combo('Teil A', 'Teil B')], new Map())).toHaveLength(0);
    expect(
      presentCombos([...cards, karte('Teil B')], [combo('Teil A', 'Teil B')], new Map()),
    ).toHaveLength(1);
  });

  it('verlangt die Commander-Zone, wenn die Combo sie verlangt', () => {
    const combos = [combo('Teil A', 'Teil B', { aMustBeCommander: true })];

    const alsKarte = [karte('Teil A'), karte('Teil B')];
    expect(presentCombos(alsKarte, combos, new Map())).toHaveLength(0);

    const alsCommander = [karte('Teil A', { isCommander: true }), karte('Teil B')];
    expect(presentCombos(alsCommander, combos, new Map())).toHaveLength(1);
  });
});

describe('bracket - Urteil B: Spellbook-Zweitmeinung', () => {
  it('bildet die Noten auf Untergrenzen ab', () => {
    expect(spellbookVerdict('R')).toBe(4);
    expect(spellbookVerdict('P')).toBe(3);
    expect(spellbookVerdict('S')).toBe(3);
    expect(spellbookVerdict('O')).toBe(2);
    expect(spellbookVerdict('C')).toBe(2);
    expect(spellbookVerdict('E')).toBe(2);
  });

  it('hat bei "gesperrte Karte" und ohne Antwort keine Meinung zur Stufe', () => {
    expect(spellbookVerdict('B')).toBeNull();
    expect(spellbookVerdict(null)).toBeNull();
  });
});

describe('bracket - Urteil C: Tuning-Grad', () => {
  it('bewertet ein unauffälliges Deck mit 0', () => {
    expect(tuningVerdict(basis())).toBe(0);
  });

  it('bewertet ein durchoptimiertes Deck nahe 1', () => {
    const wert = tuningVerdict(
      basis({
        cards: Array.from({ length: 6 }, (_, i) => karte(`GC${i}`, { gameChanger: true })),
        averageCmc: 2.0,
        nonBasicLandPercent: 95,
        tutorCount: 10,
      }),
    );
    expect(wert).toBe(1);
  });

  it('lässt fehlende Werte aus, statt sie als Null zu zählen', () => {
    // Nur die Game-Changer-Dichte ist bekannt und steht auf Anschlag: ohne Auslassen käme durch
    // die beiden fehlenden Werte ein Drittel heraus.
    const wert = tuningVerdict(
      basis({
        cards: Array.from({ length: 6 }, (_, i) => karte(`GC${i}`, { gameChanger: true })),
        averageCmc: null,
        nonBasicLandPercent: null,
        totalCards: 0,
      }),
    );
    expect(wert).toBe(1);
  });
});

describe('bracket - Tuning-Grad aufgeschluesselt', () => {
  const teil = (input: BracketInput, key: string) => tuningParts(input).find((t) => t.key === key);

  it('meldet je Messgroesse den gemessenen Wert und die Spannenenden', () => {
    const parts = tuningParts(basis({ tutorCount: 4, totalCards: 100, averageCmc: 2.8 }));
    expect(parts.map((p) => p.key)).toEqual([
      'tutors',
      'averageCmc',
      'nonBasicLands',
      'gameChangers',
    ]);
    expect(teil(basis({ tutorCount: 4, totalCards: 100 }), 'tutors')).toMatchObject({
      value: 4,
      from: 0,
      to: 8,
      score: 0.5,
    });
  });

  it('dreht die Spanne dort um, wo weniger staerker ist', () => {
    // Beim Manawert zaehlt der NIEDRIGERE Wert als staerker - deshalb from > to.
    expect(teil(basis({ averageCmc: 3.4 }), 'averageCmc')?.score).toBe(0);
    expect(teil(basis({ averageCmc: 2.2 }), 'averageCmc')?.score).toBe(1);
    expect(teil(basis({ averageCmc: 2.8 }), 'averageCmc')?.score).toBeCloseTo(0.5, 5);
  });

  it('kappt Werte ausserhalb der Spanne bei 0 und 1', () => {
    expect(teil(basis({ averageCmc: 5 }), 'averageCmc')?.score).toBe(0);
    expect(teil(basis({ nonBasicLandPercent: 100 }), 'nonBasicLands')?.score).toBe(1);
  });

  it('laesst fehlende Werte ganz weg, statt sie als 0 zu zaehlen', () => {
    const parts = tuningParts(
      basis({ averageCmc: null, nonBasicLandPercent: null, totalCards: 0 }),
    );
    expect(parts.map((p) => p.key)).toEqual(['gameChangers']);
  });

  /**
   * Die wichtigste Zusage: was die Oberflaeche aufschluesselt, ergibt genau den Prozentwert, den
   * sie daneben anzeigt. Ohne diesen Test koennten beide unbemerkt auseinanderlaufen.
   */
  it('mittelt sich exakt zum angezeigten Tuning-Grad', () => {
    for (const input of [
      basis(),
      basis({ tutorCount: 6, averageCmc: 2.5, nonBasicLandPercent: 70 }),
      basis({ cards: Array.from({ length: 4 }, (_, i) => karte(`GC${i}`, { gameChanger: true })) }),
      basis({ averageCmc: null, nonBasicLandPercent: null }),
    ]) {
      const parts = tuningParts(input);
      const mittel = parts.reduce((s, t) => s + t.score, 0) / parts.length;
      expect(tuningVerdict(input)).toBeCloseTo(mittel, 10);
    }
  });

  it('liefert dieselben Teile ueber analyzeBracket()', () => {
    const input = basis({ tutorCount: 5, averageCmc: 2.6 });
    expect(analyzeBracket(input).verdicts.tuningParts).toEqual(tuningParts(input));
  });
});

describe('bracket - Power-Level', () => {
  it('rastet paarweise auf den Brackets ein', () => {
    expect(powerLevel(2, 0)).toBe(3);
    expect(powerLevel(3, 0)).toBe(5);
    expect(powerLevel(4, 0)).toBe(7);
  });

  it('nutzt die Spanne innerhalb eines Brackets aus', () => {
    expect(powerLevel(2, 1)).toBe(4.9);
    expect(powerLevel(4, 1)).toBe(8.9);
  });
});

describe('bracket - Zusammenführung', () => {
  it('nimmt die höhere der beiden unabhängigen Untergrenzen', () => {
    const ergebnis = analyzeBracket(basis({ spellbookTag: 'R' }));
    expect(ergebnis.verdicts.rules).toBe(2);
    expect(ergebnis.verdicts.spellbook).toBe(4);
    expect(ergebnis.bracket).toBe(4);
  });

  it('senkt niemals unter die harten Kriterien', () => {
    const ergebnis = analyzeBracket(
      basis({
        cards: [karte('Armageddon'), karte('Forest')],
        flags: flags({ Armageddon: { massLandDenial: true } }),
        spellbookTag: 'E',
      }),
    );
    expect(ergebnis.bracket).toBe(4);
  });

  it('hebt ein durchoptimiertes Deck um genau eine Stufe an', () => {
    const ergebnis = analyzeBracket(
      basis({
        cards: Array.from({ length: 3 }, (_, i) => karte(`GC${i}`, { gameChanger: true })),
        averageCmc: 2.0,
        nonBasicLandPercent: 95,
        tutorCount: 10,
      }),
    );
    expect(ergebnis.verdicts.rules).toBe(3);
    expect(ergebnis.bracket).toBe(4);
    expect(ergebnis.reasons.some((r) => r.key === 'tuning')).toBe(true);
  });

  it('hebt einen Precon nicht an, egal wie gut die Kennzahlen sind', () => {
    const ergebnis = analyzeBracket(
      basis({
        isPrecon: true,
        averageCmc: 2.0,
        nonBasicLandPercent: 95,
        tutorCount: 10,
      }),
    );
    expect(ergebnis.bracket).toBe(2);
  });

  it('vergibt nie mehr als Bracket 4', () => {
    const ergebnis = analyzeBracket(
      basis({
        cards: Array.from({ length: 8 }, (_, i) => karte(`GC${i}`, { gameChanger: true })),
        averageCmc: 1.5,
        nonBasicLandPercent: 100,
        tutorCount: 15,
        spellbookTag: 'R',
      }),
    );
    expect(ergebnis.bracket).toBe(AUTO_BRACKET_MAX);
  });

  it('weist bei durchweg durchoptimierten Bracket-4-Decks auf cEDH hin', () => {
    const ergebnis = analyzeBracket(
      basis({
        cards: Array.from({ length: 8 }, (_, i) => karte(`GC${i}`, { gameChanger: true })),
        averageCmc: 1.5,
        nonBasicLandPercent: 100,
        tutorCount: 15,
      }),
    );
    expect(ergebnis.verdicts.tuning).toBeGreaterThanOrEqual(CEDH_TUNING_HINT);
    expect(ergebnis.suggestsCedh).toBe(true);
  });

  it('weist ein bloss ordentlich gebautes Bracket-4-Deck nicht als cEDH aus', () => {
    // Genau der Fall, der beim Pruefen in der laufenden App auffiel: fuenf Game Changer, sonst
    // unauffaellig. Tuning-Grad um 0,6 - das ist ein starkes Deck, aber kein Turnierdeck.
    const ergebnis = analyzeBracket(
      basis({
        cards: Array.from({ length: 5 }, (_, i) => karte(`GC${i}`, { gameChanger: true })),
        averageCmc: 2.8,
        nonBasicLandPercent: 70,
        tutorCount: 3,
      }),
    );
    expect(ergebnis.bracket).toBe(4);
    expect(ergebnis.suggestsCedh).toBe(false);
  });

  it('weist ein gewöhnliches Bracket-4-Deck nicht als cEDH aus', () => {
    const ergebnis = analyzeBracket(
      basis({
        cards: [karte('Armageddon'), karte('Forest')],
        flags: flags({ Armageddon: { massLandDenial: true } }),
      }),
    );
    expect(ergebnis.bracket).toBe(4);
    expect(ergebnis.suggestsCedh).toBe(false);
  });

  it('meldet hohe Sicherheit nur bei übereinstimmenden Urteilen', () => {
    const einig = analyzeBracket(basis({ spellbookTag: 'E' }));
    expect(einig.confidence).toBe('high');

    const ohneZweitmeinung = analyzeBracket(basis({ spellbookTag: null }));
    expect(ohneZweitmeinung.confidence).toBe('medium');

    const eineStufe = analyzeBracket(basis({ spellbookTag: 'S' }));
    expect(eineStufe.confidence).toBe('medium');

    const zweiStufen = analyzeBracket(basis({ spellbookTag: 'R' }));
    expect(zweiStufen.confidence).toBe('low');
  });
});
