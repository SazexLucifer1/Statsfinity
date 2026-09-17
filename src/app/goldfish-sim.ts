import { ALLE_FARBEN, Farbmaske, SimCard, SimKosten, tokenKarte } from './sim-card-profile';

/**
 * Der Goldfish-Simulator: ein Deck spielt gegen niemanden, bis es gewinnen könnte.
 *
 * WOZU DAS DA IST. Die Bracket-Einstufung in bracket.ts liest Kartenlisten und wendet die
 * offiziellen Kriterien an. Das beantwortet "hält dieses Deck die Regeln von Bracket 2 ein?" -
 * aber nicht die Frage, an der sich die Einstufung in der Praxis reibt: Man kann die Regeln von
 * Bracket 2 einhalten und trotzdem ein Deck bauen, das mit Bracket-4-Decks mithält. Kein
 * Kriterium aus dem Regelwerk sieht diesen Unterschied, weil keines das TEMPO misst.
 *
 * Genau das misst dieser Simulator, und zwar als eine einzige Zahl: in welchem Zug könnte dieses
 * Deck das Spiel beenden? Zweihundert Mal gemischt, zweihundert Mal ausgespielt, daraus eine
 * Verteilung. Ein Precon landet dabei woanders als ein durchgebautes Deck, ganz ohne dass eine
 * Regel über Game Changer oder Tutoren befragt wird.
 *
 * ZWEI ABBRUCHBEDINGUNGEN, beide nötig:
 *
 *   Combo   - eine gewinnende Combo (Commander Spellbooks Liste) steht vollständig.
 *   Schaden - das Feld schlägt in einem Zug genug Schaden für einen Gegner (LETHAL).
 *
 * Nur auf Combos zu achten würde jedes Kreaturendeck gleich langsam aussehen lassen; nur auf
 * Schaden zu achten würde jedes Combo-Deck übersehen. Beides zusammen deckt ab, wie Commander-
 * Decks tatsächlich gewinnen.
 *
 * WAS DER SIMULATOR NICHT KANN, damit niemand mehr hineinliest als drinsteht:
 *
 *   - Keine Gegenwehr. Kein Removal, keine Konter, kein Blocken. Ein Goldfish misst das Tempo des
 *     eigenen Plans, nicht den Ausgang eines echten Spiels. Interaktion ist eine EIGENE Achse,
 *     und dass sie hier fehlt, ist kein Mangel des Modells, sondern seine Definition.
 *   - Keine Regel-Engine. Was eine Karte tut, steht als Steckbrief in sim-card-profile.ts und ist
 *     dort auf zehn Größen eingedampft.
 *   - Keine Entscheidungen im menschlichen Sinn. Die Spielweise unten ist eine feste Rangfolge:
 *     erst Mana, dann Synergie-Bausteine, dann Ziehen und Suchen, dann Combo-Teile, dann der Rest
 *     (siehe rangFuer). Gut genug, um zwei Decks miteinander zu vergleichen, und viel zu grob, um
 *     einem Menschen zu sagen, wie er sein Deck spielen soll.
 *   - Kein Gegner heißt auch: kein Abwerfen, kein Friedhof, keine Lebenspunkte. Was gewirkt wurde,
 *     ist weg; was liegt, bleibt liegen.
 *
 * Reine Rechenfunktionen ohne Angular- und ohne Netzwerkbezug - gleiche Aufteilung wie bracket.ts
 * und combo-finder.ts, damit sich jede Regel in goldfish-sim.spec.ts einzeln festnageln lässt.
 * Derselbe Code läuft später im Browser für ein einzelnes Deck und im Stapellauf über den
 * Archidekt-Vorrat; er darf deshalb nichts kennen als seine Eingabe.
 */

/**
 * Wie viel Schaden ein tödlicher Zug braucht.
 *
 * 40 - das Startleben EINES Gegners, nicht der ganzen Tischrunde. Wer in einem Zug 40 Schaden
 * aufstellt, hat das Spiel in der Hand; zu verlangen, dass alle drei Gegner gleichzeitig sterben
 * (120), würde nur noch die extremsten Decks überhaupt als "gewinnfähig" zählen und den
 * Unterschied zwischen Bracket 2 und 4 wieder einebnen.
 */
export const LETHAL = 40;

/** Nach so vielen Zügen wird abgebrochen. Was bis Zug 20 nicht gewinnt, gewinnt im Goldfish nie. */
export const MAX_ZUEGE = 20;

/** Der Wert, der für "kein Sieg" in die Statistik geht - damit sich Perzentile rechnen lassen. */
export const KEIN_SIEG = MAX_ZUEGE + 1;

/**
 * Bis zu diesem Zug wird der aufaddierte Schaden mitgeschrieben (siehe SimSpiel.schadenBisZug10).
 *
 * Zehn, weil ein Commander-Spiel dort entschieden ist, ohne dass die Zahl schon an der Decke
 * klebt: Bei zwanzig Zügen erreichen fast alle Decks irgendwann 40 Schaden und die Spalte wäre so
 * nichtssagend wie der zensierte Siegzug, bei fünf fast keines.
 */
export const SCHADENSFENSTER = 10;

const STARTHAND = 7;
/** Nach drei Mulligans wird jede Hand behalten - so spielt es auch ein Mensch. */
const MAX_MULLIGANS = 3;

/**
 * Eine gewinnende Combo, auf das eingedampft, was der Simulator prüfen kann: welche Karten dafür
 * zusammenkommen müssen und wie viel Mana zusätzlich nötig ist.
 */
export interface SimZiel {
  /** Normalisierte Kartennamen aller Teile. */
  keys: string[];
  /** Zusätzlich nötiges Mana laut Commander Spellbook (mana_value_needed). */
  zusatzMana: number;
}

export interface SimDeck {
  /** Je Exemplar eine Karte - Mengen sind hier schon aufgelöst. Ohne Commander. */
  karten: SimCard[];
  commander: SimCard[];
  /** Farbidentität des Decks - bestimmt, was ein Holland oder eine "beliebige Farbe" liefert. */
  farben: Farbmaske;
  /** Gewinnende Combos, die vollständig im Deck liegen. Leer heißt: dieses Deck gewinnt über Schaden. */
  ziele: SimZiel[];
  /**
   * Alle Kartennamen, die zu IRGENDEINER gewinnenden Combo dieses Decks gehören.
   *
   * Warum das nicht dasselbe ist wie die Schlüssel aus `ziele`: Der Stapellauf verfolgt nur eine
   * begrenzte Zahl von Combos gleichzeitig (mehr bringt nichts und kostet Laufzeit), und genau
   * diese Deckelung hat ein Loch in die wichtigste Schutzregel gerissen: Ein Combo-Teil, das nach
   * dem Wirken im Friedhof liegt, darf NIE gewirkt werden - sonst zerlegt sich das Deck seine
   * eigene Combo. Hing das Teil an Combo Nummer elf, war es nicht geschützt und wurde verheizt.
   *
   * Als Menge statt als Liste, weil die Prüfung in jeder Wirk-Entscheidung steckt: ein Nachschlagen
   * statt einer Schleife über alle Combos.
   */
  comboTeile: ReadonlySet<string>;
}

export type SiegArt = 'combo' | 'schaden';

export interface SimSpiel {
  /** Zug des Sieges, oder KEIN_SIEG. */
  siegZug: number;
  art: SiegArt | null;
  /**
   * Zug, in dem der über alle Züge AUFADDIERTE Schaden 40 erreicht - der realistischere Wert für
   * Kreaturendecks, die über drei Züge angreifen statt in einem Zug alles aufzustellen.
   */
  kumulativZug: number;
  /** Verfügbares Mana in Zug 3, 5 und 7 - die Tempo-Achse unabhängig vom Sieg. */
  manaProben: [number, number, number];
  /**
   * Aufaddierter Schaden bis einschließlich Zug 10 - die UNZENSIERTE Uhr.
   *
   * Warum das wichtig genug für eine eigene Zahl ist: Der Siegzug ist ein zensierter Wert. Wer bis
   * Zug 20 nicht gewinnt, bekommt 21 - und das trifft die große Mehrheit aller Decks. Eine Spalte,
   * in der zwei Drittel aller Zeilen denselben Wert tragen, kann nichts mehr trennen, egal wie gut
   * die Simulation darunter ist. Der Schaden bis Zug 10 hat dieses Problem nicht: Er unterscheidet
   * auch zwischen zwei Decks, die beide nie "gewinnen", aber 12 und 34 Schaden aufbauen.
   */
  schadenBisZug10: number;
  /** Wie oft musste die Starthand neu gezogen werden? */
  mulligans: number;
  /**
   * Züge, in denen gar kein Zauber gewirkt wurde - das Maß für "das Deck stolpert".
   *
   * Ein Zug ohne Wirkung heißt: kein bezahlbarer Zauber auf der Hand. Ein durchgebautes Deck hat
   * das selten, ein Deck mit teurer Kurve und dünner Manabasis oft. Gezählt werden nur die Züge
   * bis zum Spielende, sonst wäre die Zahl bloß eine zweite Schreibweise des Siegzugs.
   */
  leerlaufZuege: number;
  /** true = die Sicherung gegen Endlosschleifen in der Hauptphase hat gegriffen. */
  abgebrochen: boolean;
}

export interface SimErgebnis {
  spiele: number;
  /** Anteil der Spiele mit Sieg bis MAX_ZUEGE (0-1). */
  siegquote: number;
  /** Median-Siegzug über ALLE Spiele; Spiele ohne Sieg zählen als KEIN_SIEG. */
  median: number;
  /** Das schnellste Zehntel - die Zahl, die zählt, wenn es um "wie schnell KANN das Deck" geht. */
  schnellste10: number;
  /** Median des aufaddierten Schadens-Siegzugs. */
  kumulativMedian: number;
  /** Anteil der Siege, die über eine Combo kamen (0-1). */
  comboAnteil: number;
  manaZug3: number;
  manaZug5: number;
  manaZug7: number;
  /** Das langsamste Viertel bzw. das schnellste Viertel - zusammen die Streuung. */
  p25: number;
  p75: number;
  /**
   * p75 - p25, also wie WEIT die Siegzüge auseinanderliegen.
   *
   * Eine eigene Achse neben dem Median, und zwar eine, die der Median nicht enthält: Zwei Decks
   * können beide im Schnitt in Zug 8 gewinnen - das eine immer, das andere in der Hälfte der
   * Spiele in Zug 5 und in der anderen gar nicht. Am Tisch sind das zwei völlig verschiedene
   * Decks. Verlässlichkeit ist das, was ein durchgebautes Deck von einem Glücksdeck unterscheidet,
   * und sie steht in keiner der bisherigen Spalten.
   */
  streuung: number;
  /** Median des aufaddierten Schadens bis Zug 10 - die unzensierte Uhr. */
  schadenZug10: number;
  /** Mulligans je Spiel im Schnitt. */
  mulliganSchnitt: number;
  /** Züge ohne gewirkten Zauber, je Spiel im Schnitt. */
  leerlaufSchnitt: number;
  /** Anteil der Spiele, in denen die Schleifensicherung griff - die Ehrlichkeitszahl. */
  abbruchAnteil: number;
}

/**
 * Welche Combo-Ergebnisse beenden ein Spiel? - DIE EINE Fassung dieser Liste.
 *
 * Commander Spellbook beschreibt jedes Ergebnis im Klartext ("Infinite damage", "Infinite mana").
 * Der Unterschied ist wesentlich: Unendlich VIEL MANA gewinnt gar nichts, solange nichts da ist,
 * wofür man es ausgibt - unendlich Schaden schon. Diese Liste ist deshalb bewusst eng und nennt
 * nur Ergebnisse, die ein Spiel unmittelbar entscheiden.
 *
 * WARUM DER AUSDRUCK ALS ZEICHENKETTE EXPORTIERT WIRD, und das ist die Lehre aus einem Fehler:
 * Dieselbe Liste stand ein zweites Mal im SQL (spellbook_winning_combos), mit dem Kommentar, beide
 * müssten dieselbe Auswahl treffen. Sie taten es nicht. Die TypeScript-Fassung enthielt "lose the
 * game" und zählte damit "You lose the game" als SIEG; die SQL-Fassung kannte nur "loses the game"
 * und verpasste jedes "All opponents lose the game". Zwei Listen, ein Kommentar, der ihre
 * Gleichheit behauptet - und niemand, der es nachprüft.
 *
 * Jetzt gibt es diese eine Zeichenkette. Das SQL benutzt wörtlich denselben Ausdruck (die Funktion
 * spellbook_winning_combo_muster() gibt ihn zurück), und scripts/simulate-deck-pool.js vergleicht
 * beide vor jedem Lauf und bricht bei Abweichung ab. Der Ausdruck kommt deshalb ohne \b aus: In
 * Postgres bedeutet \b ein Rückschritt-Zeichen, nicht eine Wortgrenze.
 */
export const SIEG_MUSTER =
  'win the game|infinite damage|infinite turns|infinite mill|infinite loss of life|opponent loses the game|opponents lose the game';

const SIEG_ERGEBNIS = new RegExp(SIEG_MUSTER, 'i');

export function istSiegCombo(produces: readonly string[]): boolean {
  return produces.some((p) => SIEG_ERGEBNIS.test(p));
}

/**
 * Zufall mit Startwert (mulberry32).
 *
 * Math.random() wäre hier ein Fehler: Zwei Läufe über denselben Deckvorrat müssten dieselben
 * Zahlen liefern, sonst ist nicht unterscheidbar, ob sich ein Ergebnis wegen einer Änderung am
 * Simulator verschoben hat oder nur, weil anders gemischt wurde.
 */
export function rngAus(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mischen<T>(karten: readonly T[], rng: () => number): T[] {
  const ergebnis = [...karten];
  for (let i = ergebnis.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ergebnis[i], ergebnis[j]] = [ergebnis[j], ergebnis[i]];
  }
  return ergebnis;
}

/** Eine bereitstehende Manaquelle im laufenden Zug. */
export interface Quelle {
  farben: Farbmaske;
  menge: number;
}

/**
 * Bezahlt diese Kostenzeile aus dem Manavorrat - und verbraucht ihn dabei.
 *
 * Gierig, aber in der richtigen Reihenfolge: Erst die farbigen Pips, jeder von der UNFLEXIBELSTEN
 * Quelle, die ihn liefern kann; das generische Restgeld danach von dem, was übrig ist. Andersherum
 * würde ein Wald das generische Mana bezahlen und der grüne Pip stünde ohne Quelle da, obwohl das
 * Deck bezahlen könnte. Ein vollständiger Zuordnungsalgorithmus wäre exakter, kostet aber bei
 * Millionen Aufrufen ein Vielfaches - und die Fälle, in denen die gierige Wahl danebenliegt,
 * brauchen drei Quellen mit sich überschneidenden, ungleich flexiblen Farben.
 *
 * Schlägt die Zahlung fehl, bleibt der Vorrat unangetastet: Der Verbrauch wird erst geschrieben,
 * wenn feststeht, dass es reicht.
 */
export function zahle(kosten: SimKosten, vorrat: Quelle[]): boolean {
  let gesamt = 0;
  for (const q of vorrat) gesamt += q.menge;
  if (gesamt < kosten.gesamt) return false;

  const rest = vorrat.map((q) => q.menge);
  const flexibilitaet = vorrat.map((q) => zaehleBits(q.farben));

  const pips = [...kosten.pips].sort((a, b) => zaehleBits(a) - zaehleBits(b));
  for (const pip of pips) {
    let beste = -1;
    for (let i = 0; i < vorrat.length; i++) {
      if (rest[i] <= 0 || (vorrat[i].farben & pip) === 0) continue;
      if (beste < 0 || flexibilitaet[i] < flexibilitaet[beste]) beste = i;
    }
    if (beste < 0) return false;
    rest[beste]--;
  }

  let offen = kosten.generisch;
  for (let i = 0; i < rest.length && offen > 0; i++) {
    const nimm = Math.min(rest[i], offen);
    rest[i] -= nimm;
    offen -= nimm;
  }
  if (offen > 0) return false;

  for (let i = 0; i < vorrat.length; i++) vorrat[i].menge = rest[i];
  return true;
}

/** Wie zahle(), aber ohne den Vorrat anzufassen - für "könnte ich das wirken?". */
export function kannZahlen(kosten: SimKosten, vorrat: readonly Quelle[]): boolean {
  return zahle(
    kosten,
    vorrat.map((q) => ({ ...q })),
  );
}

function zaehleBits(maske: Farbmaske): number {
  let n = 0;
  for (let m = maske; m; m >>= 1) n += m & 1;
  return n;
}

function summe(vorrat: readonly Quelle[]): number {
  let s = 0;
  for (const q of vorrat) s += q.menge;
  return s;
}

/** Der Spielstand eines einzelnen Goldfish-Spiels. */
interface Stand {
  bibliothek: SimCard[];
  hand: SimCard[];
  /** Alles, was liegt - mit dem Zug, in dem es dazukam (für die Einsatzverzögerung). */
  feld: { karte: SimCard; seitZug: number }[];
  zug: number;
  landGespielt: boolean;
  schadenGesamt: number;
  /**
   * Massenpump und Extra-Kampfphase gelten NUR in dem Zug, in dem die Karte gespielt wurde.
   *
   * Vorher las der Angriffsschaden diese beiden Eigenschaften bei jedem Permanent auf dem Feld in
   * jedem Zug neu. Craterhoof Behemoth ist eine Kreatur, bleibt also liegen - und pumpte damit das
   * ganze Spiel lang jede Runde erneut, aus einem einmaligen Betretens-Effekt wurde ein
   * Dauer-Anthem in Quadratgröße. Umgekehrt ging ein Overrun als Hexerei komplett verloren, weil
   * es gar nicht erst auf dem Feld landet.
   */
  pumpDiesenZug: number;
  extraKampfDiesenZug: boolean;
}

/** Spielt ein Deck einmal aus. */
export function simuliereSpiel(deck: SimDeck, seed: number): SimSpiel {
  const rng = rngAus(seed);
  const stand: Stand = {
    bibliothek: [],
    hand: [],
    feld: [],
    zug: 0,
    landGespielt: false,
    schadenGesamt: 0,
    pumpDiesenZug: 0,
    extraKampfDiesenZug: false,
  };

  const mulligans = starthand(deck, stand, rng);
  // Der Commander liegt in der Kommandozone und ist jeden Zug verfügbar. Ihn einfach in die Hand
  // zu legen ist die Näherung dafür: Im Goldfish stirbt er nie, die Kommandosteuer fällt also
  // nie an, und mehr als "er ist da, sobald das Mana reicht" braucht der Simulator nicht.
  for (const c of deck.commander) stand.hand.push(c);

  const spiel: SimSpiel = {
    siegZug: KEIN_SIEG,
    art: null,
    kumulativZug: KEIN_SIEG,
    manaProben: [0, 0, 0],
    schadenBisZug10: 0,
    mulligans,
    leerlaufZuege: 0,
    abgebrochen: false,
  };

  while (stand.zug < MAX_ZUEGE) {
    stand.zug++;
    stand.landGespielt = false;
    stand.pumpDiesenZug = 0;
    stand.extraKampfDiesenZug = false;

    // Gezogen wird in JEDEM Zug, auch im ersten. Wer anfängt, zieht in der ersten Runde zwar
    // nicht - aber das ist genau ein Sitzplatz von vieren. Der Goldfish misst das Deck und nicht
    // den Platz am Tisch, und drei von vier Spielern ziehen im ersten Zug.
    ziehe(stand, 1);

    landDrop(deck, stand);

    // Der Manavorrat des Zuges. Alles, was jetzt bereitsteht, wird EINMAL gezählt und danach
    // verbraucht - das ist das Gegenstück zum Tappen.
    const vorrat = quellen(deck, stand);
    const gesamtMana = summe(vorrat);

    // Erst prüfen, dann wirken: Steht die Combo schon zu Beginn der Hauptphase, darf das Mana
    // dafür nicht vorher in einen Bären wandern. Die Prüfung nach der Hauptphase bleibt zusätzlich
    // bestehen - sie fängt den Fall, dass das letzte Teil gerade erst gewirkt wurde.
    const comboVorher = comboSteht(deck, stand, vorrat);
    const zug = comboVorher
      ? { schaden: 0, gewirkt: 0, abgebrochen: false }
      : hauptphase(deck, stand, vorrat);
    const schadenDiesenZug = zug.schaden;
    if (zug.abgebrochen) spiel.abgebrochen = true;
    if (!comboVorher) {
      if (zug.gewirkt === 0) spiel.leerlaufZuege++;
      engines(stand, vorrat);
    }

    if (stand.zug === 3) spiel.manaProben[0] = gesamtMana;
    if (stand.zug === 5) spiel.manaProben[1] = gesamtMana;
    if (stand.zug === 7) spiel.manaProben[2] = gesamtMana;

    const angriff = angriffsschaden(stand) + schadenDiesenZug;
    stand.schadenGesamt += angriff;

    // Nur der ERSTE Sieg zählt. Seit die Schleife für das Schadensfenster über den Siegzug hinaus
    // weiterläuft, wäre das ohne diese Abfrage der letzte statt des ersten - und der Median eines
    // Combo-Decks sprang von Zug 4 auf Zug 10, ohne dass sich am Deck etwas geändert hätte.
    if (spiel.siegZug === KEIN_SIEG) {
      if (comboVorher || comboSteht(deck, stand, vorrat)) {
        spiel.siegZug = stand.zug;
        spiel.art = 'combo';
      } else if (angriff >= LETHAL) {
        spiel.siegZug = stand.zug;
        spiel.art = 'schaden';
      }
    }
    if (spiel.kumulativZug === KEIN_SIEG && stand.schadenGesamt >= LETHAL) {
      spiel.kumulativZug = stand.zug;
    }
    if (stand.zug <= SCHADENSFENSTER) spiel.schadenBisZug10 = stand.schadenGesamt;

    // WEITERSPIELEN TROTZ SIEG, bis das Schadensfenster voll ist: Sonst stünde bei einem Deck, das
    // in Zug 4 gewinnt, ein kleinerer Schaden-bis-Zug-10 als bei einem langsamen Deck, das bis
    // dahin weiter angreifen durfte - die Uhr würde die schnellen Decks bestrafen. Der Siegzug
    // selbst ist längst notiert; was danach passiert, ändert an ihm nichts.
    if (spiel.siegZug !== KEIN_SIEG && stand.zug >= SCHADENSFENSTER) break;
  }

  // Ein Sieg ist immer auch kumulativ einer - sonst stünde für ein Combo-Deck hier KEIN_SIEG.
  spiel.kumulativZug = Math.min(spiel.kumulativZug, spiel.siegZug);
  return spiel;
}

/**
 * Starthand nach der London-Regel: ziehen, prüfen, bei Bedarf neu mischen und danach die
 * überzähligen Karten zurücklegen.
 *
 * Behalten wird nach der einzigen Frage, die eine Starthand wirklich entscheidet: genug Länder,
 * aber nicht nur Länder. Die Spanne wird mit jedem Mulligan enger, weil eine Hand aus fünf Karten
 * sich kein Wunschdenken mehr leisten kann.
 */
function starthand(deck: SimDeck, stand: Stand, rng: () => number): number {
  for (let mulligan = 0; ; mulligan++) {
    stand.bibliothek = mischen(deck.karten, rng);
    stand.hand = stand.bibliothek.splice(0, STARTHAND);

    const laender = stand.hand.filter((k) => k.land !== null).length;
    const max = mulligan === 0 ? 5 : 4;
    if (mulligan >= MAX_MULLIGANS || (laender >= 2 && laender <= max)) {
      // Zurücklegen: die teuersten Karten zuerst - sie sind es, die eine kurze Hand lahmlegen.
      for (let i = 0; i < mulligan && stand.hand.length > 0; i++) {
        let teuerste = 0;
        for (let k = 1; k < stand.hand.length; k++) {
          if (stand.hand[k].cmc > stand.hand[teuerste].cmc) teuerste = k;
        }
        stand.bibliothek.push(...stand.hand.splice(teuerste, 1));
      }
      return mulligan;
    }
  }
}

function ziehe(stand: Stand, n: number): void {
  for (let i = 0; i < n && stand.bibliothek.length > 0; i++) {
    stand.hand.push(stand.bibliothek.shift()!);
  }
}

/**
 * Das Land des Zuges.
 *
 * Bewertet wird nach Tempo (ungetappt schlägt getappt) und danach, ob das Land eine Farbe
 * mitbringt, die noch fehlt. Modale Doppelkarten werden nur dann als Land gelegt, wenn sonst gar
 * kein Land in der Hand ist - ihre Vorderseite ist meist das, wofür sie im Deck liegen.
 */
function landDrop(deck: SimDeck, stand: Stand): void {
  if (stand.landGespielt) return;

  const vorhandeneFarben = feldFarben(deck, stand);
  let beste = -1;
  let besterWert = -Infinity;

  for (let i = 0; i < stand.hand.length; i++) {
    const karte = stand.hand[i];
    if (!karte.land) continue;
    let wert = karte.land.getappt ? 0 : 2;
    if (karte.land.holtLand) wert += 1;
    const farben = karte.land.holtLand ? deck.farben : karte.land.farben;
    if ((farben & ~vorhandeneFarben) !== 0) wert += 2;
    if (karte.landAufRueckseite) wert -= 3;
    if (wert > besterWert) {
      besterWert = wert;
      beste = i;
    }
  }

  if (beste >= 0) {
    const karte = stand.hand.splice(beste, 1)[0];
    stand.feld.push({ karte, seitZug: stand.zug });
    stand.landGespielt = true;
  }
}

function feldFarben(deck: SimDeck, stand: Stand): Farbmaske {
  let maske = 0;
  for (const eintrag of stand.feld) {
    const k = eintrag.karte;
    if (k.land) maske |= k.land.holtLand ? deck.farben : k.land.farben;
    if (k.manaquelle) maske |= k.manaquelle.farben;
  }
  return maske;
}

/** Die Quellen, die zu Beginn der Hauptphase Mana geben können. */
function quellen(deck: SimDeck, stand: Stand): Quelle[] {
  const liste: Quelle[] = [];
  for (const eintrag of stand.feld) {
    const k = eintrag.karte;
    if (k.land) {
      // Ein getapptes Land gibt im Zug seines Ausspielens noch nichts.
      if (k.land.getappt && eintrag.seitZug === stand.zug) continue;
      const farben = k.land.holtLand ? deck.farben : k.land.farben;
      liste.push({ farben: farben || deck.farben, menge: 1 });
      continue;
    }
    if (k.manaquelle) {
      // Einsatzverzögerung: eine Manakreatur gibt im Zug ihres Ausspielens noch nichts, ein
      // Manastein sehr wohl.
      if (k.manaquelle.brauchtBereitschaft && eintrag.seitZug === stand.zug) continue;
      liste.push({ farben: k.manaquelle.farben || ALLE_FARBEN, menge: k.manaquelle.menge });
    }
  }
  return liste;
}

/**
 * Die Hauptphase: so lange wirken, bis nichts mehr geht.
 *
 * Die Rangfolge ist das Herz der Spielweise und bewusst kurz gehalten: Mana vor Suchen vor
 * Bedrohungen. Sie bildet ab, wie ein Deck sein eigenes Spiel aufbaut - erst die Grundlage, dann
 * der Plan. Feinheiten (wann hält man etwas zurück, wann wirkt man einen Gegenzauber) sind
 * bewusst nicht drin: Sie würden den Vergleich zweier Decks nicht genauer machen, nur langsamer.
 *
 * Rückgabe: der direkte Schaden an jeden Gegner, wie viele Zauber überhaupt gewirkt wurden (ein
 * Zug mit null Zaubern ist ein Leerlaufzug), und ob die Schleifensicherung gegriffen hat.
 */
function hauptphase(
  deck: SimDeck,
  stand: Stand,
  vorrat: Quelle[],
): { schaden: number; gewirkt: number; abgebrochen: boolean } {
  let schaden = 0;
  let gewirkt = 0;

  // Obergrenze gegen eine Endlosschleife, falls eine Karte sich selbst nachzieht. 40 Zauber in
  // einem Zug hat kein Deck dieser Auswertung je erreicht; die Grenze ist eine Sicherung, kein Maß
  // - und dass sie gegriffen hat, wird ab jetzt gemeldet statt stillschweigend verschluckt.
  for (let schritt = 0; schritt < MAX_ZAUBER_JE_ZUG; schritt++) {
    let beste = -1;
    let besterRang = -Infinity;

    for (let i = 0; i < stand.hand.length; i++) {
      const karte = stand.hand[i];
      // Nur ECHTE Länder sind unwirkbar. Eine modale Doppelkarte (Land auf der Rückseite) ist
      // beides: Sie darf als Land gelegt UND als Zauber gewirkt werden. Die Abfrage stand vorher
      // auf `karte.land`, und weil die auch bei Doppelkarten gesetzt ist, war Agadeem's Awakening
      // in diesem Simulator ausschliesslich ein Land.
      if (karte.istLand) continue;
      if (!kannZahlen(mitRabatt(karte.kosten, rabattFuer(stand, karte)), vorrat)) continue;
      const rang = rangFuer(karte, deck, stand);
      if (rang < 0) continue;
      if (rang > besterRang) {
        besterRang = rang;
        beste = i;
      }
    }
    if (beste < 0) return { schaden, gewirkt, abgebrochen: false };

    const karte = stand.hand.splice(beste, 1)[0];
    zahle(mitRabatt(karte.kosten, rabattFuer(stand, karte)), vorrat);
    schaden += spieleKarte(karte, deck, stand, vorrat);
    gewirkt++;
  }
  return { schaden, gewirkt, abgebrochen: true };
}

/** Sicherung gegen Endlosschleifen in der Hauptphase - siehe hauptphase(). */
const MAX_ZAUBER_JE_ZUG = 40;

/**
 * Die wiederholbaren Fähigkeiten auf dem Feld, einmal je Zug - Zieh-Engines, wiederholbare Rampe.
 *
 * Läuft NACH der Wirk-Phase, also mit dem Mana, das übrig geblieben ist. Das ist die Reihenfolge,
 * die auch ein Mensch spielt: erst die Karten aus der Hand, die dieser Zug hergibt, und was dann
 * noch dasteht, geht in die Engine. Andersherum würde eine Zieh-Engine dem Deck den eigenen
 * Zugablauf verhungern lassen.
 *
 * Die so gezogenen Karten sind erst im nächsten Zug spielbar - auch das entspricht dem üblichen
 * Ablauf, eine Zieh-Fähigkeit am Ende des Zuges zu benutzen.
 */
function engines(stand: Stand, vorrat: Quelle[]): void {
  for (const eintrag of stand.feld) {
    const f = eintrag.karte.faehigkeit;
    if (!f) continue;
    if (f.brauchtBereitschaft && eintrag.seitZug === stand.zug) continue;
    if (f.brauchtKreatur && !stand.feld.some((e) => e.karte.istKreatur && e.karte.staerke > 0)) {
      continue;
    }
    if (!zahle(f.kosten, vorrat)) continue;

    if (f.ziehen > 0) ziehe(stand, f.ziehen);
    for (let i = 0; i < f.laenderAufsFeld; i++) {
      const land = holeLandAusBibliothek(stand);
      if (land) stand.feld.push({ karte: land, seitZug: stand.zug });
    }
  }
}

/**
 * Wie viel billiger wird GENAU DIESE Karte durch das, was auf dem Feld liegt?
 *
 * Vorher wurden schlicht alle Rabatte auf dem Feld addiert und auf jeden Zauber angewandt. Ein
 * Urza's Incubator ("Dragon spells you cast cost {2} less") machte damit auch Länder-Suchzauber
 * und Combo-Teile billiger - und zwei solche Karten nebeneinander senkten alles um vier Mana.
 * Jetzt zählt ein Rabatt nur, wenn er für alle Zauber gilt oder der Typ der Karte dazu passt.
 */
function rabattFuer(stand: Stand, karte: SimCard): number {
  let summeRabatt = 0;
  for (const e of stand.feld) {
    const typ = e.karte.kostenrabattTyp;
    if (e.karte.kostenrabatt <= 0) continue;
    if (typ === null || karte.typen.includes(typ)) summeRabatt += e.karte.kostenrabatt;
  }
  return summeRabatt;
}

function mitRabatt(kosten: SimKosten, abzug: number): SimKosten {
  if (abzug <= 0) return kosten;
  const generisch = Math.max(0, kosten.generisch - abzug);
  return {
    generisch,
    pips: kosten.pips,
    gesamt: generisch + kosten.pips.length,
    hatX: kosten.hatX,
  };
}

/**
 * Je höher, desto eher wird die Karte gewirkt. Ein negativer Rang heißt: gar nicht wirken.
 *
 * DIE REIHENFOLGE BILDET AB, WIE EIN MENSCH SEIN SPIEL AUFBAUT - erst die Grundlage, dann die
 * Maschine, dann der Plan:
 *
 *   1. Mana und Rampe      Alles, was danach kommt, wird davon bezahlt. Ein Manastein im zweiten
 *                          Zug finanziert noch im selben Zug den nächsten Zauber.
 *   2. Synergie-Bausteine  Bleibende Karten, die auf das eigene Spiel reagieren. Sie sind nur
 *                          etwas wert, solange noch Züge kommen - je früher, desto mehr.
 *   3. Karten ziehen und suchen   Mehr Auswahl heißt mehr bezahlbare Karten in den Folgezügen.
 *   4. Bleibende Combo-Teile      Sie bleiben liegen und zählen ab sofort zur Combo.
 *   5. Alles andere        Bedrohungen, Verstärkungen, Rest.
 *
 * Die Rangfolge entscheidet nur die REIHENFOLGE innerhalb eines Zuges, nicht ob etwas gewirkt
 * wird: Die Hauptphase wiederholt sich, bis nichts mehr bezahlbar ist. Wichtig wird sie genau
 * dann, wenn das Mana knapp ist - und dann ist "erst die Manaquelle" fast immer richtig, weil
 * danach womöglich noch etwas anderes dazu passt.
 *
 * DER NEGATIVE FALL ist keine Feinheit, sondern die wichtigste Regel hier: Ein Combo-Teil, das
 * nach dem Wirken im Friedhof liegt (Spontanzauber, Hexerei), ist für die Combo verloren. Es wird
 * deshalb NIE gewirkt - egal wie viel Mana übrig ist. Auf der Hand behalten kostet nichts,
 * comboSteht() zählt Teile in der Hand mit, sofern das Mana reicht, sie nachzuwirken.
 */
export function rangFuer(karte: SimCard, deck: SimDeck, stand: { zug: number }): number {
  if (karte.gewinntSofort) return 100;

  // Combo-Teile zuerst prüfen, damit die Schutzregel jede andere Einordnung schlägt: Ein
  // Combo-Teil, das zufällig auch Mana macht, darf nicht als Manaquelle verheizt werden.
  if (istZielteil(karte, deck)) return karte.bleibend ? 55 : -1;

  // 1. Mana und Rampe
  if (karte.manaquelle && stand.zug <= 8) return 90 + karte.manaquelle.menge;
  if (karte.laenderAufsFeld > 0 && stand.zug <= 8) return 90 + karte.laenderAufsFeld;

  // 2. Synergie-Bausteine
  if (karte.synergie) return 80;

  // 3. Ziehen und suchen
  if (karte.faehigkeit && karte.faehigkeit.ziehen > 0) return 75;
  if (karte.ziehen >= 2) return 70;
  if (karte.tutor) return 65;

  // 5. Der Rest
  if (karte.massenpump !== 0 || karte.extraKampf) return 45;
  const brettgewinn = karte.staerke + karte.tokenAnzahl * karte.tokenStaerke;
  if (karte.istKreatur || karte.tokenAnzahl > 0) return 20 + Math.min(brettgewinn, 15);
  if (karte.anthem > 0) return 25;
  if (karte.ausruestung > 0) return 22;
  if (karte.ziehen > 0) return 15;
  return 5;
}

/**
 * Gehört diese Karte zu einer gewinnenden Combo dieses Decks?
 *
 * Gefragt wird die vollständige Menge aller Combo-Karten, NICHT die Liste der gerade verfolgten
 * Ziele: Der Schutz vor dem eigenen Friedhof muss für jedes Combo-Teil gelten, auch für eines, das
 * zu einer Combo gehört, die der Simulator aus Laufzeitgründen nicht aktiv verfolgt.
 */
function istZielteil(karte: SimCard, deck: SimDeck): boolean {
  return deck.comboTeile.has(karte.key);
}

/**
 * Legt die Karte ab und wendet an, was sie sofort tut. Rückgabe: direkter Schaden an jeden Gegner.
 *
 * Neue Manaquellen landen im Vorrat DIESES Zuges, sofern sie sofort tappen dürfen - ein Sol Ring
 * im zweiten Zug finanziert noch im selben Zug den nächsten Zauber, und genau daran hängt ein
 * guter Teil des Tempounterschieds zwischen einem Precon und einem durchgebauten Deck.
 */
function spieleKarte(karte: SimCard, deck: SimDeck, stand: Stand, vorrat: Quelle[]): number {
  if (karte.ziehen > 0) ziehe(stand, karte.ziehen);

  for (let i = 0; i < karte.laenderAufsFeld; i++) {
    const land = holeLandAusBibliothek(stand);
    // Gesuchte Länder kommen fast ausnahmslos getappt herein - sie geben erst im nächsten Zug Mana.
    if (land) stand.feld.push({ karte: land, seitZug: stand.zug });
  }
  for (let i = 0; i < karte.laenderInDieHand; i++) {
    const land = holeLandAusBibliothek(stand);
    if (land) stand.hand.push(land);
  }

  // Ein Landsuch-Zauber ist oben schon abgehandelt (laenderAufsFeld / laenderInDieHand). Ihn hier
  // ein zweites Mal als Tutor laufen zu lassen hiesse, dieselbe Suche doppelt zu zaehlen: Rampant
  // Growth legte ein Land aufs Feld UND holte sich noch eines auf die Hand.
  const schonGesucht = karte.laenderAufsFeld > 0 || karte.laenderInDieHand > 0;
  if (karte.tutor && !schonGesucht) {
    const gesucht = tutorTreffer(karte, deck, stand);
    if (gesucht) stand.hand.push(gesucht);
  }

  // Massenpump und Extra-Kampf gelten nur in DIESEM Zug - siehe Stand.pumpDiesenZug.
  if (karte.massenpump !== 0) {
    stand.pumpDiesenZug =
      karte.massenpump === -1 || stand.pumpDiesenZug === -1
        ? -1
        : Math.max(stand.pumpDiesenZug, karte.massenpump);
  }
  if (karte.extraKampf) stand.extraKampfDiesenZug = true;

  if (karte.ritual > 0) {
    vorrat.push({ farben: ALLE_FARBEN, menge: karte.ritual });
  }
  if (karte.manaquelle && !karte.manaquelle.brauchtBereitschaft) {
    vorrat.push({ farben: karte.manaquelle.farben || ALLE_FARBEN, menge: karte.manaquelle.menge });
  }

  for (let i = 0; i < karte.tokenAnzahl; i++) {
    stand.feld.push({ karte: tokenKarte(karte.tokenStaerke), seitZug: stand.zug });
  }

  if (karte.bleibend) {
    // Eine als ZAUBER gewirkte Doppelkarte liegt als Zauber auf dem Feld, nicht als Land - sonst
    // würde sie dort auch noch Mana machen.
    const aufDemFeld = karte.landAufRueckseite ? { ...karte, land: null } : karte;
    stand.feld.push({ karte: aufDemFeld, seitZug: stand.zug });
  }

  // "X Schaden an jeden Gegner": X ist, was nach dem Wirken noch im Vorrat liegt.
  return karte.schadenJeGegner === -1 ? summe(vorrat) : karte.schadenJeGegner;
}

/** Holt ein Land aus der Bibliothek - Ramp sucht sich immer eines. */
function holeLandAusBibliothek(stand: Stand): SimCard | null {
  for (let i = 0; i < stand.bibliothek.length; i++) {
    if (stand.bibliothek[i].land) return stand.bibliothek.splice(i, 1)[0];
  }
  return null;
}

/**
 * Was holt dieser Tutor aus der Bibliothek?
 *
 * ZWEI FEHLER STECKTEN HIER, an beiden Enden derselben Zeile: Vorher fand JEDER Tutor sofort das
 * fehlende Combo-Teil - auch ein Landsuch-Zauber, auch einer, der nur Kreaturen holen darf. Und
 * hatte das Deck keine Combo, tat derselbe Tutor GAR NICHTS und war eine tote Karte. Ausgerechnet
 * die Tutorendichte ist eine der beiden Größen, an denen die Bracket-Einstufung hängt.
 *
 * Jetzt gilt: Zuerst das fehlende Combo-Teil, sofern der Tutor es überhaupt holen darf. Sonst die
 * beste Karte, die er holen darf - gemessen an derselben Rangfolge, nach der auch gewirkt wird.
 * Ein Tutor ist damit nie wirkungslos und nie allmächtig.
 */
function tutorTreffer(tutor: SimCard, deck: SimDeck, stand: Stand): SimCard | null {
  const darfHolen = (karte: SimCard) => {
    if (tutor.tutorZiel === 'land') return karte.istLand;
    if (tutor.tutorZiel === 'kreatur') return karte.istKreatur;
    return true;
  };

  const fehlendes = sucheZielteil(deck, stand, darfHolen);
  if (fehlendes) return fehlendes;

  let beste = -1;
  let besterRang = -Infinity;
  for (let i = 0; i < stand.bibliothek.length; i++) {
    const karte = stand.bibliothek[i];
    if (!darfHolen(karte)) continue;
    // Ein Land ist über die Wirk-Rangfolge nicht bewertbar (es wird nicht gewirkt) - für einen
    // Landsuch-Tutor ist aber jedes Land recht.
    const rang = karte.istLand ? 10 : rangFuer(karte, deck, stand);
    if (rang > besterRang) {
      besterRang = rang;
      beste = i;
    }
  }
  return beste >= 0 ? stand.bibliothek.splice(beste, 1)[0] : null;
}

/** Sucht das fehlende Combo-Teil aus der Bibliothek, sofern der Tutor es holen darf. */
function sucheZielteil(
  deck: SimDeck,
  stand: Stand,
  darfHolen: (karte: SimCard) => boolean,
): SimCard | null {
  for (const ziel of deck.ziele) {
    for (const key of ziel.keys) {
      if (stand.hand.some((k) => k.key === key)) continue;
      if (stand.feld.some((e) => e.karte.key === key)) continue;
      const index = stand.bibliothek.findIndex((k) => k.key === key && darfHolen(k));
      if (index >= 0) return stand.bibliothek.splice(index, 1)[0];
    }
  }
  return null;
}

/**
 * Steht eine gewinnende Combo?
 *
 * Verlangt wird, dass jedes Teil entweder liegt oder in der Hand ist UND das Mana für alles
 * Fehlende zusammen samt dem Zusatzmana der Combo noch im Vorrat ist. Das ist strenger als "alle
 * Teile irgendwo" und lockerer als eine echte Reihenfolge-Prüfung - genau die Grobheit, mit der
 * sich Combo-Decks von Nicht-Combo-Decks trennen lassen, ohne jede Combo einzeln nachzubauen.
 */
function comboSteht(deck: SimDeck, stand: Stand, vorrat: readonly Quelle[]): boolean {
  for (const ziel of deck.ziele) {
    // Die Kosten aller noch zu wirkenden Teile zu EINER Kostenzeile zusammenfassen - samt der
    // farbigen Pips. Vorher stand hier nur ein Zahlenvergleich über kosten.gesamt, und damit
    // konnte ein Deck aus lauter Wäldern eine Combo aus zwei blauen Karten "aufstellen". Der
    // sorgfältige Farbabgleich aus zahle() lag daneben und wurde an dieser Stelle nicht benutzt.
    const offen: SimKosten = { generisch: ziel.zusatzMana, pips: [], gesamt: 0, hatX: false };
    let vollstaendig = true;

    for (const key of ziel.keys) {
      if (stand.feld.some((e) => e.karte.key === key)) continue;
      const inHand = stand.hand.find((k) => k.key === key);
      if (!inHand) {
        vollstaendig = false;
        break;
      }
      offen.generisch += inHand.kosten.generisch;
      offen.pips.push(...inHand.kosten.pips);
    }

    offen.gesamt = offen.generisch + offen.pips.length;
    if (vollstaendig && kannZahlen(offen, vorrat)) return true;
  }
  return false;
}

/** Was das Feld in diesem Zug an Schaden austeilen könnte. */
export function angriffsschaden(stand: {
  feld: { karte: SimCard; seitZug: number }[];
  zug: number;
  /** Massenpump aus diesem Zug (-1 = "+X/+X", X = Kreaturenzahl). Fehlt er, wird nicht gepumpt. */
  pumpDiesenZug?: number;
  /** Zusätzliche Kampfphase aus diesem Zug. */
  extraKampfDiesenZug?: boolean;
}): number {
  let kreaturen = 0;
  let gesamt = 0;
  let anthem = 0;
  let ausruestung = 0;
  // Beides kommt aus dem ZUG, nicht vom Feld: Ein "+X/+X bis Zugende" wirkt in dem Zug, in dem es
  // gespielt wurde, und danach nie wieder - egal ob die Karte liegen bleibt oder nicht.
  const pump = stand.pumpDiesenZug ?? 0;
  const extraKampf = stand.extraKampfDiesenZug ?? false;

  for (const eintrag of stand.feld) {
    const k = eintrag.karte;
    anthem += k.anthem;
    ausruestung += k.ausruestung;
    if (!k.istKreatur || k.staerke <= 0) continue;
    // Einsatzverzögerung: was in diesem Zug dazukam, greift nur mit Eile an.
    if (eintrag.seitZug >= stand.zug && !k.eile) continue;
    kreaturen++;
    gesamt += k.staerke;
  }

  if (kreaturen === 0) return 0;
  gesamt += anthem * kreaturen;
  // Eine Ausrüstung hängt an EINER Kreatur, nicht an allen - deshalb einmal der Bonus und nicht
  // einmal je Kreatur. Mehrere Ausrüstungen dürfen sich auf derselben Kreatur stapeln, ihre Boni
  // also addieren; die Ausrüstungskosten bleiben unberücksichtigt, weil im späten Spiel ohnehin
  // Mana übrig ist.
  gesamt += ausruestung;
  // -1 steht für "+X/+X, X = Anzahl der Kreaturen" (Craterhoof-Muster).
  //
  // Dieser Zweig war bis zum 17.09.2026 UNERREICHBAR: Der Pump wurde vom Feld mit
  // "Math.max(pump, k.massenpump)" eingesammelt, und Math.max(0, -1) ist 0 - das Kennzeichen wurde
  // also jedes Mal weggeworfen. Craterhoof Behemoth und alle verwandten Abschlusskarten waren
  // damit wirkungslos; im Test sprang ein Deck mit zehn davon von 17 % auf 90 % Siegquote, als der
  // Zweig zum ersten Mal lief. Deshalb kommt der Pump jetzt aus dem Zug und nicht mehr vom Feld.
  //
  // Bewusst untertrieben: X ist hier die Zahl der ANGREIFENDEN Kreaturen, nicht aller. Was in
  // diesem Zug dazukam, greift nicht mit an und zählt deshalb auch nicht ins X.
  gesamt += (pump === -1 ? kreaturen : pump) * kreaturen;
  return extraKampf ? gesamt * 2 : gesamt;
}

/** Spielt ein Deck mehrfach aus und fasst zusammen. */
export function simuliereDeck(deck: SimDeck, spiele: number, seed = 1): SimErgebnis {
  const siegZuege: number[] = [];
  const kumulativ: number[] = [];
  const schaden10: number[] = [];
  let siege = 0;
  let comboSiege = 0;
  let mana3 = 0;
  let mana5 = 0;
  let mana7 = 0;
  let mulligans = 0;
  let leerlauf = 0;
  let abbrueche = 0;

  for (let i = 0; i < spiele; i++) {
    const spiel = simuliereSpiel(deck, seed + i);
    siegZuege.push(spiel.siegZug);
    kumulativ.push(spiel.kumulativZug);
    schaden10.push(spiel.schadenBisZug10);
    if (spiel.siegZug !== KEIN_SIEG) {
      siege++;
      if (spiel.art === 'combo') comboSiege++;
    }
    mana3 += spiel.manaProben[0];
    mana5 += spiel.manaProben[1];
    mana7 += spiel.manaProben[2];
    mulligans += spiel.mulligans;
    leerlauf += spiel.leerlaufZuege;
    if (spiel.abgebrochen) abbrueche++;
  }

  const p25 = perzentil(siegZuege, 0.25);
  const p75 = perzentil(siegZuege, 0.75);

  return {
    spiele,
    siegquote: siege / spiele,
    median: perzentil(siegZuege, 0.5),
    schnellste10: perzentil(siegZuege, 0.1),
    kumulativMedian: perzentil(kumulativ, 0.5),
    comboAnteil: siege === 0 ? 0 : comboSiege / siege,
    manaZug3: mana3 / spiele,
    manaZug5: mana5 / spiele,
    manaZug7: mana7 / spiele,
    p25,
    p75,
    streuung: p75 - p25,
    schadenZug10: perzentil(schaden10, 0.5),
    mulliganSchnitt: mulligans / spiele,
    leerlaufSchnitt: leerlauf / spiele,
    abbruchAnteil: abbrueche / spiele,
  };
}

/**
 * Perzentil über alle Spiele, auch die ohne Sieg (die mit KEIN_SIEG eingehen).
 *
 * Bewusst so und nicht "Median der gewonnenen Spiele": Ein Deck, das in 5 % der Spiele auf Zug 4
 * gewinnt und sonst gar nicht, hätte dort einen Median von 4 und stünde damit vor einem Deck, das
 * immer auf Zug 7 gewinnt. Mit den Nicht-Siegen in der Reihe sagt der Median das, was er sagen
 * soll: wie lange es dauert, bis dieses Deck normalerweise gewinnen kann.
 *
 * Gerechnet wird nach dem nächsten Rang (aufrunden), nicht abrundend: Das 10. Perzentil von zehn
 * Spielen ist damit das schnellste davon und nicht das zweitschnellste - gefragt ist "wie schnell
 * KANN dieses Deck", und darauf antwortet der beste Wert des Zehntels.
 */
export function perzentil(werte: number[], anteil: number): number {
  if (werte.length === 0) return KEIN_SIEG;
  const sortiert = [...werte].sort((a, b) => a - b);
  const rang = Math.ceil(anteil * sortiert.length) - 1;
  return sortiert[Math.min(sortiert.length - 1, Math.max(0, rang))];
}
