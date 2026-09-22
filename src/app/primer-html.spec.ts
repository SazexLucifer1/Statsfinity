import {
  bereinigePrimerHtml,
  primerAlsBearbeitbaresHtml,
  primerIstLeer,
  primerKartenNamen,
  primerKartenbilderAlsNamen,
  primerText,
} from './primer-html';

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

  describe('Kürzel im Text', () => {
    it('macht aus {G} und [G] ein Manasymbol', () => {
      expect(bereinigePrimerHtml('<p>Kostet {G}</p>')).toBe(
        '<p>Kostet <i class="ms ms-g ms-cost ms-shadow" aria-hidden="true"></i></p>',
      );
      expect(bereinigePrimerHtml('<p>[U] und {2}</p>')).toBe(
        '<p><i class="ms ms-u ms-cost ms-shadow" aria-hidden="true"></i> und <i class="ms ms-2 ms-cost ms-shadow" aria-hidden="true"></i></p>',
      );
      expect(bereinigePrimerHtml('<p>{U/R}</p>')).toBe(
        '<p><i class="ms ms-ur ms-cost ms-shadow" aria-hidden="true"></i></p>',
      );
    });

    it('lässt Text in Klammern in Ruhe, der kein Symbol ist', () => {
      // {Hallo} würde über manaKlasse() zu einem farblosen Symbol - es soll Text bleiben.
      expect(bereinigePrimerHtml('<p>{Hallo}</p>')).toBe('<p>{Hallo}</p>');
      // Eckige Klammern mit Zahl sind viel öfter eine Fußnote als eine Manakosten-Angabe.
      expect(bereinigePrimerHtml('<p>siehe [1]</p>')).toBe('<p>siehe [1]</p>');
    });

    it('macht aus [[Name]] einen anklickbaren Kartennamen', () => {
      expect(bereinigePrimerHtml('<p>Erst [[Sol Ring]] legen</p>')).toBe(
        '<p>Erst <a class="primer-card" role="button" tabindex="0">Sol Ring</a> legen</p>',
      );
      expect(
        primerKartenNamen(
          '<p><a class="primer-card">Sol Ring</a> und <a class="primer-card">Sol Ring</a></p>',
        ),
      ).toEqual(['Sol Ring']);
    });

    it('übernimmt vorhandene Symbole und Kartenlinks aus der Datenbank unverändert', () => {
      const html =
        '<p><i class="ms ms-g ms-cost ms-shadow" aria-hidden="true"></i> <a class="primer-card" role="button" tabindex="0">Sol Ring</a></p>';
      expect(bereinigePrimerHtml(html)).toBe(html);
    });

    it('wirft erfundene ms-Klassen weg und macht aus <i> sonst Kursiv', () => {
      expect(bereinigePrimerHtml('<i class="ms ms-boom">x</i>')).toBe('<em>x</em>');
      expect(bereinigePrimerHtml('<i>kursiv</i>')).toBe('<em>kursiv</em>');
    });
  });

  describe('Bilder', () => {
    it('lässt Scryfall-Bilder und eigene Uploads durch', () => {
      expect(
        bereinigePrimerHtml(
          '<img src="https://cards.scryfall.io/normal/front/a/b.jpg" alt="Sol Ring">',
        ),
      ).toBe(
        '<img src="https://cards.scryfall.io/normal/front/a/b.jpg" class="primer-image" alt="Sol Ring">',
      );
      const eigenes =
        'https://jkkelwpnrgzbvopszwrl.supabase.co/storage/v1/object/public/primer-images/abc/1.png';
      expect(bereinigePrimerHtml(`<img src="${eigenes}">`)).toBe(
        `<img src="${eigenes}" class="primer-image" alt="">`,
      );
    });

    it('wirft Bilder von überall sonst weg', () => {
      expect(bereinigePrimerHtml('<img src="https://beispiel.invalid/tracker.gif">')).toBe('');
      // Auch ein anderer Bucket desselben Supabase-Projekts ist nicht der Primer-Bucket.
      expect(
        bereinigePrimerHtml(
          '<img src="https://jkkelwpnrgzbvopszwrl.supabase.co/storage/v1/object/public/avatars/x.png">',
        ),
      ).toBe('');
    });

    it('zählt ein Bild als Inhalt, obwohl es keinen Text hat', () => {
      const nurBild = '<img src="https://cards.scryfall.io/normal/front/a/b.jpg" alt="">';
      expect(bereinigePrimerHtml(nurBild)).not.toBe('');
      expect(primerIstLeer(bereinigePrimerHtml(nurBild))).toBe(false);
    });
  });

  describe('Rückweg in den Bearbeiten-Modus', () => {
    it('macht aus Symbol und Kartenlink wieder das Kürzel', () => {
      const gespeichert =
        '<p><i class="ms ms-g ms-cost ms-shadow" aria-hidden="true"></i> über <a class="primer-card" role="button" tabindex="0">Sol Ring</a></p>';
      expect(primerAlsBearbeitbaresHtml(gespeichert)).toBe('<p>{G} über [[Sol Ring]]</p>');
    });

    it('trifft auch Beträge, Hybride und das Tap-Symbol', () => {
      const symbole = ['2', 'ur', 'tap', 'x'].map(
        (k) => `<i class="ms ms-${k} ms-cost ms-shadow" aria-hidden="true"></i>`,
      );
      expect(primerAlsBearbeitbaresHtml(symbole.join(''))).toBe('{2}{U/R}{T}{X}');
    });

    it('kommt heil zurück - Hin- und Rückweg sind zueinander gebaut', () => {
      // Das ist die eigentliche Zusage: Wer den Primer öffnet und ohne Änderung speichert, darf
      // kein Symbol und keinen Kartennamen verlieren.
      const gespeichert = bereinigePrimerHtml(
        '<h2>Plan</h2><p>{G}{2} über [[Sol Ring]], dann [[Llanowar Elves]] und {U/R}.</p>',
      );
      expect(bereinigePrimerHtml(primerAlsBearbeitbaresHtml(gespeichert))).toBe(gespeichert);
    });

    it('lässt Bilder als Bild stehen', () => {
      const bild =
        '<img src="https://cards.scryfall.io/normal/front/a/b.jpg" class="primer-image" alt="Sol Ring">';
      expect(primerAlsBearbeitbaresHtml(bild)).toBe(bild);
    });
  });

  describe('Kartenbilder auf schmalem Bildschirm', () => {
    it('macht aus dem Kartenbild den anklickbaren Namen', () => {
      const html =
        '<p><img src="https://cards.scryfall.io/normal/front/a/b.jpg" class="primer-image" alt="Sol Ring"></p>';
      expect(primerKartenbilderAlsNamen(html)).toBe(
        '<p><a class="primer-card" role="button" tabindex="0">Sol Ring</a></p>',
      );
    });

    it('lässt eigene Uploads Bilder bleiben', () => {
      // Ein eigenes Bild hat keinen Kartennamen, durch den man es ersetzen könnte - und es ist
      // ja gerade als Bild gemeint.
      const eigenes =
        '<img src="https://jkkelwpnrgzbvopszwrl.supabase.co/storage/v1/object/public/primer-images/a/1.png" class="primer-image" alt="">';
      expect(primerKartenbilderAlsNamen(eigenes)).toBe(eigenes);
    });

    it('ändert nur die Anzeige - der umgewandelte Name übersteht die Bereinigung', () => {
      const html =
        '<p><img src="https://cards.scryfall.io/normal/front/a/b.jpg" class="primer-image" alt="Sol Ring"></p>';
      expect(primerKartenNamen(primerKartenbilderAlsNamen(html))).toEqual(['Sol Ring']);
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
