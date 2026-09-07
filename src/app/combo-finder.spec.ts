import { describe, expect, it } from 'vitest';
import { fitsColorIdentity, missingComboPartners } from './combo-finder';
import type { BracketCard } from './bracket';
import type { SpellbookTwoCardCombo } from './card-data.service';

/**
 * Der Combo-Finder schlägt Karten zum Kaufen vor - ein Fehler hier ist deshalb teurer als ein
 * falsches Diagramm: Er kostet echtes Geld. Die Regeln (genau eine Karte fehlt, mustBeCommander,
 * Farbidentität, Reihenfolge) sind reine Rechnerei und lassen sich hier einzeln festnageln.
 */

const karte = (name: string, extra: Partial<BracketCard> = {}): BracketCard => ({
  name,
  key: name.toLowerCase(),
  quantity: 1,
  cmc: 2,
  gameChanger: false,
  isCommander: false,
  ...extra,
});

const combo = (
  a: string,
  b: string,
  extra: Partial<SpellbookTwoCardCombo> = {},
): SpellbookTwoCardCombo => ({
  id: `${a}-${b}`,
  cardA: a.toLowerCase(),
  cardB: b.toLowerCase(),
  aMustBeCommander: false,
  bMustBeCommander: false,
  manaValueNeeded: 0,
  bracketTag: 'S',
  popularity: 1000,
  ...extra,
});

describe('missingComboPartners', () => {
  it('schlägt die fehlende zweite Karte vor', () => {
    const vorschlaege = missingComboPartners(
      [karte('Thassa’s Oracle')],
      [combo('Thassa’s Oracle', 'Demonic Consultation')],
    );

    expect(vorschlaege).toHaveLength(1);
    expect(vorschlaege[0].key).toBe('demonic consultation');
    expect(vorschlaege[0].matches[0].partner.name).toBe('Thassa’s Oracle');
  });

  it('findet die fehlende Karte auch, wenn sie in der Quelle an erster Stelle steht', () => {
    const vorschlaege = missingComboPartners(
      [karte('Demonic Consultation')],
      [combo('Thassa’s Oracle', 'Demonic Consultation')],
    );

    expect(vorschlaege.map((v) => v.key)).toEqual(['thassa’s oracle']);
  });

  it('schlägt nichts vor, wenn die Combo schon vollständig im Deck liegt', () => {
    const vorschlaege = missingComboPartners(
      [karte('Thassa’s Oracle'), karte('Demonic Consultation')],
      [combo('Thassa’s Oracle', 'Demonic Consultation')],
    );

    expect(vorschlaege).toEqual([]);
  });

  it('schlägt nichts vor, wenn beide Karten fehlen', () => {
    const vorschlaege = missingComboPartners(
      [karte('Sol Ring')],
      [combo('Thassa’s Oracle', 'Demonic Consultation')],
    );

    expect(vorschlaege).toEqual([]);
  });

  it('lässt Combos aus, deren fehlende Karte der Commander sein müsste', () => {
    const vorschlaege = missingComboPartners(
      [karte('Basalt Monolith')],
      [combo('Kinnan', 'Basalt Monolith', { aMustBeCommander: true })],
    );

    expect(vorschlaege).toEqual([]);
  });

  it('lässt Combos aus, deren vorhandene Karte Commander sein müsste, es aber nicht ist', () => {
    const combos = [combo('Kinnan', 'Basalt Monolith', { aMustBeCommander: true })];

    expect(missingComboPartners([karte('Kinnan')], combos)).toEqual([]);
    expect(
      missingComboPartners([karte('Kinnan', { isCommander: true })], combos).map((v) => v.key),
    ).toEqual(['basalt monolith']);
  });

  it('bündelt mehrere Combos derselben fehlenden Karte zu einem Vorschlag', () => {
    const vorschlaege = missingComboPartners(
      [karte('Dockside Extortionist'), karte('Temur Sabertooth')],
      [
        combo('Dockside Extortionist', 'Cloudstone Curio'),
        combo('Temur Sabertooth', 'Cloudstone Curio'),
      ],
    );

    expect(vorschlaege).toHaveLength(1);
    expect(vorschlaege[0].matches.map((m) => m.partner.name)).toEqual([
      'Dockside Extortionist',
      'Temur Sabertooth',
    ]);
  });

  it('sortiert nach Anzahl freigeschalteter Combos, dann nach Beliebtheit', () => {
    const vorschlaege = missingComboPartners(
      [karte('A'), karte('B')],
      [
        combo('A', 'Selten', { popularity: 5 }),
        combo('A', 'Beliebt', { popularity: 900 }),
        combo('A', 'Zwei'),
        combo('B', 'Zwei'),
      ],
    );

    expect(vorschlaege.map((v) => v.key)).toEqual(['zwei', 'beliebt', 'selten']);
  });

  it('ignoriert eine Combo aus zweimal derselben Karte', () => {
    expect(missingComboPartners([karte('A')], [combo('A', 'A')])).toEqual([]);
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
