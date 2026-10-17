import { describe, expect, it } from 'vitest';
import { foilFromWords, languageFromText, parseCollectorLine } from './collector-line';

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
