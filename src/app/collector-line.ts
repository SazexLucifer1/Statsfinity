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

/** Ein Druck, der nach dem Artwork in Frage kommt (gleiches Bild, alle Sets und Sprachen). */
export interface CornerCandidate {
  /** Scryfalls Set-Kürzel, klein ("tle", "pmei"). */
  setCode: string;
  /** Scryfalls Sammlernummer ("210", "5s", "86★"). */
  collectorNumber: string;
  /** Scryfalls Sprachcode. */
  lang: string;
}

/**
 * Welcher der Drucke mit diesem Artwork in der Ecke steht. Die Texterkennung muss dafür nicht
 * fehlerfrei lesen, nur zu einem Kandidaten deutlich besser passen als zu allen anderen: Nummer
 * und Set zählen je 3 (ab drei Zeichen auch mit einem falschen Zeichen: 1), die Sprache 2. Ab 5
 * Punkten - also mit mindestens zwei Belegen - und mit Vorsprung gilt der beste. Sonst null, und
 * es bleibt beim genauen Lesen bzw. dem Artwork. Gemessen an 78 Scryfall-Scans, verkleinert und
 * unscharf wie aus der Kamera: ab einer Kartenbreite von 600 px kein falscher Druck; nur
 * Prerelease-Promos werden zum normalen Druck, den Stempel liest die Ecke nicht. Bei kleinerer
 * Karte im Bild verlangt der Scanner `minScore` 6 (Nummer und Set): Dort las die Kamera einmal
 * "DE" als Spanisch.
 */
export function matchCornerText<T extends CornerCandidate>(
  text: string,
  candidates: readonly T[],
  minScore = 5,
): T | null {
  const tokens = text
    .toUpperCase()
    .replace(/[•·★*.,:;|]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const numbers = tokens.map(numberPart).filter((n): n is string => !!n);
  const scored = candidates.map((c) => {
    const number = numberPart(c.collectorNumber.toUpperCase());
    let score = 0;
    if (number) score += bestOf(numbers, number, 3, number.length >= 3);
    // Promo-Drucke ("ptla") tragen das Kürzel des Sets ohne "p" und sehen sonst gleich aus wie
    // der normale Druck - bei Gleichstand gewinnt deshalb das genau gelesene Kürzel (2 statt 3
    // Punkte für das ohne "p"); den Prerelease-Stempel liest die Ecke nicht.
    score += Math.max(
      0,
      ...printedSetCodes(c.setCode).map((code, i) =>
        Math.max(0, bestOf(tokens, code, 3, code.length >= 3) - i),
      ),
    );
    const langs = Object.keys(PRINTED_LANG).filter((code) => PRINTED_LANG[code] === c.lang);
    // Die Sprache nur direkt hinter etwas, das wie ein Set-Kürzel aussieht - zwei Buchstaben
    // liest eine unscharfe Kamera sonst irgendwo ("SP" wäre Spanisch).
    const afterSet = (j: number) => j > 0 && isSetCode(tokens[j - 1]);
    if (tokens.some((t, j) => langs.includes(t) && afterSet(j))) score += 2;
    else if (tokens.some((t, j) => t.length === 3 && langs.includes(t.slice(-2)) && afterSet(j))) {
      score += 1;
    }
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score < minScore || (second && second.score >= best.score)) return null;
  return best.c;
}

/** Ziffern einer Nummer ohne führende Nullen, Seltenheit und Gesamtzahl ("R0210" -> "210"). */
function numberPart(token: string): string | null {
  const m = /^[A-Z]?0*(\d{1,5})/.exec(token.split('/')[0]);
  return m ? m[1] : null;
}

/** Wie das Set auf der Karte stehen kann: Promo-Sets ("ptla") tragen meist das ohne "p". */
function printedSetCodes(setCode: string): string[] {
  const code = setCode.toUpperCase();
  return code.length === 4 && code.startsWith('P') ? [code, code.slice(1)] : [code];
}

/** `full` Punkte für ein exakt gelesenes Wort, 1 für eins mit einem falschen Zeichen. */
function bestOf(tokens: readonly string[], target: string, full: number, fuzzy: boolean): number {
  if (tokens.includes(target)) return full;
  return fuzzy && tokens.some((t) => t.length === target.length && oneOff(t, target)) ? 1 : 0;
}

function oneOff(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length && diff < 2; i++) if (a[i] !== b[i]) diff++;
  return diff === 1;
}

/**
 * Foil oder nicht, aus den PIXELN zwischen Set-Kürzel und Sprache - die Texterkennung lässt das
 * Zeichen oft weg, klebt es an ein Wort ("PRM*EN") oder liest Punkt und Stern gleich. Gemessen
 * wird die Höhe des größten hellen bzw. dunklen Flecks (je nach Schriftfarbe) in der Lücke,
 * bezogen auf die Buchstabenhöhe: der Punkt • ist 0,37 bis 0,46 davon, der Stern ★ 0,67 bis
 * 0,81 (gemessen an 78 Scryfall-Scans, verkleinert und unscharf wie aus der Kamera). `gray` ist das Bild, auf dem `words` erkannt wurden.
 * null = keine Lücke gefunden oder nicht eindeutig.
 */
export function foilFromPixels(
  gray: Uint8Array,
  width: number,
  height: number,
  words: readonly OcrWord[],
): boolean | null {
  const ratio = symbolHeight(gray, width, height, words);
  if (ratio === null) return null;
  // Über FOIL_STAR_MAX ist es kein Zeichen, sondern ein Buchstabe, die Lücke lag also daneben.
  if (ratio >= FOIL_STAR_MIN && ratio <= FOIL_STAR_MAX) return true;
  if (ratio <= FOIL_DOT_MAX) return false;
  return null;
}

/** Höhe des Zeichens in Buchstabenhöhen, null ohne Lücke oder Fleck (siehe foilFromPixels). */
export function symbolHeight(
  gray: Uint8Array,
  width: number,
  height: number,
  words: readonly OcrWord[],
): number | null {
  const gap = symbolGap(words);
  if (!gap) return null;
  const { x0, x1, letters } = gap;
  const h = letters.y1 - letters.y0;
  if (h < 4 || x1 - x0 < 1) return null;
  const y0 = Math.max(0, Math.floor(letters.y0 - 0.2 * h));
  const y1 = Math.min(height, Math.ceil(letters.y1 + 0.2 * h));
  const gx0 = Math.max(0, Math.floor(x0));
  const gx1 = Math.min(width, Math.ceil(x1));
  if (gx1 <= gx0 || y1 <= y0) return null;

  // Schwelle und Schriftfarbe aus den Buchstaben daneben: Schrift ist dort die Minderheit.
  const hist = new Array<number>(256).fill(0);
  for (let y = Math.max(0, letters.y0); y < Math.min(height, letters.y1); y++) {
    for (let x = Math.max(0, letters.x0); x < Math.min(width, letters.x1); x++) {
      hist[gray[y * width + x]]++;
    }
  }
  const threshold = otsu(hist);
  let above = 0;
  let total = 0;
  for (let v = 0; v < 256; v++) {
    total += hist[v];
    if (v > threshold) above += hist[v];
  }
  if (total === 0) return null;
  const brightText = above < total / 2;
  const isInk = (v: number) => (brightText ? v > threshold : v <= threshold);

  // Größter zusammenhängender Fleck in der Lücke.
  const w = gx1 - gx0;
  const seen = new Uint8Array(w * (y1 - y0));
  let tallest = 0;
  let biggest = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = gx0; x < gx1; x++) {
      const i = (y - y0) * w + (x - gx0);
      if (seen[i] || !isInk(gray[y * width + x])) continue;
      let count = 0;
      let top = y;
      let bottom = y;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop()!;
        const jy = Math.floor(j / w);
        const jx = j % w;
        count++;
        top = Math.min(top, jy + y0);
        bottom = Math.max(bottom, jy + y0);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = jx + dx;
          const ny = jy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= y1 - y0) continue;
          const k = ny * w + nx;
          if (!seen[k] && isInk(gray[(ny + y0) * width + nx + gx0])) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
      if (count > biggest) {
        biggest = count;
        tallest = bottom - top + 1;
      }
    }
  }
  return biggest === 0 ? null : tallest / h;
}

/** Ab dieser Höhe (in Buchstabenhöhen) ist das Zeichen ein Stern, bis zu dieser ein Punkt. */
export const FOIL_STAR_MIN = 0.6;
export const FOIL_STAR_MAX = 0.9;
export const FOIL_DOT_MAX = 0.54;

/** Wo zwischen Set-Kürzel und Sprache das Zeichen sitzen muss, samt Buchstaben daneben. */
function symbolGap(
  words: readonly OcrWord[],
): { x0: number; x1: number; letters: OcrWord['bbox'] } | null {
  for (let i = 0; i < words.length; i++) {
    const raw = words[i].text.toUpperCase();
    const b = words[i].bbox;
    const charW = (b.x1 - b.x0) / Math.max(1, raw.length);
    const code = clean(raw);
    // Alles in einem Wort ("PRM*EN", "TLE.EN"): das Zeichen steht vor den letzten beiden.
    if (raw.length >= 5 && PRINTED_LANG[code.slice(-2)] && isSetCode(code.slice(0, -2))) {
      const at = b.x0 + charW * (raw.length - 3);
      if (!/[A-Z0-9]/.test(raw[raw.length - 3]) || code.length === raw.length - 1) {
        return { x0: at - charW * 0.3, x1: at + charW * 1.3, letters: b };
      }
      continue;
    }
    // Sprache allein oder mit angeklebtem Zeichen ("EN", "*EN").
    const lang = code.slice(-2);
    if (!PRINTED_LANG[lang] || code.length !== 2 || raw.length > 3) continue;
    // Set-Kürzel davor, dazwischen höchstens ein Wort aus dem Zeichen selbst.
    for (const back of [1, 2]) {
      const prev = words[i - back];
      if (!prev) break;
      if (!isSetCode(clean(prev.text))) continue;
      const p = prev.bbox;
      const x1 = raw.length === 3 ? b.x0 + charW : b.x0;
      const letters = {
        x0: p.x0,
        y0: Math.min(p.y0, b.y0),
        x1: b.x1,
        y1: Math.max(p.y1, b.y1),
      };
      return { x0: p.x1, x1, letters };
    }
  }
  return null;
}

function otsu(hist: readonly number[]): number {
  let total = 0;
  let sum = 0;
  for (let v = 0; v < 256; v++) {
    total += hist[v];
    sum += v * hist[v];
  }
  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let threshold = 127;
  for (let v = 0; v < 256; v++) {
    weightB += hist[v];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += v * hist[v];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) ** 2;
    if (between > best) {
      best = between;
      threshold = v;
    }
  }
  return threshold;
}

function clean(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Häufige Wörter je Sprache - für Karten, deren Sammlerzeile nicht lesbar ist (auf dem iPhone
 * der Normalfall: gut 1 mm hoch und meist unscharf). Name, Typzeile und Regeltext sind dagegen
 * groß genug für die Texterkennung, und an ihren Wörtern ist die Sprache gut zu erkennen. Ohne
 * Akzente, weil die englische Texterkennung sie ohnehin nicht liefert ("Legendäre" -> "legendare").
 * Bewusst eine Wortliste statt Scryfalls übersetzter Typzeile: die fehlt bei neuen Sets oft.
 * Nur Sprachen in lateinischer Schrift - Japanisch & Co. liest die englische Erkennung nicht.
 */
const LANG_WORDS: Record<string, readonly string[]> = {
  en: [
    'the',
    'you',
    'your',
    'of',
    'to',
    'and',
    'creature',
    'card',
    'target',
    'each',
    'control',
    'when',
    'this',
    'that',
    'with',
    'from',
    'player',
    'until',
    'end',
    'turn',
    'may',
    'its',
    'legendary',
    'instant',
    'sorcery',
    'enchantment',
    'artifact',
    'another',
    'gets',
    'gain',
    'whenever',
  ],
  de: [
    'der',
    'die',
    'das',
    'du',
    'deine',
    'deiner',
    'deinen',
    'deinem',
    'eine',
    'einer',
    'ein',
    'einen',
    'und',
    'oder',
    'kreatur',
    'karte',
    'wenn',
    'bis',
    'zum',
    'ende',
    'zuges',
    'kontrolle',
    'kontrollierst',
    'jede',
    'jeder',
    'ziel',
    'legendare',
    'spontanzauber',
    'hexerei',
    'verzauberung',
    'artefakt',
    'auf',
    'mit',
    'von',
    'nicht',
    'andere',
    'erhaltst',
    'immer',
    'wahl',
  ],
  fr: [
    'le',
    'la',
    'les',
    'des',
    'du',
    'une',
    'un',
    'vous',
    'votre',
    'vos',
    'et',
    'ou',
    'creature',
    'carte',
    'quand',
    'jusqu',
    'fin',
    'tour',
    'chaque',
    'cible',
    'controle',
    'controlez',
    'legendaire',
    'ephemere',
    'rituel',
    'enchantement',
    'artefact',
    'est',
    'autre',
    'gagnez',
    'chaque',
  ],
  es: [
    'el',
    'los',
    'las',
    'del',
    'una',
    'tu',
    'tus',
    'criatura',
    'carta',
    'cuando',
    'hasta',
    'final',
    'turno',
    'cada',
    'objetivo',
    'controlas',
    'legendaria',
    'instantaneo',
    'conjuro',
    'encantamiento',
    'artefacto',
    'otra',
    'ganas',
    'que',
  ],
  it: [
    'il',
    'della',
    'del',
    'di',
    'una',
    'tua',
    'tuo',
    'creatura',
    'carta',
    'quando',
    'fino',
    'fine',
    'turno',
    'ogni',
    'bersaglio',
    'controlli',
    'leggendaria',
    'istantaneo',
    'stregoneria',
    'incantesimo',
    'artefatto',
    'altra',
    'guadagni',
    'che',
  ],
  pt: [
    'os',
    'do',
    'da',
    'uma',
    'um',
    'voce',
    'sua',
    'seu',
    'ou',
    'criatura',
    'carta',
    'quando',
    'ate',
    'final',
    'turno',
    'cada',
    'alvo',
    'controla',
    'lendaria',
    'instantanea',
    'feitico',
    'encantamento',
    'artefato',
    'outra',
    'ganha',
    'que',
  ],
};

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 2);
}

/**
 * Sprache aus gelesenem Kartentext (Name, Typzeile, Regeltext), nur unter den Sprachen, in denen
 * es diesen Druck gibt. Zählt Treffer aus `LANG_WORDS` und - dreifach - Wörter aus dem gedruckten
 * Namen, die NICHT in allen Sprachen gleich sind ("die" in "Liliana, die Makellose", nicht
 * "Liliana"). null, wenn keine Sprache klar vorn liegt.
 */
export function languageFromText(
  text: string,
  candidates: readonly { lang: string; name: string | null }[],
): string | null {
  const read = words(text);
  const nameWords = candidates.map((c) => new Set(words(c.name ?? '')));
  const common = new Set(
    [...(nameWords[0] ?? [])].filter((w) => nameWords.every((set) => set.has(w))),
  );
  const scores = candidates.map((c, i) => {
    const list = new Set(LANG_WORDS[c.lang] ?? []);
    let score = 0;
    for (const w of read) {
      if (list.has(w)) score++;
      if (nameWords[i].has(w) && !common.has(w)) score += 3;
    }
    return { lang: c.lang, score };
  });
  scores.sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  if (!best || best.score < 3) return null;
  return !second || best.score - second.score >= 2 ? best.lang : null;
}
