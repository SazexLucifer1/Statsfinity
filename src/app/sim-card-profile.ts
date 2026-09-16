/**
 * Was kann diese Karte in einem Goldfish-Spiel? - die Kartenauswertung des Deck-Simulators.
 *
 * Gegenstück zu goldfish-sim.ts: dort läuft das Spiel, hier wird einmal je Karte übersetzt, was
 * sie im Spiel bewirkt. Die Trennung ist Absicht - die Spielschleife läuft je Deck hundertfach,
 * die Auswertung einer Karte genau einmal.
 *
 * WAS DAS IST UND WAS NICHT: Das ist keine Regel-Engine. Magic vollständig zu simulieren ist
 * nicht in Reichweite, und für die Frage, um die es geht - "in welchem Zug könnte dieses Deck
 * gewinnen" - auch nicht nötig. Was hier entsteht, ist ein Steckbrief aus zehn Größen, die den
 * Spielverlauf tatsächlich treiben: Mana, Ramp, Kartenfluss, Tutoren, Stärke auf dem Feld und
 * die Handvoll Effekte, die ein Spiel direkt beenden.
 *
 * DIE GEFAHR DABEI, offen benannt: Jedes Muster hier unten ist eine mögliche stille Fehlerquelle.
 * Ein Ausdruck, der "Draw two cards" verpasst, macht nicht die App kaputt - er macht alle Decks
 * mit dieser Karte unauffällig langsamer, über Zehntausende Decks hinweg, ohne dass es irgendwo
 * rot wird. Drei Dinge halten dagegen:
 *
 *   1. Jede erkannte Eigenschaft trägt sich in `regeln` ein. Ein Steckbrief sagt damit selbst,
 *      WARUM er so aussieht - im Test ist das der Anker, im Stapellauf die Abdeckungsquote
 *      ("wie viele Nicht-Länder haben gar keine erkannte Eigenschaft?").
 *   2. sim-card-profile.spec.ts nagelt jedes Muster an einer echten Karte fest, mit dem
 *      Oracle-Text im Wortlaut.
 *   3. Im Zweifel wird untertrieben. Eine nicht erkannte Fähigkeit macht ein Deck langsamer als
 *      es ist; eine zu großzügig erkannte macht es schneller als es ist. Das Erste fällt beim
 *      Vergleich zweier Decks weniger ins Gewicht, weil es alle Decks gleichermaßen trifft.
 */

/** Die fünf Farben plus farblos - Reihenfolge wie überall auf Karten (WUBRG). */
export const FARBEN = ['W', 'U', 'B', 'R', 'G', 'C'] as const;
export type Farbe = (typeof FARBEN)[number];

/**
 * Farben als Bitmaske statt als Array.
 *
 * Der Simulator fragt pro Spiel mehrere tausend Mal "kann diese Quelle diesen Pip bezahlen". Als
 * Mengenoperation auf Zahlen ist das ein `&`, als Array-Suche wäre es eine Schleife samt
 * Zwischenobjekten - bei 8 Millionen simulierten Spielen ist das der Unterschied zwischen Minuten
 * und Stunden.
 */
export type Farbmaske = number;

export const FARB_BIT: Record<Farbe, Farbmaske> = { W: 1, U: 2, B: 4, R: 8, G: 16, C: 32 };
/** Alle fünf Farben, ohne farblos - das, was "Mana beliebiger Farbe" liefert. */
export const ALLE_FARBEN: Farbmaske = 1 | 2 | 4 | 8 | 16;

export function farbmaske(symbole: readonly string[] | null | undefined): Farbmaske {
  let maske = 0;
  for (const s of symbole ?? []) {
    const bit = FARB_BIT[s.toUpperCase() as Farbe];
    if (bit) maske |= bit;
  }
  return maske;
}

/** Manakosten, zerlegt in das, was beim Bezahlen zählt. */
export interface SimKosten {
  /** Generischer Anteil - mit jeder Farbe bezahlbar. */
  generisch: number;
  /** Je farbiger Pip eine Maske der Farben, mit denen er bezahlt werden darf (Hybride: mehrere). */
  pips: Farbmaske[];
  /** Gesamtbetrag, X als 0 gerechnet. */
  gesamt: number;
  hatX: boolean;
}

export const KOSTENLOS: SimKosten = { generisch: 0, pips: [], gesamt: 0, hatX: false };

/**
 * Zerlegt eine Manakostenzeile ("{2}{G}{G}") in Bezahlbares.
 *
 * Vier Sonderfälle, jeder mit einer bewussten Entscheidung dahinter:
 *
 * - `{X}` zählt als 0. Im Goldfish gibt es kein Ziel, für das sich ein größeres X lohnen würde;
 *   der Simulator wirkt X-Zauber also für ihren Grundbetrag. Wo X den Sieg trägt (Schaden an
 *   jeden Gegner), rechnet die Spielschleife das übrige Mana selbst hinein.
 * - Phyrexianische Pips (`{W/P}`) sind gratis. Sie sind mit 2 Leben bezahlbar, und Leben ist im
 *   Goldfish keine knappe Größe - so spielt sie auch jeder Mensch.
 * - Hybride der Form `{2/W}` werden als FARBIGER Pip gerechnet, nicht als zwei generische: Wer
 *   die Farbe hat, zahlt den günstigeren Weg, und Decks, die solche Karten spielen, haben sie.
 * - Geteilte Karten ("{1}{G} // {3}{G}") werden auf die linke Hälfte gerechnet. Bei
 *   Abenteuer-Karten ist das der Abenteuer-Teil, bei geteilten Karten die erste Hälfte - in
 *   beiden Fällen die billigere Art, die Karte überhaupt zu spielen.
 */
export function parseCost(manaCost: string | null | undefined): SimKosten {
  const roh = (manaCost ?? '').split('//')[0];
  const kosten: SimKosten = { generisch: 0, pips: [], gesamt: 0, hatX: false };

  for (const [, inhalt] of roh.matchAll(/\{([^}]+)\}/g)) {
    const token = inhalt.toUpperCase();

    if (token === 'X' || token === 'Y' || token === 'Z') {
      kosten.hatX = true;
      continue;
    }
    if (/^\d+$/.test(token)) {
      kosten.generisch += Number(token);
      continue;
    }
    if (token === 'S') {
      // Schneemana - ein generisches Mana, das der Simulator nicht weiter unterscheidet.
      kosten.generisch += 1;
      continue;
    }
    if (token.includes('/P')) continue; // phyrexianisch, siehe oben

    const teile = token.split('/');
    let maske = 0;
    let generischerTeil = 0;
    for (const teil of teile) {
      if (/^\d+$/.test(teil)) generischerTeil = Number(teil);
      else maske |= FARB_BIT[teil as Farbe] ?? 0;
    }
    if (maske) kosten.pips.push(maske);
    else kosten.generisch += generischerTeil;
  }

  kosten.gesamt = kosten.generisch + kosten.pips.length;
  return kosten;
}

/** Die Kartendaten, so weit der Simulator sie braucht - Spalten aus scryfall_cards plus Tutor-Flag. */
export interface SimCardData {
  name: string;
  /** Normalisierter Vorderseiten-Name, gleicher Schlüssel wie überall sonst. */
  key: string;
  typeLine: string | null;
  oracleText: string | null;
  backTypeLine: string | null;
  backOracleText: string | null;
  manaCost: string | null;
  cmc: number | null;
  producedMana: string[] | null;
  /** Wörtlich wie bei Scryfall, "*" eingeschlossen. */
  power: string | null;
  keywords: string[];
  gameChanger: boolean;
  /** Aus spellbook_card_flags - die kuratierte Tutorenliste, nicht selbst geraten. */
  tutor: boolean;
}

/** Eine Manaquelle, die kein Land ist (Stein, Manakreatur). */
export interface SimManaquelle {
  farben: Farbmaske;
  /** NETTO-Mana je Aktivierung: was sie liefert, minus was ihre Aktivierung kostet. */
  menge: number;
  /**
   * true = die Quelle muss schon zu Beginn des Zuges dagestanden haben (Einsatzverzögerung bei
   * Kreaturen). Steine dürfen im Zug ihres Ausspielens noch nicht tappen? Doch - Steine haben
   * keine Einsatzverzögerung, Kreaturen schon. Genau das unterscheidet dieses Feld.
   */
  brauchtBereitschaft: boolean;
}

export interface SimLand {
  farben: Farbmaske;
  getappt: boolean;
  /** Holländer ("Search your library for a land card, put it onto the battlefield"). */
  holtLand: boolean;
}

/**
 * Eine aktivierte Fähigkeit, die kein Mana macht - eine Zieh-Engine, wiederholbare Rampe.
 *
 * Genau das unterscheidet ein Deck, das "rund läuft", von einem, das nur Karten aneinanderreiht:
 * Ein bleibender Dauereffekt, der JEDEN Zug etwas beiträgt, ist über zehn Züge zehnmal so viel
 * wert wie derselbe Effekt einmalig. Ohne diese Größe wäre eine Zieh-Engine für den Simulator
 * eine tote Karte.
 */
export interface SimFaehigkeit {
  kosten: SimKosten;
  ziehen: number;
  laenderAufsFeld: number;
  /** true = die Fähigkeit verlangt Tappen und die Kreatur muss erst bereit sein. */
  brauchtBereitschaft: boolean;
  /** true = sie hängt am Angriff und bringt nur etwas, wenn überhaupt Kreaturen dastehen. */
  brauchtKreatur: boolean;
}

/** Der fertige Steckbrief einer Karte. */
export interface SimCard {
  key: string;
  name: string;
  kosten: SimKosten;
  cmc: number;
  istLand: boolean;
  /**
   * Bleibt die Karte nach dem Wirken liegen? Instants und Hexereien tun das nicht - ohne diese
   * Unterscheidung würde ein Blitzschlag als Dauer-Permanent auf dem Feld stehen bleiben.
   */
  bleibend: boolean;
  /** true = das Land steht auf der RÜCKSEITE (modale Doppelkarte), die Karte ist auch ein Zauber. */
  landAufRueckseite: boolean;
  land: SimLand | null;
  manaquelle: SimManaquelle | null;
  /** Wiederholbare Fähigkeit, einmal je Zug nutzbar. null heißt "keine". */
  faehigkeit: SimFaehigkeit | null;
  /** Netto-Mana eines Rituals (Dark Ritual: +2). 0 heißt "kein Ritual". */
  ritual: number;
  laenderAufsFeld: number;
  laenderInDieHand: number;
  ziehen: number;
  tutor: boolean;
  kostenrabatt: number;
  istKreatur: boolean;
  staerke: number;
  /** Fliegend, Trampelschaden, Bedrohen, unblockbar - im Goldfish alles dasselbe: Schaden kommt durch. */
  unblockbar: boolean;
  eile: boolean;
  /** Dauerhafte Verstärkung aller eigenen Kreaturen ("+1/+1"). */
  anthem: number;
  /** Stärkebonus einer Ausrüstung oder Aura - wirkt auf GENAU EINE Kreatur, nicht auf alle. */
  ausruestung: number;
  /** Wie viele Kreaturenmarken die Karte erzeugt, und wie stark eine davon ist. */
  tokenAnzahl: number;
  tokenStaerke: number;
  /** Einmalige Verstärkung aller Kreaturen bis Zugende. -1 steht für "+X/+X", X = Kreaturenzahl. */
  massenpump: number;
  extraKampf: boolean;
  /** Direkter Schaden an JEDEN Gegner. -1 steht für "X Schaden", X = übriges Mana. */
  schadenJeGegner: number;
  /** "You win the game" - Laborschwester, Thassas Orakel und Verwandte. */
  gewinntSofort: boolean;
  gameChanger: boolean;
  /** Welche Muster gegriffen haben. Leer bei einem Nicht-Land heißt: nichts erkannt. */
  regeln: string[];
}

/** Zahlwörter, wie sie in Oracle-Texten stehen. */
const ZAHLWORT: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
};

function zahl(wort: string | undefined): number {
  if (!wort) return 0;
  const klein = wort.toLowerCase();
  if (/^\d+$/.test(klein)) return Number(klein);
  return ZAHLWORT[klein] ?? 0;
}

/**
 * Stärke als Zahl.
 *
 * "*" und "1+*" (Tarmogoyf, Alptraum) bekommen bewusst 2 statt 0 oder einer optimistischen
 * Schätzung: Solche Kreaturen sind fast nie klein, aber ihren Wert auszurechnen hieße, den halben
 * Spielzustand nachzubauen. 2 ist die Größenordnung einer durchschnittlichen Kreatur - falsch,
 * aber in beide Richtungen gleich falsch.
 */
export function parsePower(power: string | null | undefined): number {
  if (!power) return 0;
  if (/^-?\d+$/.test(power)) return Math.max(0, Number(power));
  return power.includes('*') ? 2 : 0;
}

/**
 * Zeilen, die NICHT als eigene Handlung zählen, weil sie an eine Bedingung hängen.
 *
 * "Whenever an opponent casts a spell ... you draw a card" (Rhystic Study) ist im Goldfish keine
 * gezogene Karte - es gibt keinen Gegner, der etwas wirkt. Ohne diesen Filter zählte jede
 * ausgelöste Fähigkeit als Sofort-Effekt, und ausgerechnet die teuren Wert-Karten durchgebauter
 * Decks kämen dadurch zu gut weg.
 *
 * Betretens-Auslöser ("When this creature enters, draw a card") sind ausdrücklich NICHT
 * ausgeschlossen: Die kommen beim Ausspielen zuverlässig, das ist der Unterschied.
 */
const BEDINGTE_ZEILE =
  /\b(whenever|at the beginning|each opponent|target player|opponent draws|may pay|unless)\b/i;

const BETRITT = /\bwhen(?:ever)? [^,]*enters\b/i;

/**
 * "Such dir ein Land aus der Bibliothek" - in allen Schreibweisen, die auf Karten vorkommen.
 *
 * Die naheliegende Fassung (/search your library for .* land card/) wäre falsch, und zwar bei
 * genau den Karten, auf die es ankommt: Holländer und Farseek sagen nicht "land card", sondern
 * zählen die Ländertypen auf ("a Swamp or Forest card", "a Plains, Island, Swamp or Mountain
 * card"). Sie zu verpassen hieße, die gesamte schnelle Manabasis durchgebauter Decks zu
 * übersehen - und die ist einer der Unterschiede, die der Simulator finden soll.
 */
const LAND_SUCHE =
  /search your library for (?:up to )?(\w+)[^.]*?\b(?:land|plains|island|swamp|mountain|forest)\b[^.]*?card/i;

/** Die bleibenden Kartentypen - alles andere wandert nach dem Wirken in den Friedhof. */
const BLEIBENDE_TYPEN = /\b(Land|Creature|Artifact|Enchantment|Planeswalker|Battle)\b/;

function handlungsZeilen(text: string): string[] {
  return text
    .split('\n')
    .map((z) => z.trim())
    .filter((z) => z.length > 0)
    .filter((z) => !BEDINGTE_ZEILE.test(z) || BETRITT.test(z));
}

/**
 * Wie viel Mana liefert eine Manafähigkeit netto, und in welchen Farben?
 *
 * Gelesen wird nur die Wirkung hinter dem Doppelpunkt, und nur bei Fähigkeiten, die das Tappen
 * verlangen - "Add {B}{B}{B}" ohne {T} ist kein Dauer-Manaknoten, sondern ein Ritual (siehe
 * unten). Die Aktivierungskosten davor werden ABGEZOGEN: Ein Signet ("{1}, {T}: Add {W}{U}")
 * bringt zwei Mana und kostet eines, netto also eins. Ohne diesen Abzug wären Signets doppelt so
 * gut wie Sol Ring, was sie erkennbar nicht sind.
 */
function manafaehigkeit(text: string): { farben: Farbmaske; menge: number } | null {
  for (const zeile of text.split('\n')) {
    const doppelpunkt = zeile.indexOf(':');
    if (doppelpunkt < 0) continue;

    const kostenTeil = zeile.slice(0, doppelpunkt);
    const wirkung = zeile.slice(doppelpunkt + 1);
    if (!/\{T\}/i.test(kostenTeil)) continue;

    const ergebnis = addWirkung(wirkung);
    if (!ergebnis) continue;

    const aktivierung = parseCost(kostenTeil);
    return { farben: ergebnis.farben, menge: Math.max(0, ergebnis.menge - aktivierung.gesamt) };
  }
  return null;
}

/** Wertet ein "Add ..." aus - egal ob aus einer Fähigkeit oder von einem Ritual. */
function addWirkung(text: string): { farben: Farbmaske; menge: number } | null {
  const treffer = text.match(/add ([^.\n]*)/i);
  if (!treffer) return null;
  const rest = treffer[1];

  const symbole = [...rest.matchAll(/\{([^}]+)\}/g)].map((m) => m[1].toUpperCase());
  if (symbole.length > 0) {
    return { farben: farbmaske(symbole), menge: symbole.length };
  }

  // "Add one mana of any color", "Add two mana in any combination of colors"
  const beliebig = rest.match(/(\w+) mana\b/i);
  if (beliebig) {
    const menge = zahl(beliebig[1]) || 1;
    return {
      farben: /any color|any one color|combination of colors/i.test(rest) ? ALLE_FARBEN : 0,
      menge,
    };
  }
  return null;
}

/**
 * Eine aktivierte Fähigkeit, die sich JEDEN Zug wieder nutzen lässt.
 *
 * Gelesen wird dieselbe Form wie bei der Manafähigkeit - "Kosten: Wirkung" -, nur wird hier nach
 * dem gesucht, was KEIN Mana macht: Karten ziehen und Länder holen.
 *
 * Ausgeschlossen sind Fähigkeiten, deren Kosten die Karte selbst verbrauchen ("Sacrifice",
 * "Exile"): Die gibt es genau einmal, und sie als Dauer-Engine zu zählen wäre der größere Fehler
 * als sie zu übersehen - siehe die Regel, im Zweifel zu untertreiben.
 */
function aktivierteFaehigkeit(text: string, istKreatur: boolean): SimFaehigkeit | null {
  // Ausgelöst statt aktiviert, aber im Goldfish dasselbe: Angegriffen wird jeden Zug, sobald
  // Kreaturen dastehen. Military Intelligence ("Whenever you attack with two or more creatures,
  // draw a card") ist im nachgesehenen Precon genau daran durchgefallen - der Filter für bedingte
  // Zeilen hat sie verworfen, obwohl die Bedingung hier praktisch immer zutrifft.
  for (const zeile of text.split('\n')) {
    if (!/whenever you attack/i.test(zeile)) continue;
    const zieht = zeile.match(/draw (\w+) cards?/i);
    if (!zieht) continue;
    return {
      kosten: KOSTENLOS,
      ziehen: zahl(zieht[1]),
      laenderAufsFeld: 0,
      brauchtBereitschaft: false,
      brauchtKreatur: true,
    };
  }

  for (const zeile of text.split('\n')) {
    const doppelpunkt = zeile.indexOf(':');
    if (doppelpunkt < 0) continue;

    const kostenTeil = zeile.slice(0, doppelpunkt);
    const wirkung = zeile.slice(doppelpunkt + 1);
    if (/\b(sacrifice|exile)\b/i.test(kostenTeil)) continue;
    if (/add [{]/i.test(wirkung)) continue; // das ist eine Manafähigkeit, die steht anderswo

    const zieht = wirkung.match(/draw (\w+) cards?/i);
    const laender = LAND_SUCHE.test(wirkung) && /onto the battlefield/i.test(wirkung);
    if (!zieht && !laender) continue;

    return {
      kosten: parseCost(kostenTeil),
      ziehen: zieht ? zahl(zieht[1]) : 0,
      laenderAufsFeld: laender ? 1 : 0,
      brauchtBereitschaft: istKreatur && /\{T\}/i.test(kostenTeil),
      brauchtKreatur: false,
    };
  }
  return null;
}

/**
 * Karten, die in der Hand landen, ohne dass "draw" dasteht.
 *
 * Fact or Fiction sagt "put one pile into your hand", die rote Impuls-Variante "exile the top three
 * cards of your library. You may play them this turn". Beides ist Kartenfluss, und beides verpasst
 * ein Muster, das nur nach "draw" sucht - im nachgesehenen Precon war Fact or Fiction eine von vier
 * Zieh-Karten, die dadurch als wirkungslos galten.
 *
 * Bewusst knauserig gezählt: Fact or Fiction zieht im Schnitt zweieinhalb Karten, hier steht 1.
 * Ein Stapel, dessen Größe der Gegner bestimmt, ist nicht seriös zu schätzen, und die Regel lautet
 * im Zweifel untertreiben.
 */
function kartenInDieHand(zeile: string): number {
  // "put one pile into your hand", "put that card into your hand", "put them into your hand"
  if (/put (?:one|that|those|them|it|the rest)[^.]{0,40}into your hand/i.test(zeile)) return 1;
  // "put up to two of them into your hand"
  const mehrere = zeile.match(
    /put (?:up to )?(\w+) of (?:them|those cards)[^.]{0,20}into your hand/i,
  );
  if (mehrere) return zahl(mehrere[1]);
  // Impuls-Ziehen: die Karten liegen im Exil, spielbar sind sie trotzdem.
  const impuls = zeile.match(/exile the top (\w+) cards?[^.]*\.[^.]*you may play/i);
  if (impuls) return zahl(impuls[1]);
  return 0;
}

/**
 * Der Anthem-Betrag - alle eigenen Kreaturen bekommen dauerhaft dazu.
 *
 * Das frühere Muster verlangte wörtlich "creatures you control get". Obelisk of Urd sagt
 * "Creatures of the chosen type get +2/+2" und fiel damit durch, obwohl es dasselbe tut. Jetzt
 * zählt jede Formulierung - außer denen, die die Kreaturen der GEGNER meinen, denn ein Minus für
 * andere ist kein Plus für einen selbst.
 */
function anthemBetrag(text: string): number {
  for (const zeile of text.split('\n')) {
    if (/\b(opponents?|you don't control|each player)\b/i.test(zeile)) continue;
    const treffer = zeile.match(/creatures[^.]{0,40}get \+(\d+)\/\+\d+/i);
    if (treffer) return Number(treffer[1]);
  }
  return 0;
}

/**
 * "Create two 1/1 white Soldier creature tokens" - Anzahl und Stärke einer Marke.
 *
 * Eine variable Anzahl ("Create X 1/1 ... tokens") zählt als eine einzige Marke: X hängt am
 * Spielzustand, und eine geratene Zahl wäre hier besonders teuer, weil sie sich direkt in Schaden
 * übersetzt.
 */
function tokenAngabe(text: string): { anzahl: number; staerke: number } | null {
  for (const zeile of handlungsZeilen(text)) {
    const treffer = zeile.match(/create (\w+) (\d+)\/(\d+)[^.]{0,60}?creature tokens?/i);
    if (!treffer) continue;
    const anzahl = /^x$/i.test(treffer[1]) ? 1 : zahl(treffer[1]);
    if (anzahl <= 0) continue;
    return { anzahl, staerke: Number(treffer[2]) };
  }
  return null;
}

/**
 * Eine Kreaturenmarke als Steckbrief - für den Simulator ist sie eine Kreatur wie jede andere,
 * nur ohne Karte dahinter.
 */
export function tokenKarte(staerke: number): SimCard {
  return {
    key: `#token/${staerke}`,
    name: `Marke ${staerke}/${staerke}`,
    kosten: KOSTENLOS,
    cmc: 0,
    istLand: false,
    bleibend: true,
    landAufRueckseite: false,
    land: null,
    manaquelle: null,
    faehigkeit: null,
    ritual: 0,
    laenderAufsFeld: 0,
    laenderInDieHand: 0,
    ziehen: 0,
    tutor: false,
    kostenrabatt: 0,
    istKreatur: true,
    staerke,
    unblockbar: false,
    eile: false,
    anthem: 0,
    ausruestung: 0,
    tokenAnzahl: 0,
    tokenStaerke: 0,
    massenpump: 0,
    extraKampf: false,
    schadenJeGegner: 0,
    gewinntSofort: false,
    gameChanger: false,
    regeln: ['marke'],
  };
}

/**
 * Wie viel dieses Decks versteht der Simulator überhaupt?
 *
 * Anteil der Nicht-Länder, bei denen mindestens ein Muster gegriffen hat (0-1). Das ist die
 * Ehrlichkeitszahl zu jedem Ergebnis: Bei einem Deck, von dem nur 40 % erkannt wurden, sagt ein
 * später Siegzug womöglich mehr über die Grenzen dieser Auswertung aus als über das Deck. Ohne
 * diese Zahl wäre beides nicht auseinanderzuhalten.
 *
 * Länder zählen bewusst nicht mit: Sie werden immer erkannt und würden die Quote nur schönen.
 */
export function erkennungsquote(karten: readonly SimCard[]): number {
  const zauber = karten.filter((k) => !k.istLand);
  if (zauber.length === 0) return 1;
  return zauber.filter((k) => k.regeln.length > 0).length / zauber.length;
}

/**
 * Kommt dieses Land getappt herein?
 *
 * Die Reihenfolge ist entscheidend und deshalb hier festgehalten: Erst wird geprüft, ob es sich
 * FREIKAUFEN lässt (Schockländer: "you may pay 2 life", Ländereien mit "unless you pay"). Leben
 * ist im Goldfish gratis, solche Länder kommen also ungetappt. Erst danach greift das schlichte
 * "enters tapped".
 *
 * Was bewusst als getappt durchgeht: Bedingungen, die vom Spielstand abhängen ("unless you control
 * two or fewer other lands"). Sie treffen früh zu und später nicht - und "später" ist der größere
 * Teil eines Spiels.
 */
function landGetappt(text: string): boolean {
  if (/you may pay \d+ life/i.test(text)) return false;
  if (/enters(?: the battlefield)? tapped unless you pay/i.test(text)) return false;
  return /enters(?: the battlefield)? tapped/i.test(text);
}

/** Baut den Steckbrief einer Karte. Reine Funktion - gleiche Eingabe, gleiche Ausgabe. */
export function buildSimCard(data: SimCardData): SimCard {
  const typeLine = data.typeLine ?? '';
  const text = data.oracleText ?? '';
  const kleintext = text.toLowerCase();
  const regeln: string[] = [];
  const merke = (regel: string) => regeln.push(regel);

  const istLand = /\bLand\b/.test(typeLine);
  const rueckseiteLand = !istLand && /\bLand\b/.test(data.backTypeLine ?? '');
  const istKreatur = /\bCreature\b/.test(typeLine);

  const karte: SimCard = {
    key: data.key,
    name: data.name,
    kosten: istLand ? KOSTENLOS : parseCost(data.manaCost),
    cmc: data.cmc ?? 0,
    istLand,
    bleibend: BLEIBENDE_TYPEN.test(typeLine),
    landAufRueckseite: rueckseiteLand,
    land: null,
    manaquelle: null,
    faehigkeit: null,
    ritual: 0,
    laenderAufsFeld: 0,
    laenderInDieHand: 0,
    ziehen: 0,
    tutor: data.tutor,
    kostenrabatt: 0,
    istKreatur,
    staerke: parsePower(data.power),
    unblockbar: false,
    eile: false,
    anthem: 0,
    ausruestung: 0,
    tokenAnzahl: 0,
    tokenStaerke: 0,
    massenpump: 0,
    extraKampf: false,
    schadenJeGegner: 0,
    gewinntSofort: false,
    gameChanger: data.gameChanger,
    regeln,
  };

  if (data.tutor) merke('tutor');

  // --- Land -----------------------------------------------------------------------------------
  if (istLand || rueckseiteLand) {
    const landtext = istLand ? text : (data.backOracleText ?? '');
    const holtLand = LAND_SUCHE.test(landtext) && /onto the battlefield/i.test(landtext);
    karte.land = {
      farben: farbmaske(data.producedMana),
      getappt: landGetappt(landtext),
      holtLand,
    };
    merke(istLand ? 'land' : 'land-rueckseite');
    if (holtLand) merke('holland');
    if (istLand) return karte; // Ein echtes Land tut nichts anderes mehr.
  }

  // --- Manaquelle, die kein Land ist ----------------------------------------------------------
  const faehigkeit = manafaehigkeit(text);
  if (faehigkeit && faehigkeit.menge > 0) {
    karte.manaquelle = {
      // produced_mana ist die verlässlichere Quelle für die Farben (Scryfall wertet dafür alle
      // Fähigkeiten aus, auch die, deren Text dieses Modul nicht liest); der Text liefert nur die
      // Menge, die dort nicht steht.
      farben: farbmaske(data.producedMana) || faehigkeit.farben,
      menge: faehigkeit.menge,
      brauchtBereitschaft: istKreatur,
    };
    merke(istKreatur ? 'manakreatur' : 'manastein');
  }

  // --- Wiederholbare Fähigkeit ----------------------------------------------------------------
  if (BLEIBENDE_TYPEN.test(typeLine)) {
    karte.faehigkeit = aktivierteFaehigkeit(text, istKreatur);
    if (karte.faehigkeit) merke('faehigkeit');
  }

  // --- Ritual: Mana ohne Tappen, einmalig -----------------------------------------------------
  if (!karte.manaquelle && /\b(Instant|Sorcery)\b/.test(typeLine)) {
    const sofort = addWirkung(text);
    if (sofort && sofort.menge > 0) {
      karte.ritual = sofort.menge - karte.kosten.gesamt;
      if (karte.ritual !== 0) merke('ritual');
    }
  }

  // --- Ramp aus der Bibliothek ----------------------------------------------------------------
  for (const zeile of handlungsZeilen(text)) {
    const suche = zeile.match(LAND_SUCHE);
    if (!suche) continue;
    const menge = zahl(suche[1]) || 1;
    if (/into your hand/i.test(zeile) && /onto the battlefield/i.test(zeile)) {
      // Cultivate-Muster: eines aufs Feld, eines in die Hand.
      karte.laenderAufsFeld += 1;
      karte.laenderInDieHand += Math.max(0, menge - 1);
    } else if (/onto the battlefield/i.test(zeile)) {
      karte.laenderAufsFeld += menge;
    } else if (/into your hand/i.test(zeile)) {
      karte.laenderInDieHand += menge;
    }
    if (karte.laenderAufsFeld || karte.laenderInDieHand) merke('landramp');
  }

  // --- Kartenfluss ----------------------------------------------------------------------------
  for (const zeile of handlungsZeilen(text)) {
    for (const [, wort] of zeile.matchAll(/draw (\w+) cards?/gi)) {
      karte.ziehen += zahl(wort);
    }
    karte.ziehen += kartenInDieHand(zeile);
  }
  if (karte.ziehen > 0) merke('ziehen');

  // --- Kostenrabatt ---------------------------------------------------------------------------
  const rabatt = text.match(/spells? you cast costs? \{(\d+)\} less to cast/i);
  if (rabatt) {
    karte.kostenrabatt = Number(rabatt[1]);
    merke('rabatt');
  }

  // --- Angriff --------------------------------------------------------------------------------
  const schlagwoerter = new Set(data.keywords.map((k) => k.toLowerCase()));
  karte.unblockbar =
    ['flying', 'trample', 'menace', 'shadow', 'fear', 'horsemanship', 'intimidate', 'skulk'].some(
      (k) => schlagwoerter.has(k),
    ) || /can't be blocked/i.test(text);
  karte.eile = schlagwoerter.has('haste');
  if (istKreatur && karte.staerke > 0) merke('kreatur');

  const dauerpump = anthemBetrag(text);
  if (dauerpump > 0 && !/until end of turn/i.test(text)) {
    karte.anthem = dauerpump;
    merke('anthem');
  } else if (
    /creatures you control (?:gain [^.]*and )?get \+(?:X|\d+)\/\+(?:X|\d+)[^.]*until end of turn/i.test(
      text,
    )
  ) {
    const betrag = text.match(/get \+(\d+)\/\+\d+[^.]*until end of turn/i);
    karte.massenpump = betrag ? Number(betrag[1]) : -1;
    merke('massenpump');
  }

  // Ausrüstungen und Auren hängen an EINER Kreatur, sind aber trotzdem Stärke auf dem Feld. Sie
  // gar nicht zu zählen hiesse, ein Deck mit fünf Ausrüstungen genauso zu bewerten wie eines ohne.
  const traeger = text.match(/(?:equipped|enchanted) creature gets \+(\d+)\/[+-]?\d+/i);
  if (traeger) {
    karte.ausruestung = Number(traeger[1]);
    merke('ausruestung');
  }

  // Marken: für das Schadensmodell sind sie schlicht Kreaturen. Sie zu übersehen hiesse, die halbe
  // Commander-Landschaft als schadlos zu führen - Marken-Decks gewinnen genau darüber.
  const marken = tokenAngabe(text);
  if (marken) {
    karte.tokenAnzahl = marken.anzahl;
    karte.tokenStaerke = marken.staerke;
    merke('token');
  }

  if (/additional combat phase/i.test(text)) {
    karte.extraKampf = true;
    merke('extrakampf');
  }

  // --- Direkter Sieg --------------------------------------------------------------------------
  for (const zeile of handlungsZeilen(text)) {
    const brand = zeile.match(/deals? (\w+) damage to each opponent/i);
    if (brand) {
      karte.schadenJeGegner = /^x$/i.test(brand[1]) ? -1 : zahl(brand[1]);
      merke('brand');
    }
  }
  if (/\byou win the game\b/i.test(kleintext) && !/can't win the game/i.test(kleintext)) {
    karte.gewinntSofort = true;
    merke('sieg');
  }

  return karte;
}
