import type { MetricCard, MetricCombo, MetricInput } from './deck-metrics';
import { cardsDrawn, rng, simulateGoldfish, starthand } from './goldfish-sim';

/**
 * Geprüft wird nicht "die Zahl stimmt" - eine Simulation hat keine richtige Zahl. Geprüft wird,
 * dass sie sich an die Regeln hält, die im Kopfkommentar von goldfish-sim.ts mit Regelnummer
 * belegt sind. Drei dieser Regeln waren in der ersten Fassung falsch; für jede steht hier jetzt
 * ein Fall, damit sie nicht wieder wegrutscht.
 */

const karte = (name: string, extra: Partial<MetricCard> = {}): MetricCard => ({
  name,
  key: name.toLowerCase(),
  quantity: 1,
  cmc: 2,
  manaCost: '{1}{U}',
  typeLine: 'Artifact',
  oracleText: '',
  producedMana: [],
  gameChanger: false,
  isCommander: false,
  ...extra,
});

const land = (name: string, farbe: string, n: number) =>
  karte(name, {
    cmc: 0,
    manaCost: '',
    typeLine: `Basic Land — ${name}`,
    oracleText: `({T}: Add {${farbe}}.)`,
    producedMana: [farbe],
    quantity: n,
  });

const insel = (n: number) => land('Island', 'U', n);
const wald = (n: number) => land('Forest', 'G', n);
const fueller = (n: number) => karte('Filler', { cmc: 5, manaCost: '{4}{U}', quantity: n });

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

describe('goldfish-sim - Mulligan (CR 103.5, 103.5c)', () => {
  // Ein Deck, dessen Starthand nie taugt (nur Laender) - so wird sicher gemulligant.
  const nurLaender = () => {
    const stapel: MetricCard[] = [];
    for (let i = 0; i < 99; i++)
      stapel.push(
        karte('Island' + i, {
          cmc: 0,
          manaCost: '',
          typeLine: 'Land',
          oracleText: '({T}: Add {U}.)',
        }),
      );
    return stapel;
  };

  it('lässt den ersten Mulligan im Mehrspieler gratis und legt erst ab dem zweiten ab', () => {
    // CR 103.5c: "the first mulligan a player takes doesn't count toward the number of cards that
    // player will put on the bottom of their library". Nach drei Mulligans sind also zwei Karten
    // weg, nicht drei - die Hand hat fünf Karten.
    const stand = starthand(nurLaender(), rng(1));
    expect(stand.hand).toHaveLength(5);
  });
});

describe('goldfish-sim - Farbiges Mana (CR 202.1a)', () => {
  const comboTeile = (farbe: string) => [
    karte('A', { cmc: 1, manaCost: `{${farbe}}`, quantity: 8 }),
    karte('B', { cmc: 1, manaCost: `{${farbe}}`, quantity: 8 }),
  ];

  it('gewinnt nicht mit Zaubern, deren Farbe das Deck gar nicht erzeugt', () => {
    // Gruene Combo-Teile, aber nur Inseln: CR 202.1a verlangt die passende Farbe.
    const deck = eingabe([insel(40), ...comboTeile('G'), fueller(43)], [combo(['A', 'B'])]);
    expect(simulateGoldfish(deck, 300, 1).winRate).toBe(0);
  });

  it('gewinnt mit derselben Combo, wenn die Farbe stimmt', () => {
    const deck = eingabe([wald(40), ...comboTeile('G'), fueller(43)], [combo(['A', 'B'])]);
    expect(simulateGoldfish(deck, 300, 1).winRate).toBeGreaterThan(0);
  });
});

describe('goldfish-sim - Einsatzverzögerung (CR 302.6)', () => {
  it('lässt eine Manakreatur im Zug ihres Erscheinens nicht tappen, ein Artefakt aber schon', () => {
    // Gleiches Deck, einziger Unterschied: Die zusaetzliche Manaquelle ist einmal eine Kreatur
    // mit {T} (CR 302.6 greift) und einmal ein Artefakt (greift nicht).
    const bauen = (typeLine: string) =>
      eingabe(
        [
          wald(30),
          // Erzeugt MEHR als sie kostet - sonst beschleunigt sie gar nichts und der Unterschied
          // zwischen Kreatur und Artefakt waere nicht messbar.
          karte('Quelle', {
            cmc: 1,
            manaCost: '{G}',
            typeLine,
            oracleText: '{T}: Add {G}{G}.',
            producedMana: ['G'],
            quantity: 12,
          }),
          karte('A', { cmc: 2, manaCost: '{1}{G}', quantity: 8 }),
          karte('B', { cmc: 2, manaCost: '{1}{G}', quantity: 8 }),
          fueller(39),
        ],
        [combo(['A', 'B'])],
      );

    const kreatur = simulateGoldfish(bauen('Creature — Elf Druid'), 800, 2);
    const artefakt = simulateGoldfish(bauen('Artifact'), 800, 2);

    expect(artefakt.winByTurn3).toBeGreaterThan(kreatur.winByTurn3);
  });
});

describe('goldfish-sim - Mana ist endlich', () => {
  it('gibt ausgegebenes Mana innerhalb eines Zuges nicht zurück', () => {
    // Ein Deck voller Einmana-Cantrips. Wer das verfügbare Mana je Schleifenrunde neu aus dem
    // Spielfeld liest, statt es fortzuschreiben, bekommt die Kosten jedes Zaubers zurück und kann
    // in einem Zug beliebig viele davon spielen - gemessen vervierfacht das die Siege bis Zug 3
    // (0,013 gegenüber 0,053). CR 500.5 leert den Manavorrat am Ende jedes Abschnitts; INNERHALB
    // eines Zuges ist er eine endliche Menge und keine Quelle.
    const deck = eingabe(
      [
        insel(30),
        karte('Cantrip', {
          cmc: 1,
          manaCost: '{U}',
          oracleText: 'Draw a card.',
          quantity: 60,
        }),
        karte('A', { cmc: 1, manaCost: '{U}' }),
        karte('B', { cmc: 1, manaCost: '{U}' }),
        fueller(7),
      ],
      [combo(['A', 'B'])],
    );

    expect(simulateGoldfish(deck, 400, 11).winByTurn3).toBeLessThan(0.03);
  });
});

describe('goldfish-sim - Kartenziehen', () => {
  it('liest, wie viele Karten eine Karte zieht', () => {
    expect(cardsDrawn(karte('Ponder', { oracleText: 'Draw a card.' }))).toBe(1);
    expect(cardsDrawn(karte('Divination', { oracleText: 'Draw two cards.' }))).toBe(2);
  });

  it('zählt kein Ziehen, das den Gegnern gehört', () => {
    const mine = karte('Howling Mine', { oracleText: 'Each player draws an additional card.' });
    expect(cardsDrawn(mine)).toBe(0);
  });

  it('findet mit Kartenziehen häufiger eine Combo als ohne', () => {
    const bauen = (mitZiehen: boolean) =>
      eingabe(
        [
          insel(35),
          karte('A', { cmc: 1, manaCost: '{U}' }),
          karte('B', { cmc: 1, manaCost: '{U}' }),
          karte('Cantrip', {
            cmc: 1,
            manaCost: '{U}',
            oracleText: mitZiehen ? 'Draw two cards.' : '',
            quantity: 20,
          }),
          fueller(42),
        ],
        [combo(['A', 'B'])],
      );

    expect(simulateGoldfish(bauen(true), 600, 4).winRate).toBeGreaterThan(
      simulateGoldfish(bauen(false), 600, 4).winRate,
    );
  });
});

describe('goldfish-sim - Siegbedingung', () => {
  it('gewinnt nie ohne gewinnende Combo im Deck', () => {
    const ergebnis = simulateGoldfish(eingabe([insel(38), fueller(61)]), 200);
    expect(ergebnis.winRate).toBe(0);
    expect(ergebnis.medianWinTurn).toBeNull();
  });

  it('wertet unendliches Mana nicht als Sieg', () => {
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
    const bauen = (kosten: number, manaCost: string) =>
      eingabe(
        [
          insel(38),
          karte('A', { cmc: kosten, manaCost, quantity: 8 }),
          karte('B', { cmc: kosten, manaCost, quantity: 8 }),
          fueller(45),
        ],
        [combo(['A', 'B'])],
      );

    const schnell = simulateGoldfish(bauen(1, '{U}'), 500, 3);
    const langsam = simulateGoldfish(bauen(5, '{4}{U}'), 500, 3);

    expect(schnell.winByTurn4).toBeGreaterThan(langsam.winByTurn4);
    expect(schnell.medianWinTurn).toBeLessThan(langsam.medianWinTurn ?? 99);
  });

  it('rechnet den Commander aus der Kommandozone mit (CR 903.8)', () => {
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
