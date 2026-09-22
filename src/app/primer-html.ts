import { manaKlasse } from './ui/mana-symbol/mana-symbol';

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
 *
 * Neben dem Aufräumen macht diese Datei die drei Kürzel des Primers zu echtem Markup - beim
 * Speichern, damit im Feld stehen bleiben darf, was der Schreiber getippt hat:
 *
 *   {G} {2} {U/R} {T}   ->  Manasymbol aus der Mana-Schriftart
 *   [G] [X] [T]         ->  dasselbe, aber NUR Farb- und Sondersymbole: [1] und [2] sind in
 *                           einem Text viel öfter eine Fußnote als eine Manakosten-Angabe
 *   [[Sol Ring]]        ->  anklickbarer Kartenname, öffnet die Kartenvorschau
 *
 * Bilder (Kartenbilder von Scryfall, eigene aus dem Supabase-Bucket) stehen als <img> im Text;
 * erlaubt sind nur diese beiden Herkünfte, siehe BILD_QUELLEN.
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
  // <i> ist hier NICHT kursiv (das ist <em>), sondern ausschließlich ein Manasymbol aus der
  // Mana-Schriftart - siehe manaElement(). Ein <i> ohne gültige ms-Klasse wird zu <em>.
  'I',
  'IMG',
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

/** Klasse des anklickbaren Kartennamens - der Name selbst steht als Text im Element. */
export const PRIMER_CARD_CLASS = 'primer-card';

/** Klasse jedes Bildes im Primer. */
export const PRIMER_IMAGE_CLASS = 'primer-image';

/**
 * Woher ein Bild im Primer kommen darf: Kartenbilder von Scryfall und eigene Uploads aus dem
 * Supabase-Bucket dieses Projekts. Beide stehen bereits in der CSP (public/_headers) - ein Bild
 * von irgendwoher würde der Browser also ohnehin blockieren, hier fällt es schon vor dem
 * Speichern weg. Der Bucket-Pfad ist bewusst mitgeprüft: "irgendein Objekt in diesem Supabase"
 * schlösse auch fremde Buckets ein.
 */
const BILD_QUELLEN = [
  'https://cards.scryfall.io/',
  'https://jkkelwpnrgzbvopszwrl.supabase.co/storage/v1/object/public/primer-images/',
];

/**
 * Gültige Kürzel der Mana-Schriftart, wie sie in einer ms-Klasse stehen dürfen: Farben, farblos,
 * X, Energie, Schnee, das Tap-Symbol, generische Beträge und Hybride ("ur", "2b", "gp").
 *
 * Das ist eine PRÜFUNG, keine zweite Zuordnung: Aus einem getippten {G} macht manaKlasse() (siehe
 * ui/mana-symbol) die Klasse. Hier geht es nur um schon vorhandenes Markup - aus der Datenbank
 * oder aus der Zwischenablage -, dessen Klasse niemand ungeprüft weiterreichen sollte.
 */
const MANA_KUERZEL = /^(?:[wubrgcxes]|tap|\d{1,2}|[wubrg0-9]+[wubrgp])$/;

/** Text-Kürzel: alles in geschweiften Klammern, in eckigen nur Farben und Sondersymbole. */
const KUERZEL = /\{([^{}\n]{1,5})\}|\[([WUBRGCXESTwubrgcxest])\]|\[\[([^\[\]\n]{1,120})\]\]/g;

/**
 * Ein <i> ist im Primer ein Manasymbol - aber nur mit gültiger ms-Klasse. Liefert das saubere
 * Element oder null, dann behandelt der Aufrufer das <i> als gewöhnliches Kursiv.
 */
function manaElement(element: Element, doc: Document): HTMLElement | null {
  const kuerzel = Array.from(element.classList)
    .filter((klasse) => klasse.startsWith('ms-'))
    .map((klasse) => klasse.slice(3).toLowerCase())
    .find((token) => MANA_KUERZEL.test(token));
  if (!kuerzel) return null;
  const neu = doc.createElement('i');
  // Klasse neu zusammensetzen statt übernehmen: Was sonst noch in class stand (fremde Stile,
  // Größenklassen), hat im Primer nichts zu suchen.
  neu.setAttribute('class', manaKlasse(kuerzel));
  neu.setAttribute('aria-hidden', 'true');
  return neu;
}

/** Bild mit erlaubter Herkunft, sonst null (das Bild fällt dann ersatzlos weg). */
function bildElement(element: Element, doc: Document): HTMLElement | null {
  const src = (element.getAttribute('src') ?? '').trim();
  if (!BILD_QUELLEN.some((praefix) => src.startsWith(praefix))) return null;
  const neu = doc.createElement('img');
  neu.setAttribute('src', src);
  neu.setAttribute('class', PRIMER_IMAGE_CLASS);
  neu.setAttribute('alt', (element.getAttribute('alt') ?? '').slice(0, 120));
  return neu;
}

/**
 * Macht aus einem Textstück die drei Kürzel (siehe Kopf). Hängt das Ergebnis - Text und Elemente
 * gemischt - an ziel an.
 */
function schreibeTextMitKuerzeln(text: string, ziel: HTMLElement, doc: Document): void {
  let zuletzt = 0;
  for (const treffer of text.matchAll(KUERZEL)) {
    const start = treffer.index ?? 0;
    const [ganzes, geschweift, eckig, karte] = treffer;

    let element: HTMLElement | null = null;
    if (karte !== undefined) {
      const name = karte.trim();
      if (name) {
        element = doc.createElement('a');
        element.setAttribute('class', PRIMER_CARD_CLASS);
        // Kein href: Der Klick öffnet die Kartenvorschau in der App, er führt nirgendwohin.
        // role/tabindex machen ihn trotzdem für Tastatur und Screenreader erreichbar.
        element.setAttribute('role', 'button');
        element.setAttribute('tabindex', '0');
        element.appendChild(doc.createTextNode(name));
      }
    } else {
      const symbol = (geschweift ?? eckig ?? '').trim();
      // {} mit Unsinn darin ({Hallo}) bleibt Text. Geprüft wird das GETIPPTE Symbol, nicht die
      // daraus gebaute Klasse: manaKlasse() macht aus allem Unbekannten ein farbloses Symbol -
      // {Hallo} stünde dann als {C} im Text und behauptete etwas, das niemand geschrieben hat.
      if (istManaSymbol(symbol)) {
        element = doc.createElement('i');
        element.setAttribute('class', manaKlasse(symbol));
        element.setAttribute('aria-hidden', 'true');
      }
    }

    if (!element) continue;
    if (start > zuletzt) ziel.appendChild(doc.createTextNode(text.slice(zuletzt, start)));
    ziel.appendChild(element);
    zuletzt = start + ganzes.length;
  }
  if (zuletzt < text.length) ziel.appendChild(doc.createTextNode(text.slice(zuletzt)));
}

/** Schreibweisen, die als getipptes Manasymbol gelten: Farbe, Betrag, X/E/S/T, farblos, Hybrid. */
const MANA_EINGABE = /^(?:[WUBRGCXEST]|\d{1,2}|[WUBRG0-9]+\/[WUBRGP])$/i;

function istManaSymbol(symbol: string): boolean {
  return MANA_EINGABE.test(symbol);
}

function uebertrage(quelle: Node, ziel: HTMLElement, doc: Document, tiefe: number): void {
  for (const kind of Array.from(quelle.childNodes)) {
    if (kind.nodeType === 3) {
      const text = kind.nodeValue ?? '';
      // In einem Kartenlink steht schon ein Kartenname - dort noch einmal nach [[...]] zu suchen,
      // verschachtelte nur Links ineinander.
      if (ziel.tagName === 'A') ziel.appendChild(doc.createTextNode(text));
      else schreibeTextMitKuerzeln(text, ziel, doc);
      continue;
    }
    if (kind.nodeType !== 1) continue;

    const element = kind as Element;
    const roh = element.tagName.toUpperCase();
    if (GANZ_WEG.has(roh)) continue;

    // Ein <div> ist im contenteditable mal ein Absatz (Safari setzt es beim Zeilenumbruch), mal
    // nur eine Klammer um mehrere Blöcke (eingefügter Fremdtext). Enthält es selbst Blöcke, wird
    // es ausgepackt - sonst stünden Absätze und Listen in einem Absatz.
    // Manasymbol und Bild bringen ihre eigenen Regeln mit und sind danach fertig - sie haben
    // keinen Inhalt, der noch übertragen werden müsste.
    if (roh === 'I' || roh === 'EM') {
      const symbol = manaElement(element, doc);
      if (symbol) {
        ziel.appendChild(symbol);
        continue;
      }
    }
    if (roh === 'IMG') {
      const bild = bildElement(element, doc);
      if (bild) ziel.appendChild(bild);
      continue;
    }

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
      // Ein Kartenlink hat bewusst kein href (der Klick öffnet die Vorschau in der App) - er ist
      // am Klassennamen zu erkennen und behält ihn.
      if (element.classList.contains(PRIMER_CARD_CLASS)) {
        neu.setAttribute('class', PRIMER_CARD_CLASS);
        neu.setAttribute('role', 'button');
        neu.setAttribute('tabindex', '0');
        uebertrage(element, neu, doc, tiefe + 1);
        if (neu.childNodes.length === 0) continue;
        ziel.appendChild(neu);
        continue;
      }
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
    if (neu.childNodes.length === 0 && tag !== 'BR' && tag !== 'IMG' && tag !== 'I') continue;
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
 *
 * Bild und Manasymbol zählen mit, obwohl sie keinen Text haben: Ein Primer, der nur aus dem
 * Kartenbild des Commanders besteht, ist eine Aussage - ihn als "leer" wegzuwerfen wäre
 * Datenverlust.
 */
export function primerIstLeer(html: string | null | undefined): boolean {
  if (primerText(html).length > 0) return false;
  const eingabe = html ?? '';
  if (!eingabe) return true;
  const doc = new DOMParser().parseFromString(`<body>${eingabe}</body>`, 'text/html');
  return doc.body.querySelector('img, i.ms') === null;
}

/**
 * Alle Kartennamen, die als anklickbarer Link im Primer stehen. Die Anzeige lädt damit die Bilder
 * EINMAL gebündelt nach, statt bei jedem Klick eine eigene Scryfall-Anfrage zu stellen - beim
 * ersten Klick stünde man sonst spürbar vor einem leeren Fenster.
 */
export function primerKartenNamen(html: string | null | undefined): string[] {
  const eingabe = html ?? '';
  if (!eingabe) return [];
  const doc = new DOMParser().parseFromString(`<body>${eingabe}</body>`, 'text/html');
  const namen = Array.from(doc.querySelectorAll(`a.${PRIMER_CARD_CLASS}`))
    .map((el) => (el.textContent ?? '').trim())
    .filter((name) => name.length > 0);
  return [...new Set(namen)];
}
