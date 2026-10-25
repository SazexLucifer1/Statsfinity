import { compareDeckVariants, totalQuantity, VariantCard } from './deck-variants';

function card(cardName: string, quantity = 1, extra: Partial<VariantCard> = {}): VariantCard {
  return {
    cardName,
    quantity,
    imageUrl: null,
    typeLine: 'Instant',
    cmc: 1,
    isCommander: false,
    isMaybeboard: false,
    isToken: false,
    ...extra,
  };
}

describe('deck-variants', () => {
  it('teilt Karten in gemeinsam, nur hier und nur in der Variante', () => {
    const r = compareDeckVariants(
      [card('Sol Ring'), card('Counterspell')],
      [card('Sol Ring'), card('Swan Song')],
    );
    expect(r.common.map((e) => e.cardName)).toEqual(['Sol Ring']);
    expect(r.onlyThis.map((e) => e.cardName)).toEqual(['Counterspell']);
    expect(r.onlyOther.map((e) => e.cardName)).toEqual(['Swan Song']);
  });

  it('teilt Mengen auf, damit die Listen zusammen die Deckgröße ergeben', () => {
    const r = compareDeckVariants([card('Island', 2)], [card('Island', 4)]);
    expect(r.common).toEqual([expect.objectContaining({ cardName: 'Island', quantity: 2 })]);
    expect(r.onlyThis).toEqual([]);
    expect(r.onlyOther).toEqual([expect.objectContaining({ cardName: 'Island', quantity: 2 })]);
    expect(totalQuantity(r.common) + totalQuantity(r.onlyOther)).toBe(4);
  });

  it('lässt Maybeboard und Marken weg und vergleicht Namen ohne Groß-/Kleinschreibung', () => {
    const r = compareDeckVariants(
      [
        card('sol ring'),
        card('Rhystic Study', 1, { isMaybeboard: true }),
        card('Treasure', 1, { isToken: true }),
      ],
      [card('Sol Ring')],
    );
    expect(r.common).toHaveLength(1);
    expect(r.onlyThis).toEqual([]);
    expect(r.onlyOther).toEqual([]);
  });

  it('sortiert Commander zuerst, dann nach Kartentyp und Manawert', () => {
    const r = compareDeckVariants(
      [
        card('Command Tower', 1, { typeLine: 'Land', cmc: 0 }),
        card('Big Spell', 1, { cmc: 5 }),
        card('Small Spell', 1, { cmc: 1 }),
        card('Sefris', 1, { isCommander: true, typeLine: 'Legendary Creature', cmc: 3 }),
        card('Looter', 1, { typeLine: 'Creature', cmc: 2 }),
      ],
      [],
    );
    expect(r.onlyThis.map((e) => e.cardName)).toEqual([
      'Sefris',
      'Looter',
      'Small Spell',
      'Big Spell',
      'Command Tower',
    ]);
  });
});
