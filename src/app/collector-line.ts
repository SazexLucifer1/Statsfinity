/**
 * Liest die Sammlerzeile unten links auf einer Karte aus dem Text der Texterkennung
 * (card-scan.service.ts). Seit etwa 2015 steht dort zweizeilig
 *
 *   R 0087                  bzw. älter   123/264 R
 *   FRC • DE  Künstler                   M19 • EN ★ Künstler
 *
 * also Seltenheit, Sammlernummer, Set-Kürzel, Sprache und • (nicht-Foil) bzw. ★ (Foil). Damit ist
 * der Druck bei Scryfall eindeutig (/cards/{set}/{nummer}/{sprache}). Ältere Karten haben die
 * Zeile nicht - dann bleibt nur der Artwork-Vergleich.
 *
 * Die Texterkennung liest den Punkt oft als "*" oder gar nicht, und klebt die Seltenheit gern an
 * die Nummer ("M0049"). Deshalb wird hier tolerant nach Wörtern gesucht, nicht mit einem festen
 * Muster über die ganze Zeile.
 */

/** Auf der Karte gedruckter Sprachcode -> Scryfalls Sprachcode. */
const PRINTED_LANG: Record<string, string> = {
  EN: 'en',
  DE: 'de',
  FR: 'fr',
  IT: 'it',
  SP: 'es',
  ES: 'es',
  PT: 'pt',
  JP: 'ja',
  JA: 'ja',
  KR: 'ko',
  KO: 'ko',
  RU: 'ru',
  CS: 'zhs',
  CT: 'zht',
  PH: 'ph',
};

export interface CollectorLine {
  setCode: string | null;
  collectorNumber: string | null;
  /** Scryfall-Sprachcode, falls erkannt. */
  lang: string | null;
  /** true nur, wenn ein ★ wirklich als Zeichen erkannt wurde. */
  foilMark: boolean;
}

const RARITY = '[CURMLSTPB]';
const NUMBER_TOKEN = new RegExp(`^${RARITY}?0*(\\d{1,4})(?:/\\d{1,4})?${RARITY}?$`);
const SET_TOKEN = /^[A-Z0-9]{2,6}$/;

export function parseCollectorLine(text: string): CollectorLine {
  const result: CollectorLine = {
    setCode: null,
    collectorNumber: null,
    lang: null,
    foilMark: text.includes('★'),
  };
  // Punkt, Stern und ähnliche Zeichen sind Trenner, keine Wortteile ("*EN" -> "EN").
  const lines = text
    .toUpperCase()
    .split(/\n|\|/)
    .map((line) =>
      line
        .replace(/[•·★*.,:;]/g, ' ')
        .split(/\s+/)
        .filter(Boolean),
    );

  // Zwei Durchgänge: erst genau ("DE"), dann tolerant - eine unscharfe Handykamera liest aus
  // "• DE" schon mal "DEW" (so geschehen auf dem iPhone). Tolerant heißt: drei Zeichen, die mit
  // einem Sprachcode anfangen, direkt hinter etwas, das wie ein Set-Kürzel aussieht.
  let setLine = -1;
  for (const tolerant of [false, true]) {
    lines.forEach((tokens, index) => {
      if (setLine >= 0) return;
      for (let i = 1; i < tokens.length; i++) {
        const code = tolerant && tokens[i].length === 3 ? tokens[i].slice(0, 2) : tokens[i];
        if (PRINTED_LANG[code] && isSetCode(tokens[i - 1])) {
          result.lang = PRINTED_LANG[code];
          result.setCode = tokens[i - 1].toLowerCase();
          setLine = index;
          return;
        }
      }
    });
  }

  // Die Nummer steht in der Zeile über Set und Sprache (bzw. auf alten Karten davor in derselben).
  // Erst dort suchen - darüber liest die Texterkennung oft Bruchstücke des Regeltextkastens, und
  // eine einzelne "7" daraus wäre sonst die Sammlernummer.
  const order = setLine >= 0 ? [setLine - 1, setLine] : lines.map((_, i) => i);
  for (const index of order) {
    const tokens = lines[index] ?? [];
    for (let i = 0; i < tokens.length && !result.collectorNumber; i++) {
      const m = NUMBER_TOKEN.exec(tokens[i]);
      // Ein Set-Kürzel wie "M19" darf nicht als Nummer durchgehen.
      if (m && !(PRINTED_LANG[tokens[i + 1] ?? ''] && isSetCode(tokens[i]))) {
        result.collectorNumber = m[1];
      }
    }
    if (result.collectorNumber) break;
  }
  return result;
}

function isSetCode(token: string): boolean {
  return SET_TOKEN.test(token) && /[A-Z]/.test(token);
}

/** Ein von der Texterkennung gefundenes Wort samt Rahmen (Pixel). */
export interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Foil oder nicht, aus der GRÖSSE des Zeichens zwischen Set-Kürzel und Sprache: Die Texterkennung
 * liest den Punkt (•, nicht-Foil) und den Stern (★, Foil) beide gern als "*" oder "«", aber der
 * Punkt ist nur etwa 0,4 Buchstabenhöhen hoch, der Stern fast eine ganze (gemessen an gerenderten
 * Zeilen). null = keine Aussage möglich (keine Sammlerzeile oder kein Zeichen gefunden).
 */
export function foilFromWords(words: readonly OcrWord[]): boolean | null {
  for (let i = 1; i < words.length; i++) {
    const lang = clean(words[i].text);
    if (!PRINTED_LANG[lang]) continue;
    // Klebt das Zeichen am Sprachcode ("*EN") oder fehlt es, gibt es keine eigene Höhe zu messen.
    const symbolIndex = i - 1;
    if (
      symbolIndex < 1 ||
      isSetCode(clean(words[symbolIndex].text)) ||
      !isSetCode(clean(words[symbolIndex - 1].text))
    ) {
      if (words[i].text.includes('★')) return true;
      continue;
    }
    const symbol = words[symbolIndex].bbox;
    const ref = words[i].bbox;
    const ratio = (symbol.y1 - symbol.y0) / Math.max(1, ref.y1 - ref.y0);
    return ratio > 0.65;
  }
  return null;
}

function clean(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
