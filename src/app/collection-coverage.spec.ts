import { describe, expect, it } from 'vitest';
import {
  CollectionEntry,
  collectionKey,
  deckCoverage,
  printIdFromImageUrl,
} from './collection-coverage';

const ID_A = '8ee443cc-e17a-493b-9c93-1f9e141a30e4';

function entry(
  cardName: string,
  quantity: number,
  illustrationId: string | null = null,
): CollectionEntry {
  return {
    scryfallId: crypto.randomUUID(),
    foil: false,
    cardName,
    lang: 'en',
    setCode: 'c21',
    collectorNumber: '1',
    illustrationId,
    quantity,
    addedAt: '2026-10-17T00:00:00Z',
  };
}

function owned(...entries: CollectionEntry[]) {
  const map = new Map<string, CollectionEntry[]>();
  for (const e of entries)
    map.set(collectionKey(e.cardName), [...(map.get(collectionKey(e.cardName)) ?? []), e]);
  return map;
}

const card = (cardName: string, quantity = 1, imageUrl: string | null = null) => ({
  cardName,
  quantity,
  imageUrl,
  isMaybeboard: false,
  isToken: false,
});

describe('deckCoverage', () => {
  it('meldet fehlende Karten und ignoriert Maybeboard', () => {
    const result = deckCoverage({
      deckId: 'd1',
      cards: [card('Sol Ring'), card('Forest', 10), { ...card('Mana Crypt'), isMaybeboard: true }],
      ownedByName: owned(entry('Sol Ring', 1), entry('Forest', 6)),
      usage: [],
      strictArt: false,
      illustrations: new Map(),
    });
    expect(result.neededTotal).toBe(11);
    expect(result.ownedTotal).toBe(7);
    expect(result.missing.map((c) => [c.cardName, c.missing])).toEqual([['Forest', 4]]);
  });

  it('erkennt Karten, die nicht für alle eigenen Decks reichen', () => {
    const result = deckCoverage({
      deckId: 'd1',
      cards: [card('Sol Ring')],
      ownedByName: owned(entry('Sol Ring', 2)),
      usage: [
        { deckId: 'd1', deckName: 'Dieses', cardName: 'Sol Ring', quantity: 1, imageUrl: null },
        { deckId: 'd2', deckName: 'Zwei', cardName: 'Sol Ring', quantity: 1, imageUrl: null },
        { deckId: 'd3', deckName: 'Drei', cardName: 'Sol Ring', quantity: 1, imageUrl: null },
      ],
      strictArt: false,
      illustrations: new Map(),
    });
    expect(result.missing).toEqual([]);
    expect(result.shared[0]).toMatchObject({ neededAllDecks: 3, ownedAnyArt: 2 });
    expect(result.shared[0].otherDecks.map((d) => d.deckName)).toEqual(['Drei', 'Zwei']);
  });

  it('zählt bei strenger Prüfung nur das gewählte Artwork', () => {
    const url = `https://cards.scryfall.io/normal/front/8/e/${ID_A}.jpg?1789644446`;
    const options = {
      deckId: 'd1',
      cards: [card('Sol Ring', 1, url)],
      ownedByName: owned(entry('Sol Ring', 1, 'ill-other')),
      usage: [],
      illustrations: new Map([[ID_A, 'ill-chosen']]),
    };
    expect(deckCoverage({ ...options, strictArt: false }).missing).toEqual([]);
    const strict = deckCoverage({ ...options, strictArt: true });
    expect(strict.missing[0]).toMatchObject({ missing: 1, ownedAnyArt: 1 });
  });

  it('liest die Druck-ID aus Scryfall-Bildadressen, nicht aus eigenen Uploads', () => {
    expect(printIdFromImageUrl(`https://cards.scryfall.io/large/back/8/e/${ID_A}.jpg`)).toBe(ID_A);
    expect(
      printIdFromImageUrl('https://x.supabase.co/storage/v1/object/public/deck-art/a.jpg'),
    ).toBeNull();
  });
});
