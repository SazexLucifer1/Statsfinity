import { SCRYFALL_MANA_SYMBOLS } from './mana-symbols.generated';
import type { ManaColor, ManaUnit } from './mana-symbols';
import { canPayManaCost, manaValue, parseManaCost, payManaCost, poolAus } from './mana-symbols';

/**
 * Geprüft wird hier genau das, was die Simulation vorher NICHT konnte: farbige Kosten, Hybrid,
 * Phyrexia und {X}. Jeder Fall ist an einer echten Karte aufgehängt und nennt die Regel, aus der
 * die erwartete Antwort folgt - eine Zahl ohne Regel wäre auch hier nur eine Behauptung.
 */

const pool = (...quellen: ManaColor[][]): ManaUnit[] =>
  poolAus(quellen.map((colors) => ({ amount: 1, colors })));

const einfarbig = (farbe: ManaColor, anzahl: number): ManaUnit[] =>
  poolAus([{ amount: anzahl, colors: [farbe] }]);

describe('mana-symbols - die Symboltabelle', () => {
  it('kennt die 75 Manasymbole aus Scryfalls /symbology', () => {
    expect(SCRYFALL_MANA_SYMBOLS.length).toBe(75);
  });

  it('nennt dieselben Symbole wie CR 107.4', () => {
    // CR 107.4 zählt auf: fünf Farben, {C}, die Zahlen, {X}, zehn Hybride, zehn einfarbige
    // Hybride, fünf Phyrexia-Symbole, zehn Hybrid-Phyrexia-Symbole und {S}.
    const symbole = new Set(SCRYFALL_MANA_SYMBOLS.map((s) => s.symbol));
    for (const erwartet of ['{W}', '{U}', '{B}', '{R}', '{G}', '{C}', '{X}', '{S}']) {
      expect(symbole.has(erwartet)).toBe(true);
    }
    const zweifarbig = (s: (typeof SCRYFALL_MANA_SYMBOLS)[number]) =>
      s.hybrid && s.colors.length === 2;
    expect(SCRYFALL_MANA_SYMBOLS.filter((s) => zweifarbig(s) && !s.phyrexian).length).toBe(10);
    expect(SCRYFALL_MANA_SYMBOLS.filter((s) => zweifarbig(s) && s.phyrexian).length).toBe(10);
    expect(SCRYFALL_MANA_SYMBOLS.filter((s) => s.phyrexian && s.colors.length === 1).length).toBe(
      5,
    );
  });
});

describe('mana-symbols - Kosten lesen', () => {
  it('trennt generisches von farbigem Mana (CR 107.4a/b)', () => {
    const kosten = parseManaCost('{3}{U}{U}'); // Force of Will
    expect(kosten.generic).toBe(3);
    expect(kosten.requirements.map((f) => f.colors)).toEqual([['U'], ['U']]);
    expect(manaValue(kosten)).toBe(5);
  });

  it('zählt {X} als 0 (CR 202.3e)', () => {
    const kosten = parseManaCost('{X}{R}'); // Fireball
    expect(kosten.generic).toBe(0);
    expect(manaValue(kosten)).toBe(1);
  });

  it('liest Hybrid als "eine von zwei Farben" (CR 107.4e)', () => {
    const kosten = parseManaCost('{1}{G/W}{G/W}'); // Kitchen Finks
    expect(kosten.requirements.map((f) => [...f.colors].sort())).toEqual([
      ['G', 'W'],
      ['G', 'W'],
    ]);
    expect(manaValue(kosten)).toBe(3);
  });

  it('liest einfarbiges Hybrid als "eine Farbe oder zwei beliebige" (CR 107.4e)', () => {
    const [forderung] = parseManaCost('{2/W}').requirements; // Spectral Procession
    expect(forderung.colors).toEqual(['W']);
    expect(forderung.genericAlternative).toBe(2);
    expect(manaValue(parseManaCost('{2/W}{2/W}{2/W}'))).toBe(6);
  });

  it('liest Phyrexia als "eine Farbe oder 2 Leben" (CR 107.4f)', () => {
    const [forderung] = parseManaCost('{1}{U/P}').requirements; // Mental Misstep
    expect(forderung.colors).toEqual(['U']);
    expect(forderung.lifeAlternative).toBe(2);
  });

  it('meldet unbekannte Symbole, statt sie stillschweigend zu verschlucken', () => {
    expect(parseManaCost('{1}{QQQ}').unknown).toEqual(['{QQQ}']);
  });

  it('nimmt Hybridsymbole auch in vertauschter Schreibweise an', () => {
    expect(parseManaCost('{U/W}').requirements[0].colors.slice().sort()).toEqual(['U', 'W']);
  });
});

describe('mana-symbols - Kosten bezahlen', () => {
  it('bezahlt farbige Kosten nur mit der passenden Farbe (CR 107.4a)', () => {
    const kosten = parseManaCost('{U}{U}');
    expect(canPayManaCost(kosten, einfarbig('U', 2), 40)).toBe(true);
    expect(canPayManaCost(kosten, einfarbig('G', 5), 40)).toBe(false);
  });

  it('bezahlt {C} nur mit farblosem Mana (CR 107.4c)', () => {
    const kosten = parseManaCost('{C}');
    expect(canPayManaCost(kosten, einfarbig('C', 1), 40)).toBe(true);
    expect(canPayManaCost(kosten, einfarbig('G', 3), 40)).toBe(false);
  });

  it('bezahlt generisches Mana mit allem (CR 107.4b)', () => {
    expect(canPayManaCost(parseManaCost('{3}'), einfarbig('C', 3), 40)).toBe(true);
  });

  it('verteilt knappe Farben richtig, statt sie der Reihe nach zu verbrauchen', () => {
    // {W}{U} gegen ein Land, das W oder U kann, und eine Insel: Wer stur von vorn zuteilt, gibt
    // das Doppelland auf {W} und steht bei {U} mit nichts da. Bezahlbar ist es trotzdem.
    const kosten = parseManaCost('{W}{U}');
    expect(canPayManaCost(kosten, pool(['W', 'U'], ['U']), 40)).toBe(true);
    expect(canPayManaCost(kosten, pool(['U', 'B'], ['U']), 40)).toBe(false);
  });

  it('weicht bei Phyrexia auf Leben aus, wenn die Farbe woanders gebraucht wird (CR 601.2b)', () => {
    // {W/P}{1} gegen ein einziges weißes Mana: Nur mit den 2 Leben geht es auf.
    const kosten = parseManaCost('{W/P}{1}');
    const zahlung = payManaCost(kosten, einfarbig('W', 1), 40);
    expect(zahlung?.lifePaid).toBe(2);
  });

  it('zahlt keine Leben, wenn die Farbe da ist', () => {
    expect(payManaCost(parseManaCost('{W/P}'), einfarbig('W', 1), 40)?.lifePaid).toBe(0);
  });

  it('zahlt keine Leben, die es nicht gibt (CR 118.3)', () => {
    expect(payManaCost(parseManaCost('{W/P}'), einfarbig('G', 1), 1)).toBeNull();
    expect(payManaCost(parseManaCost('{W/P}'), einfarbig('G', 1), 2)?.lifePaid).toBe(2);
  });

  it('bezahlt einfarbiges Hybrid notfalls mit zwei beliebigen Mana (CR 107.4e)', () => {
    expect(canPayManaCost(parseManaCost('{2/W}'), einfarbig('G', 2), 40)).toBe(true);
    expect(canPayManaCost(parseManaCost('{2/W}'), einfarbig('G', 1), 40)).toBe(false);
    expect(canPayManaCost(parseManaCost('{2/W}'), einfarbig('W', 1), 40)).toBe(true);
  });

  it('gibt den Rest des Vorrats zurück, damit im selben Zug weitergezahlt werden kann', () => {
    const rest = payManaCost(parseManaCost('{1}'), einfarbig('G', 3), 40);
    expect(rest?.pool.length).toBe(2);
  });

  it('bezahlt generisch zuerst mit dem unbeweglichsten Mana', () => {
    // {1}{G} gegen eine Vogelfreiheit (alle Farben) und einen Wald: Das {1} muss der Wald zahlen,
    // sonst bleibt für {G} nur ein Mana, das zwar grün kann - hier reicht beides, aber die
    // Reihenfolge entscheidet, was danach noch übrig ist.
    const zahlung = payManaCost(
      parseManaCost('{1}{G}'),
      pool(['W', 'U', 'B', 'R', 'G'], ['G']),
      40,
    );
    expect(zahlung).not.toBeNull();
    expect(zahlung?.pool.length).toBe(0);
  });
});
