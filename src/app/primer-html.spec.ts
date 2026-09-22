import { bereinigePrimerHtml, primerIstLeer, primerText } from './primer-html';

/**
 * Der Primer ist die einzige Stelle der App, an der ein Nutzer Markup schreibt, das anderen
 * angezeigt wird. Die Bereinigung ist damit kein Formatierungsdetail, sondern die Schranke - und
 * eine Schranke, die man nicht prüft, ist geraten.
 */
describe('primer-html', () => {
  describe('bereinigePrimerHtml', () => {
    it('behält die erlaubte Auszeichnung', () => {
      const html =
        '<h2>Plan</h2><p><strong>Ramp</strong> und <em>Karten</em></p><ul><li>Sol Ring</li></ul>';
      expect(bereinigePrimerHtml(html)).toBe(html);
    });

    it('wirft Skripte samt Inhalt weg, statt sie als Text anzuzeigen', () => {
      expect(bereinigePrimerHtml('<p>Hallo</p><script>alert(1)</script>')).toBe('<p>Hallo</p>');
      expect(bereinigePrimerHtml('<p>Hi</p><style>body{display:none}</style>')).toBe('<p>Hi</p>');
    });

    it('entfernt Ereignis-Attribute, Klassen und Stile', () => {
      const html = '<p class="x" style="color:red" onclick="alert(1)">Text</p>';
      expect(bereinigePrimerHtml(html)).toBe('<p>Text</p>');
    });

    it('packt nicht erlaubte Elemente aus, behält aber ihren Text', () => {
      expect(bereinigePrimerHtml('<table><tr><td>Zelle</td></tr></table>')).toBe('Zelle');
      expect(bereinigePrimerHtml('<p><span style="color:red">rot</span></p>')).toBe('<p>rot</p>');
    });

    it('schreibt die Browser-Schreibweisen auf die Wunschform um', () => {
      expect(bereinigePrimerHtml('<b>fett</b> <i>kursiv</i> <strike>weg</strike>')).toBe(
        '<strong>fett</strong> <em>kursiv</em> <s>weg</s>',
      );
      // h1 gehört dem Decknamen, der Inhalt beginnt bei h2.
      expect(bereinigePrimerHtml('<h1>Titel</h1>')).toBe('<h2>Titel</h2>');
    });

    it('macht aus einem div einen Absatz, packt es aber aus, wenn Blöcke darin stehen', () => {
      expect(bereinigePrimerHtml('<div>Zeile</div>')).toBe('<p>Zeile</p>');
      expect(bereinigePrimerHtml('<div><p>eins</p><p>zwei</p></div>')).toBe(
        '<p>eins</p><p>zwei</p>',
      );
    });

    it('lässt nur http(s)- und mailto-Links durch', () => {
      expect(bereinigePrimerHtml('<a href="https://edhrec.com">EDHREC</a>')).toBe(
        '<a href="https://edhrec.com" target="_blank" rel="noopener noreferrer">EDHREC</a>',
      );
      expect(bereinigePrimerHtml('<a href="javascript:alert(1)">Klick</a>')).toBe('Klick');
      // Steuerzeichen mitten im Schema - für den Browser weiterhin javascript:, für einen naiven
      // Vergleich nicht.
      expect(bereinigePrimerHtml('<a href="java\nscript:alert(1)">Klick</a>')).toBe('Klick');
      expect(bereinigePrimerHtml('<a href="/profil">intern</a>')).toBe('intern');
    });

    it('wirft leere Blöcke weg, behält aber eine bewusst leere Zeile', () => {
      // Das <p></p> setzt der Browser beim Umschalten auf eine Liste - es stünde als Lücke im Text.
      expect(bereinigePrimerHtml('<p>Text</p><p></p><ul><li>eins</li></ul>')).toBe(
        '<p>Text</p><ul><li>eins</li></ul>',
      );
      expect(bereinigePrimerHtml('<p>Text</p><p><br></p><p>Mehr</p>')).toBe(
        '<p>Text</p><p><br></p><p>Mehr</p>',
      );
    });

    it('liefert für ein leeres Feld einen leeren String', () => {
      expect(bereinigePrimerHtml('')).toBe('');
      expect(bereinigePrimerHtml('<p><br></p>')).toBe('');
      expect(bereinigePrimerHtml(null)).toBe('');
      expect(bereinigePrimerHtml('<img src="x" onerror="alert(1)">')).toBe('');
    });

    it('bricht zu tiefe Verschachtelung ab, ohne Text zu verlieren', () => {
      const tief = '<div>'.repeat(40) + 'Kern' + '</div>'.repeat(40);
      expect(primerText(bereinigePrimerHtml(tief))).toBe('Kern');
    });
  });

  describe('primerText / primerIstLeer', () => {
    it('zählt nur den sichtbaren Text', () => {
      expect(primerText('<h2>Plan</h2><p>Ramp</p>')).toBe('PlanRamp');
    });

    it('erkennt ein Feld ohne Text als leer', () => {
      expect(primerIstLeer('<p><br></p>')).toBe(true);
      expect(primerIstLeer('<p>&nbsp;</p>')).toBe(true);
      expect(primerIstLeer('<p>x</p>')).toBe(false);
    });
  });
});
