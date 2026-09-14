import {
  type MetricCard,
  type MetricCombo,
  type MetricInput,
  completeCombos,
  computeDeckMetrics,
  fastManaCount,
  freeInteractionCards,
  isUntappedLand,
  isWinCombo,
  manaProduced,
} from './deck-metrics';

/**
 * Die Kennzahlen sind reine Rechnerei über Kartenlisten - eine verschobene Regel fiele sonst erst
 * auf, wenn im Bericht eine Verteilung komisch aussieht, und selbst dann wüsste niemand welche.
 * Deshalb je Regel ein Fall, gleiche Aufteilung wie bracket.spec.ts.
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

const combo = (cards: string[], extra: Partial<MetricCombo> = {}): MetricCombo => ({
  id: cards.join('-'),
  cards: cards.map((c) => c.toLowerCase()),
  mustBeCommander: [],
  manaValueNeeded: 0,
  produces: ['Win the game'],
  ...extra,
});

const eingabe = (extra: Partial<MetricInput> = {}): MetricInput => ({
  cards: [],
  combos: [],
  flags: new Map(),
  effects: new Map(),
  ...extra,
});

const SOL_RING = karte('Sol Ring', { cmc: 1, oracleText: '{T}: Add {C}{C}.' });
const SIGNET = karte('Arcane Signet', { cmc: 2, oracleText: '{T}: Add one mana of any color.' });
const MOX = karte('Mox Diamond', { cmc: 0, oracleText: '{T}: Add one mana of any color.' });

describe('deck-metrics - Manaerzeugung', () => {
  it('zählt die Symbole der ergiebigsten Add-Klausel', () => {
    expect(manaProduced(SOL_RING)).toBe(2);
    expect(manaProduced(karte('Wald', { oracleText: '({T}: Add {G}.)' }))).toBe(1);
    expect(manaProduced(karte('Nichts', { oracleText: 'Draw a card.' }))).toBe(0);
  });

  it('zählt als Fast Mana nur, was mehr erzeugt als es kostet', () => {
    // Sol Ring (1 -> 2) und Mox Diamond (0 -> 1) ja, Arcane Signet (2 -> 1) nein: das ist der
    // Unterschied zwischen Beschleunigung und blosser Rampe.
    expect(fastManaCount([SOL_RING, SIGNET, MOX])).toBe(2);
  });

  it('lässt Länder aussen vor, auch wenn sie Mana erzeugen', () => {
    const insel = karte('Island', {
      cmc: 0,
      typeLine: 'Basic Land — Island',
      oracleText: '({T}: Add {U}.)',
    });
    expect(fastManaCount([insel])).toBe(0);
  });

  it('zählt Exemplare, nicht Deckzeilen', () => {
    expect(
      fastManaCount([
        karte('Petal', { cmc: 0, oracleText: 'Add one mana of any color.', quantity: 3 }),
      ]),
    ).toBe(3);
  });
});

describe('deck-metrics - Manabasis', () => {
  it('erkennt bedingungslos getappte Länder', () => {
    const gate = karte('Azorius Guildgate', {
      typeLine: 'Land',
      oracleText: 'Azorius Guildgate enters tapped.',
    });
    expect(isUntappedLand(gate)).toBe(false);
  });

  it('zählt Schockländer als ungetappt - sie bieten einen Ausweg', () => {
    const schock = karte('Hallowed Fountain', {
      typeLine: 'Land — Plains Island',
      oracleText:
        'As Hallowed Fountain enters, you may pay 2 life. If you don’t, it enters tapped.',
    });
    expect(isUntappedLand(schock)).toBe(true);
  });
});

describe('deck-metrics - Combos', () => {
  it('findet nur vollständig im Deck liegende Combos', () => {
    const input = eingabe({
      cards: [karte('Thoracle'), karte('Consult')],
      combos: [combo(['Thoracle', 'Consult']), combo(['Thoracle', 'Pact'])],
    });
    expect(completeCombos(input).map((c) => c.id)).toEqual(['Thoracle-Consult']);
  });

  it('achtet auf mustBeCommander', () => {
    const nurMitCommander = combo(['Kinnan', 'Basalt'], { mustBeCommander: ['kinnan'] });
    const ohne = eingabe({ cards: [karte('Kinnan'), karte('Basalt')], combos: [nurMitCommander] });
    const mit = eingabe({
      cards: [karte('Kinnan', { isCommander: true }), karte('Basalt')],
      combos: [nurMitCommander],
    });
    expect(completeCombos(ohne)).toHaveLength(0);
    expect(completeCombos(mit)).toHaveLength(1);
  });

  it('zählt nur Combos als Sieg, die das Spiel wirklich beenden', () => {
    expect(isWinCombo(combo(['A', 'B'], { produces: ['Win the game'] }))).toBe(true);
    expect(isWinCombo(combo(['A', 'B'], { produces: ['Infinite damage'] }))).toBe(true);
    // Unendlich Mana allein gewinnt nichts - es braucht noch etwas, das es umsetzt.
    expect(isWinCombo(combo(['A', 'B'], { produces: ['Infinite mana'] }))).toBe(false);
  });
});

describe('deck-metrics - Interaktion', () => {
  it('erkennt freie Interaktion an den Alternativkosten und an billigen Kontern', () => {
    const fow = karte('Force of Will', {
      cmc: 5,
      oracleText:
        'You may pay 1 life and exile a blue card from your hand rather than pay this spell’s mana cost.',
    });
    const echterFow = karte('Fierce Guardianship', {
      cmc: 3,
      oracleText:
        'If you control a commander, you may cast this spell without paying its mana cost.',
    });
    const swan = karte('Swan Song', { cmc: 1 });
    const teuer = karte('Cancel', { cmc: 3 });

    const input = eingabe({
      cards: [fow, echterFow, swan, teuer],
      effects: new Map([
        ['swan song', new Set(['counterspell'])],
        ['cancel', new Set(['counterspell'])],
      ]),
    });

    const namen = freeInteractionCards(input).map((c) => c.name);
    // Force of Will hat eine andere Formulierung ("rather than pay") und faellt bewusst durchs
    // Raster - die Regel nennt nur den Wortlaut "without paying its mana cost" plus Konter fuer
    // ein Mana. Genau das haelt dieser Test fest, damit die Luecke bekannt bleibt.
    expect(namen).toEqual(['Fierce Guardianship', 'Swan Song']);
  });
});

describe('deck-metrics - Gesamtbild', () => {
  const insel = (n: number) =>
    karte('Island', {
      cmc: 0,
      typeLine: 'Basic Land — Island',
      oracleText: '({T}: Add {U}.)',
      quantity: n,
    });

  it('rechnet den frühestmöglichen Siegzug aus Combo-Kosten und Manaentwicklung', () => {
    const input = eingabe({
      cards: [insel(30), SOL_RING, karte('Thoracle', { cmc: 2 }), karte('Consult', { cmc: 1 })],
      combos: [combo(['Thoracle', 'Consult'])],
    });

    const m = computeDeckMetrics(input);
    expect(m.winComboCount).toBe(1);
    expect(m.cheapestWinComboMana).toBe(3);
    // Erwartungswert, nicht Obergrenze: In Zug 2 kennt man 8 der 33 Karten, das reicht im Schnitt
    // für zwei Länder plus einen Bruchteil Sol Ring - erst Zug 3 kommt sicher auf drei Mana.
    expect(m.earliestWinTurn).toBe(3);
  });

  it('liefert ohne gewinnende Combo keine Tempo-Aussage statt einer geratenen', () => {
    const m = computeDeckMetrics(eingabe({ cards: [insel(38), SIGNET] }));
    expect(m.cheapestWinComboMana).toBeNull();
    expect(m.earliestWinTurn).toBeNull();
    expect(m.winComboCount).toBe(0);
  });

  it('misst Interaktionsdichte an der Kartenzahl', () => {
    const input = eingabe({
      cards: [insel(38), karte('Swords', { cmc: 1 }), karte('Swan Song', { cmc: 1 })],
      effects: new Map([
        ['swords', new Set(['removal'])],
        ['swan song', new Set(['counterspell'])],
      ]),
    });
    const m = computeDeckMetrics(input);
    expect(m.removalCount).toBe(1);
    expect(m.counterspellCount).toBe(1);
    // Swan Song zaehlt zusaetzlich als freie Interaktion (Konter fuer ein Mana).
    expect(m.freeInteractionCount).toBe(1);
    expect(m.interactionDensity).toBeCloseTo(3 / 40, 5);
  });
});
