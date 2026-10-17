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
