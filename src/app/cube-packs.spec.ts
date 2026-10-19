import { describe, expect, it } from 'vitest';
import { CubeCardData } from './cube-layout';
import {
  PackSettings,
  buildPack,
  matchesRule,
  normalizePackSettings,
  splitIntoPacks,
} from './cube-packs';

function card(name: string, typeLine: string, colors: string[]): CubeCardData {
  return { name, typeLine, cmc: 2, colorIdentity: colors, quantity: 1 };
}

/** Feste Zufallsquelle, damit die Tests nicht flattern. */
function seeded(seed = 1): () => number {
  let x = seed;
  return () => {
    x = (x * 16807) % 2147483647;
    return (x - 1) / 2147483646;
  };
}

const pool: CubeCardData[] = [
  ...Array.from({ length: 20 }, (_, i) => card(`Red ${i}`, 'Creature — Goblin', ['R'])),
  ...Array.from({ length: 20 }, (_, i) => card(`Blue ${i}`, 'Instant', ['U'])),
  ...Array.from({ length: 4 }, (_, i) => card(`Land ${i}`, 'Land', [])),
  ...Array.from({ length: 6 }, (_, i) => card(`Legend ${i}`, 'Legendary Creature — Elf', ['G'])),
];

describe('matchesRule', () => {
  it('erkennt Spalte, Typ und Legendär', () => {
    const elf = pool[44];
    expect(matchesRule(elf, { kind: 'column', key: 'G', min: 1 })).toBe(true);
    expect(matchesRule(elf, { kind: 'type', key: 'Creature', min: 1 })).toBe(true);
    expect(matchesRule(elf, { kind: 'legendary', key: '', min: 1 })).toBe(true);
    expect(matchesRule(pool[0], { kind: 'legendary', key: '', min: 1 })).toBe(false);
  });
});

describe('buildPack', () => {
  it('erfüllt die Mindestanteile', () => {
    const settings: PackSettings = {
      size: 10,
      rules: [
        { kind: 'column', key: 'L', min: 1 },
        { kind: 'legendary', key: '', min: 2 },
        { kind: 'type', key: 'Instant', min: 3 },
      ],
    };
    for (let seed = 1; seed < 20; seed++) {
      const { pack, shortfalls } = buildPack(pool, settings, seeded(seed));
      expect(pack).toHaveLength(10);
      expect(shortfalls).toEqual([]);
      expect(pack.filter((c) => c.typeLine === 'Land').length).toBeGreaterThanOrEqual(1);
      expect(pack.filter((c) => c.typeLine!.startsWith('Legendary')).length).toBeGreaterThanOrEqual(
        2,
      );
    }
  });
});

describe('splitIntoPacks', () => {
  it('verteilt jedes Exemplar höchstens einmal und meldet, was nicht reicht', () => {
    const settings: PackSettings = { size: 10, rules: [{ kind: 'column', key: 'L', min: 1 }] };
    const split = splitIntoPacks(pool, settings, seeded(3));
    expect(split.packs).toHaveLength(5);
    expect(split.packs.every((p) => p.length === 10)).toBe(true);
    const names = split.packs.flat().map((c) => c.name);
    expect(new Set(names).size).toBe(50);
    // Nur 4 Länder für 5 Packs: genau ein Pack bleibt ohne.
    expect(split.shortfalls.filter((s) => s.length > 0)).toHaveLength(1);
  });

  it('lässt Reste übrig, wenn der Cube nicht aufgeht', () => {
    const split = splitIntoPacks(pool, { size: 15, rules: [] }, seeded(5));
    expect(split.packs).toHaveLength(3);
    expect(split.leftover).toHaveLength(5);
  });
});

describe('normalizePackSettings', () => {
  it('fällt bei kaputten Daten auf den Standard zurück', () => {
    expect(normalizePackSettings(null)).toEqual({ size: 15, rules: [] });
    expect(
      normalizePackSettings({
        size: 8,
        rules: [{ kind: 'type', key: 'Instant', min: 2 }, { kind: 'x' }],
      }),
    ).toEqual({ size: 8, rules: [{ kind: 'type', key: 'Instant', min: 2 }] });
  });
});
