import { describe, expect, it } from 'vitest';
import {
  CollectionFilters,
  CollectionItem,
  activeFilterCount,
  collectionValue,
  filterCollection,
  groupCollection,
  mergePrints,
  sortCollection,
} from './collection-filter';
import { EMPTY_COLOR_SELECTION } from './color-filter-match';

function item(
  cardName: string,
  extra: Partial<CollectionItem> & {
    lang?: string;
    set?: string;
    foil?: boolean;
    qty?: number;
  } = {},
): CollectionItem {
  return {
    entry: {
      scryfallId: `${cardName}-${extra.set ?? 'c21'}-${extra.lang ?? 'en'}-${extra.foil ?? false}`,
      foil: extra.foil ?? false,
      cardName,
      lang: extra.lang ?? 'en',
      setCode: extra.set ?? 'c21',
      collectorNumber: '1',
      illustrationId: null,
      quantity: extra.qty ?? 1,
      addedAt: '2026-10-18T00:00:00Z',
    },
    typeLine: extra.typeLine ?? 'Artifact',
    cmc: extra.cmc ?? 1,
    colorIdentity: extra.colorIdentity ?? [],
    keywords: extra.keywords ?? [],
    effects: extra.effects ?? new Set(),
    rarity: extra.rarity ?? 'uncommon',
    setName: extra.setName ?? 'Commander 2021',
    price: extra.price ?? null,
    inDecks: extra.inDecks ?? 0,
  };
}

const none: CollectionFilters = {
  search: '',
  langs: new Set(),
  sets: new Set(),
  rarities: new Set(),
  foil: 'all',
  cmc: 'all',
  colors: EMPTY_COLOR_SELECTION,
  type: 'all',
  effect: 'all',
  keyword: 'all',
  usage: 'all',
};

const items = [
  item('Sol Ring', { price: 1.5, qty: 2, inDecks: 3 }),
  item('Sol Ring', { lang: 'de', foil: true, price: 20 }),
  item('Llanowar Elves', {
    typeLine: 'Creature — Elf Druid',
    colorIdentity: ['G'],
    effects: new Set(['ramp']),
    rarity: 'common',
    set: 'dom',
    setName: 'Dominaria',
  }),
  item('Swords to Plowshares', {
    typeLine: 'Instant',
    colorIdentity: ['W'],
    effects: new Set(['removal']),
    rarity: 'rare',
    cmc: 1,
    price: 2,
  }),
  item('Smothering Tithe', {
    typeLine: 'Enchantment',
    colorIdentity: ['W'],
    cmc: 4,
    rarity: 'rare',
    price: 25,
  }),
];

describe('filterCollection', () => {
  it('filtert nach Set, Foil, Sprache und Seltenheit', () => {
    expect(
      filterCollection(items, { ...none, sets: new Set(['dom']) }).map((i) => i.entry.cardName),
    ).toEqual(['Llanowar Elves']);
    expect(filterCollection(items, { ...none, foil: 'foil' })).toHaveLength(1);
    expect(filterCollection(items, { ...none, langs: new Set(['de']) })[0].entry.lang).toBe('de');
    expect(filterCollection(items, { ...none, rarities: new Set(['rare']) })).toHaveLength(2);
  });

  it('filtert wie die Kartensuche der Deck-Ansicht', () => {
    expect(filterCollection(items, { ...none, cmc: 4 }).map((i) => i.entry.cardName)).toEqual([
      'Smothering Tithe',
    ]);
    expect(
      filterCollection(items, { ...none, type: 'Kreatur' }).map((i) => i.entry.cardName),
    ).toEqual(['Llanowar Elves']);
    expect(
      filterCollection(items, { ...none, effect: 'removal' }).map((i) => i.entry.cardName),
    ).toEqual(['Swords to Plowshares']);
    expect(
      filterCollection(items, { ...none, colors: { colors: ['W'], mode: 'exact' } }),
    ).toHaveLength(2);
    expect(filterCollection(items, { ...none, search: 'commander 2021' }).length).toBe(4);
  });

  it('unterscheidet benutzte und freie Karten', () => {
    expect(filterCollection(items, { ...none, usage: 'used' })).toHaveLength(1);
    expect(filterCollection(items, { ...none, usage: 'free' })).toHaveLength(4);
  });

  it('zählt aktive Filter', () => {
    expect(activeFilterCount(none)).toBe(0);
    expect(activeFilterCount({ ...none, foil: 'foil', cmc: 2 })).toBe(2);
  });
});

describe('Sortieren, Zusammenfassen, Gruppieren, Wert', () => {
  it('sortiert nach Preis mit unbekannten Preisen am Ende', () => {
    expect(sortCollection(items, 'price').map((i) => i.price)).toEqual([25, 20, 2, 1.5, null]);
  });

  it('fasst Drucke zusammen, ohne den Wert zu verlieren', () => {
    const merged = mergePrints(items);
    const sol = merged.find((i) => i.entry.cardName === 'Sol Ring')!;
    expect(sol.entry.quantity).toBe(3);
    expect(collectionValue(merged)).toBeCloseTo(collectionValue(items));
  });

  it('gruppiert nach Seltenheit, wertvollste zuerst', () => {
    expect(groupCollection(items, 'rarity').map((s) => s.key)).toEqual([
      'rare',
      'uncommon',
      'common',
    ]);
    expect(groupCollection(items, 'type')[0].key).toBe('Kreatur');
  });

  it('rechnet den Gesamtwert über alle Exemplare', () => {
    expect(collectionValue(items)).toBeCloseTo(1.5 * 2 + 20 + 2 + 25);
  });
});
