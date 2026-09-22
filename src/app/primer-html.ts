/**
 * Bereinigung des Primer-HTML (siehe deck-primer/ und sql/deck-primer-2026-09-22.sql).
 *
 * Der Primer wird mit einem contenteditable-Feld geschrieben, und was ein Browser dort erzeugt,
 * ist nicht vorhersehbar: Safari, Chrome und die iOS-Tastatur setzen jeweils eigenes Markup,
 * dazu kommt alles, was beim Einfügen aus einer fremden Seite mitkommt (<script>, <img>,
 * style-Attribute, ganze Tabellen). Gespeichert wird deshalb nie das, was im Feld steht, sondern
 * nur das, was hier durchkommt - eine kurze Positivliste, alles andere wird ausgepackt oder
 * weggeworfen.
 *
 * Das ist die erste von zwei Schichten. Angezeigt wird der Primer über [innerHTML], und Angular
 * bereinigt dabei ein zweites Mal. Die Schicht hier ist trotzdem nötig, weil sie bestimmt, was
 * überhaupt in der Datenbank landet: Angulars Bereinigung schützt nur die eigene Anzeige, nicht
 * den nächsten, der die Spalte ausliest.
 *
 * KEINE neue Abhängigkeit: Der Browser bringt mit DOMParser bereits einen vollständigen
 * HTML-Parser mit. Selbst geschriebene Bereinigung mit regulären Ausdrücken wäre der eine Weg,
 * der hier wirklich gefährlich ist.
 */

/**
 * Obergrenze für den reinen Text (ohne Markup). Der CHECK in der Datenbank begrenzt dagegen das
 * gespeicherte HTML auf 40.000 Zeichen - zwei verschiedene Größen mit zwei verschiedenen Zwecken:
 * Diese hier ist die Ansage an den Schreiber, die andere schützt die Tabelle.
 */
export const PRIMER_MAX_TEXT_LENGTH = 10000;

/**
 * Tags, die im Primer stehen dürfen. Absichtlich klein gehalten: Überschriften, Hervorhebungen,
 * Listen, Zitate, Links. Kein <img> (Bilder gehören nicht in eine Textspalte und die CSP erlaubt
 * ohnehin nur bekannte Quellen), keine Tabellen (auf einem iPhone unlesbar), kein <span> (käme
 * nur mit style-Attributen und damit mit fremden Farben in die Oberfläche).
 */
const ERLAUBTE_TAGS = new Set([
  'P',
  'BR',
  'STRONG',
  'EM',
  'U',
  'S',
  'H2',
  'H3',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'A',
]);

/**
 * Was die Browser statt der Wunschform erzeugen. document.execCommand() setzt je nach Browser
 * <b>/<i>/<strike>, eingefügter Fremdtext bringt <h1> und <h4> mit - inhaltlich ist das dasselbe,
 * nur anders geschrieben, also wird es umgeschrieben statt weggeworfen. <h1> gibt es bewusst
 * nicht: Die Seitenüberschrift ist der Deckname, ein zweites h1 im Inhalt wäre falsch.
 */
const ERSETZTE_TAGS: Record<string, string> = {
  B: 'STRONG',
  I: 'EM',
  STRIKE: 'S',
  DEL: 'S',
  H1: 'H2',
  H4: 'H3',
  H5: 'H3',
  H6: 'H3',
};

/**
 * Elemente, die samt Inhalt verschwinden. Bei allem anderen wird nur das Tag entfernt und der
 * Text behalten - bei diesen hier wäre der "Text" aber der Quelltext selbst, der dann sichtbar
 * mitten im Primer stünde.
 */
const GANZ_WEG = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'NOSCRIPT',
  'TEMPLATE',
  'HEAD',
  'TITLE',
]);

/** Block-Elemente - entscheidet, ob ein <div> zu einem Absatz wird oder nur ausgepackt (siehe unten). */
const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'UL',
  'OL',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'TABLE',
]);

/** Tiefer verschachtelt als das ist kein Primer mehr, sondern eingefügter Seitenquelltext. */
const MAX_TIEFE = 12;

/**
 * Link-Ziel prüfen. Nur http(s) und mailto - "javascript:" ist genau der Grund, warum diese
 * Funktion existiert, und ein relativer Pfad hat in einem Primer nichts zu suchen (er zeigte auf
 * die App selbst und käme nur aus eingefügtem Fremdtext).
 */
function sicheresZiel(href: string | null): string | null {
  const wert = (href ?? '').trim();
  if (!wert) return null;
  // Steuerzeichen raus, bevor geprüft wird: "java\nscript:" ist für den Browser dasselbe wie
  // "javascript:", für einen naiven Vergleich aber nicht.
  const flach = wert.replace(/[\u0000-\u001f\u007f]/g, '');
  return /^(https?:\/\/|mailto:)/i.test(flach) ? flach : null;
}

function uebertrage(quelle: Node, ziel: HTMLElement, doc: Document, tiefe: number): void {
  for (const kind of Array.from(quelle.childNodes)) {
    if (kind.nodeType === 3) {
      ziel.appendChild(doc.createTextNode(kind.nodeValue ?? ''));
      continue;
    }
    if (kind.nodeType !== 1) continue;

    const element = kind as Element;
    const roh = element.tagName.toUpperCase();
    if (GANZ_WEG.has(roh)) continue;

    // Ein <div> ist im contenteditable mal ein Absatz (Safari setzt es beim Zeilenumbruch), mal
    // nur eine Klammer um mehrere Blöcke (eingefügter Fremdtext). Enthält es selbst Blöcke, wird
    // es ausgepackt - sonst stünden Absätze und Listen in einem Absatz.
    let tag = ERSETZTE_TAGS[roh] ?? roh;
    if (roh === 'DIV') {
      const enthaeltBloecke = Array.from(element.children).some((c) =>
        BLOCK_TAGS.has(c.tagName.toUpperCase()),
      );
      tag = enthaeltBloecke ? '' : 'P';
    }

    if (!tag || !ERLAUBTE_TAGS.has(tag) || tiefe >= MAX_TIEFE) {
      // Auspacken statt wegwerfen: Der Text bleibt, nur die Formatierung fällt weg.
      uebertrage(element, ziel, doc, tiefe);
      continue;
    }

    const neu = doc.createElement(tag);
    if (tag === 'A') {
      const ziel_url = sicheresZiel(element.getAttribute('href'));
      if (!ziel_url) {
        uebertrage(element, ziel, doc, tiefe);
        continue;
      }
      neu.setAttribute('href', ziel_url);
      // Die App ist eine PWA - ein fremder Link im selben Tab würde sie verlassen und der Nutzer
      // käme nur über den Zurück-Knopf zurück.
      neu.setAttribute('target', '_blank');
      neu.setAttribute('rel', 'noopener noreferrer');
    }
    // Alle übrigen Attribute fallen weg - auch class und style: Ein Primer soll den Text
    // gliedern, nicht die Oberfläche umfärben.
    uebertrage(element, neu, doc, tiefe + 1);
    // Leere Blöcke fallen weg: execCommand hinterlässt beim Umschalten auf eine Liste oder eine
    // Überschrift regelmäßig ein <p></p>, das als Lücke im Text zu sehen wäre, ohne dass jemand
    // sie gesetzt hätte. Ein bewusst leer gelassener Absatz enthält ein <br> und bleibt deshalb.
    if (neu.childNodes.length === 0 && tag !== 'BR') continue;
    ziel.appendChild(neu);
  }
}

/** Bereinigt HTML aus dem Primer-Feld auf die erlaubte Teilmenge. Liefert '' für leere Eingaben. */
export function bereinigePrimerHtml(html: string | null | undefined): string {
  const eingabe = (html ?? '').trim();
  if (!eingabe) return '';

  const doc = new DOMParser().parseFromString(`<body>${eingabe}</body>`, 'text/html');
  const ziel = doc.createElement('div');
  uebertrage(doc.body, ziel, doc, 0);
  const ergebnis = ziel.innerHTML.trim();
  return primerIstLeer(ergebnis) ? '' : ergebnis;
}

/** Der sichtbare Text ohne Markup - Grundlage der Längenanzeige und der Leer-Prüfung. */
export function primerText(html: string | null | undefined): string {
  const eingabe = html ?? '';
  if (!eingabe) return '';
  const doc = new DOMParser().parseFromString(`<body>${eingabe}</body>`, 'text/html');
  return (doc.body.textContent ?? '').replace(/ /g, ' ').trim();
}

/**
 * true = da steht nichts drin. Ein Feld, in das jemand hineingetippt und alles wieder gelöscht
 * hat, enthält je nach Browser <p><br></p> - das ist kein Primer, sondern ein leeres Feld, und es
 * soll in der Datenbank als NULL landen statt als Markup ohne Text.
 */
export function primerIstLeer(html: string | null | undefined): boolean {
  return primerText(html).length === 0;
}
