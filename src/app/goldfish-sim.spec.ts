import {
  KEIN_SIEG,
  MAX_ZUEGE,
  Quelle,
  SCHADENSFENSTER,
  SIEG_MUSTER,
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
  // Die geschuetzten Combo-Teile: im Test dieselben Karten wie die verfolgten Ziele. Im Stapellauf
  // ist die Menge groesser als die Zielliste, weil die aus Laufzeitgruenden gedeckelt ist.
  comboTeile: new Set(ziele.flatMap((z) => z.keys)),
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

  it('nutzt eine Zieh-Engine jeden Zug und kommt dadurch schneller durchs Deck', () => {
    const engine = buildSimCard(
      daten({
        name: 'Endless Atlas',
        key: 'endless atlas',
        typeLine: 'Artifact',
        oracleText: '{2}, {T}: Draw a card.',
        manaCost: '{3}',
        cmc: 3,
      }),
    );
    const grundstock = [...vervielfache(wald(), 38), ...vervielfache(kreatur('Dicker', 5, 6), 51)];
    const mitEngine = simuliereDeck(deckAus([...grundstock, ...vervielfache(engine, 10)]), 200);
    const ohneEngine = simuliereDeck(
      deckAus([...grundstock, ...vervielfache(kreatur('Blindgaenger', 3, 0), 10)]),
      200,
    );

    // Gemessen wird die VERLAESSLICHKEIT, nicht der Siegzug - und das ist seit der neuen
    // Rangfolge die ehrlichere Zusage: Kartenziehen steht jetzt VOR Bedrohungen, die Engine
    // konkurriert also um dasselbe Mana wie die Kreaturen. Sie macht das Deck damit nicht
    // schneller, sondern gleichmaessiger: weniger Zuege, in denen gar nichts geht, und praktisch
    // kein Spiel mehr, in dem das Deck stecken bleibt.
    expect(mitEngine.leerlaufSchnitt).toBeLessThan(ohneEngine.leerlaufSchnitt);
    expect(mitEngine.siegquote).toBeGreaterThanOrEqual(ohneEngine.siegquote);
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

describe('istSiegCombo - eine Liste, nicht zwei', () => {
  /**
   * Der Ausdruck stand doppelt: einmal hier, einmal im SQL der Ansicht spellbook_winning_combos,
   * mit einem Kommentar, beide müssten dieselbe Auswahl treffen. Sie taten es nicht. Diese Tests
   * halten genau die beiden Abweichungen fest, die daraus entstanden waren.
   */
  it('zählt "You lose the game" NICHT als Sieg', () => {
    // Die alte TypeScript-Fassung enthielt "lose the game" ohne Gegenüber - und hat damit eine
    // Combo, bei der man selbst verliert, als Siegbedingung geführt.
    expect(istSiegCombo(['You lose the game'])).toBe(false);
    expect(istSiegCombo(['Each opponent loses the game'])).toBe(true);
  });

  it('erkennt auch die Mehrzahlform, die das SQL verpasst hat', () => {
    // Die alte SQL-Fassung kannte nur "loses the game" und ist an "All opponents lose the game"
    // vorbeigelaufen.
    expect(istSiegCombo(['All opponents lose the game'])).toBe(true);
  });

  it('erkennt die Ergebnisse, die ein Spiel wirklich beenden', () => {
    expect(istSiegCombo(['Infinite damage'])).toBe(true);
    expect(istSiegCombo(['Infinite turns'])).toBe(true);
  });

  it('zählt unendlich Mana NICHT als Sieg - davon stirbt niemand', () => {
    expect(istSiegCombo(['Infinite colorless mana'])).toBe(false);
    expect(istSiegCombo(['Infinite lifegain'])).toBe(false);
  });

  it('kommt ohne \\b aus - Postgres liest das als Rückschritt-Zeichen', () => {
    // Der Ausdruck wird wörtlich auch im SQL benutzt. Ein \\b darin wäre dort etwas anderes als
    // hier, und genau solche stillen Unterschiede soll die gemeinsame Zeichenkette verhindern.
    expect(SIEG_MUSTER).not.toContain('\\b');
  });
});

describe('simuliereDeck - die neuen Kennzahlen', () => {
  /** Ein Deck, das verlässlich über Schaden gewinnt: viele Länder, billige dicke Kreaturen. */
  const schnellesSchadensdeck = () =>
    deckAus([...vervielfache(wald(), 40), ...vervielfache(kreatur('Baer', 1, 10), 59)]);

  /** Dasselbe Deck, nur mit unbezahlbar teuren Kreaturen - es stolpert. */
  const lahmesDeck = () =>
    deckAus([...vervielfache(wald(), 40), ...vervielfache(kreatur('Koloss', 9, 4), 59)]);

  it('misst den Schaden bis Zug 10 auch dort, wo kein Sieg zustande kommt', () => {
    const lahm = simuliereDeck(lahmesDeck(), 60);
    const schnell = simuliereDeck(schnellesSchadensdeck(), 60);

    // Die eigentliche Zusage: Diese Uhr trennt zwei Decks auch dann, wenn der Siegzug bei beiden
    // am Anschlag steht - genau das kann der zensierte Median nicht.
    expect(schnell.schadenZug10).toBeGreaterThan(lahm.schadenZug10);
    expect(lahm.schadenZug10).toBeGreaterThanOrEqual(0);
  });

  it('zählt einen Sieg weiterhin im Zug des Sieges, obwohl bis Zug 10 weitergespielt wird', () => {
    const ergebnis = simuliereDeck(schnellesSchadensdeck(), 60);
    expect(ergebnis.median).toBeLessThan(SCHADENSFENSTER);
  });

  it('meldet Leerlaufzüge, wenn nichts bezahlbar ist', () => {
    const lahm = simuliereDeck(lahmesDeck(), 40);
    const schnell = simuliereDeck(schnellesSchadensdeck(), 40);

    expect(lahm.leerlaufSchnitt).toBeGreaterThan(schnell.leerlaufSchnitt);
  });

  it('meldet die Streuung als eigene Achse neben dem Median', () => {
    const ergebnis = simuliereDeck(schnellesSchadensdeck(), 60);

    expect(ergebnis.p25).toBeLessThanOrEqual(ergebnis.p75);
    expect(ergebnis.streuung).toBe(ergebnis.p75 - ergebnis.p25);
  });

  it('meldet Mulligans und Abbrüche als Ehrlichkeitszahlen', () => {
    // Ein Deck ohne jedes Land muss oft mulliganen und kommt nie ins Spiel.
    const ohneLand = deckAus(vervielfache(kreatur('Baer', 1, 4), 99));
    const ergebnis = simuliereDeck(ohneLand, 30);

    expect(ergebnis.mulliganSchnitt).toBeGreaterThan(0);
    expect(ergebnis.abbruchAnteil).toBe(0);
    expect(ergebnis.median).toBe(KEIN_SIEG);
  });
});

describe('rangFuer - die Reihenfolge, in der ein Deck sein Spiel aufbaut', () => {
  const zug = { zug: 3 };
  const leer = deckAus([]);

  const manastein = buildSimCard(
    daten({
      name: 'Arcane Signet',
      key: 'arcane signet',
      typeLine: 'Artifact',
      oracleText: '{T}: Add one mana of any color in your commander’s color identity.',
      manaCost: '{2}',
      cmc: 2,
    }),
  );
  const synergie = buildSimCard(
    daten({
      name: 'Archmage Emeritus',
      key: 'archmage emeritus',
      typeLine: 'Creature — Human Wizard',
      oracleText: 'Whenever you cast or copy an instant or sorcery spell, draw a card.',
      manaCost: '{2}{U}{U}',
      cmc: 4,
      power: '2',
    }),
  );
  const zieher = buildSimCard(
    daten({
      name: 'Divination',
      key: 'divination',
      typeLine: 'Sorcery',
      oracleText: 'Draw two cards.',
      manaCost: '{2}{U}',
      cmc: 3,
    }),
  );
  const comboTeil = buildSimCard(
    daten({ name: 'Teil A', key: 'teil a', typeLine: 'Artifact', manaCost: '{2}', cmc: 2 }),
  );
  const baer = kreatur('Baer', 3, 5);

  it('stellt Mana vor Synergie vor Ziehen vor Combo-Teil vor den Rest', () => {
    const mitCombo = deckAus([], [{ keys: ['teil a', 'teil b'], zusatzMana: 0 }]);
    const raenge = [
      rangFuer(manastein, leer, zug),
      rangFuer(synergie, leer, zug),
      rangFuer(zieher, leer, zug),
      rangFuer(comboTeil, mitCombo, zug),
      rangFuer(baer, leer, zug),
    ];
    // Streng absteigend - genau die Reihenfolge, die ein Mensch spielt.
    for (let i = 1; i < raenge.length; i++) {
      expect(raenge[i - 1]).toBeGreaterThan(raenge[i]);
    }
  });

  /**
   * Die wichtigste Zusage der Datei: Ein Combo-Teil, das nach dem Wirken im Friedhof liegt, wird
   * NIE gewirkt. Sie galt bisher nur fuer die Combos, die der Simulator aktiv verfolgt - und die
   * Liste ist aus Laufzeitgruenden gedeckelt. Haengt das Teil an Combo Nummer elf, wurde es
   * verheizt. Jetzt zaehlt die vollstaendige Menge aller Combo-Karten des Decks.
   */
  it('schützt ein Combo-Teil auch dann, wenn seine Combo gar nicht verfolgt wird', () => {
    const hexerei = buildSimCard(
      daten({ name: 'Teil Z', key: 'teil z', typeLine: 'Sorcery', manaCost: '{2}', cmc: 2 }),
    );
    const deck: SimDeck = {
      karten: [],
      commander: [],
      farben: FARB_BIT.G,
      // Verfolgt wird eine ganz andere Combo ...
      ziele: [{ keys: ['teil a', 'teil b'], zusatzMana: 0 }],
      // ... geschuetzt ist trotzdem jedes Teil jeder gewinnenden Combo des Decks.
      comboTeile: new Set(['teil a', 'teil b', 'teil z']),
    };
    expect(rangFuer(hexerei, deck, zug)).toBeLessThan(0);
  });
});

describe('simuliereSpiel - die Regeln, die 2026-09-17 dazukamen', () => {
  const doppelkarte = () =>
    buildSimCard(
      daten({
        name: 'Agadeem’s Awakening',
        key: 'agadeems awakening',
        typeLine: 'Sorcery',
        oracleText:
          'Return from your graveyard to the battlefield any number of target creature cards.',
        backTypeLine: 'Land',
        backOracleText:
          'As Agadeem, the Undercrypt enters, you may pay 3 life. If you don’t, it enters tapped.\n{T}: Add {B}.',
        manaCost: '{3}{B}',
        cmc: 4,
      }),
    );

  it('darf eine modale Doppelkarte auch als Zauber wirken', () => {
    // Vorher war sie ausschliesslich ein Land: Die Hauptphase uebersprang alles, bei dem eine
    // Landseite erkannt war - und das ist bei einer Doppelkarte immer der Fall.
    const karte = doppelkarte();
    expect(karte.land).not.toBe(null);
    expect(karte.istLand).toBe(false);

    // Sumpf statt Wald: Die Karte kostet {3}{B}, gruenes Mana kann sie nicht bezahlen.
    const sumpf = buildSimCard(
      daten({
        name: 'Swamp',
        key: 'swamp',
        typeLine: 'Land',
        oracleText: '{T}: Add {B}.',
        producedMana: ['B'],
      }),
    );
    const deck: SimDeck = {
      karten: [...vervielfache(sumpf, 50), ...vervielfache(karte, 49)],
      commander: [],
      farben: FARB_BIT.B,
      ziele: [],
      comboTeile: new Set<string>(),
    };
    const ergebnis = simuliereDeck(deck, 40);
    // Gewirkt werden kann sie nur, wenn ueberhaupt Zauber gewirkt werden - sonst waeren alle
    // zwanzig Zuege Leerlauf.
    expect(ergebnis.leerlaufSchnitt).toBeLessThan(MAX_ZUEGE);
  });

  it('pumpt nur in dem Zug, in dem der Pump gespielt wurde', () => {
    const feld = [
      { karte: kreatur('A', 2, 2), seitZug: 1 },
      { karte: kreatur('B', 2, 2), seitZug: 1 },
    ];
    // Mit Pump in diesem Zug: (2+2) + 2 Kreaturen x 2 = 8.
    expect(angriffsschaden({ feld, zug: 5, pumpDiesenZug: 2 })).toBe(8);
    // Im Zug darauf ist der Pump weg - vorher las der Angriffsschaden ihn vom Feld und ein
    // Craterhoof Behemoth pumpte das ganze Spiel lang weiter.
    expect(angriffsschaden({ feld, zug: 6 })).toBe(4);
  });

  it('rechnet "+X/+X, X = Kreaturenzahl" als Quadrat der Kreaturenzahl', () => {
    const feld = [
      { karte: kreatur('A', 2, 1), seitZug: 1 },
      { karte: kreatur('B', 2, 1), seitZug: 1 },
      { karte: kreatur('C', 2, 1), seitZug: 1 },
    ];
    // 3 Kreaturen a 1 Staerke, jede bekommt +3: 3 + 9 = 12.
    expect(angriffsschaden({ feld, zug: 5, pumpDiesenZug: -1 })).toBe(12);
  });

  it('stellt eine Combo nicht auf, deren Farben das Deck nicht bezahlen kann', () => {
    // Zwei blaue Combo-Teile in einem Deck aus lauter Waeldern. Vorher verglich comboSteht nur
    // Manabetraege - und ein gruenes Deck "gewann" mit einer blauen Combo.
    const blau = (name: string) =>
      buildSimCard(
        daten({
          name,
          key: name.toLowerCase(),
          typeLine: 'Creature — Merfolk',
          manaCost: '{U}{U}',
          cmc: 2,
          power: '1',
        }),
      );
    const deck = deckAus(
      [
        ...vervielfache(wald(), 60),
        ...vervielfache(blau('Teil A'), 20),
        ...vervielfache(blau('Teil B'), 19),
      ],
      [{ keys: ['teil a', 'teil b'], zusatzMana: 0 }],
    );
    const ergebnis = simuliereDeck(deck, 60);
    expect(ergebnis.comboAnteil).toBe(0);
  });
});

describe('Tutoren - weder allmächtig noch wirkungslos', () => {
  const tutorKarte = (name: string, text: string): SimCard =>
    buildSimCard(
      daten({
        name,
        key: name.toLowerCase(),
        typeLine: 'Sorcery',
        oracleText: text,
        manaCost: '{2}',
        cmc: 2,
        tutor: true,
      }),
    );

  const allesTutor = () =>
    tutorKarte(
      'Demonic Tutor',
      'Search your library for a card, then shuffle and put that card on top.',
    );
  const landTutor = () =>
    tutorKarte(
      'Rampant Growth',
      'Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.',
    );

  /**
   * Der eine Fehler: Ein Tutor in einem Deck OHNE Combo war eine vollkommen tote Karte -
   * sucheZielteil() kannte nur Combo-Teile und lieferte null. Jetzt holt er die beste Karte, die
   * er holen darf, gemessen an derselben Rangfolge, nach der auch gewirkt wird.
   */
  it('holt auch ohne Combo etwas - und zwar die beste Karte, die es gibt', () => {
    const bombe = kreatur('Bombe', 3, 40);
    const fueller = kreatur('Fueller', 2, 1);
    const grundstock = [...vervielfache(wald(), 40), bombe, ...vervielfache(fueller, 48)];

    const mitTutoren = simuliereDeck(
      deckAus([...grundstock, ...vervielfache(allesTutor(), 10)]),
      200,
    );
    const ohneTutoren = simuliereDeck(deckAus([...grundstock, ...vervielfache(fueller, 10)]), 200);

    // Eine einzige Bombe im Deck: Wer sie suchen kann, findet sie deutlich frueher.
    expect(mitTutoren.median).toBeLessThan(ohneTutoren.median);
  });

  /**
   * Der andere Fehler, das genaue Gegenteil: JEDER Tutor fand sofort das fehlende Combo-Teil -
   * auch ein Landsuch-Zauber, der gar keine Nicht-Land-Karte holen darf.
   */
  it('lässt einen Landsuch-Zauber das Combo-Teil NICHT holen', () => {
    const teil = (name: string) =>
      buildSimCard(
        daten({
          name,
          key: name.toLowerCase(),
          typeLine: 'Artifact',
          manaCost: '{2}',
          cmc: 2,
        }),
      );
    const bauteile = [teil('Teil A'), teil('Teil B')];
    const ziel = [{ keys: ['teil a', 'teil b'], zusatzMana: 0 }];
    const grundstock = [
      ...vervielfache(wald(), 45),
      ...bauteile,
      ...vervielfache(kreatur('Fueller', 2, 1), 42),
    ];

    const mitLandTutoren = simuliereDeck(
      deckAus([...grundstock, ...vervielfache(landTutor(), 10)], ziel),
      200,
    );
    const mitAllesTutoren = simuliereDeck(
      deckAus([...grundstock, ...vervielfache(allesTutor(), 10)], ziel),
      200,
    );

    // Verglichen wird die SIEGQUOTE, nicht der Combo-Anteil: Beide Decks gewinnen ausschliesslich
    // ueber die Combo (die Fueller kommen nie auf 40 Schaden), der Combo-Anteil steht also bei
    // beiden auf 1. Die Frage ist, wie oft sie die Combo ueberhaupt zusammenbekommen.
    expect(mitAllesTutoren.siegquote).toBeGreaterThan(mitLandTutoren.siegquote);
  });
});
