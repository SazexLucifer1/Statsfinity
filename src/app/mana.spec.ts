import { canPay, manaUnits, parseManaCost, payFrom, type ManaSource } from './mana';

/**
 * Die Manaregeln sind der Teil der Simulation, der sich exakt prüfen lässt - anders als die Frage,
 * wie ein Mensch spielen würde, steht hier in den Comprehensive Rules eine eindeutige Antwort.
 * Jeder Fall unten nennt die Regel, die er festhält.
 */

const quelle = (amount: number, colors: string[]): ManaSource => ({
  amount,
  colors: colors as never,
});

describe('mana - Kosten lesen (CR 107.4)', () => {
  it('trennt generisches von farbigem Mana', () => {
    const k = parseManaCost('{2}{G}{G}');
    expect(k.generic).toBe(2);
    expect(k.requirements).toHaveLength(2);
    expect(k.requirements.every((r) => r.colors[0] === 'G')).toBe(true);
  });

  it('liest Hybridsymbole als zwei Möglichkeiten (CR 107.4e)', () => {
    const k = parseManaCost('{W/U}');
    expect(k.requirements[0].colors).toEqual(['W', 'U']);
  });

  it('liest monofarbigen Hybrid mit seiner generischen Alternative (CR 107.4g)', () => {
    const k = parseManaCost('{2/U}');
    expect(k.requirements[0].colors).toEqual(['U']);
    expect(k.requirements[0].genericAlternative).toBe(2);
  });

  it('erkennt Phyrexia-Symbole (CR 107.4f)', () => {
    expect(parseManaCost('{U/P}').requirements[0].phyrexian).toBe(true);
  });

  it('merkt sich {X}, ohne einen Wert zu erfinden (CR 107.3a)', () => {
    const k = parseManaCost('{X}{R}');
    expect(k.hasX).toBe(true);
    expect(k.generic).toBe(0);
  });

  it('kommt mit leeren Kosten zurecht - Länder haben keine', () => {
    expect(parseManaCost('')).toEqual({ generic: 0, requirements: [], hasX: false });
  });
});

describe('mana - Kosten bezahlen (CR 202.1a, 601.2h)', () => {
  it('verlangt für farbige Symbole die passende Farbe', () => {
    // CR 202.1a: "paying that mana cost requires matching the type of any colored ... mana symbols"
    expect(canPay(parseManaCost('{G}'), [quelle(1, ['U'])])).toBe(false);
    expect(canPay(parseManaCost('{G}'), [quelle(1, ['G'])])).toBe(true);
  });

  it('bezahlt generisches Mana mit jeder Farbe', () => {
    expect(canPay(parseManaCost('{3}'), [quelle(3, ['U'])])).toBe(true);
  });

  it('kennt keine Teilzahlung (CR 601.2h)', () => {
    expect(canPay(parseManaCost('{2}{G}'), [quelle(2, ['G'])])).toBe(false);
  });

  it('löst auch die Fälle, an denen eine gierige Zuweisung scheitern würde', () => {
    // {W}{U} mit einer Quelle "nur Weiss" und einer "Weiss oder Blau": Wer das W-Symbol zuerst
    // der flexiblen Quelle gibt, steht ohne Blau da. Die Rücksetzsuche findet die Loesung.
    const quellen = [quelle(1, ['W']), quelle(1, ['W', 'U'])];
    expect(canPay(parseManaCost('{W}{U}'), quellen)).toBe(true);
  });

  it('nutzt bei monofarbigem Hybrid die generische Alternative, wenn die Farbe fehlt', () => {
    expect(canPay(parseManaCost('{2/U}'), [quelle(2, ['R'])])).toBe(true);
    expect(canPay(parseManaCost('{2/U}'), [quelle(1, ['R'])])).toBe(false);
  });

  it('behandelt Phyrexia als bezahlbar, weil Leben im Goldfish nicht knapp ist', () => {
    expect(canPay(parseManaCost('{U/P}'), [])).toBe(true);
  });

  it('gibt zurück, was übrig bleibt - die Simulation zaubert mehrfach je Zug', () => {
    const rest = payFrom(parseManaCost('{G}'), manaUnits([quelle(3, ['G'])]));
    expect(rest).toHaveLength(2);
  });

  it('spart flexible Quellen auf und zahlt generisch mit den unflexibelsten', () => {
    // Zwei farblose und eine Grün-Quelle, Kosten {1}: Danach muss das Grün noch dastehen.
    const rest = payFrom(parseManaCost('{1}'), manaUnits([quelle(1, []), quelle(1, ['G'])]));
    expect(rest).toEqual([['G']]);
  });
});
