/**
 * Findet die Karte innerhalb des Scanner-Rahmens (card-scan.service.ts). Der Rahmen auf dem
 * Bildschirm ist nur eine Anlegehilfe: In der Hand liegt die Karte fast nie genau darin, meist
 * kleiner (Handy weiter weg) und etwas verschoben. Die Sammlerzeile unten links und die
 * Artwork-Lagen sind aber auf die KARTE bezogen - mit dem Rahmen als Bezug schnitt die erste
 * Fassung auf dem iPhone die Nummernzeile ab und erkannte gar nichts.
 *
 * Verfahren ohne Bildverarbeitungs-Paket: Helligkeitssprünge je Spalte (über das mittlere Drittel
 * der Höhe) und je Zeile (über das mittlere Drittel der Breite). Die Kartenkante ist der
 * äußerste kräftige Sprung auf jeder Seite - weiter innen liegen die Kanten von Rand zu Artwork,
 * die genauso kräftig sein können. Passt das Ergebnis nicht zum Kartenformat, gilt der Rahmen.
 */

/** Ausschnitt in Anteilen des Bildes: [links, oben, rechts, unten]. */
export type Bounds = readonly [number, number, number, number];

const CARD_RATIO = 63 / 88;

/** `gray` zeilenweise, Werte 0-255. */
export function findCardBounds(
  gray: ArrayLike<number>,
  width: number,
  height: number,
): Bounds | null {
  const cols = edgeProfile(gray, width, height, 'x');
  const rows = edgeProfile(gray, width, height, 'y');
  const left = outermostEdge(cols, 0, Math.floor(width * 0.35), 'start');
  const right = outermostEdge(cols, Math.ceil(width * 0.65), width - 1, 'end');
  const top = outermostEdge(rows, 0, Math.floor(height * 0.35), 'start');
  const bottom = outermostEdge(rows, Math.ceil(height * 0.65), height - 1, 'end');
  if (left === null || right === null || top === null || bottom === null) return null;

  const w = right - left;
  const h = bottom - top;
  if (w < width * 0.45 || h < height * 0.45) return null;
  const ratio = w / h;
  if (Math.abs(ratio - CARD_RATIO) / CARD_RATIO > 0.12) return null;
  return [left / width, top / height, right / width, bottom / height];
}

function edgeProfile(
  gray: ArrayLike<number>,
  width: number,
  height: number,
  axis: 'x' | 'y',
): Float64Array {
  const len = axis === 'x' ? width : height;
  const out = new Float64Array(len);
  // Nur das mittlere Drittel der anderen Richtung: Dort kreuzt die Kartenkante sicher, Ecken und
  // Hintergrundkanten außerhalb der Karte zählen weniger.
  const from = Math.floor((axis === 'x' ? height : width) / 3);
  const to = Math.ceil(((axis === 'x' ? height : width) * 2) / 3);
  for (let i = 1; i < len - 1; i++) {
    let sum = 0;
    for (let j = from; j < to; j++) {
      const a = axis === 'x' ? gray[j * width + i - 1] : gray[(i - 1) * width + j];
      const b = axis === 'x' ? gray[j * width + i + 1] : gray[(i + 1) * width + j];
      sum += Math.abs(b - a);
    }
    out[i] = sum / (to - from);
  }
  return out;
}

/** Äußerster Sprung im Bereich, der mindestens halb so stark ist wie der stärkste dort. */
function outermostEdge(
  profile: Float64Array,
  from: number,
  to: number,
  side: 'start' | 'end',
): number | null {
  let max = 0;
  for (let i = from; i <= to; i++) max = Math.max(max, profile[i]);
  if (max < 12) return null; // kein deutlicher Sprung: Karte hebt sich nicht vom Grund ab
  const threshold = max * 0.5;
  if (side === 'start') {
    for (let i = from; i <= to; i++) if (profile[i] >= threshold) return i;
  } else {
    for (let i = to; i >= from; i--) if (profile[i] >= threshold) return i;
  }
  return null;
}
