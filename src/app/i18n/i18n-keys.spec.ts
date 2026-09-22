import { auth } from './auth';
import { common } from './common';
import { deck } from './deck';
import { deckView } from './deck-view';
import { feedback } from './feedback';
import { group } from './group';
import { ingame } from './ingame';
import { match } from './match';
import { profile } from './profile';
import { search } from './search';
import { stats } from './stats';
import { tournament } from './tournament';
import { tutorial } from './tutorial';

/**
 * Übersetzungs-Keys sind reine Strings - ein Tippfehler fällt nicht auf, sondern zeigt in der App
 * stumm den Key selbst an. Diese Tests fangen die drei Fehler ab, die beim Pflegen der Tabellen
 * tatsächlich passieren: eine Sprache vergessen, einen Key doppelt vergeben (der spätere Spread
 * in i18n.service.ts überschreibt dann kommentarlos den früheren), oder einen Key in der falschen
 * Datei ablegen, wo ihn beim nächsten Mal niemand sucht.
 */

/** Modulname -> erlaubte Key-Präfixe. Muss zur Aufteilung in i18n.service.ts passen. */
const MODULES = {
  auth: { table: auth, prefixes: ['login', 'loginRequired', 'resetPassword'] },
  common: {
    table: common,
    prefixes: [
      'dialog',
      'common',
      'nav',
      'header',
      'sort',
      'legal',
      'cardImage',
      'partnerCardImage',
    ],
  },
  deck: {
    table: deck,
    prefixes: [
      'deck',
      'deckComment',
      'deckPrimer',
      'deckSteckbrief',
      'deckViewer',
      'importDialog',
      'pdfDialog',
    ],
  },
  deckView: { table: deckView, prefixes: ['deckView'] },
  feedback: { table: feedback, prefixes: ['feedback'] },
  group: { table: group, prefixes: ['group', 'permission'] },
  ingame: { table: ingame, prefixes: ['ingame', 'goldfish'] },
  match: { table: match, prefixes: ['match', 'game', 'placement'] },
  profile: { table: profile, prefixes: ['profile', 'inbox'] },
  search: {
    table: search,
    prefixes: [
      'archetypeFilter',
      'effectFilter',
      'keywordFilter',
      'commanderRec',
      'precons',
      'publicDecks',
      'publicSearch',
      'search',
      'colorFilter',
      'colorCombo',
      'pip',
    ],
  },
  stats: { table: stats, prefixes: ['stats'] },
  tournament: { table: tournament, prefixes: ['tournament', 'tournamentHistory'] },
  tutorial: { table: tutorial, prefixes: ['tutorial'] },
};

const entries = Object.entries(MODULES);

describe('i18n-Keys', () => {
  describe.each(entries)('%s', (_name, { table, prefixes }) => {
    it('hat in beiden Sprachen dieselben Keys', () => {
      const de = Object.keys(table.de).sort();
      const en = Object.keys(table.en).sort();
      expect(en).toEqual(de);
    });

    it('legt jeden Key unter einem Präfix ab, das zu dieser Datei gehört', () => {
      const fremd = Object.keys(table.de).filter((key) => !prefixes.includes(key.split('.')[0]));
      expect(fremd).toEqual([]);
    });

    it('hat keine leeren Übersetzungen', () => {
      const leer = [
        ...Object.entries(table.de).filter(([, value]) => value.trim() === ''),
        ...Object.entries(table.en).filter(([, value]) => value.trim() === ''),
      ].map(([key]) => key);
      expect(leer).toEqual([]);
    });
  });

  it('vergibt keinen Key in zwei Dateien', () => {
    const gesehen = new Map<string, string>();
    const doppelt: string[] = [];
    for (const [name, { table }] of entries) {
      for (const key of Object.keys(table.de)) {
        const vorher = gesehen.get(key);
        if (vorher) doppelt.push(`${key} (${vorher} + ${name})`);
        else gesehen.set(key, name);
      }
    }
    expect(doppelt).toEqual([]);
  });

  it('deckt alle Präfixe genau einmal ab', () => {
    const alle = entries.flatMap(([, { prefixes }]) => prefixes);
    expect(alle.length).toBe(new Set(alle).size);
  });
});
