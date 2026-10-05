import {
  AUTO_BRACKET_MAX,
  BracketCard,
  BracketInput,
  CEDH_TUNING_HINT,
  DEFAULT_BRACKET_BENCHMARK,
  PREIS_SCHWELLE_EUR,
  TUNING_BUMP_SCHWELLE,
  analyzeBracket,
  bracketBenchmarkFromRows,
  powerLevel,
  powerPosition,
  powerRange,
  presentCombos,
  priceVerdict,
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
  untappedLandPercent: 70,
  tutorCount: 0,
  totalCards: 100,
  totalPrice: null,
  winningCombos: 0,
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
        untappedLandPercent: 95,
        tutorCount: 10,
      }),
    );
    expect(wert).toBe(1);
  });

  it('lässt fehlende Werte aus, statt sie als Null zu zählen', () => {
    // Nur die Tutorendichte ist bekannt und steht auf Anschlag: ohne Auslassen käme durch die
    // beiden fehlenden Werte etwa die Hälfte heraus.
    const wert = tuningVerdict(
      basis({ tutorCount: 8, totalCards: 100, averageCmc: null, untappedLandPercent: null }),
    );
    expect(wert).toBe(1);
  });
});

describe('bracket - Tuning-Grad aufgeschluesselt', () => {
  const teil = (input: BracketInput, key: string) => tuningParts(input).find((t) => t.key === key);

  it('meldet je Messgroesse den gemessenen Wert und die Spannenenden', () => {
    const parts = tuningParts(basis({ tutorCount: 4, totalCards: 100, averageCmc: 2.8 }));
    expect(parts.map((p) => p.key)).toEqual(['tutors', 'averageCmc', 'untappedLands']);
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

  it('verankert die Manabasis an gemessenen Decks', () => {
    // 70 % ungetappt ist Precon-Niveau (nachgemessen: 70/72/79 %) und gibt deshalb keinen Punkt;
    // ab 95 % ist die Manabasis praktisch durchgaengig ungetappt.
    expect(teil(basis({ untappedLandPercent: 70 }), 'untappedLands')?.score).toBe(0);
    expect(teil(basis({ untappedLandPercent: 95 }), 'untappedLands')?.score).toBe(1);
    expect(teil(basis({ untappedLandPercent: 82.5 }), 'untappedLands')?.score).toBeCloseTo(0.5, 5);
  });

  it('kappt Werte ausserhalb der Spanne bei 0 und 1', () => {
    expect(teil(basis({ averageCmc: 5 }), 'averageCmc')?.score).toBe(0);
    expect(teil(basis({ untappedLandPercent: 100 }), 'untappedLands')?.score).toBe(1);
  });

  it('laesst fehlende Werte ganz weg, statt sie als 0 zu zaehlen', () => {
    const parts = tuningParts(
      basis({ averageCmc: null, untappedLandPercent: null, totalCards: 0 }),
    );
    expect(parts).toEqual([]);
  });

  /**
   * Die wichtigste Zusage: was die Oberflaeche aufschluesselt, ergibt genau den Prozentwert, den
   * sie daneben anzeigt. Ohne diesen Test koennten beide unbemerkt auseinanderlaufen.
   */
  it('mittelt sich gewichtet exakt zum angezeigten Tuning-Grad', () => {
    for (const input of [
      basis(),
      basis({ tutorCount: 6, averageCmc: 2.5, untappedLandPercent: 85 }),
      basis({ cards: Array.from({ length: 4 }, (_, i) => karte(`GC${i}`, { gameChanger: true })) }),
      basis({ averageCmc: null, untappedLandPercent: null }),
    ]) {
      const parts = tuningParts(input);
      const gewichte = parts.reduce((s, t) => s + t.weight, 0);
      const mittel = parts.reduce((s, t) => s + t.score * t.weight, 0) / gewichte;
      expect(tuningVerdict(input)).toBeCloseTo(mittel, 10);
    }
  });

  it('zaehlt Game Changer nicht ein zweites Mal - sie legen schon die Untergrenze fest', () => {
    const ohne = basis({ tutorCount: 4, averageCmc: 2.8 });
    const mit = basis({
      tutorCount: 4,
      averageCmc: 2.8,
      cards: Array.from({ length: 6 }, (_, i) => karte(`GC${i}`, { gameChanger: true })),
    });
    expect(tuningVerdict(mit)).toBe(tuningVerdict(ohne));
    expect(analyzeBracket(mit).verdicts.rules).toBe(4);
  });

  it('liefert dieselben Teile ueber analyzeBracket()', () => {
    const input = basis({ tutorCount: 5, averageCmc: 2.6 });
    expect(analyzeBracket(input).verdicts.tuningParts).toEqual(tuningParts(input));
  });
});

describe('bracket - Power-Level', () => {
  it('streckt den Tuning-Bereich jedes Ergebnisses auf die ganze Spanne - keine Lücken', () => {
    // Nicht angehoben: 0 bis Schwelle (0,7) füllt die ganze Spanne.
    expect(powerLevel(2, powerPosition(0.69, false, true))).toBe(4.9);
    expect(powerLevel(2, powerPosition(0.35, false, true))).toBe(4);
    // Angehoben: Schwelle bis 1 füllt die ganze Spanne des neuen Brackets.
    expect(powerLevel(3, powerPosition(0.7, true, true))).toBe(5);
    expect(powerLevel(3, powerPosition(1, true, true))).toBe(6.9);
    // Keine Anhebung möglich (B4, Precon): der Tuning-Grad selbst.
    expect(powerPosition(0.5, false, false)).toBe(0.5);
  });

  it('rastet paarweise auf den Brackets ein', () => {
    expect(powerLevel(2, 0)).toBe(3);
    expect(powerLevel(3, 0)).toBe(5);
    expect(powerLevel(4, 0)).toBe(7);
  });

  it('nutzt die Spanne innerhalb eines Brackets aus', () => {
    expect(powerLevel(2, 1)).toBe(4.9);
    expect(powerLevel(4, 1)).toBe(8.9);
  });

  /**
   * Die Oberflaeche fuehrt die Power-Rechnung im Erklaer-Popup vor ("Bracket 3 belegt 5,0 bis 6,9,
   * also 5,0 + 0,12 x 1,9"). Sie darf die Spanne dafuer nicht abschreiben - powerRange() ist die
   * eine Quelle, aus der auch powerLevel() rechnet. Dieser Test haelt beide zusammen.
   */
  it('meldet je Bracket genau die Spanne, aus der powerLevel() rechnet', () => {
    for (const bracket of [1, 2, 3, 4, 5] as const) {
      const [von, bis] = powerRange(bracket);
      expect(powerLevel(bracket, 0)).toBe(von);
      expect(powerLevel(bracket, 1)).toBe(bis);
    }
  });
});

describe('bracket - Anhebe-Schwelle', () => {
  /**
   * Der Erklaertext nennt die Schwelle als Prozentwert. Damit Text und Verhalten nicht wieder
   * auseinanderlaufen, klemmen diese Faelle die Schwelle von unten und von oben ein. Alle drei
   * Karten-Messgroessen stehen auf Anschlag (Karten-Tuning 1), ueber die Beständigkeit laesst sich
   * der gemeinsame Wert genau setzen: 0,6 × 1 + 0,4 × Beständigkeit.
   */
  const aufAnschlag = (consistency: number | null) =>
    basis({ tutorCount: 20, averageCmc: 1.5, untappedLandPercent: 100, consistency });

  it('hebt unterhalb der Schwelle nicht an', () => {
    // 0,6 × 1 + 0,4 × 0 = 0,6.
    const ergebnis = analyzeBracket(aufAnschlag(0));
    expect(ergebnis.verdicts.tuning).toBe(1);
    expect(ergebnis.verdicts.combined).toBeCloseTo(0.6, 10);
    expect(ergebnis.bracket).toBe(ergebnis.verdicts.rules);
    expect(ergebnis.reasons.some((r) => r.key === 'tuning')).toBe(false);
  });

  it('hebt oberhalb der Schwelle um genau eine Stufe an', () => {
    // 0,6 × 1 + 0,4 × 0,5 = 0,8.
    const ergebnis = analyzeBracket(aufAnschlag(0.5));
    expect(ergebnis.verdicts.combined).toBeGreaterThanOrEqual(TUNING_BUMP_SCHWELLE);
    expect(ergebnis.bracket).toBe(ergebnis.verdicts.rules + 1);
    expect(ergebnis.reasons.some((r) => r.key === 'tuning')).toBe(true);
  });

  it('nimmt ohne Beständigkeit allein das Karten-Tuning', () => {
    const ergebnis = analyzeBracket(aufAnschlag(null));
    expect(ergebnis.verdicts.consistency).toBeNull();
    expect(ergebnis.verdicts.combined).toBe(1);
  });

  it('hebt ein beständigeres Deck bei gleichen Karten höher in der Spanne', () => {
    const karten = { tutorCount: 2, averageCmc: 3, untappedLandPercent: 80 };
    const wackelig = analyzeBracket(basis({ ...karten, consistency: 0.2 }));
    const rund = analyzeBracket(basis({ ...karten, consistency: 0.9 }));
    expect(rund.bracket).toBe(wackelig.bracket);
    expect(rund.power).toBeGreaterThan(wackelig.power);
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
        untappedLandPercent: 95,
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
        untappedLandPercent: 95,
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
        untappedLandPercent: 100,
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
        untappedLandPercent: 100,
        tutorCount: 15,
      }),
    );
    expect(ergebnis.verdicts.tuning).toBeGreaterThanOrEqual(CEDH_TUNING_HINT);
    expect(ergebnis.suggestsCedh).toBe(true);
  });

  it('weist ein bloss ordentlich gebautes Bracket-4-Deck nicht als cEDH aus', () => {
    // Genau der Fall, der beim Pruefen in der laufenden App auffiel: fuenf Game Changer, sonst
    // unauffaellig. Tuning-Grad um 0,55 - das ist ein starkes Deck, aber kein Turnierdeck.
    const ergebnis = analyzeBracket(
      basis({
        cards: Array.from({ length: 5 }, (_, i) => karte(`GC${i}`, { gameChanger: true })),
        averageCmc: 2.8,
        untappedLandPercent: 82.5,
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

describe('bracket - Urteil E: Kartenwert', () => {
  it('erzwingt ab der Schwelle mindestens Bracket 3 und lässt darunter alles, wie es war', () => {
    expect(priceVerdict(PREIS_SCHWELLE_EUR - 0.01)).toBe(null);
    expect(priceVerdict(PREIS_SCHWELLE_EUR)).toBe(3);
    expect(priceVerdict(PREIS_SCHWELLE_EUR + 50)).toBe(3);
  });

  it('löst bei unbekanntem Preis nichts aus', () => {
    expect(priceVerdict(null)).toBe(null);
    expect(analyzeBracket(basis({ totalPrice: null })).bracket).toBe(2);
  });

  it('hebt ein unauffälliges 150-Euro-Deck von Bracket 2 auf 3', () => {
    const guenstig = analyzeBracket(basis({ totalPrice: 149.99 }));
    const teuer = analyzeBracket(basis({ totalPrice: 150 }));

    expect(guenstig.bracket).toBe(2);
    expect(teuer.bracket).toBe(3);
  });

  it('nennt den Preis als Befund, statt "nichts gefunden" zu behaupten', () => {
    const analyse = analyzeBracket(basis({ totalPrice: 188.42 }));

    expect(analyse.reasons.map((r) => r.key)).toEqual(['price']);
    expect(analyse.reasons[0].minimum).toBe(3);
    expect(analyse.verdicts.price).toBe(188.42);
  });

  it('lässt die anderen Befunde daneben stehen, statt sie zu verdrängen', () => {
    const analyse = analyzeBracket(
      basis({
        cards: [karte('Armageddon'), karte('Forest')],
        flags: flags({ Armageddon: { massLandDenial: true } }),
        totalPrice: 200,
      }),
    );

    expect(analyse.reasons.map((r) => r.key)).toEqual(['massLandDenial', 'price']);
    // Der Preis ist eine Untergrenze, keine Obergrenze - Bracket 4 aus Urteil A bleibt stehen.
    expect(analyse.bracket).toBe(4);
  });

  it('greift auch bei unveränderten Precons', () => {
    expect(analyzeBracket(basis({ isPrecon: true, totalPrice: 196.17 })).bracket).toBe(3);
  });

  it('lässt die Zeile "Offiziell" unberührt - der Preis ist kein offizielles Kriterium', () => {
    const analyse = analyzeBracket(basis({ totalPrice: 200, spellbookTag: 'E' }));

    expect(analyse.verdicts.rules).toBe(2);
    // Die Verlässlichkeitsangabe vergleicht weiter nur die beiden kartenbasierten Urteile.
    expect(analyse.confidence).toBe('high');
    expect(analyse.bracket).toBe(3);
  });
});

describe('Urteil F - Combo plus Tutoren', () => {
  // Der einzige Befund dieser Einstufung, der nicht aus dem Regelwerk stammt, sondern aus
  // gemessenen Decks: Wer eine spielbeendende Combo UND mindestens zwei Tutoren hat (Startwert,
  // siehe BracketBenchmark), liegt zu 93 % in Bracket 4 oder 5.

  const harmlos = (extra: Partial<BracketInput> = {}): BracketInput => basis(extra);

  it('hebt auf Bracket 4, wenn Combo und Tutoren zusammenkommen', () => {
    const ergebnis = analyzeBracket(harmlos({ winningCombos: 1, tutorCount: 2 }));
    expect(ergebnis.bracket).toBe(4);
    expect(ergebnis.reasons.map((r) => r.key)).toContain('comboAndTutors');
  });

  it('hebt NICHT an, wenn nur die Combo da ist', () => {
    // Das Regelwerk erlaubt in Bracket 2 ausdrücklich langsame Combos, und 9,9 % der
    // Bracket-2-Decks haben eine - allein sagt sie zu wenig.
    expect(analyzeBracket(harmlos({ winningCombos: 2, tutorCount: 1 })).bracket).toBe(2);
  });

  it('hebt NICHT an, wenn nur die Tutoren da sind', () => {
    expect(analyzeBracket(harmlos({ winningCombos: 0, tutorCount: 5 })).bracket).toBe(2);
  });

  it('verdrängt den Befund "nichts gefunden"', () => {
    const ergebnis = analyzeBracket(harmlos({ winningCombos: 1, tutorCount: 3 }));
    expect(ergebnis.reasons.map((r) => r.key)).not.toContain('nothing');
  });

  it('hebt nie über Bracket 4 - auch das bleibt eine Untergrenze', () => {
    const ergebnis = analyzeBracket(harmlos({ winningCombos: 9, tutorCount: 9 }));
    expect(ergebnis.bracket).toBe(4);
  });

  it('rechnet ohne die Zahl einfach weiter', () => {
    // 0 heisst "liegt nicht vor" - dann darf Urteil F nichts behaupten.
    expect(analyzeBracket(harmlos({ winningCombos: 0, tutorCount: 2 })).bracket).toBe(2);
  });

  it('nimmt die Tutorenschwelle aus dem gemessenen Benchmark', () => {
    const benchmark = { ...DEFAULT_BRACKET_BENCHMARK, comboTutorMin: 3 };
    expect(analyzeBracket(harmlos({ winningCombos: 1, tutorCount: 2, benchmark })).bracket).toBe(2);
    expect(analyzeBracket(harmlos({ winningCombos: 1, tutorCount: 3, benchmark })).bracket).toBe(4);
  });
});

describe('Gemessener Benchmark - Tuning-Spannen', () => {
  it('rechnet ohne Benchmark genau mit den Startwerten', () => {
    const ohne = tuningParts(basis({ tutorCount: 4 }));
    const mit = tuningParts(basis({ tutorCount: 4, benchmark: DEFAULT_BRACKET_BENCHMARK }));
    expect(mit).toEqual(ohne);
  });

  it('übernimmt die Spannen aus der Datenbank', () => {
    const benchmark = {
      ...DEFAULT_BRACKET_BENCHMARK,
      tuning: { ...DEFAULT_BRACKET_BENCHMARK.tuning, tutors: [1, 5] as [number, number] },
    };
    const teil = tuningParts(basis({ tutorCount: 3, benchmark })).find((t) => t.key === 'tutors');
    expect(teil).toMatchObject({ from: 1, to: 5, score: 0.5 });
  });
});

describe('bracketBenchmarkFromRows - Tabellenzeilen zu Schwellen', () => {
  const zeile = (bracket: number, werte: Partial<Record<string, number | null>> = {}) => ({
    bracket,
    tutor_density: null,
    avg_cmc: null,
    untapped_land_percent: null,
    game_changers: null,
    combo_tutor_min: null,
    ...werte,
  });

  it('liefert ohne Zeilen genau die Startwerte', () => {
    expect(bracketBenchmarkFromRows([])).toEqual(DEFAULT_BRACKET_BENCHMARK);
  });

  it('spannt von Bracket 2 bis Bracket 5 und nimmt Urteil F aus Bracket 4', () => {
    const b = bracketBenchmarkFromRows([
      zeile(2, { tutor_density: 1, avg_cmc: 3.2 }),
      zeile(4, { combo_tutor_min: 3 }),
      zeile(5, { tutor_density: 7, avg_cmc: 2.1 }),
    ]);
    expect(b.tuning.tutors).toEqual([1, 7]);
    expect(b.tuning.averageCmc).toEqual([3.2, 2.1]);
    expect(b.comboTutorMin).toBe(3);
  });

  it('fällt je Merkmal auf den Startwert zurück, wenn ein Ende fehlt oder beide gleich sind', () => {
    const b = bracketBenchmarkFromRows([
      zeile(2, { tutor_density: 2, game_changers: 1 }),
      zeile(5, { tutor_density: 2 }),
    ]);
    expect(b.tuning.tutors).toEqual(DEFAULT_BRACKET_BENCHMARK.tuning.tutors);
    expect(b.tuning.gameChangers).toEqual(DEFAULT_BRACKET_BENCHMARK.tuning.gameChangers);
  });

  it('nimmt gelernte Gewichte aus Bracket 4, fehlende bleiben Startwerte', () => {
    const b = bracketBenchmarkFromRows([
      zeile(4, { weight_tutors: 0.3, weight_game_changers: 0.35, weight_avg_cmc: null }),
    ]);
    expect(b.weights.tutors).toBe(0.3);
    expect(b.weights.gameChangers).toBe(0.35);
    expect(b.weights.averageCmc).toBe(DEFAULT_BRACKET_BENCHMARK.weights.averageCmc);
    expect(b.weights.untappedLands).toBe(DEFAULT_BRACKET_BENCHMARK.weights.untappedLands);
  });
});
