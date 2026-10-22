import { describe, expect, it } from 'vitest';
import {
  foilFromPixels,
  foilFromWords,
  languageFromText,
  matchCornerText,
  OcrWord,
  parseCollectorLine,
} from './collector-line';

describe('parseCollectorLine', () => {
  it('liest die heutige zweizeilige Sammlerzeile', () => {
    expect(parseCollectorLine('R 0087\nFRC • DE VOLKAN BAGA')).toEqual({
      setCode: 'frc',
      collectorNumber: '87',
      lang: 'de',
      foilMark: false,
    });
  });

  it('verträgt Lesefehler der Texterkennung', () => {
    // Echte Ausgaben aus dem Test mit Scryfall-Bildern.
    expect(parseCollectorLine('BERR | M0049 | FRA * EN CYNTHIA SHEPPARD')).toMatchObject({
      setCode: 'fra',
      collectorNumber: '49',
      lang: 'en',
    });
    expect(parseCollectorLine('M 0106 | MDD *EN BASTIEN L DEHARME')).toMatchObject({
      setCode: 'mdd',
      collectorNumber: '106',
      lang: 'en',
    });
    // Bruchstück aus dem Textkasten darüber darf nicht die Nummer werden.
    expect(parseCollectorLine('7 BEATE TA | U 0050 | FRA * EN JEFF MIRACOLA')).toMatchObject({
      collectorNumber: '50',
    });
  });

  it('liest das ältere Format mit Gesamtzahl und Foil-Stern', () => {
    expect(parseCollectorLine('123/264 R\nM19 ★ EN')).toEqual({
      setCode: 'm19',
      collectorNumber: '123',
      lang: 'en',
      foilMark: true,
    });
  });

  it('übersetzt gedruckte Sprachcodes in Scryfalls', () => {
    expect(parseCollectorLine('C 0012\nNEO • JP').lang).toBe('ja');
    expect(parseCollectorLine('C 0012\nDMU • SP').lang).toBe('es');
    expect(parseCollectorLine('C 0012\nDMU • CS').lang).toBe('zhs');
  });

  it('gibt ohne Sammlerzeile nichts vor', () => {
    expect(parseCollectorLine('ILLUS. RON SPENCER')).toEqual({
      setCode: null,
      collectorNumber: null,
      lang: null,
      foilMark: false,
    });
  });
});

describe('foilFromWords', () => {
  const word = (text: string, x0: number, y0: number, x1: number, y1: number) => ({
    text,
    bbox: { x0, y0, x1, y1 },
  });

  it('unterscheidet Punkt und Stern an der Höhe', () => {
    // Rahmen aus der Texterkennung gerenderter Zeilen ("FRC • DE" bzw. "FRC ★ DE").
    expect(
      foilFromWords([
        word('FRC', 34, 102, 114, 136),
        word('«', 137, 112, 150, 125),
        word('DE', 176, 102, 232, 135),
      ]),
    ).toBe(false);
    expect(
      foilFromWords([
        word('FRC', 34, 102, 114, 136),
        word('*', 134, 103, 167, 135),
        word('DE', 190, 102, 246, 135),
      ]),
    ).toBe(true);
  });

  it('macht ohne Zeichen keine Aussage', () => {
    expect(
      foilFromWords([word('FRC', 34, 102, 114, 136), word('DE', 176, 102, 232, 135)]),
    ).toBeNull();
    expect(foilFromWords([word('ILLUS', 0, 0, 50, 20)])).toBeNull();
  });
});

describe('parseCollectorLine mit unscharfer Kamera', () => {
  it('liest die Sprache auch aus einem angehängten Lesefehler', () => {
    // Echte Ausgabe eines iPhone-Bilds von "R 0293 / FRA • DE".
    expect(parseCollectorLine('2\nR Q23 LF J\nRRA DEW ARAAN BRI\n')).toMatchObject({ lang: 'de' });
  });

  it('bevorzugt einen genauen Sprachcode', () => {
    expect(parseCollectorLine('C 0012\nNEO • JP ENX')).toMatchObject({
      setCode: 'neo',
      lang: 'ja',
    });
  });
});

describe('languageFromText', () => {
  // Gedruckte Namen von Liliana, die Makellose (FRA #293) in den Sprachen, die es gibt.
  const candidates = [
    { lang: 'en', name: 'Liliana the Faultless' },
    { lang: 'de', name: 'Liliana, die Makellose' },
    { lang: 'es', name: 'Liliana, la Impecable' },
    { lang: 'fr', name: 'Liliana la vertueuse' },
    { lang: 'it', name: "Liliana l'Impeccabile" },
    { lang: 'ja', name: '過ち無き者、リリアナ' },
  ];

  it('erkennt die Sprache an Name und Typzeile', () => {
    // Echte Lesungen: iPhone-Foto (unscharf) und Scryfall-Bilder.
    expect(
      languageFromText('Liliana, die Bay em\nLegenditre Kreatur — Mensch, Kieriher', candidates),
    ).toBe('de');
    expect(
      languageFromText(
        'Liliana the faultless Legendary Creature — Human Cleric Whenever another creature',
        candidates,
      ),
    ).toBe('en');
    expect(
      languageFromText('Liliana la vertueuse Créature légendaire : humain et clerc', candidates),
    ).toBe('fr');
    expect(
      languageFromText(
        'Liliana, la Impecable Criatura legendaria — Clérigo humano Siempre que otra criatura',
        candidates,
      ),
    ).toBe('es');
  });

  it('rät nicht, wenn nichts Lesbares dasteht', () => {
    expect(languageFromText('g $80 wy ) 5 BomEE. YUP CR', candidates)).toBeNull();
    expect(languageFromText('Liliana', candidates)).toBeNull();
  });
});

describe('matchCornerText', () => {
  const prints = [
    { id: 'en', setCode: 'tle', collectorNumber: '146', lang: 'en' },
    { id: 'de', setCode: 'tle', collectorNumber: '146', lang: 'de' },
    { id: 'fr', setCode: 'tle', collectorNumber: '146', lang: 'fr' },
    { id: 'alt', setCode: 'tle', collectorNumber: '74', lang: 'de' },
  ];

  it('wählt unter den Drucken mit diesem Artwork', () => {
    // Echte Lesung aus dem Browser-Test (4K-Kamera, deutsche Karte).
    const text = 'FE LLU ANULILLVILICI OL\n4 M  A\nU 0146\nTLE DE  3HIY/TOMOYO ASATANI';
    expect(matchCornerText(text, prints)?.id).toBe('de');
  });

  it('verträgt ein falsch gelesenes Zeichen in der Nummer', () => {
    expect(matchCornerText('U 0148\nTLE * FR', prints)?.id).toBe('fr');
  });

  it('entscheidet nicht ohne zwei Belege oder bei Gleichstand', () => {
    expect(matchCornerText('TLE', prints)).toBeNull();
    expect(matchCornerText('U 0146\nTLE', prints)).toBeNull(); // Sprache offen
  });

  it('nimmt zwei Buchstaben nur direkt hinter dem Set als Sprache', () => {
    // Ohne lesbare Nummer: nur Drucke derselben Nummer, sonst stünden zwei deutsche gleichauf.
    const es = [
      ...prints.filter((p) => p.id !== 'alt'),
      { id: 'es', setCode: 'tle', collectorNumber: '146', lang: 'es' },
    ];
    expect(matchCornerText('R OOO N SP\nTLE DE', es)?.id).toBe('de');
  });

  it('nimmt bei gleichem Bild den normalen Druck statt der Prerelease-Promo', () => {
    const promo = [
      { id: 'promo', setCode: 'ptla', collectorNumber: '263s', lang: 'en' },
      { id: 'normal', setCode: 'tla', collectorNumber: '263', lang: 'en' },
    ];
    expect(matchCornerText('R 0263\nTLA EN DOM LAY', promo)?.id).toBe('normal');
  });

  it('verlangt mit minScore 6 Nummer und Set', () => {
    expect(matchCornerText('TLE DE', prints, 6)).toBeNull();
    expect(matchCornerText('U 0146\nTLE DE', prints, 6)?.id).toBe('de');
  });
});

describe('foilFromPixels', () => {
  // Helle Schrift auf dunklem Rand: "TLE", Zeichen, "EN" - Buchstaben 20 px hoch.
  function line(symbolHeight: number): { gray: Uint8Array; words: OcrWord[] } {
    const width = 200;
    const height = 60;
    const gray = new Uint8Array(width * height).fill(20);
    const fill = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) gray[y * width + x] = 230;
    };
    // Buchstaben als senkrechte Striche, damit die Schrift im Wortrahmen die Minderheit ist.
    for (const x of [20, 30, 40, 120, 130]) fill(x, 20, x + 4, 40);
    const top = 30 - Math.floor(symbolHeight / 2);
    fill(78, top, 78 + symbolHeight, top + symbolHeight);
    return {
      gray,
      words: [
        { text: 'TLE', bbox: { x0: 20, y0: 20, x1: 44, y1: 40 } },
        { text: 'EN', bbox: { x0: 120, y0: 20, x1: 134, y1: 40 } },
      ],
    };
  }

  it('erkennt den Punkt als nicht-Foil und den Stern als Foil', () => {
    const dot = line(8);
    expect(foilFromPixels(dot.gray, 200, 60, dot.words)).toBe(false);
    const star = line(15);
    expect(foilFromPixels(star.gray, 200, 60, star.words)).toBe(true);
  });

  it('sagt nichts, wenn die Höhe zwischen Punkt und Stern liegt oder ein Buchstabe ist', () => {
    const unclear = line(11);
    expect(foilFromPixels(unclear.gray, 200, 60, unclear.words)).toBeNull();
    const letter = line(20);
    expect(foilFromPixels(letter.gray, 200, 60, letter.words)).toBeNull();
  });

  it('findet das Zeichen auch, wenn die Texterkennung alles zu einem Wort klebt', () => {
    const star = line(15);
    const merged = [{ text: 'TLE*EN', bbox: { x0: 20, y0: 20, x1: 134, y1: 40 } }];
    // Sechs Zeichen auf 114 px: das vierte (der Stern) liegt bei 77-96.
    expect(foilFromPixels(star.gray, 200, 60, merged)).toBe(true);
  });

  it('findet den Stern auch, wenn ihn die Texterkennung als Buchstaben liest', () => {
    const star = line(15);
    const merged = [{ text: 'TLERDE', bbox: { x0: 20, y0: 20, x1: 134, y1: 40 } }];
    expect(foilFromPixels(star.gray, 200, 60, merged)).toBe(true);
  });

  it('findet den Stern auch im Wortrahmen der Sprache', () => {
    const star = line(15);
    // iPhone: "FRA DE", der Rahmen von "DE" beginnt schon vor dem Stern.
    const words = [star.words[0], { text: 'EN', bbox: { x0: 74, y0: 20, x1: 134, y1: 40 } }];
    expect(foilFromPixels(star.gray, 200, 60, words)).toBe(true);
  });
});
