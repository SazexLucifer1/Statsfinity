import { manaKlasse } from './ui/mana-symbol/mana-symbol';
import { bildAusDataUrl, kartenBildAlsDataUrl } from './card-image-datauri';

/**
 * Zeichnet den Steckbrief eines Decks - die Kurzvorstellung zum Teilen, Vorbild deckpassport.com.
 *
 * Diese Datei ist der GANZE Steckbrief: Was hier gezeichnet wird, ist zugleich die Vorschau im
 * Reiter und die heruntergeladene Datei - die Komponente zeigt schlicht dieses Canvas an. Es gibt
 * bewusst keine zweite, in HTML nachgebaute Fassung des Layouts: zwei Fassungen desselben Bildes
 * laufen auseinander, und dann lädt jemand etwas herunter, das anders aussieht als das, was er
 * angesehen hat.
 *
 * Quadratisch 1080x1080, weil das Bild vor allem in Beiträgen landet (Reddit, Discord) und dort
 * ungeschnitten durchkommt. Gezeichnet wird immer in voller Größe; die Anzeige skaliert das
 * Canvas per CSS herunter.
 *
 * Alle Texte kommen fertig übersetzt von außen herein (SteckbriefDaten) - diese Datei kennt keine
 * Sprache und keinen i18n-Service.
 */

/** Kantenlänge des erzeugten Bildes in Pixeln. */
export const STECKBRIEF_GROESSE = 1080;

/**
 * Obergrenze je Freitextfeld. Dieselbe Zahl steht als check-Constraint in der Datenbank
 * (sql/deck-steckbrief-2026-09-22.sql) - hier, damit die Meldung vor dem Absenden kommt, dort,
 * damit sie auch für einen direkten API-Aufruf gilt. 220 Zeichen sind rund fünf Zeilen im Bild;
 * mehr passt schlicht nicht mehr hinein.
 */
export const STECKBRIEF_MAX_LAENGE = 220;

/** Eine Kennzahl im unteren Band, z.B. "99" / "Karten". Beides fertig übersetzt. */
export interface SteckbriefKachel {
  wert: string;
  label: string;
}

/** Ein selbst geschriebener Absatz, z.B. "Wie gewinnt es?" / "Über Krenko-Marken …". */
export interface SteckbriefTextblock {
  titel: string;
  text: string;
}

export interface SteckbriefDaten {
  deckName: string;
  /** Namen der markierten Commander (bei Partnern zwei) - leer, wenn keiner markiert ist. */
  commanderNamen: string[];
  /** Kartenbilder der Commander, in derselben Reihenfolge. Fehlende Bilder werden übersprungen. */
  commanderBildUrls: string[];
  /** Farbidentität als W/U/B/R/G. Leer = farblos, dann steht ein einzelnes {C} da. */
  farben: string[];
  /** Zeile unter dem Decknamen, z.B. "Commander · Elf" - fertig zusammengesetzt. */
  untertitel: string | null;
  /** Bracket-Abzeichen, z.B. "B3 · Upgraded". null = kein Bracket bekannt, dann fehlt das Abzeichen. */
  bracketText: string | null;
  /** true = automatisch geschätzt (gestrichelter Rand, wie das Abzeichen in der App). */
  bracketGeschaetzt: boolean;
  /** Die ausgefüllten Freitextfelder. Leer = es gibt keine, dann wird das Commander-Bild groß. */
  textbloecke: SteckbriefTextblock[];
  kacheln: SteckbriefKachel[];
  /** Kleingedrucktes unten, z.B. "Statsfinity · 22.09.2026". */
  fusszeile: string;
}

const RAND = 56;
const SCHRIFT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif";
/** Seitenverhältnis einer Magic-Karte (63 x 88 mm). */
const KARTEN_VERHAELTNIS = 88 / 63;

/**
 * Zeichnet den Steckbrief auf das übergebene Canvas. Setzt dessen Pixelgröße selbst.
 *
 * Bilder werden vorher über kartenBildAlsDataUrl() geholt und damit als data:-URL eingebettet -
 * ein direkt geladenes Fremdbild würde das Canvas vergiften und den Download mit einem
 * SecurityError beenden. Fehlt ein Bild, zeichnet die Funktion trotzdem: An seiner Stelle steht
 * dann nur der Kartenname.
 */
export async function zeichneSteckbrief(
  canvas: HTMLCanvasElement,
  daten: SteckbriefDaten,
): Promise<void> {
  canvas.width = STECKBRIEF_GROESSE;
  canvas.height = STECKBRIEF_GROESSE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Die Manaschrift muss geladen sein, BEVOR gemessen und gezeichnet wird - sonst misst das Canvas
  // die Ersatzschrift und die Symbole sitzen daneben oder fehlen ganz.
  await manaSchriftLaden();

  const bilder = await Promise.all(
    daten.commanderBildUrls.slice(0, 2).map(async (url) => {
      const dataUrl = await kartenBildAlsDataUrl(url);
      return dataUrl ? await bildAusDataUrl(dataUrl) : null;
    }),
  );
  const kartenBilder = bilder.filter((b): b is HTMLImageElement => b !== null);

  hintergrund(ctx, kartenBilder[0] ?? null);
  const kopfEnde = kopfbereich(ctx, daten);
  const kachelOben = kachelBand(ctx, daten.kacheln);
  mitte(ctx, daten, kartenBilder, kopfEnde, kachelOben);
  fusszeile(ctx, daten.fusszeile);
}

/** Das fertige Bild als PNG-Blob - genau das, was der Download-Knopf speichert. */
export function steckbriefAlsBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

// ---------------------------------------------------------------------------
// Die einzelnen Bänder
// ---------------------------------------------------------------------------

/**
 * Hintergrund: das Commander-Artwork bildfüllend, darüber ein dunkler Verlauf. Ohne den Verlauf
 * schwankt die Lesbarkeit mit dem Motiv - genau deshalb steht in styles.scss dieselbe Überlegung
 * hinter dem angehobenen --glass-bg.
 */
function hintergrund(ctx: CanvasRenderingContext2D, bild: HTMLImageElement | null): void {
  ctx.fillStyle = '#0c0817';
  ctx.fillRect(0, 0, STECKBRIEF_GROESSE, STECKBRIEF_GROESSE);

  if (bild) {
    // Nur das Artwork-Fenster der Karte nehmen (grob das obere Drittel unterhalb des Titelbalkens)
    // und bildfüllend aufziehen - mitsamt Titelbalken und Regeltext stünden hinter dem Decknamen
    // lesbare Buchstaben, und das sieht nach Versehen aus statt nach Hintergrund.
    const quellOben = bild.height * 0.1;
    const quellHoehe = bild.height * 0.42;
    // Etwas über den Rand hinaus zeichnen: Die Unschärfe unten zieht sonst die durchsichtigen
    // Ränder des Bildes mit ins Sichtbare und es entsteht ein heller Saum.
    const ueberstand = 80;
    const ziel = STECKBRIEF_GROESSE + 2 * ueberstand;
    const skala = Math.max(ziel / bild.width, ziel / quellHoehe);
    const zielBreite = bild.width * skala;
    const zielHoehe = quellHoehe * skala;
    ctx.save();
    ctx.globalAlpha = 0.9;
    // Weichzeichnen, damit vom Motiv Farbe und Stimmung bleiben, aber nichts mehr mit dem Text
    // davor konkurriert. Kennt der Browser den Filter nicht (ältere Safari-Fassungen), wird
    // schlicht scharf gezeichnet - dafür sorgt zusätzlich der dunkle Verlauf darüber.
    ctx.filter = 'blur(26px)';
    ctx.drawImage(
      bild,
      0,
      quellOben,
      bild.width,
      quellHoehe,
      (STECKBRIEF_GROESSE - zielBreite) / 2,
      (STECKBRIEF_GROESSE - zielHoehe) / 2,
      zielBreite,
      zielHoehe,
    );
    ctx.restore();
  }

  const verlauf = ctx.createLinearGradient(0, 0, 0, STECKBRIEF_GROESSE);
  verlauf.addColorStop(0, 'rgba(12, 8, 23, 0.6)');
  verlauf.addColorStop(0.45, 'rgba(12, 8, 23, 0.82)');
  verlauf.addColorStop(1, 'rgba(12, 8, 23, 0.95)');
  ctx.fillStyle = verlauf;
  ctx.fillRect(0, 0, STECKBRIEF_GROESSE, STECKBRIEF_GROESSE);
}

/** Deckname, Commander, Manasymbole und Bracket-Abzeichen. Liefert das untere Ende des Bandes. */
function kopfbereich(ctx: CanvasRenderingContext2D, daten: SteckbriefDaten): number {
  const bracketBreite = daten.bracketText ? bracketAbzeichen(ctx, daten, true) : 0;
  const nameBreite = STECKBRIEF_GROESSE - 2 * RAND - (bracketBreite ? bracketBreite + 24 : 0);

  let y = RAND + 12;
  // Der Deckname darf schrumpfen, bevor er umbricht: Zwei Zeilen Titel drücken alles darunter
  // zusammen, und die meisten Decknamen passen in einer Zeile, wenn man sie etwas kleiner setzt.
  const titelGroesse = passendeSchriftgroesse(ctx, daten.deckName, nameBreite, 60, 40);
  ctx.font = `700 ${titelGroesse}px ${SCHRIFT}`;
  ctx.fillStyle = '#f4f2fa';
  ctx.textBaseline = 'top';
  const titelZeilen = umbrich(ctx, daten.deckName, nameBreite, 2);
  for (const zeile of titelZeilen) {
    ctx.fillText(zeile, RAND, y);
    y += titelGroesse * 1.14;
  }

  if (daten.commanderNamen.length) {
    y += 6;
    ctx.font = `500 30px ${SCHRIFT}`;
    ctx.fillStyle = 'rgba(244, 242, 250, 0.72)';
    ctx.fillText(kuerzeAufBreite(ctx, daten.commanderNamen.join(' + '), nameBreite), RAND, y);
    y += 40;
  }

  y += 14;
  let x = RAND;
  const symbole = daten.farben.length ? daten.farben : ['C'];
  for (const farbe of symbole) {
    manaSymbol(ctx, farbe, x, y, 44);
    x += 52;
  }

  if (daten.untertitel) {
    ctx.font = `500 26px ${SCHRIFT}`;
    ctx.fillStyle = 'rgba(244, 242, 250, 0.66)';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      kuerzeAufBreite(ctx, daten.untertitel, STECKBRIEF_GROESSE - RAND - x - 16),
      x + 8,
      y + 22,
    );
    ctx.textBaseline = 'top';
  }

  if (daten.bracketText) bracketAbzeichen(ctx, daten, false);

  return y + 44 + 20;
}

/**
 * Das Bracket-Abzeichen oben rechts. Mit `nurMessen` liefert es bloß seine Breite zurück, ohne zu
 * zeichnen - der Deckname daneben braucht die, bevor er umbricht.
 *
 * Geschätzt gegen selbst festgelegt wird sichtbar unterschieden (gestrichelter gegen durchgezogener
 * Rand), genau wie beim Abzeichen in der App (ui/bracket-badge).
 */
function bracketAbzeichen(
  ctx: CanvasRenderingContext2D,
  daten: SteckbriefDaten,
  nurMessen: boolean,
): number {
  const text = daten.bracketText ?? '';
  ctx.font = `600 26px ${SCHRIFT}`;
  const breite = ctx.measureText(text).width + 40;
  if (nurMessen) return breite;

  const hoehe = 52;
  const x = STECKBRIEF_GROESSE - RAND - breite;
  const y = RAND + 14;
  ctx.save();
  rundesRechteck(ctx, x, y, breite, hoehe, 26);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 209, 102, 0.75)';
  ctx.lineWidth = 2;
  if (daten.bracketGeschaetzt) ctx.setLineDash([7, 6]);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = '#ffd166';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 20, y + hoehe / 2 + 1);
  ctx.textBaseline = 'top';
  return breite;
}

/**
 * Das Kennzahlen-Band unten. Liefert seine Oberkante zurück, damit der mittlere Bereich weiß, wie
 * viel Platz ihm bleibt.
 *
 * Bis vier Kacheln stehen nebeneinander, ab fünf in zwei Reihen zu drei - vier schmale Kacheln
 * sind noch lesbar, sechs wären es nicht mehr.
 */
function kachelBand(ctx: CanvasRenderingContext2D, kacheln: SteckbriefKachel[]): number {
  if (!kacheln.length) return STECKBRIEF_GROESSE - RAND - 40;

  const spalten = kacheln.length <= 4 ? kacheln.length : 3;
  const reihen = Math.ceil(kacheln.length / spalten);
  const abstand = 16;
  const breite = (STECKBRIEF_GROESSE - 2 * RAND - abstand * (spalten - 1)) / spalten;
  const hoehe = 116;
  const oben = STECKBRIEF_GROESSE - RAND - 46 - reihen * hoehe - (reihen - 1) * abstand;

  kacheln.forEach((kachel, i) => {
    const x = RAND + (i % spalten) * (breite + abstand);
    const y = oben + Math.floor(i / spalten) * (hoehe + abstand);

    rundesRechteck(ctx, x, y, breite, hoehe, 18);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 46px ${SCHRIFT}`;
    ctx.fillStyle = '#f4f2fa';
    ctx.fillText(kuerzeAufBreite(ctx, kachel.wert, breite - 20), x + breite / 2, y + 62);
    ctx.font = `500 22px ${SCHRIFT}`;
    ctx.fillStyle = 'rgba(244, 242, 250, 0.64)';
    ctx.fillText(kuerzeAufBreite(ctx, kachel.label, breite - 16), x + breite / 2, y + 95);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  });

  return oben;
}

/**
 * Der mittlere Bereich: links das Commander-Bild, rechts die selbst geschriebenen Absätze.
 *
 * Gibt es keinen einzigen Absatz (fremdes Deck ohne Steckbrief-Text, oder die Migration steht noch
 * aus), wäre die rechte Spalte leer und das Bild sähe kaputt aus. Dann rücken die Kartenbilder
 * stattdessen in die Mitte und werden größer - das ist keine Notlösung, sondern die ehrlichere
 * Darstellung: Zu sagen hat dieses Deck dann nur seine Karte.
 */
function mitte(
  ctx: CanvasRenderingContext2D,
  daten: SteckbriefDaten,
  bilder: HTMLImageElement[],
  oben: number,
  unten: number,
): void {
  const hoehe = unten - oben - 24;
  if (hoehe < 80) return;

  if (!daten.textbloecke.length) {
    kartenReihe(
      ctx,
      bilder,
      daten.commanderNamen,
      RAND,
      oben,
      STECKBRIEF_GROESSE - 2 * RAND,
      hoehe,
      true,
    );
    return;
  }

  // So groß, dass die Karte das mittlere Band ausfüllt - gedeckelt auf zwei Fünftel der Breite,
  // damit für die Sätze daneben genug Zeile bleibt. Kleiner sähe verloren aus: Unter einem
  // schmalen Bild klaffte sonst bis zu den Kacheln eine leere Fläche.
  const bildBreite = Math.min(hoehe / KARTEN_VERHAELTNIS, (STECKBRIEF_GROESSE - 2 * RAND) * 0.4);
  kartenReihe(ctx, bilder, daten.commanderNamen, RAND, oben, bildBreite, hoehe, false);

  const x = RAND + bildBreite + 36;
  const breite = STECKBRIEF_GROESSE - RAND - x;
  let y = oben + 4;
  // Der Platz wird gleichmäßig auf die vorhandenen Absätze verteilt: Bei nur einem darf er die
  // ganze Höhe nutzen, bei zweien bekommt keiner mehr als die Hälfte - sonst schöbe ein langer
  // erster Absatz den zweiten aus dem Bild.
  const proBlock = hoehe / daten.textbloecke.length;
  for (const block of daten.textbloecke) {
    ctx.font = `700 24px ${SCHRIFT}`;
    ctx.fillStyle = '#8ab4ff';
    ctx.fillText(kuerzeAufBreite(ctx, block.titel.toUpperCase(), breite), x, y);
    y += 38;

    ctx.font = `400 28px ${SCHRIFT}`;
    ctx.fillStyle = 'rgba(244, 242, 250, 0.92)';
    const maxZeilen = Math.max(1, Math.floor((proBlock - 54) / 38));
    for (const zeile of umbrich(ctx, block.text, breite, maxZeilen)) {
      ctx.fillText(zeile, x, y);
      y += 38;
    }
    y += 22;
  }
}

/**
 * Ein oder zwei Commander-Kartenbilder nebeneinander, an der Oberkante ausgerichtet. Ohne Bild
 * steht an seiner Stelle ein Platzhalter mit dem Kartennamen - dieselbe Regel wie überall sonst
 * in der App: kein Bild heißt Name, nicht leere Fläche.
 */
function kartenReihe(
  ctx: CanvasRenderingContext2D,
  bilder: HTMLImageElement[],
  namen: string[],
  x: number,
  y: number,
  maxBreite: number,
  maxHoehe: number,
  zentriert: boolean,
): void {
  const anzahl = Math.max(1, Math.min(2, bilder.length || namen.length || 1));
  const abstand = 20;
  let breite = (maxBreite - abstand * (anzahl - 1)) / anzahl;
  let hoehe = breite * KARTEN_VERHAELTNIS;
  if (hoehe > maxHoehe) {
    hoehe = maxHoehe;
    breite = hoehe / KARTEN_VERHAELTNIS;
  }
  const gesamt = breite * anzahl + abstand * (anzahl - 1);
  let links = zentriert ? x + (maxBreite - gesamt) / 2 : x;

  for (let i = 0; i < anzahl; i++) {
    ctx.save();
    rundesRechteck(ctx, links, y, breite, hoehe, breite * 0.05);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fill();
    const bild = bilder[i];
    if (bild) {
      ctx.clip();
      ctx.drawImage(bild, links, y, breite, hoehe);
    }
    ctx.restore();

    if (!bild) {
      ctx.save();
      ctx.font = `500 24px ${SCHRIFT}`;
      ctx.fillStyle = 'rgba(244, 242, 250, 0.7)';
      ctx.textAlign = 'center';
      let ty = y + hoehe / 2 - 16;
      for (const zeile of umbrich(ctx, namen[i] ?? '', breite - 24, 3)) {
        ctx.fillText(zeile, links + breite / 2, ty);
        ty += 32;
      }
      ctx.restore();
    }

    ctx.save();
    rundesRechteck(ctx, links, y, breite, hoehe, breite * 0.05);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    links += breite + abstand;
  }
}

function fusszeile(ctx: CanvasRenderingContext2D, text: string): void {
  ctx.font = `500 22px ${SCHRIFT}`;
  ctx.fillStyle = 'rgba(244, 242, 250, 0.45)';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, RAND, STECKBRIEF_GROESSE - RAND + 8);
  ctx.textBaseline = 'top';
}

// ---------------------------------------------------------------------------
// Zeichen-Handwerkszeug
// ---------------------------------------------------------------------------

function rundesRechteck(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  breite: number,
  hoehe: number,
  radius: number,
): void {
  const r = Math.min(radius, breite / 2, hoehe / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + breite, y, x + breite, y + hoehe, r);
  ctx.arcTo(x + breite, y + hoehe, x, y + hoehe, r);
  ctx.arcTo(x, y + hoehe, x, y, r);
  ctx.arcTo(x, y, x + breite, y, r);
  ctx.closePath();
}

/** Bricht an Wortgrenzen um. Die letzte erlaubte Zeile bekommt bei Überlänge ein Auslassungszeichen. */
function umbrich(
  ctx: CanvasRenderingContext2D,
  text: string,
  breite: number,
  maxZeilen: number,
): string[] {
  const woerter = text.trim().split(/\s+/).filter(Boolean);
  if (!woerter.length) return [];
  const zeilen: string[] = [];
  let aktuell = '';

  for (const wort of woerter) {
    const versuch = aktuell ? `${aktuell} ${wort}` : wort;
    if (ctx.measureText(versuch).width <= breite || !aktuell) {
      aktuell = versuch;
      continue;
    }
    zeilen.push(aktuell);
    aktuell = wort;
    if (zeilen.length === maxZeilen) break;
  }

  if (zeilen.length < maxZeilen && aktuell) zeilen.push(aktuell);
  if (zeilen.length > maxZeilen) zeilen.length = maxZeilen;

  // Steht noch Text aus, endet die letzte Zeile mit "…" statt mitten im Satz.
  const gezeigt = zeilen.join(' ');
  if (gezeigt.replace(/\s+/g, ' ') !== woerter.join(' ') && zeilen.length) {
    zeilen[zeilen.length - 1] = kuerzeAufBreite(ctx, `${zeilen[zeilen.length - 1]} …`, breite);
  }
  return zeilen;
}

/** Kürzt einzeilig auf die Breite und hängt ein Auslassungszeichen an. */
function kuerzeAufBreite(ctx: CanvasRenderingContext2D, text: string, breite: number): string {
  if (ctx.measureText(text).width <= breite) return text;
  let kurz = text;
  while (kurz.length > 1 && ctx.measureText(`${kurz}…`).width > breite) {
    kurz = kurz.slice(0, -1);
  }
  return `${kurz.trimEnd()}…`;
}

/** Größte Schriftgröße, in der der Text noch in eine Zeile passt - nie kleiner als `min`. */
function passendeSchriftgroesse(
  ctx: CanvasRenderingContext2D,
  text: string,
  breite: number,
  max: number,
  min: number,
): number {
  for (let groesse = max; groesse > min; groesse -= 2) {
    ctx.font = `700 ${groesse}px ${SCHRIFT}`;
    if (ctx.measureText(text).width <= breite) return groesse;
  }
  return min;
}

// ---------------------------------------------------------------------------
// Manasymbole
// ---------------------------------------------------------------------------

/**
 * Zeichen und Hintergrundfarbe eines Manasymbols - beides aus dem fertig berechneten Stil der
 * Manaschrift ausgelesen, nicht hier noch einmal aufgeschrieben.
 *
 * Grund: Die Zuordnung "Farbe -> Zeichen -> Kreisfarbe" steht bereits im Paket mana-font (siehe
 * src/styles/_mana.scss). Eine zweite Tabelle hier sähe nach dem nächsten Paket-Update anders aus
 * als die Symbole überall sonst in der App. Also legt diese Funktion kurz ein unsichtbares
 * Element mit genau der Klasse an, die auch ui/mana-symbol setzt, und fragt den Browser.
 */
const symbolCache = new Map<string, { zeichen: string; farbe: string } | null>();

function symbolAussehen(symbol: string): { zeichen: string; farbe: string } | null {
  const vorhanden = symbolCache.get(symbol);
  if (vorhanden !== undefined) return vorhanden;

  const probe = document.createElement('i');
  probe.className = manaKlasse(symbol);
  probe.style.position = 'absolute';
  probe.style.left = '-9999px';
  probe.style.top = '0';
  document.body.appendChild(probe);
  const inhalt = getComputedStyle(probe, '::before').content;
  const farbe = getComputedStyle(probe).backgroundColor;
  probe.remove();

  // content kommt in Anführungszeichen zurück ('""'); "none" heißt, die Klasse kennt das
  // Symbol nicht.
  const zeichen = inhalt && inhalt !== 'none' ? inhalt.replace(/^["']|["']$/g, '') : '';
  const ergebnis = zeichen ? { zeichen, farbe: farbe || '#8a8f98' } : null;
  symbolCache.set(symbol, ergebnis);
  return ergebnis;
}

/** Ein Manasymbol als farbiger Kreis mit dem Zeichen der Manaschrift darin. */
function manaSymbol(
  ctx: CanvasRenderingContext2D,
  symbol: string,
  x: number,
  y: number,
  groesse: number,
): void {
  const aussehen = symbolAussehen(symbol);
  ctx.beginPath();
  ctx.arc(x + groesse / 2, y + groesse / 2, groesse / 2, 0, Math.PI * 2);
  ctx.fillStyle = aussehen?.farbe ?? '#8a8f98';
  ctx.fill();
  // Derselbe dünne dunkle Rand, den .ms-shadow in der App setzt - ohne ihn verschwimmt das fast
  // weiße W-Symbol auf hellem Hintergrund.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (!aussehen) return;
  ctx.save();
  // .ms-cost setzt den Kreis auf 1.3em und das Zeichen auf 0.95em - dasselbe Verhältnis hier,
  // damit das Symbol den Kreis genauso füllt wie in der App.
  ctx.font = `${Math.round((groesse / 1.3) * 0.95)}px Mana`;
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(aussehen.zeichen, x + groesse / 2, y + groesse / 2 + 1);
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

/**
 * Wartet, bis die Manaschrift wirklich da ist. font-display: block heißt zwar "lieber nichts
 * anzeigen als ein Ersatzzeichen", aber ein Canvas wartet nicht - es würde die Ersatzschrift
 * messen und zeichnen.
 */
async function manaSchriftLaden(): Promise<void> {
  try {
    await document.fonts.load('40px Mana', '');
    await document.fonts.ready;
  } catch {
    // Ohne geladene Schrift bleiben die Kreise farbig und leer - immer noch besser als gar kein Bild.
  }
}
