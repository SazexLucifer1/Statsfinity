import { TestBed } from '@angular/core/testing';
import { ScryfallService } from './scryfall.service';

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
            { id: '1', code: 'm10', name: 'Magic 2010', released_at: '2009-07-17', set_type: 'core' },
            { id: '2', code: 'znr', name: 'Zendikar Rising', released_at: '2020-09-25', set_type: 'expansion' },
          ],
        }),
      ) as Response,
    );

    const results = await service.searchSets('magic', 2009);

    expect(results.map((set) => set.code)).toEqual(['m10']);
  });

  it('builds an exact color-identity query for searchCommanders', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [] })) as Response);

    await service.searchCommanders(['W', 'U']);

    const calledUrl = fetchSpy.mock.calls.at(-1)![0] as string;
    expect(decodeURIComponent(calledUrl)).toContain('is:commander id=WU');
  });

  it('AND-composes name, archetype, and creature-type filters in searchCommanders', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [] })) as Response);

    await service.searchCommanders(['G'], {
      name: 'Elf',
      archetypeQuery: 'otag:counters-matter',
      creatureType: 'Elf',
    });

    const calledUrl = fetchSpy.mock.calls.at(-1)![0] as string;
    expect(decodeURIComponent(calledUrl)).toContain(
      'is:commander id=G name:"Elf" otag:counters-matter (t:"Elf" or o:"Elf")',
    );
  });

  it('omits the color-identity clause in searchCommanders when no colors are selected', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: [] })) as Response);

    await service.searchCommanders([], { archetypeQuery: 'otag:landfall' });

    const calledUrl = fetchSpy.mock.calls.at(-1)![0] as string;
    expect(decodeURIComponent(calledUrl)).toContain('is:commander otag:landfall');
    expect(decodeURIComponent(calledUrl)).not.toContain('id=');
  });

  describe('searchCommanderPairs', () => {
    /** Routet den gemockten fetch je nach Query: type:background-Abfragen bekommen backgroundData, alle anderen creatureData. */
    function mockPartnerFetch(creatureData: unknown[], backgroundData: unknown[] = []) {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const decoded = decodeURIComponent(url as string);
        const data = decoded.includes('type:background') ? backgroundData : creatureData;
        return new Response(JSON.stringify({ data })) as Response;
      });
    }

    const tymna = {
      name: 'Tymna the Weaver',
      type_line: 'Legendary Creature — Human Cleric',
      color_identity: ['W', 'B'],
      oracle_text:
        'Whenever a legendary creature enters the battlefield under your control this turn for the second time, target opponent loses 2 life.\nPartner (You can have two commanders if both have partner.)',
    };
    const silasRenn = {
      name: 'Silas Renn, Seeker Adept',
      type_line: 'Legendary Creature — Human Rogue',
      color_identity: ['U', 'B'],
      oracle_text:
        'You may cast artifact spells as though they had flash.\nPartner (You can have two commanders if both have partner.)',
    };

    it('returns [] immediately without fetching when no colors are selected', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const pairs = await service.searchCommanderPairs([]);

      expect(pairs).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('pairs two bare-Partner commanders whose combined color identity exactly matches the target', async () => {
      mockPartnerFetch([tymna, silasRenn]);

      const pairs = await service.searchCommanderPairs(['W', 'U', 'B']);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].map((c) => c.name).sort()).toEqual(['Silas Renn, Seeker Adept', 'Tymna the Weaver']);
    });

    it('excludes a bare-Partner pair whose combined color identity does not exactly equal the target', async () => {
      mockPartnerFetch([tymna, silasRenn]);

      // Tymna (WB) + Silas Renn (UB) kombiniert ergeben WUB, nicht WB - kein exakter Treffer.
      const pairs = await service.searchCommanderPairs(['W', 'B']);

      expect(pairs).toEqual([]);
    });

    it('pairs a "Choose a Background" commander with a Background card from the separate background query', async () => {
      const chooseBackgroundCommander = {
        name: "Abdel Adrian, Gorion's Ward",
        type_line: 'Legendary Creature — Human Fighter',
        color_identity: ['W'],
        oracle_text: 'Choose a Background (You may have a Background as a second commander.)',
      };
      const background = {
        name: 'Ranger Background',
        type_line: 'Legendary Enchantment — Background',
        color_identity: ['G'],
        oracle_text: 'Whenever you cast a spell that targets only a permanent or player you control, draw a card.',
      };
      mockPartnerFetch([chooseBackgroundCommander], [background]);

      const pairs = await service.searchCommanderPairs(['W', 'G']);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].map((c) => c.name).sort()).toEqual(["Abdel Adrian, Gorion's Ward", 'Ranger Background']);
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
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }) as Response);
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
