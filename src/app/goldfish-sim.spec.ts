import type { MetricCard, MetricCombo, MetricInput } from './deck-metrics';
import { MAX_ZUEGE, rng, simulateGoldfish } from './goldfish-sim';

/**
 * Was hier geprüft wird, ist nicht "die Zahl stimmt" - eine Simulation hat keine richtige Zahl.
 * Geprüft wird, dass sie sich an die Regeln hält, die im Kopfkommentar von goldfish-sim.ts stehen
 * (R1-R11, Wortlaut in docs/mtg-regeln.md), und dass die Aussagen tragen, auf die der Bericht sich
 * stützt: reproduzierbar, ohne Siegweg kein Sieg, und ein schnelleres Deck gewinnt messbar früher.
 *
 * Jeder Regelfall ist so gebaut, dass er NUR an dieser einen Regel scheitern kann - dasselbe Deck
 * einmal mit und einmal ohne die Eigenschaft, um die es geht.
 */

const karte = (name: string, extra: Partial<MetricCard> = {}): MetricCard => ({
  name,
  key: name.toLowerCase(),
  quantity: 1,
  cmc: 2,
  manaCost: '{2}',
  typeLine: 'Artifact',
  oracleText: '',
  producedMana: [],
  gameChanger: false,
  isCommander: false,
  ...extra,
});

const insel = (n: number) =>
  karte('Island', {
    cmc: 0,
    manaCost: '',
    typeLine: 'Basic Land — Island',
    oracleText: '({T}: Add {U}.)',
    producedMana: ['U'],
    quantity: n,
  });

const wald = (n: number) =>
  karte('Forest', {
    cmc: 0,
    manaCost: '',
    typeLine: 'Basic Land — Forest',
    oracleText: '({T}: Add {G}.)',
    producedMana: ['G'],
    quantity: n,
  });

/** Füllmaterial ohne Funktion - hält die Deckgröße bei 99, damit die Ziehwahrscheinlichkeiten stimmen. */
const fueller = (n: number) => karte('Filler', { cmc: 3, manaCost: '{3}', quantity: n });

const combo = (cards: string[], extra: Partial<MetricCombo> = {}): MetricCombo => ({
  id: cards.join('-'),
  cards: cards.map((c) => c.toLowerCase()),
  mustBeCommander: [],
  manaValueNeeded: 0,
  produces: ['Win the game'],
  ...extra,
});

const eingabe = (
  cards: MetricCard[],
  combos: MetricCombo[] = [],
  flags: MetricInput['flags'] = new Map(),
): MetricInput => ({ cards, combos, flags, effects: new Map() });

describe('goldfish-sim - Zufallsgenerator', () => {
  it('liefert zum selben Startwert dieselbe Folge', () => {
    const a = rng(42);
    const b = rng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('goldfish-sim - Grundaussagen', () => {
  it('gewinnt nie ohne gewinnende Combo im Deck', () => {
    const ergebnis = simulateGoldfish(eingabe([insel(38), fueller(61)]), 200);
    expect(ergebnis.winRate).toBe(0);
    expect(ergebnis.medianWinTurn).toBeNull();
  });

  it('wertet unendliches Mana nicht als Sieg', () => {
    // Dieselbe Combo, nur ein anderes Ergebnis - ohne etwas, das das Mana umsetzt, ist es kein Sieg.
    const deck = [
      insel(38),
      karte('A', { cmc: 1, manaCost: '{U}', quantity: 10 }),
      karte('B', { cmc: 1, manaCost: '{U}', quantity: 10 }),
      fueller(41),
    ];
    const mana = simulateGoldfish(
      eingabe(deck, [combo(['A', 'B'], { produces: ['Infinite mana'] })]),
      200,
    );
    const sieg = simulateGoldfish(
      eingabe(deck, [combo(['A', 'B'], { produces: ['Infinite damage'] })]),
      200,
    );

    expect(mana.winRate).toBe(0);
    expect(sieg.winRate).toBeGreaterThan(0);
  });

  it('ist reproduzierbar - gleicher Startwert, gleiches Ergebnis', () => {
    const deck = eingabe(
      [
        insel(38),
        karte('A', { cmc: 1, manaCost: '{U}', quantity: 8 }),
        karte('B', { cmc: 2, manaCost: '{1}{U}', quantity: 8 }),
        fueller(45),
      ],
      [combo(['A', 'B'])],
    );
    expect(simulateGoldfish(deck, 300, 7)).toEqual(simulateGoldfish(deck, 300, 7));
  });

  it('gewinnt mit billiger Combo früher als mit teurer', () => {
    const bauen = (kosten: number) =>
      eingabe(
        [
          insel(38),
          karte('A', { cmc: kosten, manaCost: `{${kosten}}`, quantity: 8 }),
          karte('B', { cmc: kosten, manaCost: `{${kosten}}`, quantity: 8 }),
          fueller(45),
        ],
        [combo(['A', 'B'])],
      );

    const schnell = simulateGoldfish(bauen(1), 500, 3);
    const langsam = simulateGoldfish(bauen(5), 500, 3);

    expect(schnell.winByTurn4).toBeGreaterThan(langsam.winByTurn4);
    expect(schnell.medianWinTurn).toBeLessThan(langsam.medianWinTurn ?? 99);
  });

  it('gewinnt nie nach dem Abbruchzug (H6)', () => {
    const deck = eingabe(
      [
        insel(38),
        karte('A', { cmc: 1, manaCost: '{U}', quantity: 8 }),
        karte('B', { cmc: 1, manaCost: '{U}', quantity: 8 }),
        fueller(45),
      ],
      [combo(['A', 'B'])],
    );
    expect(simulateGoldfish(deck, 300, 2).medianWinTurn ?? 0).toBeLessThanOrEqual(MAX_ZUEGE);
  });

  it('rechnet den Commander aus der Kommandozone mit, statt ihn zu ziehen (CR 903.8)', () => {
    const deck = eingabe(
      [
        insel(38),
        karte('Kinnan', { cmc: 2, manaCost: '{1}{U}', isCommander: true }),
        karte('Basalt', { cmc: 3, manaCost: '{3}', quantity: 8 }),
        fueller(52),
      ],
      [combo(['Kinnan', 'Basalt'], { mustBeCommander: ['kinnan'] })],
    );

    expect(simulateGoldfish(deck, 300, 5).winRate).toBeGreaterThan(0.5);
  });
});

describe('goldfish-sim - die Regeln, nach denen sie spielt', () => {
  /** Dasselbe Deck, nur die Farbe der Combo-Teile unterscheidet sich. */
  const farbdeck = (comboKosten: string) =>
    eingabe(
      [
        insel(38),
        karte('A', { cmc: 2, manaCost: comboKosten, quantity: 10 }),
        karte('B', { cmc: 2, manaCost: comboKosten, quantity: 10 }),
        fueller(41),
      ],
      [combo(['A', 'B'])],
    );

  it('R8 - bezahlt farbige Kosten nur mit der passenden Farbe', () => {
    // 38 Inseln: {1}{U} geht, {1}{G} in einem blauen Deck nie.
    expect(simulateGoldfish(farbdeck('{1}{U}'), 300, 4).winRate).toBeGreaterThan(0);
    expect(simulateGoldfish(farbdeck('{1}{G}'), 300, 4).winRate).toBe(0);
  });

  it('R8 - Hybrid lässt sich mit jeder seiner beiden Farben bezahlen', () => {
    expect(simulateGoldfish(farbdeck('{1}{G/U}'), 300, 4).winRate).toBeGreaterThan(0);
  });

  it('R8 - Phyrexia lässt sich mit Leben bezahlen, auch in der falschen Farbe', () => {
    expect(simulateGoldfish(farbdeck('{1}{G/P}'), 300, 4).winRate).toBeGreaterThan(0);
  });

  it('R7 - eine Manakreatur liefert im Zug ihres Ausspielens nichts, ein Artefakt schon', () => {
    // Beide kosten 1 und liefern 2. Nur das Artefakt kann damit im selben Zug die Combo bezahlen.
    const bauen = (typeLine: string) =>
      eingabe(
        [
          wald(20),
          insel(18),
          karte('Ring', {
            cmc: 1,
            manaCost: '{1}',
            typeLine,
            oracleText: '{T}: Add {C}{C}.',
            producedMana: ['C'],
            quantity: 10,
          }),
          karte('A', { cmc: 4, manaCost: '{4}', quantity: 10 }),
          fueller(41),
        ],
        [combo(['A'])],
      );

    const artefakt = simulateGoldfish(bauen('Artifact'), 400, 6);
    const kreatur = simulateGoldfish(bauen('Creature — Elf Druid'), 400, 6);
    expect(artefakt.winByTurn3).toBeGreaterThan(kreatur.winByTurn3);
  });

  it('R6 - ein Land, das getappt kommt, liefert in diesem Zug kein Mana', () => {
    const bauen = (oracleText: string) =>
      eingabe(
        [
          karte('Tor', {
            cmc: 0,
            manaCost: '',
            typeLine: 'Land',
            oracleText,
            producedMana: ['U'],
            quantity: 38,
          }),
          karte('A', { cmc: 3, manaCost: '{2}{U}', quantity: 10 }),
          fueller(51),
        ],
        [combo(['A'])],
      );

    // Drei Mana: ungetappt steht das in Zug 3, getappt erst in Zug 4 - das eine Land, das in
    // diesem Zug dazukommt, liefert noch nichts.
    const ungetappt = simulateGoldfish(bauen('{T}: Add {U}.'), 400, 8);
    const getappt = simulateGoldfish(bauen('This land enters tapped. {T}: Add {U}.'), 400, 8);
    expect(ungetappt.winByTurn3).toBeGreaterThan(getappt.winByTurn3);
  });

  it('R5 - nur ein Land je Zug', () => {
    // Die Combo braucht 8 Mana aus reinen Ländern: vor Zug 8 kann sie nicht stehen.
    const deck = eingabe(
      [insel(50), karte('A', { cmc: 8, manaCost: '{8}', quantity: 10 }), fueller(39)],
      [combo(['A'])],
    );
    expect(simulateGoldfish(deck, 300, 9).winByTurn5).toBe(0);
  });

  it('R10 - Kartenziehen bringt die fehlenden Teile schneller auf die Hand', () => {
    // Dieselbe Karte, einmal mit Ziehtext und einmal ohne - sonst identisch.
    const bauen = (oracleText: string) =>
      eingabe(
        [
          insel(38),
          karte('Ritus', {
            cmc: 1,
            manaCost: '{U}',
            typeLine: 'Sorcery',
            oracleText,
            quantity: 20,
          }),
          karte('A', { cmc: 2, manaCost: '{1}{U}', quantity: 4 }),
          karte('B', { cmc: 2, manaCost: '{1}{U}', quantity: 4 }),
          fueller(33),
        ],
        [combo(['A', 'B'])],
      );

    const mitZiehen = simulateGoldfish(bauen('Draw three cards.'), 500, 11);
    const ohne = simulateGoldfish(bauen('Target creature gets +1/+1.'), 500, 11);
    expect(mitZiehen.winRate).toBeGreaterThan(ohne.winRate);
  });

  it('CR 903.8 - der Commander wird gewirkt, wenn er selbst Mana macht', () => {
    // Derselbe Commander, einmal mit und einmal ohne Manafähigkeit. Die Combo kostet 6; mit den
    // drei Mana aus der Kommandozone steht das deutlich früher.
    const bauen = (producedMana: string[], oracleText: string) =>
      eingabe(
        [
          insel(38),
          karte('Quelle', {
            cmc: 2,
            manaCost: '{1}{U}',
            typeLine: 'Legendary Artifact',
            oracleText,
            producedMana,
            isCommander: true,
          }),
          karte('A', { cmc: 6, manaCost: '{6}', quantity: 10 }),
          fueller(51),
        ],
        [combo(['A'])],
      );

    const mitMana = simulateGoldfish(bauen(['C'], '{T}: Add {C}{C}{C}.'), 400, 13);
    const ohne = simulateGoldfish(bauen([], 'Flying.'), 400, 13);
    expect(mitMana.winByTurn5).toBeGreaterThan(ohne.winByTurn5);
  });

  it('H4 - ein Tutor holt das eine fehlende Teil', () => {
    const teile = [
      insel(38),
      karte('A', { cmc: 1, manaCost: '{U}', quantity: 1 }),
      karte('B', { cmc: 1, manaCost: '{U}', quantity: 1 }),
      karte('Tutor', { cmc: 1, manaCost: '{U}', quantity: 20 }),
      fueller(39),
    ];
    const mitTutor = simulateGoldfish(
      eingabe(
        teile,
        [combo(['A', 'B'])],
        new Map([['tutor', { tutor: true, massLandDenial: false, extraTurn: false }]]),
      ),
      500,
      12,
    );
    const ohne = simulateGoldfish(eingabe(teile, [combo(['A', 'B'])]), 500, 12);
    expect(mitTutor.winRate).toBeGreaterThan(ohne.winRate);
  });
});
