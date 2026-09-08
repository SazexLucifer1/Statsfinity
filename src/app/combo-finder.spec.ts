import { describe, expect, it } from 'vitest';
import {
  comboSteps,
  fitsColorIdentity,
  groupSuggestions,
  parseManaCost,
  splitManaSymbols,
} from './combo-finder';
import type { ComboSuggestionRow } from './card-data.service';

/**
 * Der Combo-Finder schlägt Karten zum Kaufen vor - ein Fehler hier ist teurer als ein falsches
 * Diagramm, er kostet echtes Geld. Welche Combos überhaupt in Frage kommen, entscheidet die
 * Datenbankfunktion (sql/spellbook-combos-2026-09-07.sql); was hier geprüft wird, ist alles
 * danach: bündeln, sortieren, Farbidentität, Ablauf-Aufteilung.
 */

const zeile = (missing: string, extra: Partial<ComboSuggestionRow> = {}): ComboSuggestionRow => ({
  comboId: `${missing}-${extra.present?.join('+') ?? 'x'}`,
  missing,
  present: ['sol ring'],
  cardCount: 2,
  produces: ['Infinite mana'],
  description: 'Schritt eins\nSchritt zwei',
  manaNeeded: null,
  manaValueNeeded: 0,
  popularity: 100,
  comboCount: 1,
  totalCards: 1,
  ...extra,
});

describe('groupSuggestions', () => {
  it('bündelt mehrere Combos derselben fehlenden Karte zu einem Vorschlag', () => {
    const vorschlaege = groupSuggestions([
      zeile('cloudstone curio', { present: ['dockside extortionist'], comboCount: 2 }),
      zeile('cloudstone curio', { present: ['temur sabertooth'], comboCount: 2 }),
    ]);

    expect(vorschlaege).toHaveLength(1);
    expect(vorschlaege[0].key).toBe('cloudstone curio');
    expect(vorschlaege[0].comboCount).toBe(2);
    expect(vorschlaege[0].combos).toHaveLength(2);
  });

  it('sortiert nach Anzahl freigeschalteter Combos, dann nach Beliebtheit', () => {
    const vorschlaege = groupSuggestions([
      zeile('selten', { popularity: 5, comboCount: 1 }),
      zeile('beliebt', { popularity: 900, comboCount: 1 }),
      zeile('zwei', { present: ['a'], comboCount: 2 }),
      zeile('zwei', { present: ['b'], comboCount: 2 }),
    ]);

    expect(vorschlaege.map((v) => v.key)).toEqual(['zwei', 'beliebt', 'selten']);
  });

  it('sortiert innerhalb eines Vorschlags die beliebteste Combo nach vorn', () => {
    const vorschlaege = groupSuggestions([
      zeile('x', { comboId: 'leise', present: ['a'], popularity: 10, comboCount: 2 }),
      zeile('x', { comboId: 'laut', present: ['b'], popularity: 5000, comboCount: 2 }),
    ]);

    expect(vorschlaege[0].combos.map((c) => c.comboId)).toEqual(['laut', 'leise']);
  });

  it('behält die Reihenfolge bei gleichen Werten stabil (alphabetisch)', () => {
    const vorschlaege = groupSuggestions([zeile('b'), zeile('a')]);
    expect(vorschlaege.map((v) => v.key)).toEqual(['a', 'b']);
  });

  it('kommt mit einer leeren Antwort klar', () => {
    expect(groupSuggestions([])).toEqual([]);
  });
});

describe('fitsColorIdentity', () => {
  it('lässt Karten in den Farben des Decks zu', () => {
    expect(fitsColorIdentity(['U'], ['U', 'B'])).toBe(true);
    expect(fitsColorIdentity(['U', 'B'], ['U', 'B'])).toBe(true);
  });

  it('lehnt Karten mit einer Farbe außerhalb der Farbidentität ab', () => {
    expect(fitsColorIdentity(['R'], ['U', 'B'])).toBe(false);
    expect(fitsColorIdentity(['U', 'R'], ['U', 'B'])).toBe(false);
  });

  it('lässt farblose Karten immer zu', () => {
    expect(fitsColorIdentity([], ['U'])).toBe(true);
    expect(fitsColorIdentity(undefined, [])).toBe(true);
  });

  it('filtert gar nicht, solange die Farbidentität des Decks unbekannt ist', () => {
    expect(fitsColorIdentity(['R', 'G'], null)).toBe(true);
  });
});

const alsText = (teile: { kind: string; value: string }[]) => teile.map((t) => t.value).join('');

describe('comboSteps', () => {
  it('teilt den Ablauf an den Zeilenumbrüchen auf', () => {
    expect(comboSteps('Erstens\nZweitens\nDrittens').map(alsText)).toEqual([
      'Erstens',
      'Zweitens',
      'Drittens',
    ]);
  });

  it('wirft Leerzeilen und Leerraum weg', () => {
    expect(comboSteps('  Erstens  \n\n\n Zweitens \n').map(alsText)).toEqual([
      'Erstens',
      'Zweitens',
    ]);
  });

  it('liefert eine leere Liste, wenn die Quelle keine Beschreibung hat', () => {
    expect(comboSteps('')).toEqual([]);
  });

  it('holt die Manasymbole aus dem Fließtext heraus', () => {
    expect(comboSteps('Activate it by paying {1}, then repeat.')[0]).toEqual([
      { kind: 'text', value: 'Activate it by paying ' },
      { kind: 'symbol', value: '1' },
      { kind: 'text', value: ', then repeat.' },
    ]);
  });
});

describe('splitManaSymbols', () => {
  it('behält Leerzeichen rund um die Symbole', () => {
    expect(splitManaSymbols('a {U} b')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'symbol', value: 'U' },
      { kind: 'text', value: ' b' },
    ]);
  });

  it('erkennt Energie, Schnee, Tappen, X und Hybride als Symbol', () => {
    for (const t of ['E', 'S', 'T', 'X', 'C', 'U/R', '2/B', 'B/P', '15']) {
      expect(splitManaSymbols(`{${t}}`)).toEqual([{ kind: 'symbol', value: t }]);
    }
  });

  it('lässt Unbekanntes als Text in seinen Klammern stehen', () => {
    expect(splitManaSymbols('zahle {Blubb} dafür')).toEqual([
      { kind: 'text', value: 'zahle {Blubb} dafür' },
    ]);
  });

  it('zieht Text um ein unbekanntes Token herum zu einem Stück zusammen', () => {
    expect(splitManaSymbols('a {Q} b {U} c')).toEqual([
      { kind: 'text', value: 'a {Q} b ' },
      { kind: 'symbol', value: 'U' },
      { kind: 'text', value: ' c' },
    ]);
  });
});

describe('parseManaCost', () => {
  it('zerlegt eine reine Kartenschreibweise in Symbole', () => {
    expect(parseManaCost('{1}{R}{R}')).toEqual([
      { kind: 'symbol', value: '1' },
      { kind: 'symbol', value: 'R' },
      { kind: 'symbol', value: 'R' },
    ]);
  });

  it('behält Hybridsymbole als Ganzes', () => {
    expect(parseManaCost('{U}{U/R}')).toEqual([
      { kind: 'symbol', value: 'U' },
      { kind: 'symbol', value: 'U/R' },
    ]);
  });

  it('behält den erklärenden Text hinter den Kosten', () => {
    expect(parseManaCost('{2}{G} at most')).toEqual([
      { kind: 'symbol', value: '2' },
      { kind: 'symbol', value: 'G' },
      { kind: 'text', value: 'at most' },
    ]);
  });

  it('behält auch Text zwischen zwei Symbolen', () => {
    expect(parseManaCost('{5} minus {X}, wobei X zählt')).toEqual([
      { kind: 'symbol', value: '5' },
      { kind: 'text', value: 'minus' },
      { kind: 'symbol', value: 'X' },
      { kind: 'text', value: ', wobei X zählt' },
    ]);
  });

  it('kommt mit einer Angabe ganz ohne Klammern klar', () => {
    expect(parseManaCost('nichts weiter')).toEqual([{ kind: 'text', value: 'nichts weiter' }]);
    expect(parseManaCost('')).toEqual([]);
  });
});
