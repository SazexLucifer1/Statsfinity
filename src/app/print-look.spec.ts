import { describe, expect, it } from 'vitest';
import {
  LOOK_MASK,
  TEXT_MASK,
  bestCorrelation,
  clearWinner,
  lookKey,
  photoEdgeWindows,
  prepareWindows,
  scanEdges,
} from './print-look';

/** Gezeichnete "Karte" (RGB): Rahmenlinien je nach Rahmenart, Textzeilen je nach Sprache. */
function card(frame: 'old' | 'new', textRows: number[], width = 245, height = 342): Uint8Array {
  const px = new Uint8Array(width * height * 3).fill(200);
  const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = Math.floor(y0 * height); y < Math.floor(y1 * height); y++) {
      for (let x = Math.floor(x0 * width); x < Math.floor(x1 * width); x++) {
        px.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
      }
    }
  };
  fill(0, 0, 1, 0.04, 20);
  fill(0, 0.96, 1, 1, 20);
  if (frame === 'new') {
    fill(0.06, 0.06, 0.94, 0.1, 60); // Namenszeile als Balken
    fill(0.06, 0.56, 0.94, 0.6, 60); // Typzeile
  } else {
    fill(0.1, 0.62, 0.9, 0.64, 60); // schmale Linie über dem Textkasten
    fill(0.45, 0.9, 0.55, 0.93, 60); // Kästchen unten mittig
  }
  for (const row of textRows) fill(0.1, row, 0.85, row + 0.015, 40);
  return px;
}

/** Dieselbe Karte als "Foto": dunkler, leicht verschoben auf grauem Grund. */
function photo(cardPx: Uint8Array, dark: number) {
  const cw = 245;
  const ch = 342;
  const width = 320;
  const height = 440;
  const ox = 40;
  const oy = 52;
  const px = new Uint8Array(width * height * 3).fill(Math.round(150 * dark));
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      for (let c = 0; c < 3; c++) {
        px[((y + oy) * width + x + ox) * 3 + c] = Math.round(cardPx[(y * cw + x) * 3 + c] * dark);
      }
    }
  }
  // Kartenlage aus dem Fingerabdruck liegt ein paar Pixel daneben.
  const box = [
    (ox + 6) / width,
    (oy - 5) / height,
    (ox + cw + 6) / width,
    (oy + ch - 5) / height,
  ] as const;
  return { px, width, height, box };
}

const EN = [0.66, 0.7, 0.74, 0.78];
const DE = [0.68, 0.73, 0.8, 0.84, 0.88];

describe('print-look', () => {
  it('erkennt die Rahmenart auch auf einem dunklen, verschobenen Foto', () => {
    const shot = photo(card('new', EN), 0.3);
    const windows = prepareWindows(
      photoEdgeWindows(shot.px, shot.width, shot.height, 3, shot.box),
      LOOK_MASK,
    );
    const scores = [card('old', EN), card('new', EN)].map((scan) =>
      bestCorrelation(windows, scanEdges(scan, 245, 342, 3), LOOK_MASK),
    );
    expect(clearWinner(scores)).toBe(1);
  });

  it('unterscheidet Sprachen am Textkasten', () => {
    const shot = photo(card('new', DE), 0.5);
    const windows = prepareWindows(
      photoEdgeWindows(shot.px, shot.width, shot.height, 3, shot.box),
      TEXT_MASK,
    );
    const scores = [card('new', EN), card('new', DE)].map((scan) =>
      bestCorrelation(windows, scanEdges(scan, 245, 342, 3), TEXT_MASK),
    );
    expect(clearWinner(scores)).toBe(1);
  });

  it('entscheidet nur mit Vorsprung', () => {
    expect(clearWinner([0.7, 0.68])).toBeNull();
    expect(clearWinner([0.7, 0.5, 0.6])).toBe(0);
    expect(clearWinner([0.7])).toBeNull();
  });

  it('fasst Drucke mit gleichem Rahmen zusammen', () => {
    const mh1 = { frame: '2015', border_color: 'black', frame_effects: [] };
    const blc = { frame: '2015', border_color: 'black' };
    const pcy = { frame: '1997', border_color: 'black' };
    expect(lookKey(mh1)).toBe(lookKey(blc));
    expect(lookKey(mh1)).not.toBe(lookKey(pcy));
    expect(lookKey({ ...mh1, frame_effects: ['showcase'] })).not.toBe(lookKey(mh1));
  });
});
