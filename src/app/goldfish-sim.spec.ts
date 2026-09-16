import {
  KEIN_SIEG,
  MAX_ZUEGE,
  Quelle,
  SimDeck,
  angriffsschaden,
  istSiegCombo,
  kannZahlen,
  perzentil,
  rangFuer,
  rngAus,
  simuliereDeck,
  simuliereSpiel,
  zahle,
} from './goldfish-sim';
import {
  ALLE_FARBEN,
  FARB_BIT,
  SimCard,
  SimCardData,
  buildSimCard,
  parseCost,
} from './sim-card-profile';

/**
 * Der Simulator hat keine "richtige" Antwort, gegen die sich prüfen ließe - es gibt keine Liste,
 * in welchem Zug ein Deck gewinnt. Prüfbar ist stattdessen zweierlei, und beides steht hier:
 *
 *   1. Die Bausteine einzeln. Zahlt die Manarechnung richtig? Greift die Einsatzverzögerung?
 *   2. Die RICHTUNG im Ganzen. Ein schnelles Deck muss früher gewinnen als ein langsames, ein
 *      Deck aus 99 Ländern nie. Das sind die Aussagen, auf denen die ganze spätere Auswertung
 *      ruht: Wenn der Simulator diese Richtungen nicht trifft, sagt keine Zahl aus ihm etwas aus.
 */

const daten = (extra: Partial<SimCardData>): SimCardData => ({
  name: 'Testkarte',
  key: 'testkarte',
  typeLine: null,
  oracleText: null,
  backTypeLine: null,
  backOracleText: null,
  manaCost: null,
  cmc: 0,
  producedMana: null,
  power: null,
  keywords: [],
  gameChanger: false,
  tutor: false,
  ...extra,
});

const wald = (): SimCard =>
  buildSimCard(
    daten({
      name: 'Forest',
      key: 'forest',
      typeLine: 'Land',
      oracleText: '{T}: Add {G}.',
      producedMana: ['G'],
    }),
  );

/** Eine schlichte Kreatur: generische Kosten, damit jedes Land sie bezahlen kann. */
const kreatur = (name: string, cmc: number, staerke: number): SimCard =>
  buildSimCard(
    daten({
      name,
      key: name.toLowerCase(),
      typeLine: 'Creature — Bear',
      manaCost: `{${cmc}}`,
      cmc,
      power: String(staerke),
    }),
  );

const vervielfache = (karte: SimCard, n: number): SimCard[] =>
  Array.from({ length: n }, () => karte);

const deckAus = (karten: SimCard[], ziele: SimDeck['ziele'] = []): SimDeck => ({
  karten,
  commander: [],
  farben: FARB_BIT.G,
  ziele,
});

const quelle = (farben: number, menge = 1): Quelle => ({ farben, menge });

describe('rngAus', () => {
  it('liefert bei gleichem Startwert dieselbe Folge', () => {
    const a = rngAus(42);
    const b = rngAus(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('liefert bei verschiedenen Startwerten verschiedene Folgen', () => {
    expect(rngAus(1)()).not.toBe(rngAus(2)());
  });
});

describe('zahle', () => {
  it('bezahlt generische Kosten aus beliebigen Quellen', () => {
    const vorrat = [quelle(FARB_BIT.G), quelle(FARB_BIT.U)];
    expect(zahle(parseCost('{2}'), vorrat)).toBe(true);
    expect(vorrat.every((q) => q.menge === 0)).toBe(true);
  });

  it('verweigert einen farbigen Pip ohne passende Quelle', () => {
    expect(zahle(parseCost('{U}'), [quelle(FARB_BIT.G), quelle(FARB_BIT.G)])).toBe(false);
  });

  it('lässt den Vorrat unangetastet, wenn es nicht reicht', () => {
    const vorrat = [quelle(FARB_BIT.G), quelle(FARB_BIT.G)];
    expect(zahle(parseCost('{2}{U}'), vorrat)).toBe(false);
    expect(vorrat.map((q) => q.menge)).toEqual([1, 1]);
  });

  it('bezahlt den Pip aus der unflexibelsten Quelle, damit das Restgeld noch passt', () => {
    // Ein Wald und ein Land beliebiger Farbe, Kosten {1}{G}: Würde der Wald das generische Mana
    // zahlen, stünde der grüne Pip ohne Quelle da - obwohl das Deck bezahlen könnte.
    expect(zahle(parseCost('{1}{G}'), [quelle(FARB_BIT.G), quelle(ALLE_FARBEN)])).toBe(true);
  });

  it('kannZahlen prüft, ohne zu verbrauchen', () => {
    const vorrat = [quelle(FARB_BIT.G, 3)];
    expect(kannZahlen(parseCost('{2}'), vorrat)).toBe(true);
    expect(vorrat[0].menge).toBe(3);
  });

  it('bezahlt einen Sol Ring aus zwei farblosen Mana einer einzigen Quelle', () => {
    expect(zahle(parseCost('{2}'), [quelle(FARB_BIT.C, 2)])).toBe(true);
  });
});

describe('perzentil', () => {
  it('nimmt Spiele ohne Sieg als KEIN_SIEG in die Reihe auf', () => {
    // Zwei schnelle Siege, acht Spiele ohne - der Median gehört zu den Nicht-Siegen.
    const werte = [3, 4, ...Array(8).fill(KEIN_SIEG)];
    expect(perzentil(werte, 0.5)).toBe(KEIN_SIEG);
    expect(perzentil(werte, 0.1)).toBe(3);
  });
});

describe('istSiegCombo', () => {
  it('erkennt Ergebnisse, die ein Spiel beenden', () => {
    expect(istSiegCombo(['Infinite damage'])).toBe(true);
    expect(istSiegCombo(['Each opponent loses the game'])).toBe(true);
  });

  it('zählt unendlich Mana NICHT als Sieg - davon stirbt niemand', () => {
    expect(istSiegCombo(['Infinite colorless mana'])).toBe(false);
    expect(istSiegCombo(['Infinite lifegain'])).toBe(false);
  });
});

describe('angriffsschaden', () => {
  const stand = (feld: { karte: SimCard; seitZug: number }[], zug: number) => ({ feld, zug });

  it('lässt eine frisch gespielte Kreatur nicht angreifen', () => {
    expect(angriffsschaden(stand([{ karte: kreatur('Baer', 2, 5), seitZug: 4 }], 4))).toBe(0);
  });

  it('lässt sie im Zug darauf angreifen', () => {
    expect(angriffsschaden(stand([{ karte: kreatur('Baer', 2, 5), seitZug: 4 }], 5))).toBe(5);
  });

  it('rechnet ein Anthem auf jede angreifende Kreatur', () => {
    const anthem = buildSimCard(
      daten({
        name: 'Glorious Anthem',
        key: 'glorious anthem',
        typeLine: 'Enchantment',
        oracleText: 'Creatures you control get +1/+1.',
        manaCost: '{1}{W}{W}',
        cmc: 3,
      }),
    );
    const feld = [
      { karte: kreatur('A', 2, 2), seitZug: 1 },
      { karte: kreatur('B', 2, 2), seitZug: 1 },
      { karte: anthem, seitZug: 1 },
    ];
    expect(angriffsschaden(stand(feld, 5))).toBe(6);
  });
});

describe('rangFuer', () => {
  const ziel = [{ keys: ['teil a', 'teil b'], zusatzMana: 0 }];
  const zug = { zug: 3 };

  it('wirkt ein bleibendes Combo-Teil sofort - es steht danach auf dem Feld', () => {
    const teil = buildSimCard(
      daten({ name: 'Teil A', key: 'teil a', typeLine: 'Artifact', manaCost: '{2}', cmc: 2 }),
    );
    expect(rangFuer(teil, deckAus([], ziel), zug)).toBeGreaterThan(0);
  });

  it('wirkt ein Combo-Teil NICHT, das nach dem Wirken weg wäre', () => {
    // Eine Hexerei als Combo-Teil ohne Gegenstück zu wirken hiesse, sich die eigene Combo zu
    // zerlegen: Die Karte ist danach im Friedhof und kommt nie wieder.
    const teil = buildSimCard(
      daten({ name: 'Teil B', key: 'teil b', typeLine: 'Sorcery', manaCost: '{2}', cmc: 2 }),
    );
    expect(rangFuer(teil, deckAus([], ziel), zug)).toBeLessThan(0);
  });

  it('wirkt dieselbe Hexerei sehr wohl, wenn sie gar kein Combo-Teil ist', () => {
    const egal = buildSimCard(
      daten({ name: 'Egal', key: 'egal', typeLine: 'Sorcery', manaCost: '{2}', cmc: 2 }),
    );
    expect(rangFuer(egal, deckAus([], ziel), zug)).toBeGreaterThan(0);
  });
});

describe('simuliereSpiel', () => {
  it('gewinnt mit 99 Ländern nie', () => {
    const ergebnis = simuliereDeck(deckAus(vervielfache(wald(), 99)), 20);
    expect(ergebnis.siegquote).toBe(0);
    expect(ergebnis.median).toBe(KEIN_SIEG);
  });

  it('liefert bei gleichem Startwert dasselbe Spiel', () => {
    const deck = deckAus([...vervielfache(wald(), 40), ...vervielfache(kreatur('Baer', 3, 6), 59)]);
    expect(simuliereSpiel(deck, 7)).toEqual(simuliereSpiel(deck, 7));
  });

  it('lässt ein schnelles Deck früher gewinnen als ein langsames', () => {
    const schnell = deckAus([
      ...vervielfache(wald(), 36),
      ...vervielfache(kreatur('Schnell', 1, 5), 63),
    ]);
    const langsam = deckAus([
      ...vervielfache(wald(), 36),
      ...vervielfache(kreatur('Langsam', 6, 3), 63),
    ]);

    const a = simuliereDeck(schnell, 50);
    const b = simuliereDeck(langsam, 50);
    expect(a.median).toBeLessThan(b.median);
    expect(a.siegquote).toBeGreaterThan(0);
  });

  it('gewinnt über eine Combo, sobald beide Teile zusammenkommen', () => {
    const teilA = kreatur('Teil A', 2, 0);
    const teilB = kreatur('Teil B', 2, 0);
    const ziel = [{ keys: ['teil a', 'teil b'], zusatzMana: 0 }];
    const karten = [
      ...vervielfache(wald(), 40),
      ...vervielfache(teilA, 5),
      ...vervielfache(teilB, 5),
      ...vervielfache(kreatur('Fuellung', 4, 1), 49),
    ];

    const mitZiel = simuliereDeck(deckAus(karten, ziel), 50);
    const ohneZiel = simuliereDeck(deckAus(karten), 50);

    expect(mitZiel.comboAnteil).toBe(1);
    expect(mitZiel.median).toBeLessThan(MAX_ZUEGE);
    // Dieselben Karten ohne gewinnende Combo gewinnen deutlich später oder gar nicht.
    expect(ohneZiel.median).toBeGreaterThan(mitZiel.median);
  });

  it('hebt das Mana für eine bereits vollständige Combo auf', () => {
    // Beide Teile sind Hexereien und liegen im Deck reichlich vor; das Deck hat daneben nur
    // billige Kreaturen, in die es sein Mana sonst stecken würde.
    const teilA = buildSimCard(
      daten({ name: 'Teil A', key: 'teil a', typeLine: 'Sorcery', manaCost: '{1}', cmc: 1 }),
    );
    const teilB = buildSimCard(
      daten({ name: 'Teil B', key: 'teil b', typeLine: 'Sorcery', manaCost: '{1}', cmc: 1 }),
    );
    const deck = deckAus(
      [
        ...vervielfache(wald(), 40),
        ...vervielfache(teilA, 10),
        ...vervielfache(teilB, 10),
        ...vervielfache(kreatur('Koeder', 1, 1), 39),
      ],
      [{ keys: ['teil a', 'teil b'], zusatzMana: 0 }],
    );

    const ergebnis = simuliereDeck(deck, 100);
    expect(ergebnis.median).toBeLessThanOrEqual(6);
  });

  it('macht ein Deck mit Manasteinen schneller als dasselbe Deck ohne', () => {
    const solRing = buildSimCard(
      daten({
        name: 'Sol Ring',
        key: 'sol ring',
        typeLine: 'Artifact',
        oracleText: '{T}: Add {C}{C}.',
        manaCost: '{1}',
        cmc: 1,
        producedMana: ['C'],
      }),
    );
    const grundstock = [...vervielfache(wald(), 36), ...vervielfache(kreatur('Dicker', 5, 7), 53)];
    const mitRampe = simuliereDeck(deckAus([...grundstock, ...vervielfache(solRing, 10)]), 50);
    const ohneRampe = simuliereDeck(
      deckAus([...grundstock, ...vervielfache(kreatur('Blindgaenger', 1, 0), 10)]),
      50,
    );
    expect(mitRampe.manaZug5).toBeGreaterThan(ohneRampe.manaZug5);
    expect(mitRampe.median).toBeLessThanOrEqual(ohneRampe.median);
  });
});
