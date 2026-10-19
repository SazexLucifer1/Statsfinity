import { describe, expect, it } from 'vitest';
import {
  CubeCardData,
  collectionGaps,
  colorCategory,
  columnCounts,
  cubeTable,
  parseCubeCobraCsv,
  samplePack,
} from './cube-layout';

function card(
  name: string,
  typeLine: string,
  cmc: number,
  colors: string[],
  quantity = 1,
): CubeCardData {
  return { name, typeLine, cmc, colorIdentity: colors, quantity };
}

const bolt = card('Lightning Bolt', 'Instant', 1, ['R']);
const goblin = card('Goblin Guide', 'Creature — Goblin Scout', 1, ['R']);
const hellrider = card('Hellrider', 'Creature — Devil', 4, ['R']);
const helix = card('Lightning Helix', 'Instant', 2, ['R', 'W']);
const ring = card('Sol Ring', 'Artifact', 1, []);
const fountain = card('Sacred Foundry', 'Land — Mountain Plains', 0, ['R', 'W']);
const mdfc = card('Shatterskull Smashing // Shatterskull, the Hammer Pass', 'Sorcery // Land', 2, [
  'R',
]);

describe('colorCategory', () => {
  it('ordnet Mono, Gold, farblos und Länder ihren Spalten zu', () => {
    expect(colorCategory(bolt)).toBe('R');
    expect(colorCategory(helix)).toBe('M');
    expect(colorCategory(ring)).toBe('C');
    expect(colorCategory(fountain)).toBe('L');
  });

  it('nimmt bei Doppelkarten die Vorderseite', () => {
    expect(colorCategory(mdfc)).toBe('R');
  });
});

describe('cubeTable', () => {
  it('gruppiert je Spalte nach Typ und sortiert nach Manawert', () => {
    const table = cubeTable([hellrider, bolt, goblin, helix, ring, fountain]);
    expect(table.map((c) => c.key)).toEqual(['R', 'M', 'C', 'L']);
    const red = table[0];
    expect(red.count).toBe(3);
    expect(red.groups.map((g) => g.type)).toEqual(['Kreatur', 'Spontanzauber']);
    expect(red.groups[0].cards.map((c) => c.name)).toEqual(['Goblin Guide', 'Hellrider']);
  });

  it('zählt Exemplare mit', () => {
    const table = cubeTable([{ ...bolt, quantity: 2 }]);
    expect(table[0].count).toBe(2);
    expect(table[0].groups[0].count).toBe(2);
  });
});

describe('columnCounts', () => {
  it('liefert alle Spalten, auch leere', () => {
    const counts = columnCounts([bolt, helix]);
    expect(counts).toHaveLength(9);
    expect(counts.find((c) => c.key === 'R')?.count).toBe(1);
    expect(counts.find((c) => c.key === 'W')?.count).toBe(0);
  });
});

describe('samplePack', () => {
  it('zieht höchstens size Exemplare ohne Zurücklegen', () => {
    const cards = Array.from({ length: 30 }, (_, i) => card(`C${i}`, 'Instant', 1, ['U']));
    const pack = samplePack(cards, 15);
    expect(pack).toHaveLength(15);
    expect(new Set(pack.map((c) => c.name)).size).toBe(15);
  });

  it('kann mehrere Exemplare derselben Karte ziehen', () => {
    const pack = samplePack([{ ...bolt, quantity: 3 }], 15);
    expect(pack).toHaveLength(3);
  });

  it('ist mit fester Zufallsquelle reproduzierbar', () => {
    const cards = [bolt, goblin, hellrider, helix];
    const a = samplePack(cards, 2, () => 0);
    expect(a.map((c) => c.name)).toEqual(['Lightning Bolt', 'Goblin Guide']);
  });
});

describe('collectionGaps', () => {
  it('meldet nur, was nicht abgedeckt ist', () => {
    const owned = new Map([
      ['Lightning Bolt', 1],
      ['Sol Ring', 3],
    ]);
    const gaps = collectionGaps([{ ...bolt, quantity: 2 }, ring, goblin], (n) => owned.get(n) ?? 0);
    expect(gaps).toEqual([
      { name: 'Lightning Bolt', missing: 1 },
      { name: 'Goblin Guide', missing: 1 },
    ]);
  });
});

describe('CubeCobra-Sortierung', () => {
  it('teilt Mehrfarbig und Länder nach Gilden in CubeCobra-Reihenfolge', () => {
    const rakdos = card('Rakdos Charm', 'Instant', 2, ['B', 'R']);
    const azorius = card('Azorius Charm', 'Instant', 2, ['W', 'U']);
    const golgari = card('Golgari Charm', 'Instant', 2, ['B', 'G']);
    const table = cubeTable([rakdos, golgari, azorius, helix, fountain]);
    const multi = table.find((c) => c.key === 'M')!;
    expect(multi.groups.map((g) => g.type)).toEqual(['WU', 'BR', 'BG', 'WR']);
    expect(multi.groups.every((g) => g.byColors)).toBe(true);
    expect(table.find((c) => c.key === 'L')!.groups[0].type).toBe('WR');
  });

  it('nimmt eine gesetzte Farbkategorie vor der gerechneten', () => {
    expect(colorCategory({ ...helix, colorCategory: 'H' })).toBe('H');
    expect(colorCategory({ ...ring, colorCategory: 'L' })).toBe('L');
  });
});

describe('parseCubeCobraCsv', () => {
  const header =
    'name,CMC,Type,Color,Set,Collector Number,Rarity,Color Category,status,Finish,maybeboard,image URL,image Back URL,tags,Notes,MTGO ID';

  it('liest Name, Farbkategorie und Druck, auch mit Kommas in Anführungszeichen', () => {
    const rows = parseCubeCobraCsv(
      [
        header,
        '"Thalia, Guardian of Thraben",2,"Legendary Creature - Human Soldier",W,isd,24,rare,White,Owned,Non-foil,false,,,,,',
        '"Lier, Disciple of the Drowned",5,"Legendary Creature - Human Wizard",UR,mid,224,mythic,Multicolored,Owned,Foil,false,,,"a,b",,',
      ].join('\n'),
    );
    expect(rows).toEqual([
      {
        name: 'Thalia, Guardian of Thraben',
        quantity: 1,
        colorCategory: 'W',
        set: 'isd',
        collectorNumber: '24',
      },
      {
        name: 'Lier, Disciple of the Drowned',
        quantity: 1,
        colorCategory: 'M',
        set: 'mid',
        collectorNumber: '224',
      },
    ]);
  });

  it('lässt das Maybeboard weg und zählt doppelte Zeilen', () => {
    const rows = parseCubeCobraCsv(
      [
        header,
        'Island,0,Basic Land - Island,,unf,236,common,Lands,Owned,Non-foil,false,,,,,',
        'Island,0,Basic Land - Island,,unf,236,common,Lands,Owned,Non-foil,false,,,,,',
        'Sol Ring,1,Artifact,,c21,263,uncommon,Colorless,Owned,Non-foil,true,,,,,',
      ].join('\r\n'),
    );
    expect(rows).toEqual([
      { name: 'Island', quantity: 2, colorCategory: 'L', set: 'unf', collectorNumber: '236' },
    ]);
  });

  it('erkennt eine normale Liste nicht als CSV', () => {
    expect(parseCubeCobraCsv('1 Sol Ring\n1 Lightning Bolt')).toBeNull();
  });
});
