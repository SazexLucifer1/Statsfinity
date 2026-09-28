import { einstufen, SCHWELLE, StufenErgebnis, wilson } from './forge-einstufung';
import type { BracketLevel } from './bracket';

/** Winraten je Stufe 1-5 in Prozent, je 100 Partien. */
function lauf(...prozent: number[]): StufenErgebnis[] {
  return prozent.map((p, i) => ({
    stufe: (i + 1) as BracketLevel,
    spiele: 100,
    siege: p,
    remis: 0,
  }));
}

describe('wilson', () => {
  it('liegt um den Punktwert und bleibt in [0, 1]', () => {
    const { unten, oben } = wilson(25, 100);
    expect(unten).toBeLessThan(0.25);
    expect(oben).toBeGreaterThan(0.25);
    expect(wilson(0, 100).unten).toBe(0);
    expect(wilson(100, 100).oben).toBeCloseTo(1, 10);
  });

  it('wird mit mehr Partien enger', () => {
    const w20 = wilson(5, 20);
    const w100 = wilson(25, 100);
    expect(w100.oben - w100.unten).toBeLessThan(w20.oben - w20.unten);
  });
});

describe('einstufen', () => {
  it('nimmt die höchste Stufe, in der das Deck mithält', () => {
    const e = einstufen(lauf(60, 45, 28, 8, 1));
    expect(e.simStufe).toBe(3);
    expect(e.stufe).toBe(3);
  });

  it('ist Stufe 1, wenn es nirgends mithält', () => {
    expect(einstufen(lauf(12, 5, 2, 0, 0)).simStufe).toBe(1);
  });

  it('ist Stufe 5, wenn es selbst gegen cEDH mithält', () => {
    expect(einstufen(lauf(90, 85, 70, 50, 26)).simStufe).toBe(5);
  });

  it('zählt die höchste Stufe auch bei einer Lücke darunter', () => {
    // Schwach gegen den Stil von Stufe 2, hält aber gegen Stufe 3 mit.
    expect(einstufen(lauf(50, 15, 22, 5, 0)).simStufe).toBe(3);
  });

  it('die Schwelle selbst reicht zum Mithalten', () => {
    expect(einstufen(lauf(80, 60, SCHWELLE * 100, 5, 0)).simStufe).toBe(3);
  });

  it('die Kartenregeln setzen eine Untergrenze', () => {
    const e = einstufen(lauf(40, 18, 5, 1, 0), 4);
    expect(e.simStufe).toBe(1);
    expect(e.stufe).toBe(4);
    expect(e.regelMinimum).toBe(4);
  });

  it('ohne B1-Partien: wer gegen B2 nicht mithält, ist Bracket 1', () => {
    const ohneB1 = lauf(0, 10, 3, 0, 0).slice(1);
    expect(einstufen(ohneB1).stufe).toBe(1);
  });

  it('eine 2 aus den Kartenregeln ist keine Untergrenze - sonst gäbe es kein Bracket 1', () => {
    const ohneB1 = lauf(0, 10, 3, 0, 0).slice(1);
    const e = einstufen(ohneB1, 2);
    expect(e.stufe).toBe(1);
    expect(e.regelMinimum).toBe(2);
  });

  it('die Simulation hebt über die Kartenregeln hinaus an', () => {
    expect(einstufen(lauf(80, 60, 45, 30, 3), 2).stufe).toBe(4);
  });

  it('ist sicher, wenn beide Ränder klar sind', () => {
    expect(einstufen(lauf(70, 55, 40, 5, 0)).sicherheit).toBe('sicher');
  });

  it('ist knapp, wenn die Rate an der Grenze im Rauschen liegt', () => {
    expect(einstufen(lauf(70, 55, 21, 5, 0)).sicherheit).toBe('knapp');
    expect(einstufen(lauf(70, 55, 40, 17, 0)).sicherheit).toBe('knapp');
  });

  it('übergeht Stufen ohne Partien', () => {
    const e = einstufen([
      { stufe: 1, spiele: 100, siege: 40, remis: 0 },
      { stufe: 2, spiele: 0, siege: 0, remis: 0 },
    ]);
    expect(e.stufen).toHaveLength(1);
    expect(e.simStufe).toBe(1);
  });
});
