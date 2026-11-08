import { describe, expect, it } from 'vitest';
import { CollectionItem } from './collection-filter';
import { collectionStats, priceTier } from './collection-stats';
import { entryPrice } from './collection.service';

function item(
  cardName: string,
  extra: Partial<CollectionItem> & { qty?: number; foil?: boolean; set?: string } = {},
): CollectionItem {
  return {
    entry: {
      scryfallId: `${cardName}-${extra.set ?? 'c21'}-${extra.foil ?? false}`,
      foil: extra.foil ?? false,
      cardName,
      lang: 'en',
      setCode: extra.set ?? 'c21',
      collectorNumber: '1',
      illustrationId: null,
      quantity: extra.qty ?? 1,
      addedAt: '2026-11-06T00:00:00Z',
    },
    typeLine: extra.typeLine ?? 'Creature — Elf',
    cmc: extra.cmc ?? 2,
    colorIdentity: extra.colorIdentity ?? ['G'],
    keywords: [],
    effects: new Set(),
    rarity: extra.rarity ?? 'common',
    setName: null,
    price: extra.price === undefined ? 1 : extra.price,
    inDecks: extra.inDecks ?? 0,
  };
}

describe('collectionStats', () => {
  it('zählt Exemplare, Wert und Schnitte', () => {
    const s = collectionStats([
      item('Elf', { qty: 3, price: 1 }),
      item('Bolt', { qty: 1, price: 5, cmc: 1, colorIdentity: ['R'], typeLine: 'Instant' }),
      item('Forest', { qty: 10, price: null, cmc: 0, typeLine: 'Basic Land — Forest' }),
    ]);
    expect(s.copies).toBe(14);
    expect(s.distinct).toBe(3);
    expect(s.value).toBe(8);
    expect(s.avgPrice).toBe(2);
    expect(s.medianPrice).toBe(1);
    expect(s.unpricedCopies).toBe(10);
    // Länder zählen nicht zum Ø Manawert: (3×2 + 1×1) / 4
    expect(s.avgCmc).toBeCloseTo(7 / 4);
    expect(s.curve.find((b) => b.key === '0')?.copies).toBe(0);
  });

  it('gespielt höchstens so viele, wie man besitzt', () => {
    const s = collectionStats([
      item('Elf', { qty: 2, price: 2, inDecks: 5 }),
      item('Elf', { qty: 1, price: 4, inDecks: 5, set: 'm21', foil: true }),
      item('Bear', { qty: 4, price: 1 }),
    ]);
    expect(s.usage.distinctPlayed).toBe(1);
    expect(s.usage.copiesPlayed).toBe(3);
    expect(s.usage.valuePlayed).toBeCloseTo(8);
    expect(s.mostPlayed.map((r) => r.item.entry.cardName)).toEqual(['Elf']);
    expect(s.mostValuableFree.map((r) => r.item.entry.cardName)).toEqual(['Bear']);
    // Je Karte nur einmal, der teuerste Druck vorn.
    expect(s.mostValuable.map((r) => r.amount)).toEqual([4, 1]);
    expect(s.foilCopies).toBe(1);
  });

  it('Preisstufen', () => {
    expect(priceTier(0.1)).toBe(0);
    expect(priceTier(0.5)).toBe(1);
    expect(priceTier(9.99)).toBe(2);
    expect(priceTier(50)).toBe(4);
  });
});

describe('entryPrice', () => {
  const info = {
    illustrationId: null,
    rarity: null,
    setName: null,
    eur: 4.66,
    eurFoil: null,
    legalities: {},
    priceFromEnglish: false,
    cmAvg7: 4,
    cmAvg7Foil: 9,
    cmLow: 1.5,
    cmLowFoil: 6,
  };
  it('Near Mint = avg7, Played = low, Foil-Werte bei Foil', () => {
    expect(entryPrice(info, false).price).toBe(4);
    expect(entryPrice(info, true).price).toBe(9);
    expect(entryPrice(info, false, 'pl').price).toBe(1.5);
    expect(entryPrice(info, true, 'pl').price).toBe(6);
    expect(entryPrice(info, false, 'nm', 'low').price).toBe(1.5);
  });
  it('ohne avg7 der Trendpreis, nicht das günstigste Angebot', () => {
    expect(entryPrice({ ...info, cmAvg7: null, cmAvg7Foil: null }, false).price).toBe(4.66);
    expect(entryPrice({ ...info, cmAvg7: null, cmAvg7Foil: null, eur: null }, false).price).toBe(
      1.5,
    );
  });
});
