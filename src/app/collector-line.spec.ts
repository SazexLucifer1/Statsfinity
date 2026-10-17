import { describe, expect, it } from 'vitest';
import { foilFromWords, parseCollectorLine } from './collector-line';

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
