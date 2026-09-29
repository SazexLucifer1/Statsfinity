import { TestBed } from '@angular/core/testing';
import { ScryfallCard, ScryfallService } from './scryfall.service';

describe('ScryfallService', () => {
  let service: ScryfallService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ScryfallService);
  });

  afterEach(() => {
    // vi.spyOn() reuses an existing spy instead of creating a fresh one if globalThis.fetch is
    // already mocked - without restoring here, later tests would inherit earlier tests' call
    // history (and mocked response) instead of starting clean.
    vi.restoreAllMocks();
  });

  it('filters draft sets by query and year from the Scryfall API response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: '1',
              code: 'm10',
              name: 'Magic 2010',
              released_at: '2009-07-17',
              set_type: 'core',
            },
            {
              id: '2',
              code: 'znr',
              name: 'Zendikar Rising',
              released_at: '2020-09-25',
              set_type: 'expansion',
            },
          ],
        }),
      ) as Response,
    );

    const results = await service.searchSets('magic', 2009);

    expect(results.map((set) => set.code)).toEqual(['m10']);
  });

  describe('Commander-Paare', () => {
    const card = (name: string, typeLine: string, oracleText: string) =>
      ({ name, typeLine, oracleText, imageUrl: null }) as unknown as ScryfallCard;

    const tymna = card(
      'Tymna the Weaver',
      'Legendary Creature — Human Cleric',
      'Partner (You can have two commanders if both have partner.)',
    );
    const silas = card(
      'Silas Renn, Seeker Adept',
      'Legendary Creature — Human Rogue',
      'Partner (You can have two commanders if both have partner.)',
    );
    const abdel = card(
      "Abdel Adrian, Gorion's Ward",
      'Legendary Creature — Human Fighter',
      'Choose a Background (You may have a Background as a second commander.)',
    );
    const ranger = card(
      'Ranger Background',
      'Legendary Enchantment — Background',
      'Whenever you cast a spell ...',
    );
    const pir = card(
      'Pir, Imaginative Rascal',
      'Legendary Creature — Human',
      'Partner with Toothy, Imaginary Friend',
    );
    const toothy = card(
      'Toothy, Imaginary Friend',
      'Legendary Creature — Illusion',
      'Partner with Pir, Imaginative Rascal',
    );

    it('erkennt Partner, Partner with und Background-Paare', () => {
      expect(service.canBeCommanderPair(tymna, silas)).toBe(true);
      expect(service.canBeCommanderPair(abdel, ranger)).toBe(true);
      expect(service.canBeCommanderPair(ranger, abdel)).toBe(true);
      expect(service.canBeCommanderPair(pir, toothy)).toBe(true);
    });

    it('lehnt unpassende Paare ab', () => {
      expect(service.canBeCommanderPair(tymna, abdel)).toBe(false);
      expect(service.canBeCommanderPair(pir, tymna)).toBe(false);
    });

    it('erlaubt einen zweiten Commander auch für die passive Hälfte (Background)', () => {
      expect(service.allowsSecondCommander(ranger)).toBe(true);
      expect(service.allowsSecondCommander(card('Sol Ring', 'Artifact', '{T}: Add {C}{C}.'))).toBe(
        false,
      );
    });
  });

  describe('creatureTypes', () => {
    it('parses and caches the creature-type catalog', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            object: 'catalog',
            uri: 'https://api.scryfall.com/catalog/creature-types',
            total_values: 2,
            data: ['Zombie', 'Elf'],
          }),
        ) as Response,
      );

      const first = await service.creatureTypes();
      expect(first).toEqual(['Elf', 'Zombie']);

      const second = await service.creatureTypes();
      expect(second).toEqual(['Elf', 'Zombie']);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns an empty array when the catalog request fails', async () => {
      // status 404 statt 500: fetchWithRetry() behandelt 404 als "gültige, sofortige Antwort ohne
      // Wiederholung" (siehe scryfall.service.ts) - ein echter 5xx-Fehlschlag würde hier reale
      // Sleeps zwischen den Wiederholungsversuchen auslösen und den Test unnötig verlangsamen.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 404 }) as Response,
      );
      expect(await service.creatureTypes()).toEqual([]);
    });
  });

  describe('cheapestPrices', () => {
    it('keys double-faced cards by their front face so callers actually find the price', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { name: 'Esika, God of the Tree // The Prismatic Bridge', prices: { eur: '4.50' } },
              { name: 'Sol Ring', prices: { eur: '1.20' } },
            ],
          }),
        ) as Response,
      );

      const { prices, incomplete } = await service.cheapestPrices([
        'Esika, God of the Tree // The Prismatic Bridge',
        'Sol Ring',
      ]);

      expect(prices.get('esika, god of the tree')).toBe(4.5);
      expect(prices.get('sol ring')).toBe(1.2);
      expect(incomplete).toBe(false);
    });

    it('reports incomplete when a chunk request fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, { status: 404 }) as Response,
      );

      const { prices, incomplete } = await service.cheapestPrices(['Sol Ring']);

      expect(prices.size).toBe(0);
      expect(incomplete).toBe(true);
    });
  });
});
