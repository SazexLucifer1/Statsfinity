import { describe, expect, it } from 'vitest';
import { SHEEN_FOIL_MIN, foilFromSheen, sheenScore } from './foil-sheen';

// Eine Karte 300×420 als RGB: heller Textkasten mit dunklen Zeilen, Farbe je Pixel aus `tint`.
function card(tint: (x: number, y: number) => [number, number, number]): Uint8Array {
  const w = 300;
  const h = 420;
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ink = y % 14 < 3 && x % 9 < 6;
      const [r, g, b] = ink ? [30, 30, 30] : tint(x / w, y / h);
      data.set([r, g, b], (y * w + x) * 3);
    }
  }
  return data;
}
const score = (data: Uint8Array) => sheenScore(data, 300, 420, 3, [0, 0, 1, 1])!;

describe('sheenScore', () => {
  it('sieht im gleichmäßigen Papier keinen Schimmer, auch nicht unter farbigem Licht', () => {
    expect(score(card(() => [235, 228, 210]))).toBeLessThan(0.005);
    // Warmes Licht von links, kühles von rechts: ein Verlauf, kein Schimmer.
    expect(score(card((x) => [250 - 40 * x, 228, 200 + 40 * x]))).toBeLessThan(0.005);
  });

  it('erkennt den Regenbogen einer Foil-Karte', () => {
    const rainbow = card((x, y) => {
      const t = (x * 3 + y * 7) * Math.PI;
      return [215 + 25 * Math.sin(t), 215 + 25 * Math.sin(t + 2.1), 215 + 25 * Math.sin(t + 4.2)];
    });
    expect(score(rainbow)).toBeGreaterThan(SHEEN_FOIL_MIN);
  });
});

describe('foilFromSheen', () => {
  it('sagt Foil nur bei deutlich mehr Schimmer als im Scan, sonst nichts', () => {
    expect(foilFromSheen(0.07, 0.01)).toBe(true);
    expect(foilFromSheen(0.14, 0.13)).toBeNull();
    expect(foilFromSheen(null, 0.01)).toBeNull();
  });
});
