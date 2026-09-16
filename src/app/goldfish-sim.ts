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
 *   - Keine Entscheidungen im menschlichen Sinn. Die Spielweise unten ist eine feste Rangfolge
 *     (erst Mana, dann Suchen, dann Bedrohungen) - gut genug, um zwei Decks miteinander zu
 *     vergleichen, und viel zu grob, um einem Menschen zu sagen, wie er sein Deck spielen soll.
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
}

/**
 * Welche Combo-Ergebnisse beenden ein Spiel?
 *
 * Commander Spellbook beschreibt jedes Ergebnis im Klartext ("Infinite damage", "Infinite mana").
 * Der Unterschied ist wesentlich: Unendlich VIEL MANA gewinnt gar nichts, solange nichts da ist,
 * wofür man es ausgibt - unendlich Schaden schon. Diese Liste ist deshalb bewusst eng und nennt
 * nur Ergebnisse, die ein Spiel unmittelbar entscheiden.
 */
const SIEG_ERGEBNIS =
  /win the game|infinite damage|infinite turns|infinite mill|infinite loss of life|each opponent loses the game|lose the game/i;

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
  };

  starthand(deck, stand, rng);
  // Der Commander liegt in der Kommandozone und ist jeden Zug verfügbar. Ihn einfach in die Hand
  // zu legen ist die Näherung dafür: Im Goldfish stirbt er nie, die Kommandosteuer fällt also
  // nie an, und mehr als "er ist da, sobald das Mana reicht" braucht der Simulator nicht.
  for (const c of deck.commander) stand.hand.push(c);

  const spiel: SimSpiel = {
    siegZug: KEIN_SIEG,
    art: null,
    kumulativZug: KEIN_SIEG,
    manaProben: [0, 0, 0],
  };

  while (stand.zug < MAX_ZUEGE) {
    stand.zug++;
    stand.landGespielt = false;

    // Auf dem Spiel: im ersten Zug wird nicht gezogen.
    if (stand.zug > 1) ziehe(stand, 1);

    landDrop(deck, stand);

    // Der Manavorrat des Zuges. Alles, was jetzt bereitsteht, wird EINMAL gezählt und danach
    // verbraucht - das ist das Gegenstück zum Tappen.
    const vorrat = quellen(deck, stand);
    const gesamtMana = summe(vorrat);

    // Erst prüfen, dann wirken: Steht die Combo schon zu Beginn der Hauptphase, darf das Mana
    // dafür nicht vorher in einen Bären wandern. Die Prüfung nach der Hauptphase bleibt zusätzlich
    // bestehen - sie fängt den Fall, dass das letzte Teil gerade erst gewirkt wurde.
    const comboVorher = comboSteht(deck, stand, vorrat);
    const schadenDiesenZug = comboVorher ? 0 : hauptphase(deck, stand, vorrat);
    if (!comboVorher) engines(stand, vorrat);

    if (stand.zug === 3) spiel.manaProben[0] = gesamtMana;
    if (stand.zug === 5) spiel.manaProben[1] = gesamtMana;
    if (stand.zug === 7) spiel.manaProben[2] = gesamtMana;

    const angriff = angriffsschaden(stand) + schadenDiesenZug;
    stand.schadenGesamt += angriff;

    if (comboVorher || comboSteht(deck, stand, vorrat)) {
      spiel.siegZug = stand.zug;
      spiel.art = 'combo';
    } else if (angriff >= LETHAL) {
      spiel.siegZug = stand.zug;
      spiel.art = 'schaden';
    }
    if (spiel.kumulativZug === KEIN_SIEG && stand.schadenGesamt >= LETHAL) {
      spiel.kumulativZug = stand.zug;
    }
    if (spiel.siegZug !== KEIN_SIEG) break;
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
function starthand(deck: SimDeck, stand: Stand, rng: () => number): void {
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
      return;
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
 * Rückgabewert ist der direkte Schaden, den die gewirkten Zauber an jeden Gegner ausgeteilt haben.
 */
function hauptphase(deck: SimDeck, stand: Stand, vorrat: Quelle[]): number {
  let schaden = 0;

  // Obergrenze gegen eine Endlosschleife, falls eine Karte sich selbst nachzieht. 40 Zauber in
  // einem Zug hat kein Deck dieser Auswertung je erreicht; die Grenze ist eine Sicherung, kein Maß.
  for (let schritt = 0; schritt < 40; schritt++) {
    const abzug = kostenrabatt(stand);
    let beste = -1;
    let besterRang = -Infinity;

    for (let i = 0; i < stand.hand.length; i++) {
      const karte = stand.hand[i];
      if (karte.land) continue;
      if (!kannZahlen(mitRabatt(karte.kosten, abzug), vorrat)) continue;
      const rang = rangFuer(karte, deck, stand);
      if (rang < 0) continue;
      if (rang > besterRang) {
        besterRang = rang;
        beste = i;
      }
    }
    if (beste < 0) break;

    const karte = stand.hand.splice(beste, 1)[0];
    zahle(mitRabatt(karte.kosten, abzug), vorrat);
    schaden += spieleKarte(karte, deck, stand, vorrat);
  }
  return schaden;
}

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

function kostenrabatt(stand: Stand): number {
  let summeRabatt = 0;
  for (const e of stand.feld) summeRabatt += e.karte.kostenrabatt;
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
 * Der negative Fall ist keine Feinheit, sondern verhindert, dass sich das Deck selbst die Combo
 * zerlegt: Ein Combo-Teil, das NICHT liegen bleibt (Spontanzauber, Hexerei), ist nach dem Wirken
 * weg - ohne Gegenstück also ersatzlos verheizt. Ein bleibendes Teil darf dagegen jederzeit
 * gewirkt werden, es steht danach auf dem Feld und zählt weiter zur Combo.
 *
 * Auf der Hand behalten kostet nichts: comboSteht() zählt Teile in der Hand mit, sofern das Mana
 * reicht, sie im selben Zug nachzuwirken.
 */
export function rangFuer(karte: SimCard, deck: SimDeck, stand: { zug: number }): number {
  if (karte.gewinntSofort) return 100;
  if (istZielteil(karte, deck)) return karte.bleibend ? 90 : -1;
  if (karte.manaquelle && stand.zug <= 8) return 70 + karte.manaquelle.menge;
  if (karte.laenderAufsFeld > 0 && stand.zug <= 8) return 70 + karte.laenderAufsFeld;
  if (karte.tutor && deck.ziele.length > 0) return 60;
  if (karte.ziehen >= 2) return 50;
  if (karte.massenpump !== 0 || karte.extraKampf) return 45;
  const brettgewinn = karte.staerke + karte.tokenAnzahl * karte.tokenStaerke;
  if (karte.istKreatur || karte.tokenAnzahl > 0) return 20 + Math.min(brettgewinn, 15);
  if (karte.ausruestung > 0) return 22;
  if (karte.anthem > 0) return 25;
  if (karte.ziehen > 0) return 15;
  return 5;
}

function istZielteil(karte: SimCard, deck: SimDeck): boolean {
  for (const ziel of deck.ziele) {
    if (ziel.keys.includes(karte.key)) return true;
  }
  return false;
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

  if (karte.tutor) {
    const gesucht = sucheZielteil(deck, stand);
    if (gesucht) stand.hand.push(gesucht);
  }

  if (karte.ritual > 0) {
    vorrat.push({ farben: ALLE_FARBEN, menge: karte.ritual });
  }
  if (karte.manaquelle && !karte.manaquelle.brauchtBereitschaft) {
    vorrat.push({ farben: karte.manaquelle.farben || ALLE_FARBEN, menge: karte.manaquelle.menge });
  }

  for (let i = 0; i < karte.tokenAnzahl; i++) {
    stand.feld.push({ karte: tokenKarte(karte.tokenStaerke), seitZug: stand.zug });
  }

  if (karte.bleibend) stand.feld.push({ karte, seitZug: stand.zug });

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

/** Sucht das fehlende Combo-Teil aus der Bibliothek. */
function sucheZielteil(deck: SimDeck, stand: Stand): SimCard | null {
  for (const ziel of deck.ziele) {
    for (const key of ziel.keys) {
      if (stand.hand.some((k) => k.key === key)) continue;
      if (stand.feld.some((e) => e.karte.key === key)) continue;
      const index = stand.bibliothek.findIndex((k) => k.key === key);
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
  const mana = summe(vorrat);

  for (const ziel of deck.ziele) {
    let fehlendesMana = ziel.zusatzMana;
    let vollstaendig = true;

    for (const key of ziel.keys) {
      if (stand.feld.some((e) => e.karte.key === key)) continue;
      const inHand = stand.hand.find((k) => k.key === key);
      if (!inHand) {
        vollstaendig = false;
        break;
      }
      fehlendesMana += inHand.kosten.gesamt;
    }

    if (vollstaendig && fehlendesMana <= mana) return true;
  }
  return false;
}

/** Was das Feld in diesem Zug an Schaden austeilen könnte. */
export function angriffsschaden(stand: {
  feld: { karte: SimCard; seitZug: number }[];
  zug: number;
}): number {
  let kreaturen = 0;
  let gesamt = 0;
  let anthem = 0;
  let ausruestung = 0;
  let pump = 0;
  let extraKampf = false;

  for (const eintrag of stand.feld) {
    const k = eintrag.karte;
    anthem += k.anthem;
    ausruestung += k.ausruestung;
    if (k.extraKampf) extraKampf = true;
    if (k.massenpump !== 0) pump = Math.max(pump, k.massenpump);
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
  gesamt += (pump === -1 ? kreaturen : pump) * kreaturen;
  return extraKampf ? gesamt * 2 : gesamt;
}

/** Spielt ein Deck mehrfach aus und fasst zusammen. */
export function simuliereDeck(deck: SimDeck, spiele: number, seed = 1): SimErgebnis {
  const siegZuege: number[] = [];
  const kumulativ: number[] = [];
  let siege = 0;
  let comboSiege = 0;
  let mana3 = 0;
  let mana5 = 0;
  let mana7 = 0;

  for (let i = 0; i < spiele; i++) {
    const spiel = simuliereSpiel(deck, seed + i);
    siegZuege.push(spiel.siegZug);
    kumulativ.push(spiel.kumulativZug);
    if (spiel.siegZug !== KEIN_SIEG) {
      siege++;
      if (spiel.art === 'combo') comboSiege++;
    }
    mana3 += spiel.manaProben[0];
    mana5 += spiel.manaProben[1];
    mana7 += spiel.manaProben[2];
  }

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
