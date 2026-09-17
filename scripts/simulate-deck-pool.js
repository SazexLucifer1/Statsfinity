// Der Goldfish-Stapellauf über den Archidekt-Deckvorrat.
// Ergebnistabelle und Begründung: sql/deck-sim-results-2026-09-16.sql
// Ausgelöst von .github/workflows/deck-sim.yml (nur von Hand, kein Nachtlauf).
//
// Kurz: Jedes Deck des Vorrats wird ein paar hundert Mal ohne Gegner ausgespielt, und es wird
// notiert, in welchem Zug es hätte gewinnen können - dazu seit Fassung 6 der aufaddierte Schaden
// bis Zug 10 (die UNZENSIERTE Uhr: der Siegzug steht bei der Mehrzahl aller Decks am Anschlag und
// kann dort nichts mehr trennen), die Streuung der Siegzüge und die Leerlaufzüge. Dazu kommen gezählte Kennzahlen (Rampe,
// Kartenziehen, Interaktion, Tutoren, Manakosten). Damit lässt sich die Frage, um die es geht -
// worin unterscheiden sich Bracket 2, 3 und 4 MESSBAR? - an 40.000 Decks beantworten statt an
// Vermutungen. Die fertige Gegenüberstellung liefert die Ansicht deck_sim_by_bracket.
//
// DIE SPIELLOGIK STEHT NICHT HIER. Sie liegt in src/app/goldfish-sim.ts und
// src/app/sim-card-profile.ts, weil dieselbe Rechnung später im Browser für ein einzelnes Deck
// laufen soll. Zwei Kopien derselben Regeln wären die sichere Art, sie auseinanderlaufen zu
// lassen: Der Stapellauf würde Schwellen liefern, nach denen die App gar nicht rechnet. Dieses
// Skript bündelt die beiden TypeScript-Module deshalb zur Laufzeit mit esbuild (liegt als
// Abhängigkeit des Angular-Builds ohnehin im Projekt) und benutzt genau den Code der App.
//
// Braucht den Supabase SERVICE-ROLE-Key - der Vorrat ist per RLS nur für Developer lesbar:
//
//   SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/simulate-deck-pool.js --bracket 3 --anzahl 1000
//
// Idempotent: Ein zweiter Lauf derselben Fassung überschreibt seine eigenen Zeilen.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

/**
 * Fassung des Simulators. GEHÖRT HOCHGEZÄHLT, sobald sich an der Spiellogik etwas ändert.
 *
 * Sie steht im Primärschlüssel der Ergebnistabelle, damit ein neuer Lauf die alten Zahlen nicht
 * still überschreibt. Ohne sie ließe sich hinterher nicht mehr sagen, ob ein verschobenes Ergebnis
 * am Deck liegt oder an einer Änderung hier.
 */
const SIM_VERSION = '8';

/** Voreinstellung: so oft wird jedes Deck ausgespielt. */
const SPIELE_JE_DECK = 200;

/**
 * Ab welcher Erkennungsquote eine Zeile in die AUSWERTUNG darf.
 *
 * Geschrieben werden weiterhin alle Zeilen - ein Deck stillschweigend verschwinden zu lassen wäre
 * der schlechtere Fehler. Aber die Ansichten, die die Stufen vergleichen, filtern darauf (siehe
 * sql/deck-sim-v6-2026-09-16.sql). Der Grund steht in der Spalte selbst: Bei 0,4 erkannten Karten
 * sagt ein später Siegzug mehr über die Grenzen der Kartenauswertung als über das Deck. Die Zahl
 * war von Anfang an da und hat nie etwas gefiltert.
 */
const MIN_ERKANNT = 0.6;

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://jkkelwpnrgzbvopszwrl.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Kategorien aus scryfall_card_effects, die als Interaktion zählen. */
const INTERAKTION = ['removal', 'counterspell', 'boardwipe'];
/** Die übrigen Kategorien, die als eigene Kennzahl mitlaufen. */
const WEITERE_KATEGORIEN = ['ramp', 'draw'];

// ---------------------------------------------------------------------------------------------
// Aufrufparameter
// ---------------------------------------------------------------------------------------------

function argument(name, standard) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : standard;
}

const dryRun = process.argv.includes('--dry-run');
const bracketFilter = argument('bracket', 'alle');
const maxDecks = Number(argument('anzahl', '1000'));
const spiele = Number(argument('spiele', String(SPIELE_JE_DECK)));

if (!SERVICE_ROLE_KEY) {
  console.error(
    'Fehlt: SUPABASE_SERVICE_ROLE_KEY als Umgebungsvariable setzen (siehe Kommentar oben).',
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------------------------
// Den Simulator aus src/app/ holen
// ---------------------------------------------------------------------------------------------

/**
 * Bündelt die beiden TypeScript-Module zu einer Datei und lädt sie.
 *
 * Node kann TypeScript inzwischen selbst ausführen, scheitert hier aber an etwas anderem: Die
 * Module importieren sich gegenseitig ohne Dateiendung ("./sim-card-profile"), wie in Angular
 * üblich - und Nodes ESM-Auflösung verlangt die Endung. esbuild löst das in einem Schritt mit.
 */
function ladeSimulator() {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    console.error('esbuild nicht gefunden - "npm ci" im Projektverzeichnis ausführen.');
    process.exit(1);
  }

  const ziel = path.join(os.tmpdir(), `statsfinity-sim-${process.pid}.cjs`);
  esbuild.buildSync({
    // Ein Einstieg, der beide Module weiterreicht - gebraucht wird aus dem einen die
    // Spielschleife, aus dem anderen der Kartensteckbrief.
    stdin: {
      contents: "export * from './goldfish-sim.ts';\nexport * from './sim-card-profile.ts';\n",
      resolveDir: path.join(__dirname, '..', 'src/app'),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: ziel,
  });
  return ziel;
}

// ---------------------------------------------------------------------------------------------
// Daten laden
// ---------------------------------------------------------------------------------------------

const SEITE = 1000;

/** Liest eine ganze Tabelle in Paketen - Supabase schneidet eine Antwort sonst still bei 1.000 Zeilen ab. */
async function ladeAlle(tabelle, spalten, anpassen = (q) => q) {
  const zeilen = [];
  for (let von = 0; ; von += SEITE) {
    const { data, error } = await anpassen(
      supabase
        .from(tabelle)
        .select(spalten)
        .range(von, von + SEITE - 1),
    );
    if (error) {
      const hinweis =
        tabelle === 'spellbook_winning_combos'
          ? ' Migration sql/spellbook-winning-combos-matview-2026-09-16.sql schon ausgefuehrt?'
          : '';
      throw new Error(`Laden aus ${tabelle} fehlgeschlagen: ${error.message}.${hinweis}`);
    }
    zeilen.push(...data);
    if (data.length < SEITE) return zeilen;
  }
}

/**
 * Je Kartenname genau eine Zeile - und zwar die SPIELBARE.
 *
 * Der normalisierte Vorderseiten-Name ist nicht eindeutig: 45 Namen haben mehrere Einträge, und
 * bei 21 davon ist einer im Commander spielbar und ein anderer nicht. "Savage Lands" gibt es als
 * Dreifarben-Land (spielbar) und als Eintrag mit der Typzeile "Card" (nicht spielbar), "Smelt" als
 * Instant und als Playtest-Karte "Smelt // Herd // Saw".
 *
 * Ohne diese Auswahl gewinnt schlicht die zuletzt geladene Zeile - also der Zufall. Ein Land, das
 * als Nicht-Land eingestuft wird, verschiebt das ganze simulierte Spiel, und bei "Savage Lands"
 * hinge das an 875 Decks. Die Reihenfolge ist deshalb: spielbar schlägt unbekannt schlägt
 * unspielbar.
 */
function ohneDoppelte(zeilen) {
  const beste = new Map();
  const rang = (zeile) =>
    zeile.commander_legal === true ? 2 : zeile.commander_legal === null ? 1 : 0;
  for (const zeile of zeilen) {
    const vorhanden = beste.get(zeile.front_name_normalized);
    if (!vorhanden || rang(zeile) > rang(vorhanden)) beste.set(zeile.front_name_normalized, zeile);
  }
  return [...beste.values()];
}

async function ladeKartendaten() {
  console.log('Kartendaten laden ...');
  const rohe = await ladeAlle(
    'scryfall_cards',
    'front_name_normalized, name, type_line, oracle_text, back_type_line, back_oracle_text, mana_cost, cmc, produced_mana, power, keywords, game_changer, color_identity, commander_legal',
  );
  const karten = ohneDoppelte(rohe);
  const flags = await ladeAlle('spellbook_card_flags', 'name_normalized, tutor');
  const effekte = await ladeAlle('scryfall_card_effects', 'category, front_name_normalized', (q) =>
    q.in('category', [...INTERAKTION, ...WEITERE_KATEGORIEN]),
  );

  const tutoren = new Set(flags.filter((f) => f.tutor).map((f) => f.name_normalized));
  // Die Farbidentität steht bewusst NICHT im Kartensteckbrief: Sie ist eine Regel des Formats,
  // keine Eigenschaft im Spielverlauf. Der Stapellauf braucht sie trotzdem, um die Farben des
  // Decks aus den Commandern zu bestimmen.
  const farbenNachKarte = new Map(
    karten.map((k) => [k.front_name_normalized, k.color_identity ?? []]),
  );
  const kategorien = new Map();
  for (const e of effekte) {
    const vorhanden = kategorien.get(e.front_name_normalized);
    if (vorhanden) vorhanden.add(e.category);
    else kategorien.set(e.front_name_normalized, new Set([e.category]));
  }

  console.log(
    `  ${karten.length} Karten (${rohe.length - karten.length} doppelte Namen zusammengefasst), ` +
      `${tutoren.size} Tutoren, ${kategorien.size} Karten mit Effekt-Kategorie.`,
  );
  return { karten, tutoren, kategorien, farbenNachKarte };
}

/**
 * Prüft, dass die Datenbank dieselbe Sieg-Definition benutzt wie der Simulator.
 *
 * Dieser Abgleich existiert wegen eines echten Fehlers: Die Liste der spielbeendenden Ergebnisse
 * stand zweimal - einmal in src/app/goldfish-sim.ts, einmal im SQL der Ansicht - mit einem
 * Kommentar, beide müssten übereinstimmen. Sie taten es nicht (die eine zählte "You lose the game"
 * als Sieg, die andere verpasste "All opponents lose the game"), und gemerkt hat es niemand, weil
 * nichts es geprüft hat. Jetzt bricht der Lauf ab, statt Zahlen aus zwei Definitionen zu mischen.
 */
async function pruefeSiegDefinition(sim) {
  const paare = [
    ['spellbook_winning_combo_muster', sim.SIEG_MUSTER, 'weite Sieg-Definition'],
    ['spellbook_sofort_sieg_muster', sim.SOFORT_SIEG_MUSTER, 'enge Sieg-Definition (Urteil F)'],
    ['spellbook_sieg_ausnahme', sim.SIEG_AUSNAHME, 'Ausnahmeliste'],
  ];
  for (const [funktion, erwartet, bezeichnung] of paare) {
    const { data, error } = await supabase.rpc(funktion);
    if (error) {
      throw new Error(
        `${bezeichnung} nicht lesbar (${funktion}): ${error.message}. ` +
          'Migration sql/sieg-definition-breit-2026-09-17.sql schon ausgefuehrt?',
      );
    }
    if (data !== erwartet) {
      throw new Error(
        `Die ${bezeichnung} der Datenbank weicht vom Simulator ab.\n` +
          `  Datenbank:  ${data}\n` +
          `  Simulator:  ${erwartet}\n` +
          'Beide muessen woertlich gleich sein - sonst zaehlen Stapellauf und App Verschiedenes.',
      );
    }
  }
  console.log('Alle drei Sieg-Definitionen stimmen zwischen Datenbank und Simulator ueberein.');
}

async function ladeGewinnCombos() {
  console.log('Gewinnende Combos laden ...');
  // spellbook_winning_combos ist eine MATERIALISIERTE Ansicht - sie liefert fertige Zeilen. Als
  // gewoehnliche Ansicht hat dieselbe Abfrage die Verknuepfung ueber 369.706 Kartenzeilen bei
  // JEDEM der zwanzig Pakete neu gerechnet und ist irgendwann in die Zeitueberschreitung gelaufen
  // (siehe sql/spellbook-winning-combos-matview-2026-09-16.sql).
  const combos = await ladeAlle(
    'spellbook_winning_combos',
    'combo_id, mana_value_needed, card_names, commander_required, beendet_sofort',
  );

  // Welche Combos enthalten diese Karte? Ohne diesen Index müsste je Deck die ganze Liste
  // durchlaufen werden - bei 40.000 Decks und zehntausenden Combos ist das der Unterschied
  // zwischen Minuten und Tagen.
  const nachKarte = new Map();
  combos.forEach((combo, index) => {
    for (const name of combo.card_names) {
      const liste = nachKarte.get(name);
      if (liste) liste.push(index);
      else nachKarte.set(name, [index]);
    }
  });

  const sofort = combos.filter((c) => c.beendet_sofort).length;
  console.log(
    `  ${combos.length} Combos nach der weiten Definition über ${nachKarte.size} Karten, ` +
      `davon ${sofort} spielbeendend nach der engen (Urteil F).`,
  );
  return { combos, nachKarte };
}

/**
 * Die Decks, über die simuliert wird.
 *
 * GLEICHMÄSSIG ÜBER DIE STUFEN, nicht die ersten N Zeilen. Der erste Lauf hat gezeigt, warum das
 * kein Detail ist: Ohne Sortierung gibt Postgres die Zeilen in beliebiger Reihenfolge zurück, und
 * die ersten 1.000 bestanden aus 802 Decks der Stufe 1, 5 der Stufe 5 und KEINEM einzigen der
 * Stufe 4. Ein Vergleich der Stufen war damit unmöglich - und das Ergebnis sah trotzdem
 * vollständig aus, was der gefährlichere Teil daran ist.
 *
 * "anzahl" ist die GESAMTZAHL und wird bei "alle" gleichmäßig auf die fünf Stufen aufgeteilt: Wer
 * 1000 einträgt, bekommt 200 Decks je Stufe. Gleich große Gruppen sind dabei nicht Bequemlichkeit,
 * sondern Voraussetzung - ein Mittelwert über 800 Decks der einen und 5 der anderen Stufe
 * vergleicht nichts, er stellt nur zwei ungleich verlässliche Zahlen nebeneinander.
 *
 * Liefert eine Stufe weniger als ihren Anteil (weil so viele gar nicht importiert sind), bleibt es
 * dabei - der Rest wird NICHT auf die anderen verteilt. Sonst wäre die Gruppe, die ohnehin schon
 * die größte ist, am Ende auch noch übergewichtet.
 */
async function ladeDeckAuswahl(bracket, anzahl) {
  const zeilen = [];
  for (let von = 0; von < anzahl; von += SEITE) {
    const bis = Math.min(von + SEITE, anzahl) - 1;
    const { data, error } = await supabase
      .from('archidekt_deck_pool')
      .select('id, name, creator_bracket')
      .eq('creator_bracket', bracket)
      // Decks mit Karten, die im Commander nicht spielbar sind, gehoeren nicht in die Eichung
      // (siehe sql/deck-pool-legality-2026-09-16.sql). Ausgeschlossen wird nur, was GEPRUEFT und
      // durchgefallen ist - ein noch ungepruefetes Deck (legal = null) bleibt drin. Es
      // stillschweigend zu uebergehen waere der unauffaelligere und damit schlimmere Fehler.
      .not('legal', 'is', false)
      // Feste Reihenfolge, damit zwei Läufe dieselben Decks erwischen - sonst ist ein Ergebnis
      // nicht wiederholbar und eine Abweichung nicht einzuordnen.
      .order('id')
      .range(von, bis);
    if (error) throw new Error(`Laden aus archidekt_deck_pool fehlgeschlagen: ${error.message}`);
    zeilen.push(...data);
    if (data.length < bis - von + 1) break;
  }
  return zeilen;
}

async function ladeDecks() {
  console.log('Decks laden ...');
  const stufen = bracketFilter === 'alle' ? [1, 2, 3, 4, 5] : [Number(bracketFilter)];
  const proStufe = Math.ceil(maxDecks / stufen.length);
  const decks = [];
  for (const stufe of stufen) {
    const teil = await ladeDeckAuswahl(stufe, proStufe);
    console.log(`  Bracket ${stufe}: ${teil.length} Decks`);
    decks.push(...teil);
  }

  const namen = await ladeAlle('archidekt_pool_card_names', 'id, name_normalized');
  const nameNachId = new Map(namen.map((n) => [n.id, n.name_normalized]));

  // Nur die Kartenlisten der gewählten Decks holen. Alle zu laden kostete im ersten Lauf 50
  // Sekunden für 42.000 Zeilen - bei einem Trockenlauf über 300 Decks ist das die längste
  // Wartezeit des ganzen Ablaufs, für nichts.
  const listeNachDeck = new Map();
  const ids = decks.map((d) => d.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from('archidekt_deck_pool_cardlists')
      .select('deck_id, card_ids, quantities, commander_ids')
      .in('deck_id', ids.slice(i, i + 200));
    if (error) throw new Error(`Laden der Kartenlisten fehlgeschlagen: ${error.message}`);
    for (const l of data) listeNachDeck.set(l.deck_id, l);
  }

  console.log(`  ${decks.length} Decks insgesamt, ${listeNachDeck.size} Kartenlisten.`);
  return { decks, nameNachId, listeNachDeck };
}

// ---------------------------------------------------------------------------------------------
// Ein Deck auswerten
// ---------------------------------------------------------------------------------------------

/**
 * Baut die Steckbriefe EINMAL für alle Karten, nicht je Deck neu.
 *
 * Ein Steckbrief ist unveränderlich, der Simulator fasst ihn nie an - dieselbe Instanz kann also
 * in allen 40.000 Decks und in jedem Exemplar stecken. Je Deck neu zu bauen hiesse, die
 * Oracle-Texte vierzigtausendfach durch dieselben Ausdrücke zu schicken.
 */
function baueSteckbriefe(sim, kartendaten) {
  const steckbriefe = new Map();
  for (const k of kartendaten.karten) {
    steckbriefe.set(
      k.front_name_normalized,
      sim.buildSimCard({
        name: k.name,
        key: k.front_name_normalized,
        typeLine: k.type_line,
        oracleText: k.oracle_text,
        backTypeLine: k.back_type_line,
        backOracleText: k.back_oracle_text,
        manaCost: k.mana_cost,
        cmc: k.cmc,
        producedMana: k.produced_mana,
        power: k.power,
        keywords: k.keywords ?? [],
        gameChanger: k.game_changer ?? false,
        tutor: kartendaten.tutoren.has(k.front_name_normalized),
      }),
    );
  }
  return steckbriefe;
}

/**
 * Welche gewinnenden Combos liegen in diesem Deck vollständig?
 *
 * Liefert ZWEI Dinge, und der Unterschied ist wichtig:
 *
 *   ziele       Die Combos, die der Simulator aktiv verfolgt (tutort, Mana zurückhält). Gedeckelt,
 *               weil comboSteht() in jedem Zug über diese Liste läuft - mehr als eine Handvoll
 *               kostet Laufzeit und bringt nichts.
 *   comboTeile  ALLE Karten ALLER gewinnenden Combos des Decks. Daran hängt die Schutzregel: Ein
 *               Combo-Teil, das nach dem Wirken im Friedhof liegt, darf nie gewirkt werden. Hing
 *               das Teil vorher an Combo Nummer elf, war es nicht geschützt und wurde verheizt.
 */
function findeZiele(kartenKeys, commanderKeys, gewinnCombos) {
  const treffer = new Map();
  for (const key of kartenKeys) {
    for (const index of gewinnCombos.nachKarte.get(key) ?? []) {
      treffer.set(index, (treffer.get(index) ?? 0) + 1);
    }
  }

  const ziele = [];
  let sofortCombos = 0;
  for (const [index, anzahl] of treffer) {
    const combo = gewinnCombos.combos[index];
    if (anzahl !== combo.card_names.length) continue;
    // Verlangt die Combo eine Karte in der Kommandozone, muss sie dort auch stehen.
    if ((combo.commander_required ?? []).some((n) => !commanderKeys.has(n))) continue;
    if (combo.beendet_sofort) sofortCombos++;
    ziele.push({ keys: combo.card_names, zusatzMana: combo.mana_value_needed ?? 0 });
  }
  const comboTeile = new Set(ziele.flatMap((z) => z.keys));

  // Die billigsten zuerst - danach sucht der Simulator, und mehr als eine Handvoll Ziele
  // gleichzeitig zu verfolgen bringt nichts.
  ziele.sort((a, b) => a.keys.length - b.keys.length || a.zusatzMana - b.zusatzMana);
  return {
    ziele: ziele.slice(0, VERFOLGTE_ZIELE),
    comboTeile,
    // BEIDE Zaehlungen wandern ungedeckelt in die Ergebniszeile: die enge fuer Urteil F, die weite
    // fuer die Simulation. Erst die Trennschaerfe-Ansicht sagt, welche die Stufen besser trennt -
    // deshalb wird keine durch die andere ersetzt.
    sofortCombos,
    siegCombos: ziele.length,
  };
}

/** So viele Combos verfolgt der Simulator gleichzeitig - siehe findeZiele(). */
const VERFOLGTE_ZIELE = 10;

function werteDeckAus(sim, deck, liste, umgebung) {
  const { nameNachId, steckbriefe, kartendaten, gewinnCombos } = umgebung;

  const commanderKeys = new Set((liste.commander_ids ?? []).map((id) => nameNachId.get(id)));
  const karten = [];
  const commander = [];
  const keys = new Set();
  let farben = 0;
  let laender = 0;
  let cmcSumme = 0;
  let zauber = 0;
  const zaehler = { ramp: 0, draw: 0, interaktion: 0, tutoren: 0, gameChanger: 0 };

  for (let i = 0; i < liste.card_ids.length; i++) {
    const key = nameNachId.get(liste.card_ids[i]);
    const steckbrief = key ? steckbriefe.get(key) : null;
    // Karte nicht in scryfall_cards (z.B. ein Kartenname, den der Abgleich noch nicht kennt):
    // überspringen statt zu raten. Die Erkennungsquote unten macht das sichtbar.
    if (!steckbrief) continue;
    keys.add(key);

    const menge = liste.quantities[i] ?? 1;
    const istCommander = commanderKeys.has(key);
    for (let n = 0; n < menge; n++) {
      if (istCommander) commander.push(steckbrief);
      else karten.push(steckbrief);
    }

    const kategorien = kartendaten.kategorien.get(key);
    if (kategorien) {
      if (INTERAKTION.some((k) => kategorien.has(k))) zaehler.interaktion += menge;
      if (kategorien.has('ramp')) zaehler.ramp += menge;
      if (kategorien.has('draw')) zaehler.draw += menge;
    }
    if (kartendaten.tutoren.has(key)) zaehler.tutoren += menge;
    if (steckbrief.gameChanger) zaehler.gameChanger += menge;
    if (steckbrief.istLand) laender += menge;
    else {
      cmcSumme += steckbrief.cmc * menge;
      zauber += menge;
    }
  }

  if (karten.length < 50) return null; // unvollständige Liste - lieber keine Zahl als eine falsche

  for (const key of commanderKeys) {
    farben |= sim.farbmaske(kartendaten.farbenNachKarte.get(key) ?? []);
  }
  const { ziele, comboTeile, sofortCombos, siegCombos } = findeZiele(
    keys,
    commanderKeys,
    gewinnCombos,
  );

  const simDeck = {
    karten,
    commander,
    // Fällt die Farbidentität aus (kein Commander erkannt), zählt jede Farbe als verfügbar -
    // ein Deck an einer fehlenden Farbe scheitern zu lassen wäre der größere Fehler.
    farben: farben || sim.ALLE_FARBEN,
    ziele,
    comboTeile,
  };

  const ergebnis = sim.simuliereDeck(simDeck, spiele, 1);
  return {
    deck_id: deck.id,
    sim_version: SIM_VERSION,
    spiele,
    median_siegzug: ergebnis.median,
    schnellste10: ergebnis.schnellste10,
    kumulativ_median: ergebnis.kumulativMedian,
    siegquote: Number(ergebnis.siegquote.toFixed(3)),
    combo_anteil: Number(ergebnis.comboAnteil.toFixed(3)),
    mana_zug3: Number(ergebnis.manaZug3.toFixed(2)),
    mana_zug5: Number(ergebnis.manaZug5.toFixed(2)),
    mana_zug7: Number(ergebnis.manaZug7.toFixed(2)),
    // Fassung 6: die unzensierte Uhr und die Streuung - siehe SimSpiel.schadenBisZug10 und
    // SimErgebnis.streuung in src/app/goldfish-sim.ts.
    schaden_zug10: ergebnis.schadenZug10,
    streuung: ergebnis.streuung,
    p25_siegzug: ergebnis.p25,
    p75_siegzug: ergebnis.p75,
    mulligans: Number(ergebnis.mulliganSchnitt.toFixed(2)),
    leerlauf: Number(ergebnis.leerlaufSchnitt.toFixed(2)),
    abbruch_anteil: Number(ergebnis.abbruchAnteil.toFixed(3)),
    // Eng: beendet das Spiel unmittelbar - dieselbe Zaehlung, an der Urteil F geeicht ist.
    gewinn_combos: sofortCombos,
    // Weit: Endpunkt eines Decks. Neu in Fassung 8.
    sieg_combos: siegCombos,
    karten_erkannt: Number(sim.erkennungsquote([...karten, ...commander]).toFixed(3)),
    rampe: zaehler.ramp,
    kartenziehen: zaehler.draw,
    interaktion: zaehler.interaktion,
    tutoren: zaehler.tutoren,
    game_changer: zaehler.gameChanger,
    laender,
    avg_cmc: zauber > 0 ? Number((cmcSumme / zauber).toFixed(2)) : 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------------------------

async function schreibe(zeilen) {
  const PAKET = 500;
  for (let i = 0; i < zeilen.length; i += PAKET) {
    const { error } = await supabase
      .from('deck_sim_results')
      .upsert(zeilen.slice(i, i + PAKET), { onConflict: 'deck_id,sim_version' });
    if (error) throw new Error(`Upsert in deck_sim_results fehlgeschlagen: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------------------------

async function main() {
  console.log(
    `Goldfish-Stapellauf, Fassung ${SIM_VERSION}: Bracket ${bracketFilter}, bis zu ${maxDecks} Decks${
      bracketFilter === 'alle' ? ' (gleichmäßig auf die fünf Stufen verteilt)' : ''
    }, ${spiele} Spiele je Deck.`,
  );

  const buendel = ladeSimulator();
  const sim = require(buendel);

  await pruefeSiegDefinition(sim);

  const [kartendaten, gewinnCombos, deckdaten] = [
    await ladeKartendaten(),
    await ladeGewinnCombos(),
    await ladeDecks(),
  ];

  console.log('Steckbriefe bauen ...');
  const steckbriefe = baueSteckbriefe(sim, kartendaten);
  const umgebung = {
    nameNachId: deckdaten.nameNachId,
    steckbriefe,
    kartendaten,
    gewinnCombos,
  };

  console.log('Simulieren ...');
  const begonnen = Date.now();
  const zeilen = [];
  let uebersprungen = 0;

  for (const deck of deckdaten.decks) {
    const liste = deckdaten.listeNachDeck.get(deck.id);
    if (!liste) {
      uebersprungen++;
      continue;
    }
    const zeile = werteDeckAus(sim, deck, liste, umgebung);
    if (!zeile) {
      uebersprungen++;
      continue;
    }
    zeilen.push(zeile);
    if (zeilen.length % 250 === 0) {
      const proDeck = (Date.now() - begonnen) / zeilen.length;
      console.log(
        `  ${zeilen.length}/${deckdaten.decks.length} Decks, ${proDeck.toFixed(0)} ms je Deck.`,
      );
    }
  }

  const dauer = ((Date.now() - begonnen) / 1000).toFixed(0);
  console.log(`Fertig: ${zeilen.length} Decks in ${dauer} s, ${uebersprungen} übersprungen.`);
  zeigeUebersicht(zeilen, deckdaten.decks);

  if (dryRun) {
    console.log('Trockenlauf - nichts geschrieben.');
    return;
  }
  await schreibe(zeilen);
  console.log(`${zeilen.length} Zeilen in deck_sim_results geschrieben.`);
  fs.unlinkSync(buendel);
}

/** Eine erste Gegenüberstellung schon im Lauf-Protokoll - dieselbe Frage wie deck_sim_by_bracket. */
function zeigeUebersicht(zeilen, decks) {
  const bracketNachId = new Map(decks.map((d) => [d.id, d.creator_bracket]));
  const nachBracket = new Map();
  for (const z of zeilen) {
    const b = bracketNachId.get(z.deck_id);
    if (!nachBracket.has(b)) nachBracket.set(b, []);
    nachBracket.get(b).push(z);
  }

  const mittel = (liste, feld) => liste.reduce((s, z) => s + z[feld], 0) / liste.length;
  console.log(
    '\nBracket | Decks | Siegzug | Schaden10 | Streuung | Leerlauf | Siegquote | Combos eng/weit | Interakt. | Tutoren | Ø CMC | erkannt',
  );
  for (const b of [...nachBracket.keys()].sort()) {
    const l = nachBracket.get(b);
    console.log(
      `      ${b} | ${String(l.length).padStart(5)} | ${mittel(l, 'median_siegzug').toFixed(1).padStart(7)} | ` +
        `${mittel(l, 'schaden_zug10').toFixed(1).padStart(9)} | ` +
        `${mittel(l, 'streuung').toFixed(1).padStart(8)} | ${mittel(l, 'leerlauf').toFixed(1).padStart(8)} | ` +
        `${(mittel(l, 'siegquote') * 100).toFixed(0).padStart(8)}% | ` +
        `${mittel(l, 'gewinn_combos').toFixed(1).padStart(6)}/${mittel(l, 'sieg_combos').toFixed(1).padStart(5)} | ` +
        `${mittel(l, 'interaktion').toFixed(1).padStart(9)} | ` +
        `${mittel(l, 'tutoren').toFixed(1).padStart(7)} | ${mittel(l, 'avg_cmc').toFixed(2).padStart(5)} | ` +
        `${(mittel(l, 'karten_erkannt') * 100).toFixed(0).padStart(6)}%`,
    );
  }

  // Wie viele Zeilen die Auswertung überhaupt benutzen darf - die Zahl gehört ins Protokoll, weil
  // eine niedrige Erkennungsquote sonst als Deck-Eigenschaft durchgeht.
  const brauchbar = zeilen.filter((z) => z.karten_erkannt >= MIN_ERKANNT).length;
  console.log(
    `\n${brauchbar} von ${zeilen.length} Zeilen erreichen die Erkennungsquote ${MIN_ERKANNT} ` +
      'und gehen in die Auswertung ein (deck_sim_by_bracket filtert darauf).',
  );
  console.log('');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
