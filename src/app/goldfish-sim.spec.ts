import type { MetricCard, MetricCombo, MetricInput } from './deck-metrics';
import { rng, simulateGoldfish } from './goldfish-sim';

/**
 * Was hier geprüft wird, ist nicht "die Zahl stimmt" - eine Simulation hat keine richtige Zahl.
 * Geprüft wird, dass sie sich an ihre eigenen Annahmen hält (goldfish-sim.ts, Kopfkommentar) und
 * dass die Aussagen, auf die der Bericht sich stützt, tatsächlich tragen: reproduzierbar, ohne
 * Siegweg kein Sieg, und ein schnelleres Deck gewinnt messbar früher als ein langsames.
 */

const karte = (name: string, extra: Partial<MetricCard> = {}): MetricCard => ({
  name,
  key: name.toLowerCase(),
  quantity: 1,
  cmc: 2,
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
    typeLine: 'Basic Land — Island',
    oracleText: '({T}: Add {U}.)',
    quantity: n,
  });

/** Füllmaterial ohne Funktion - hält die Deckgröße bei 99, damit die Ziehwahrscheinlichkeiten stimmen. */
const fueller = (n: number) => karte('Filler', { cmc: 3, quantity: n });

const combo = (cards: string[], extra: Partial<MetricCombo> = {}): MetricCombo => ({
  id: cards.join('-'),
  cards: cards.map((c) => c.toLowerCase()),
  mustBeCommander: [],
  manaValueNeeded: 0,
  produces: ['Win the game'],
  ...extra,
});

const eingabe = (cards: MetricCard[], combos: MetricCombo[] = []): MetricInput => ({
  cards,
  combos,
  flags: new Map(),
  effects: new Map(),
});

describe('goldfish-sim - Zufallsgenerator', () => {
  it('liefert zum selben Startwert dieselbe Folge', () => {
    const a = rng(42);
    const b = rng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('goldfish-sim', () => {
  it('gewinnt nie ohne gewinnende Combo im Deck', () => {
    const ergebnis = simulateGoldfish(eingabe([insel(38), fueller(61)]), 200);
    expect(ergebnis.winRate).toBe(0);
    expect(ergebnis.medianWinTurn).toBeNull();
  });

  it('wertet unendliches Mana nicht als Sieg', () => {
    // Dieselbe Combo, nur ein anderes Ergebnis - ohne etwas, das das Mana umsetzt, ist es kein Sieg.
    const deck = [
      insel(38),
      karte('A', { cmc: 1, quantity: 10 }),
      karte('B', { cmc: 1, quantity: 10 }),
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
        karte('A', { cmc: 1, quantity: 8 }),
        karte('B', { cmc: 2, quantity: 8 }),
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
          karte('A', { cmc: kosten, quantity: 8 }),
          karte('B', { cmc: kosten, quantity: 8 }),
          fueller(45),
        ],
        [combo(['A', 'B'])],
      );

    const schnell = simulateGoldfish(bauen(1), 500, 3);
    const langsam = simulateGoldfish(bauen(5), 500, 3);

    expect(schnell.winByTurn4).toBeGreaterThan(langsam.winByTurn4);
    expect(schnell.medianWinTurn).toBeLessThan(langsam.medianWinTurn ?? 99);
  });

  it('rechnet den Commander aus der Kommandozone mit, statt ihn zu ziehen', () => {
    // Eine Combo, die den Commander braucht: Läge er in der Bibliothek, käme sie nur mit Glück
    // zustande. Aus der Kommandozone steht er immer bereit - und genau so wird Commander gespielt.
    const deck = eingabe(
      [
        insel(38),
        karte('Kinnan', { cmc: 2, isCommander: true }),
        karte('Basalt', { cmc: 3, quantity: 8 }),
        fueller(52),
      ],
      [combo(['Kinnan', 'Basalt'], { mustBeCommander: ['kinnan'] })],
    );

    expect(simulateGoldfish(deck, 300, 5).winRate).toBeGreaterThan(0.5);
  });
});
