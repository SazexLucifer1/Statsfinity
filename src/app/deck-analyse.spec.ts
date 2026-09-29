import {
  AnalyseKarte,
  averageCmc,
  cmcBucket,
  groupByTypeSection,
  landCount,
  manaCurve,
  nonBasicLandPercent,
  parseSubtypes,
  pipDistribution,
  typeSection,
} from './deck-analyse';
import type { I18nService } from './i18n.service';

const i18n = { t: (key: string) => key } as unknown as I18nService;

const deck: AnalyseKarte[] = [
  { quantity: 1, cmc: 1, typeLine: 'Artifact', manaCost: '{1}' },
  { quantity: 1, cmc: 2, typeLine: 'Legendary Creature — Elf Druid', manaCost: '{G}{G}' },
  { quantity: 1, cmc: 3, typeLine: 'Instant', manaCost: '{1}{G/U}{U}' },
  { quantity: 1, cmc: 9, typeLine: 'Sorcery', manaCost: '{7}{G}{G}' },
  { quantity: 10, cmc: 0, typeLine: 'Basic Land — Forest' },
  { quantity: 2, cmc: 0, typeLine: 'Land' },
];

describe('deck-analyse', () => {
  it('stuft Manawerte in 0-6 und 7+ ein', () => {
    expect(cmcBucket(0)).toBe(0);
    expect(cmcBucket(6.6)).toBe(6);
    expect(cmcBucket(7)).toBe(7);
    expect(cmcBucket(15)).toBe(7);
  });

  it('zählt die Manakurve ohne Länder', () => {
    const curve = manaCurve(deck);
    expect(curve.map((b) => b.count)).toEqual([0, 1, 1, 1, 0, 0, 0, 1]);
    expect(curve[7].label).toBe('7+');
  });

  it('rechnet Ø Manawert, Landzahl und Nichtbasis-Anteil', () => {
    expect(averageCmc(deck)).toBe((1 + 2 + 3 + 9) / 4);
    expect(averageCmc([])).toBeNull();
    expect(landCount(deck)).toBe(12);
    expect(nonBasicLandPercent(deck)).toBe(17);
    expect(nonBasicLandPercent([])).toBeNull();
  });

  it('zählt Hybrid-Symbole für beide Farben', () => {
    const pips = Object.fromEntries(pipDistribution(deck, i18n).map((p) => [p.color, p.count]));
    expect(pips).toEqual({ W: 0, U: 2, B: 0, R: 0, G: 5 });
  });

  it('gruppiert nach Typ-Abschnitt und liest Untertypen', () => {
    expect(typeSection('Artifact Creature — Golem')).toBe('Kreatur');
    expect(typeSection('Kindred Tribal')).toBe('Sonstiges');
    expect(parseSubtypes('Legendary Creature — Elf Druid')).toEqual(['Elf', 'Druid']);
    const sections = groupByTypeSection(
      deck,
      (c) => c.typeLine,
      (a, b) => a.cmc - b.cmc,
    );
    expect(sections.map((s) => s.label)).toEqual([
      'Kreatur',
      'Spontanzauber',
      'Hexerei',
      'Artefakt',
      'Land',
    ]);
  });
});
