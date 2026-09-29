import { colorComboLabel, colorComboName, colorRadarData, sortColors } from './color-combo-names';
import type { I18nService } from './i18n.service';

const i18n = {
  t: (key: string, p?: Record<string, string>) => (p ? `${key}:${p['color']}` : key),
} as unknown as I18nService;

/**
 * Die Namenstabelle ist von Hand gepflegt und liegt in WUBRG-Reihenfolge - hereinkommen können die
 * Farben aber in jeder Reihenfolge (die Farbidentität eines Decks kommt so aus der Datenbank, wie
 * sie dort steht). Diese Tests halten beides fest: die Sortierung und ein paar Namen aus jeder
 * Gruppe, bei denen ein Zahlendreher in der Tabelle sonst unbemerkt bliebe.
 */
describe('color-combo-names', () => {
  it('sortiert Farben in die WUBRG-Reihenfolge', () => {
    expect(sortColors(['G', 'W', 'U'])).toEqual(['W', 'U', 'G']);
    expect(sortColors(['R', 'B'])).toEqual(['B', 'R']);
  });

  it('findet Gildennamen unabhängig von der Eingabereihenfolge', () => {
    expect(colorComboName(['W', 'U'])).toBe('Azorius');
    expect(colorComboName(['U', 'W'])).toBe('Azorius');
    expect(colorComboName(['R', 'W'])).toBe('Boros');
    expect(colorComboName(['G', 'B'])).toBe('Golgari');
  });

  it('kennt Schattenreiche und Keile', () => {
    expect(colorComboName(['U', 'B', 'R'])).toBe('Grixis');
    expect(colorComboName(['G', 'W', 'U'])).toBe('Bant');
    expect(colorComboName(['R', 'W', 'B'])).toBe('Mardu');
    expect(colorComboName(['G', 'U', 'R'])).toBe('Temur');
  });

  it('kennt die Vierfarben-Namen', () => {
    expect(colorComboName(['W', 'U', 'B', 'R'])).toBe('Yore-Tiller');
    expect(colorComboName(['G', 'W', 'U', 'B'])).toBe('Witch-Maw');
  });

  it('hat keinen Eigennamen für eine Farbe, keine Farbe und alle fünf', () => {
    expect(colorComboName([])).toBeNull();
    expect(colorComboName(['W'])).toBeNull();
    expect(colorComboName(['W', 'U', 'B', 'R', 'G'])).toBeNull();
  });

  it('beschriftet Kombinationen mit Eigenname oder Text', () => {
    expect(colorComboLabel(i18n, ['U', 'W'])).toBe('Azorius');
    expect(colorComboLabel(i18n, [])).toBe('deckView.colorless');
    expect(colorComboLabel(i18n, ['G'])).toBe('colorCombo.mono:pip.G');
    expect(colorComboLabel(i18n, ['W', 'U', 'B', 'R', 'G'])).toBe('colorCombo.fiveColor');
  });

  it('zeichnet das Netzdiagramm in fester Achsenreihenfolge', () => {
    const data = colorRadarData(
      i18n,
      [
        { color: 'G', n: 3 },
        { color: 'C', n: 1 },
      ],
      (s) => s.n,
    );
    expect(data.map((d) => d.symbol)).toEqual(['W', 'U', 'B', 'R', 'G', 'C']);
    expect(data.map((d) => d.value)).toEqual([0, 0, 0, 0, 3, 1]);
    expect(data[5].color).toBe('var(--series-neutral)');
  });
});
