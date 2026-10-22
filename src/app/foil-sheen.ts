/**
 * Foil am Regenbogen-Schimmer: Die Foil-Schicht bricht das Licht, im Foto läuft über den hellen
 * Textkasten ein Farbverlauf aus Rosa, Grün und Blau. Ein normaler Druck hat dort überall
 * denselben Papierton - auch unter farbigem Licht, das den ganzen Kasten gleich (Weißabgleich)
 * oder als gleichmäßigen Verlauf (Ebene, siehe unten) einfärbt.
 *
 * Gemessen wird der Farbton je Zelle eines Rasters über die hellen Pixel des Kastens (Schrift
 * fällt heraus), nach Weißabgleich und ohne den linearen Verlauf über den Kasten. Was übrig
 * bleibt, ist ungleichmäßige Färbung. Weil es Rahmen mit buntem Textkasten gibt (Vollbild-Länder,
 * Showcase), entscheidet erst der Vergleich mit Scryfalls flachem Scan desselben Drucks.
 *
 * Der Kasten ist bewusst schmal gewählt: Die Kartenlage aus dem Artwork-Fingerabdruck liegt bis
 * zu 7 % daneben, und ein Stück Artwork oder Typzeile im Ausschnitt schimmert auch ohne Foil.
 * Aus demselben Grund gilt beim Scan der höchste Wert über leicht verschobene Lagen.
 *
 * Gemessen am 22.10.2026 (Fotos um bis zu 7 % verschoben): vier iPhone-Fotos von Foils lagen
 * 0,047-0,075 über ihrem Scan; 38 Scryfall-Scans normaler Karten, verfälscht mit Farbverlauf,
 * Vignette, Rauschen und Unschärfe wie aus einer Kamera, höchstens 0,013. Echte Fotos normaler
 * Karten fehlten in der Messung. Eigene Messung, ohne fremden Code oder fremdes Modell.
 */

/** Lage des Textkastens auf der Karte (Anteile: x0, y0, x1, y1). */
export const SHEEN_BOX = [0.1, 0.71, 0.9, 0.87] as const;

/** Um so viel muss das Foto mehr schimmern als der Scan, damit es als Foil gilt. */
export const SHEEN_FOIL_MIN = 0.035;

const GRID_W = 240;
const GRID_H = 160;
const CELLS_X = 12;
const CELLS_Y = 8;

/**
 * Ungleichmäßige Färbung im Textkasten der Karte `card` (Anteile von `width`/`height`).
 * `data` sind Pixel mit `channels` Werten je Pixel (RGBA: 4). null, wenn zu wenig Fläche da ist.
 */
export function sheenScore(
  data: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  card: readonly [number, number, number, number],
): number | null {
  const cw = card[2] - card[0];
  const ch = card[3] - card[1];
  const x0 = (card[0] + SHEEN_BOX[0] * cw) * width;
  const y0 = (card[1] + SHEEN_BOX[1] * ch) * height;
  const x1 = (card[0] + SHEEN_BOX[2] * cw) * width;
  const y1 = (card[1] + SHEEN_BOX[3] * ch) * height;
  if (x1 - x0 < 24 || y1 - y0 < 16) return null;

  // Auf ein festes Raster abtasten (Mittel je Rasterpunkt), damit Kameraauflösung und Scan
  // gleich gewichtet sind.
  const n = GRID_W * GRID_H;
  const rgb = new Float32Array(n * 3);
  const lum = new Float32Array(n);
  for (let gy = 0; gy < GRID_H; gy++) {
    const sy0 = Math.max(0, Math.floor(y0 + ((y1 - y0) * gy) / GRID_H));
    const sy1 = Math.min(
      height,
      Math.max(sy0 + 1, Math.floor(y0 + ((y1 - y0) * (gy + 1)) / GRID_H)),
    );
    for (let gx = 0; gx < GRID_W; gx++) {
      const sx0 = Math.max(0, Math.floor(x0 + ((x1 - x0) * gx) / GRID_W));
      const sx1 = Math.min(
        width,
        Math.max(sx0 + 1, Math.floor(x0 + ((x1 - x0) * (gx + 1)) / GRID_W)),
      );
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const i = (y * width + x) * channels;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          count++;
        }
      }
      const k = gy * GRID_W + gx;
      if (count === 0) continue;
      rgb[k * 3] = r / count;
      rgb[k * 3 + 1] = g / count;
      rgb[k * 3 + 2] = b / count;
      lum[k] = (r + g + b) / (3 * count);
    }
  }

  // Papier = die helleren 60 %, Schrift und Symbole fallen heraus.
  const threshold = percentile(lum, 0.4);
  const paper = new Uint8Array(n);
  for (let k = 0; k < n; k++) paper[k] = lum[k] >= threshold ? 1 : 0;
  const balance = [0, 1, 2].map((c) => {
    const values: number[] = [];
    for (let k = 0; k < n; k++) if (paper[k]) values.push(rgb[k * 3 + c]);
    return Math.max(1, percentile(values, 0.5));
  });
  const mean = (balance[0] + balance[1] + balance[2]) / 3;

  // Farbton je Zelle: Rot-Grün und Gelb-Blau, bezogen auf die Helligkeit.
  const cells: [number, number, number, number][] = [];
  for (let cy = 0; cy < CELLS_Y; cy++) {
    for (let cx = 0; cx < CELLS_X; cx++) {
      let a = 0;
      let b = 0;
      let count = 0;
      for (let gy = (cy * GRID_H) / CELLS_Y; gy < ((cy + 1) * GRID_H) / CELLS_Y; gy++) {
        for (let gx = (cx * GRID_W) / CELLS_X; gx < ((cx + 1) * GRID_W) / CELLS_X; gx++) {
          const k = gy * GRID_W + gx;
          if (!paper[k]) continue;
          const r = (rgb[k * 3] / balance[0]) * mean;
          const g = (rgb[k * 3 + 1] / balance[1]) * mean;
          const bl = (rgb[k * 3 + 2] / balance[2]) * mean;
          const l = (r + g + bl) / 3 + 1;
          a += (r - g) / l;
          b += ((r + g) / 2 - bl) / l;
          count++;
        }
      }
      if (count >= 20) cells.push([cx, cy, a / count, b / count]);
    }
  }
  if (cells.length < 12) return null;

  // Ohne den Verlauf über den Kasten (Ebene durch die Zellen): farbiges Licht von einer Seite.
  const ra = residuals(cells, 2);
  const rb = residuals(cells, 3);
  let sum = 0;
  for (let i = 0; i < cells.length; i++) sum += Math.hypot(ra[i], rb[i]);
  return sum / cells.length;
}

/** true, wenn das Foto deutlich mehr schimmert als der Scan desselben Drucks; sonst null. */
export function foilFromSheen(photo: number | null, scan: number | null): boolean | null {
  if (photo === null || scan === null) return null;
  return photo - scan >= SHEEN_FOIL_MIN ? true : null;
}

function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** Abweichung jeder Zelle von der besten Ebene a + b·x + c·y durch Spalte `col`. */
function residuals(cells: readonly (readonly number[])[], col: number): number[] {
  // Normalgleichungen 3×3, gelöst nach Cramer.
  let s1 = 0,
    sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0,
    syy = 0,
    sv = 0,
    sxv = 0,
    syv = 0;
  for (const c of cells) {
    const [x, y, v] = [c[0], c[1], c[col]];
    s1++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sv += v;
    sxv += x * v;
    syv += y * v;
  }
  const det = (m: number[]) =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  const base = [s1, sx, sy, sx, sxx, sxy, sy, sxy, syy];
  const d = det(base);
  if (Math.abs(d) < 1e-9) {
    const avg = sv / s1;
    return cells.map((c) => c[col] - avg);
  }
  const a = det([sv, sx, sy, sxv, sxx, sxy, syv, sxy, syy]) / d;
  const b = det([s1, sv, sy, sx, sxv, sxy, sy, syv, syy]) / d;
  const c = det([s1, sx, sv, sx, sxx, sxv, sy, sxy, syv]) / d;
  return cells.map((cell) => cell[col] - (a + b * cell[0] + c * cell[1]));
}
