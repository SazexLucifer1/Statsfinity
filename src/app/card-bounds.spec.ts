import { describe, expect, it } from 'vitest';
import { findCardBounds } from './card-bounds';

/** Heller Tisch, darauf eine dunkle Karte im Format 63x88 mit hellerem "Artwork". */
function scene(width: number, height: number, card: [number, number, number, number]): Uint8Array {
  const g = new Uint8Array(width * height).fill(200);
  const [l, t, r, b] = card;
  for (let y = t; y < b; y++) {
    for (let x = l; x < r; x++) {
      const inner = x > l + 8 && x < r - 8 && y > t + 12 && y < t + (b - t) * 0.55;
      g[y * width + x] = inner ? 120 : 25;
    }
  }
  return g;
}

describe('findCardBounds', () => {
  it('findet eine Karte, die kleiner und verschoben im Rahmen liegt', () => {
    // Rahmen 200x280, Karte 170x237 ab (8, 12) - wie auf dem iPhone-Bild.
    const bounds = findCardBounds(scene(200, 280, [8, 12, 178, 249]), 200, 280);
    expect(bounds).not.toBeNull();
    const [l, t, r, b] = bounds!;
    expect(l * 200).toBeCloseTo(8, -1);
    expect(t * 280).toBeCloseTo(12, -1);
    expect(r * 200).toBeCloseTo(178, -1);
    expect(b * 280).toBeCloseTo(249, -1);
  });

  it('gibt ohne Karte nichts zurück', () => {
    expect(findCardBounds(new Uint8Array(200 * 280).fill(180), 200, 280)).toBeNull();
  });
});

describe('findCardBounds bei schlampig angelegter Karte', () => {
  it('findet eine kleine Karte, die nicht mittig liegt', () => {
    // Suchbereich 260x364, Karte nur gut halb so hoch und nach rechts unten verschoben.
    const bounds = findCardBounds(scene(260, 364, [110, 150, 250, 345]), 260, 364);
    expect(bounds).not.toBeNull();
    const [l, t, r, b] = bounds!;
    expect(l * 260).toBeCloseTo(110, -1);
    expect(t * 364).toBeCloseTo(150, -1);
    expect(r * 260).toBeCloseTo(250, -1);
    expect(b * 364).toBeCloseTo(345, -1);
  });

  it('nimmt die Außenkante, nicht den inneren Rand', () => {
    // Die Szene hat ein helleres "Artwork" innen - dessen Kante darf nicht gewinnen.
    const bounds = findCardBounds(scene(200, 280, [20, 20, 180, 243]), 200, 280);
    expect(bounds![0] * 200).toBeLessThan(24);
    expect(bounds![2] * 200).toBeGreaterThan(176);
  });
});
