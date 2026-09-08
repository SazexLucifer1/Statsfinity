// Einmaliger Aufbau eines EIGENEN Bestands an legalen Commander-Decks ("Deck-Korpus") - die
// Grundlage dafür, die Kartenvorschläge im Bearbeiten-Modus irgendwann selbst zu rechnen, statt
// sie bei EDHREC abzuholen.
// Tabellen, Bucket und ausführliche Begründung: sql/deck-corpus-2026-09-08.sql
// Auswertung des Korpus: scripts/aggregate-deck-corpus.js
// Ausgelöst von .github/workflows/deck-corpus-import.yml (nur von Hand, kein Zeitplan).
//
// Drei Quellen, ein Weg:
//
//   --source=precon       ~2.000 Precon-Decklisten von MTGJSON (dieselben URLs, die
//                         src/app/precon.service.ts schon nutzt, nur serverseitig).
//   --source=statsfinity  Die eigenen öffentlichen Decks aus decks/deck_cards.
//   --source=archidekt    Öffentliche Commander-Decks über Archidekts Lese-API. STEHT STILL,
//                         bis von dort eine Erlaubnis vorliegt - siehe ARCHIDEKT-ANFRAGE.md und
//                         das Flag --erlaubnis-liegt-vor weiter unten.
//
// Geschrieben wird NICHT in die Datenbank, sondern als gepackte JSONL-Dateien in den privaten
// Storage-Bucket "deck-corpus" (eine Zeile je Deck). In die Datenbank wandert nur der Fortschritt.
//
// Braucht den Supabase SERVICE-ROLE-Key (nicht den öffentlichen Anon-Key aus supabase.client.ts):
//
//   SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/import-deck-corpus.js --source=precon
//
// Idempotent und fortsetzbar: Jede Quelle merkt sich in deck_corpus_state, wie weit sie gekommen
// ist, und deck_corpus_seen verhindert, dass schon geholte Decks ein zweites Mal abgefragt werden.
// Ein abgebrochener Lauf kostet höchstens den noch nicht geschriebenen Puffer.
//
// Ohne Netz und ohne Schlüssel prüfbar: `node scripts/import-deck-corpus.js --selftest` lässt den
// Torwächter (die Legalitätsprüfung) gegen eingebaute Beispieldecks laufen.

const { gzipSync } = require('node:zlib');

// =====================================================================================
// Aufrufparameter
// =====================================================================================
const argumente = process.argv.slice(2);
const flagGesetzt = (name) => argumente.includes(`--${name}`);
const parameter = (name, vorgabe) => {
  const treffer = argumente.find((a) => a.startsWith(`--${name}=`));
  return treffer ? treffer.slice(name.length + 3) : vorgabe;
};

const QUELLE = parameter('source', '');
const ZIEL_DECKS = Number(parameter('target', '50000'));
const MAX_MINUTEN = Number(parameter('max-minutes', '300'));
const PRUEF_LIMIT = Number(parameter('limit', '0')); // 0 = kein Limit
const TROCKENLAUF = flagGesetzt('dry-run');
const ERLAUBNIS_LIEGT_VOR = flagGesetzt('erlaubnis-liegt-vor');
const SELBSTTEST = flagGesetzt('selftest');

/**
 * Archidekts Format-Kennzahl für Commander/EDH. Als Parameter und nicht als Konstante, weil die
 * Zuordnung nirgends dokumentiert ist (Archidekt veröffentlicht bewusst keine API-Doku, siehe
 * Kommentar an ladeArchidektSeite) - stimmt die 3 nicht, ist das eine Zahl im Aufruf statt einer
 * Codeänderung.
 */
const ARCHIDEKT_FORMAT = parameter('archidekt-format', '3');

const SCHEMA_VERSION = 1;

/**
 * Decks je Bucket-Datei. 5.000 Zeilen sind gepackt rund 2 MB - groß genug, dass 300.000 Decks
 * nicht in 300 Dateien zerfallen, klein genug, dass ein Abbruch nie mehr als ein paar Minuten
 * Arbeit kostet.
 */
const CHUNK_GROESSE = 5000;

/**
 * Spätestens nach dieser Zeit wird auch ein halb voller Puffer weggeschrieben.
 *
 * Ohne das wäre ein Lauf, der die 5.000 Decks nicht vollmacht, bis zum Schluss ungesichert - und
 * GitHub bricht einen Job bei 6 Stunden hart ab. Der Cursor stünde dann noch auf dem Stand von
 * vor fünf Stunden, und der nächste Lauf holte alles noch einmal.
 */
const SICHERUNG_ALLE_MS = 30 * 60 * 1000;

// =====================================================================================
// Der Torwächter - hier steht die Legalitätsprüfung, alles andere ist Transport
// =====================================================================================

/**
 * Muss exakt normalizeCardName() aus src/app/array-utils.ts entsprechen - dieser Wert ist der
 * Schlüssel, unter dem sich Karten wiederfinden, und zugleich derselbe Schlüssel wie
 * scryfall_cards.front_name_normalized. Weicht er auch nur um ein Zeichen ab, findet der
 * Torwächter keine einzige Karte und verwirft jedes Deck. Dieses Skript läuft ohne
 * Angular/TypeScript und kann die Funktion deshalb nicht importieren (gleiche Situation wie in
 * scripts/sync-scryfall-bulk.js und scripts/sync-spellbook-bracket.js).
 */
function normalizeCardName(name) {
  return name.toLowerCase().replace(/[’‘´`]/g, "'");
}

/** Wie überall in der App wird auf dem Namen VOR " // " nachgeschlagen. */
function frontName(name) {
  return name.split(' // ')[0].trim();
}

const normalisierterName = (name) => normalizeCardName(frontName(name));

/**
 * Karten, von denen ein Deck beliebig viele Kopien enthalten darf, sagen das selbst in ihrem
 * Regeltext ("A deck can have any number of cards named Relentless Rats", "A deck can have up to
 * nine cards named Nazgûl"). Deshalb wird das aus scryfall_cards.oracle_text gelesen und NICHT als
 * Namensliste gepflegt - eine Liste wäre mit dem übernächsten Set wieder unvollständig, und die
 * Folge wäre, dass legale Decks stillschweigend aus dem Korpus fielen.
 */
const BELIEBIG_OFT = /a deck can have (any number of|up to [a-z-]+) cards named/i;

/** Verwerfungsgründe. Die Schlüssel landen so in deck_corpus_state.rejects. */
const GRUND = {
  falschesFormat: 'falschesFormat',
  commanderZahl: 'commanderZahl',
  nicht100Karten: 'nicht100Karten',
  nichtSingleton: 'nichtSingleton',
  farbidentitaet: 'farbidentitaet',
  unbekannteKarte: 'unbekannteKarte',
};

/**
 * Entscheidet, ob ein Rohdeck in den Korpus darf, und formt es dabei in die Bucket-Zeile um.
 *
 * Erwartet `{ sourceDeckId, sourceUpdatedAt, format, commanders: [name], cards: [{name, quantity}] }`,
 * wobei `cards` das vollständige Hauptdeck EINSCHLIESSLICH der Commander enthält - Maybeboard,
 * Sideboard und Marken hat die jeweilige Quelle vorher schon aussortiert.
 *
 * Geprüft wird genau das, was ein Deck zu einem legalen Commander-Deck macht. Ein zu großzügiger
 * Torwächter wäre hier der teuerste Fehler des ganzen Vorhabens: Halbfertige, kaputte oder gar
 * nicht für Commander gedachte Listen verschieben die Prozentzahlen dauerhaft, und auffallen würde
 * es erst an unsinnigen Vorschlägen in der App - lange nachdem das erneute Crawlen zu teuer
 * geworden ist.
 */
function pruefeDeck(roh, wissen) {
  const format = (roh.format ?? '').toString().toLowerCase();
  if (format !== 'commander' && format !== 'edh') {
    return { ok: false, grund: GRUND.falschesFormat };
  }

  const commander = (roh.commanders ?? []).map(normalisierterName).filter(Boolean);
  if (commander.length < 1 || commander.length > 2) {
    return { ok: false, grund: GRUND.commanderZahl };
  }

  // Mehrfach genannte Zeilen zusammenfassen - manche Quellen listen dieselbe Karte in zwei
  // Kategorien und damit zweimal, was sonst fälschlich als Singleton-Verstoß gälte.
  const anzahlJeKarte = new Map();
  for (const eintrag of roh.cards ?? []) {
    const name = normalisierterName(eintrag.name ?? '');
    if (!name) continue;
    const menge = Number(eintrag.quantity ?? 1);
    if (!Number.isFinite(menge) || menge < 1) continue;
    anzahlJeKarte.set(name, (anzahlJeKarte.get(name) ?? 0) + menge);
  }

  let gesamt = 0;
  for (const menge of anzahlJeKarte.values()) gesamt += menge;
  if (gesamt !== 100) return { ok: false, grund: GRUND.nicht100Karten };

  for (const name of commander) {
    if (!anzahlJeKarte.has(name)) return { ok: false, grund: GRUND.commanderZahl };
  }

  // Farbidentität der Commander - die Obergrenze für jede andere Karte im Deck.
  const farbenDesDecks = new Set();
  for (const name of commander) {
    const karte = wissen.get(name);
    if (!karte) return { ok: false, grund: GRUND.unbekannteKarte };
    for (const farbe of karte.farben) farbenDesDecks.add(farbe);
  }

  const mehrfach = {};
  for (const [name, menge] of anzahlJeKarte) {
    const karte = wissen.get(name);
    if (!karte) return { ok: false, grund: GRUND.unbekannteKarte };

    if (menge > 1) {
      if (!karte.basisland && !karte.beliebigOft) {
        return { ok: false, grund: GRUND.nichtSingleton };
      }
      mehrfach[name] = menge;
    }

    for (const farbe of karte.farben) {
      if (!farbenDesDecks.has(farbe)) return { ok: false, grund: GRUND.farbidentitaet };
    }
  }

  return {
    ok: true,
    zeile: {
      v: SCHEMA_VERSION,
      source: roh.source,
      sourceDeckId: String(roh.sourceDeckId),
      sourceUpdatedAt: roh.sourceUpdatedAt ?? null,
      commanders: commander.sort(),
      colorIdentity: [...farbenDesDecks].sort(),
      // Nur die verschiedenen Namen, nicht 100 Einzelzeilen: Die Empfehlung fragt "spielt dieses
      // Deck Karte X?", nicht "wie oft". Die wenigen Karten mit mehr als einer Kopie stehen in
      // "multi", damit sich das Deck trotzdem lückenlos rekonstruieren lässt - erneutes Crawlen
      // ist der eine Vorgang, der hier wirklich teuer ist.
      cards: [...anzahlJeKarte.keys()].sort(),
      multi: Object.keys(mehrfach).length > 0 ? mehrfach : undefined,
    },
  };
}

// =====================================================================================
// Selbsttest - läuft ohne Netz und ohne Schlüssel
// =====================================================================================
function selbsttest() {
  const wissen = new Map([
    [
      "atraxa, praetors' voice",
      { farben: new Set(['W', 'U', 'B', 'G']), basisland: false, beliebigOft: false },
    ],
    ['sol ring', { farben: new Set(), basisland: false, beliebigOft: false }],
    ['forest', { farben: new Set(), basisland: true, beliebigOft: false }],
    ['relentless rats', { farben: new Set(['B']), basisland: false, beliebigOft: true }],
    ['lightning bolt', { farben: new Set(['R']), basisland: false, beliebigOft: false }],
    [
      'thrasios, triton hero',
      { farben: new Set(['G', 'U']), basisland: false, beliebigOft: false },
    ],
    ['tymna the weaver', { farben: new Set(['W', 'B']), basisland: false, beliebigOft: false }],
  ]);

  const deck = (aenderungen) => ({
    source: 'test',
    sourceDeckId: '1',
    format: 'Commander',
    commanders: ["Atraxa, Praetors' Voice"],
    cards: [
      { name: "Atraxa, Praetors' Voice", quantity: 1 },
      { name: 'Sol Ring', quantity: 1 },
      { name: 'Forest', quantity: 98 },
    ],
    ...aenderungen,
  });

  const faelle = [
    ['legales Deck mit 100 Karten', deck({}), true, null],
    [
      '99 Karten',
      deck({
        cards: [
          { name: 'Sol Ring', quantity: 1 },
          { name: "Atraxa, Praetors' Voice", quantity: 1 },
          { name: 'Forest', quantity: 97 },
        ],
      }),
      false,
      GRUND.nicht100Karten,
    ],
    [
      '101 Karten',
      deck({
        cards: [
          { name: 'Sol Ring', quantity: 1 },
          { name: "Atraxa, Praetors' Voice", quantity: 1 },
          { name: 'Forest', quantity: 99 },
        ],
      }),
      false,
      GRUND.nicht100Karten,
    ],
    ['kein Commander-Format', deck({ format: 'Modern' }), false, GRUND.falschesFormat],
    [
      'drei Commander',
      deck({
        commanders: ["Atraxa, Praetors' Voice", 'Thrasios, Triton Hero', 'Tymna the Weaver'],
      }),
      false,
      GRUND.commanderZahl,
    ],
    [
      'Karte außerhalb der Farbidentität',
      deck({
        cards: [
          { name: "Atraxa, Praetors' Voice", quantity: 1 },
          { name: 'Lightning Bolt', quantity: 1 },
          { name: 'Forest', quantity: 98 },
        ],
      }),
      false,
      GRUND.farbidentitaet,
    ],
    [
      'unerlaubte Zweitkopie',
      deck({
        cards: [
          { name: "Atraxa, Praetors' Voice", quantity: 1 },
          { name: 'Sol Ring', quantity: 2 },
          { name: 'Forest', quantity: 97 },
        ],
      }),
      false,
      GRUND.nichtSingleton,
    ],
    [
      'unbekannter Kartenname',
      deck({
        cards: [
          { name: "Atraxa, Praetors' Voice", quantity: 1 },
          { name: 'Gibtesnicht', quantity: 1 },
          { name: 'Forest', quantity: 98 },
        ],
      }),
      false,
      GRUND.unbekannteKarte,
    ],
    [
      'Commander nicht im Deck',
      deck({ commanders: ['Thrasios, Triton Hero'] }),
      false,
      GRUND.commanderZahl,
    ],
    [
      'Partner-Paar, Reihenfolge egal',
      deck({
        commanders: ['Tymna the Weaver', 'Thrasios, Triton Hero'],
        cards: [
          { name: 'Thrasios, Triton Hero', quantity: 1 },
          { name: 'Tymna the Weaver', quantity: 1 },
          { name: 'Sol Ring', quantity: 1 },
          { name: 'Forest', quantity: 97 },
        ],
      }),
      true,
      null,
    ],
    [
      'erlaubte Vielfachkopien (Relentless Rats)',
      {
        source: 'test',
        sourceDeckId: '2',
        format: 'Commander',
        commanders: ['Tymna the Weaver'],
        cards: [
          { name: 'Tymna the Weaver', quantity: 1 },
          { name: 'Relentless Rats', quantity: 60 },
          { name: 'Forest', quantity: 39 },
        ],
      },
      true,
      null,
    ],
  ];

  let fehler = 0;
  for (const [titel, roh, erwartetOk, erwarteterGrund] of faelle) {
    const ergebnis = pruefeDeck(roh, wissen);
    const passt = ergebnis.ok === erwartetOk && (erwartetOk || ergebnis.grund === erwarteterGrund);
    console.log(
      `  ${passt ? 'ok  ' : 'FEHL'} ${titel}${passt ? '' : ` -> ${JSON.stringify(ergebnis)}`}`,
    );
    if (!passt) fehler++;
  }

  // Die Partner-Zeile muss reihenfolgeunabhängig denselben Schlüssel ergeben - daran hängt später
  // die ganze Zusammenfassung je Commander.
  const paarA = pruefeDeck(faelle[9][1], wissen).zeile.commanders.join('|');
  const paarB = pruefeDeck(
    { ...faelle[9][1], commanders: ['Thrasios, Triton Hero', 'Tymna the Weaver'] },
    wissen,
  ).zeile.commanders.join('|');
  const paarPasst = paarA === paarB;
  console.log(`  ${paarPasst ? 'ok  ' : 'FEHL'} Commander-Schlüssel ist reihenfolgeunabhängig`);
  if (!paarPasst) fehler++;

  console.log(fehler === 0 ? '\nSelbsttest bestanden.' : `\n${fehler} Fall/Fälle fehlgeschlagen.`);
  return fehler === 0;
}

if (SELBSTTEST) {
  console.log('Selbsttest des Torwächters (ohne Netz, ohne Datenbank):');
  process.exit(selbsttest() ? 0 : 1);
}

// =====================================================================================
// Ab hier braucht es die Datenbank
// =====================================================================================
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://jkkelwpnrgzbvopszwrl.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const QUELLEN = ['archidekt', 'statsfinity', 'precon'];
if (!QUELLEN.includes(QUELLE)) {
  console.error(`Fehlt oder unbekannt: --source=${QUELLEN.join('|')}`);
  process.exit(1);
}

if (!SERVICE_ROLE_KEY) {
  console.error(
    'Fehlt: SUPABASE_SERVICE_ROLE_KEY als Umgebungsvariable setzen (siehe Kommentar oben).',
  );
  process.exit(1);
}

/**
 * Der Archidekt-Lauf ist für Archidekt unübersehbar: Der User-Agent unten nennt Statsfinity
 * namentlich, und 30 Anfragen pro Minute über Stunden von einer Actions-IP stehen in jedem
 * Zugriffsprotokoll. Das ist Absicht - anonym zu crawlen wäre schlechter, nicht besser. Aber
 * genau deshalb wird zuerst gefragt: eine Sperre nach 40.000 gezogenen Decks kostet mehr als eine
 * Mail vorher. Der Trockenlauf bleibt frei (20 Anfragen, um die Antwortform zu prüfen).
 */
if (QUELLE === 'archidekt' && !TROCKENLAUF && !ERLAUBNIS_LIEGT_VOR) {
  console.error(
    'Der Archidekt-Import steht still, bis von dort eine Erlaubnis vorliegt.\n' +
      'Anfragetext und Hintergrund: ARCHIDEKT-ANFRAGE.md im Projektwurzelverzeichnis.\n' +
      'Liegt die Antwort vor, diesen Lauf mit --erlaubnis-liegt-vor starten\n' +
      '(im Workflow: das Feld "permission_granted" auf true setzen).\n' +
      'Zum Prüfen der Antwortform genügt --dry-run --limit=20, das geht auch ohne.',
  );
  process.exit(1);
}

// Erst hier geladen und nicht am Dateikopf, damit --selftest ganz ohne installierte
// Abhängigkeiten läuft - der Torwächter ist reine Rechnerei und braucht keine Datenbank.
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

/**
 * Aussagekräftiger User-Agent, damit dieser Lauf für die angefragte Seite als Statsfinity
 * erkennbar und zuordenbar ist - gleiche Höflichkeit wie im Scryfall- und im
 * Spellbook-Abgleich. Aus dem Browser heraus ginge das gar nicht (User-Agent ist dort ein
 * verbotener Header), hier serverseitig greift es.
 */
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Statsfinity/1.0 (+https://github.com/SazexLucifer1/Statsfinity)',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VERSUCHE = 6;

/**
 * Wiederholt bei Netz-/Rate-Limit-Fehlern mit wachsender Pause - übernommen aus
 * scripts/sync-spellbook-bracket.js, samt der dort teuer gelernten Lehre: der GRUND muss im
 * Fehlertext landen, sonst lässt sich ein Fehlschlag aus dem Lauf-Protokoll heraus nicht
 * einordnen. Ein 429 wird deutlich geduldiger behandelt als ein Serverfehler, weil ein
 * Kontingent-pro-Minute sich nicht "wegprobieren" lässt.
 */
const PAUSE_NACH_LIMIT = 60000;

async function holeJson(url) {
  let letzterGrund = 'unbekannt';

  for (let versuch = 0; versuch < VERSUCHE; versuch++) {
    let wartezeit = 3000 * 2 ** versuch; // 3, 6, 12, 24, 48 s
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.json();
      // 404 kommt bei gelöschten/privat gestellten Decks vor - kein Fehler, nur nichts zu holen.
      if (res.status === 404) return null;
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status}`);
      letzterGrund = `HTTP ${res.status}`;
      if (res.status === 429) wartezeit = Math.max(wartezeit, PAUSE_NACH_LIMIT);
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        wartezeit = Math.max(wartezeit, retryAfter * 1000);
      }
    } catch (err) {
      letzterGrund = err.message;
      if (versuch === VERSUCHE - 1) break;
    }
    console.log(
      `    Versuch ${versuch + 1}/${VERSUCHE} fehlgeschlagen (${letzterGrund}), erneut in ${wartezeit / 1000}s ...`,
    );
    await sleep(wartezeit);
  }

  throw new Error(`${url} -> nach ${VERSUCHE} Versuchen aufgegeben, zuletzt: ${letzterGrund}`);
}

// =====================================================================================
// Kartenwissen für den Torwächter
// =====================================================================================

/**
 * Lädt aus scryfall_cards genau die drei Angaben, die die Legalitätsprüfung braucht. Rund 33.000
 * Zeilen, ein paar MB - einmal je Lauf, nicht je Deck.
 *
 * Läuft der Scryfall-Abgleich (scripts/sync-scryfall-bulk.js) noch nie durch, ist die Tabelle leer
 * und JEDES Deck fiele mit "unbekannteKarte" durch. Deshalb bricht der Lauf hier lieber laut ab,
 * als einen leeren Korpus zu erzeugen.
 */
async function ladeKartenwissen() {
  const wissen = new Map();
  const SEITE = 1000;

  for (let von = 0; ; von += SEITE) {
    const { data, error } = await supabase
      .from('scryfall_cards')
      .select('front_name_normalized, color_identity, type_line, oracle_text')
      .order('front_name_normalized', { ascending: true })
      .range(von, von + SEITE - 1);
    if (error) throw new Error(`scryfall_cards lesen fehlgeschlagen: ${error.message}`);

    for (const zeile of data) {
      const typ = zeile.type_line ?? '';
      wissen.set(zeile.front_name_normalized, {
        farben: new Set(zeile.color_identity ?? []),
        basisland: /basic/i.test(typ) && /land/i.test(typ),
        beliebigOft: BELIEBIG_OFT.test(zeile.oracle_text ?? ''),
      });
    }

    if (data.length < SEITE) break;
  }

  if (wissen.size < 10000) {
    throw new Error(
      `scryfall_cards enthält nur ${wissen.size} Karten - zu wenig für eine verlässliche ` +
        'Legalitätsprüfung. Erst den Scryfall-Abgleich laufen lassen (Workflow "Daily Scryfall sync").',
    );
  }

  console.log(`Kartenwissen geladen: ${wissen.size} Karten.`);
  return wissen;
}

// =====================================================================================
// Zustand und Bucket-Schreiber
// =====================================================================================
async function ladeZustand() {
  const { data, error } = await supabase
    .from('deck_corpus_state')
    .select('cursor, chunk_index, deck_count, checked_count')
    .eq('id', QUELLE)
    .maybeSingle();
  if (error) throw new Error(`deck_corpus_state lesen fehlgeschlagen: ${error.message}`);
  return {
    cursor: data?.cursor ?? null,
    chunkIndex: data?.chunk_index ?? 0,
    deckCount: data?.deck_count ?? 0,
    checkedCount: data?.checked_count ?? 0,
  };
}

async function ladeGesehene() {
  const gesehen = new Set();
  const SEITE = 1000;

  for (let von = 0; ; von += SEITE) {
    const { data, error } = await supabase
      .from('deck_corpus_seen')
      .select('source_deck_id')
      .eq('source', QUELLE)
      .order('source_deck_id', { ascending: true })
      .range(von, von + SEITE - 1);
    if (error) throw new Error(`deck_corpus_seen lesen fehlgeschlagen: ${error.message}`);
    for (const zeile of data) gesehen.add(zeile.source_deck_id);
    if (data.length < SEITE) break;
  }

  return gesehen;
}

/**
 * Sammelt geprüfte Decks und schreibt sie blockweise in den Bucket.
 *
 * Reihenfolge beim Schreiben ist bewusst: erst die Datei hochladen, dann in deck_corpus_files
 * verzeichnen, dann den Fortschritt fortschreiben. supabase-js kennt keine Transaktion über
 * mehrere Aufrufe - bricht der Lauf mittendrin ab, ist der schlimmste Fall damit eine Datei, die
 * niemand kennt (sie wird beim nächsten Lauf schlicht überschrieben), nie ein fortgeschriebener
 * Cursor ohne die zugehörigen Daten.
 */
class KorpusSchreiber {
  constructor(zustand) {
    this.zustand = zustand;
    this.puffer = [];
    this.gesehenPuffer = [];
    this.rejects = {};
    this.geschrieben = 0;
    this.geprueft = 0;
  }

  merkeVerwurf(grund) {
    this.rejects[grund] = (this.rejects[grund] ?? 0) + 1;
  }

  async nimmAuf(zeile, cursor) {
    this.puffer.push(zeile);
    if (this.puffer.length >= CHUNK_GROESSE) await this.schreibeBlock(cursor);
  }

  merkeGesehen(sourceDeckId) {
    this.gesehenPuffer.push({ source: QUELLE, source_deck_id: String(sourceDeckId) });
  }

  async schreibeBlock(cursor) {
    if (this.puffer.length === 0 && this.gesehenPuffer.length === 0) return;

    if (this.puffer.length > 0) {
      const pfad = `${QUELLE}/${String(this.zustand.chunkIndex).padStart(5, '0')}.jsonl.gz`;
      const inhalt = gzipSync(Buffer.from(this.puffer.map((z) => JSON.stringify(z)).join('\n')));

      if (TROCKENLAUF) {
        console.log(
          `  [Trockenlauf] würde ${this.puffer.length} Decks nach ${pfad} schreiben (${(inhalt.length / 1024).toFixed(0)} kB).`,
        );
      } else {
        const { error: uploadFehler } = await supabase.storage
          .from('deck-corpus')
          .upload(pfad, inhalt, { contentType: 'application/gzip', upsert: true });
        if (uploadFehler) throw new Error(`Upload ${pfad} fehlgeschlagen: ${uploadFehler.message}`);

        const { error: dateiFehler } = await supabase.from('deck_corpus_files').upsert(
          {
            path: pfad,
            source: QUELLE,
            deck_count: this.puffer.length,
            schema_version: SCHEMA_VERSION,
            written_at: new Date().toISOString(),
          },
          { onConflict: 'path' },
        );
        if (dateiFehler)
          throw new Error(`deck_corpus_files schreiben fehlgeschlagen: ${dateiFehler.message}`);

        console.log(
          `  ${pfad}: ${this.puffer.length} Decks (${(inhalt.length / 1024).toFixed(0)} kB).`,
        );
      }

      this.zustand.chunkIndex++;
      this.zustand.deckCount += this.puffer.length;
      this.puffer = [];
    }

    if (!TROCKENLAUF) {
      for (let i = 0; i < this.gesehenPuffer.length; i += 500) {
        const { error } = await supabase
          .from('deck_corpus_seen')
          .upsert(this.gesehenPuffer.slice(i, i + 500), {
            onConflict: 'source,source_deck_id',
            ignoreDuplicates: true,
          });
        if (error) throw new Error(`deck_corpus_seen schreiben fehlgeschlagen: ${error.message}`);
      }
    }
    this.gesehenPuffer = [];

    await this.schreibeZustand(cursor);
  }

  async schreibeZustand(cursor) {
    if (TROCKENLAUF) return;
    const { error } = await supabase.from('deck_corpus_state').upsert(
      {
        id: QUELLE,
        cursor: cursor ?? this.zustand.cursor,
        chunk_index: this.zustand.chunkIndex,
        deck_count: this.zustand.deckCount,
        checked_count: this.zustand.checkedCount + this.geprueft,
        rejects: this.rejects,
        synced_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    );
    if (error) throw new Error(`deck_corpus_state schreiben fehlgeschlagen: ${error.message}`);
    if (cursor != null) this.zustand.cursor = cursor;
  }
}

// =====================================================================================
// Quelle: MTGJSON-Precons
// =====================================================================================
const MTGJSON_DECKLISTE = 'https://mtgjson.com/api/v5/DeckList.json';
const mtgjsonDeckUrl = (dateiname) => `https://mtgjson.com/api/v5/decks/${dateiname}.json`;

/**
 * Dieselben URLs wie in src/app/precon.service.ts, nur serverseitig. Precons sind der ideale
 * Prüfstein für den Torwächter: Sie sind per Definition legale 100-Karten-Decks, es müssen also
 * praktisch alle durchkommen. Fällt hier ein nennenswerter Teil durch, liegt der Fehler im
 * Prüfer, nicht in den Daten.
 */
async function* preconRohdecks(gesehen) {
  const katalog = await holeJson(MTGJSON_DECKLISTE);
  const commanderDecks = (katalog?.data ?? []).filter((d) => d.type === 'Commander Deck');
  console.log(`MTGJSON-Katalog: ${commanderDecks.length} Commander-Precons.`);

  for (const eintrag of commanderDecks) {
    if (gesehen.has(eintrag.code)) continue;
    const antwort = await holeJson(mtgjsonDeckUrl(eintrag.fileName));
    const deck = antwort?.data;
    if (!deck) continue;

    yield {
      roh: {
        source: 'precon',
        sourceDeckId: eintrag.code,
        sourceUpdatedAt: eintrag.releaseDate ? `${eintrag.releaseDate}T00:00:00Z` : null,
        format: 'Commander',
        commanders: (deck.commander ?? []).map((k) => k.name),
        cards: [...(deck.commander ?? []), ...(deck.mainBoard ?? [])].map((k) => ({
          name: k.name,
          quantity: k.count ?? 1,
        })),
      },
      cursor: eintrag.code,
    };

    // MTGJSON liefert statische Dateien von einem CDN, verlangt aber trotzdem keine Sturmflut.
    await sleep(250);
  }
}

// =====================================================================================
// Quelle: die eigenen öffentlichen Decks
// =====================================================================================

/**
 * Liest decks/deck_cards direkt. Übernommen werden nur nicht-private Decks; Precons bleiben außen
 * vor, weil sie über die MTGJSON-Quelle schon im Korpus stehen und sonst doppelt zählten.
 *
 * In den Korpus wandern ausschließlich Commander- und Kartennamen - keine user_id, keine
 * player_id, kein Deckname, keine Gruppe. Der Korpus soll Kartenhäufigkeiten zeigen, nicht, wer
 * was spielt.
 */
async function* statsfinityRohdecks(gesehen) {
  const { data: decks, error } = await supabase
    .from('decks')
    .select('id, format, updated_at')
    .eq('is_private', false)
    .eq('is_precon', false)
    .eq('format', 'Commander');
  if (error) throw new Error(`decks lesen fehlgeschlagen: ${error.message}`);
  console.log(`Eigene öffentliche Commander-Decks: ${decks.length}.`);

  for (const deck of decks) {
    if (gesehen.has(deck.id)) continue;

    const { data: karten, error: kartenFehler } = await supabase
      .from('deck_cards')
      .select('card_name, quantity, is_commander, is_maybeboard, is_token')
      .eq('deck_id', deck.id);
    if (kartenFehler) throw new Error(`deck_cards lesen fehlgeschlagen: ${kartenFehler.message}`);

    const imDeck = karten.filter((k) => !k.is_maybeboard && !k.is_token);

    yield {
      roh: {
        source: 'statsfinity',
        sourceDeckId: deck.id,
        sourceUpdatedAt: deck.updated_at,
        format: deck.format,
        commanders: imDeck.filter((k) => k.is_commander).map((k) => k.card_name),
        cards: imDeck.map((k) => ({ name: k.card_name, quantity: k.quantity ?? 1 })),
      },
      cursor: deck.id,
    };
  }
}

// =====================================================================================
// Quelle: Archidekt
// =====================================================================================

/**
 * Archidekt veröffentlicht bewusst keine API-Dokumentation (Begründung im eigenen Forum: sie
 * ändern zu viel, um Zusagen machen zu können), die Lese-Endpunkte sind aber offen. Die
 * Feldnamen unten sind deshalb aus öffentlich beschriebener Nutzung abgeleitet und NICHT
 * garantiert.
 *
 * Konsequenz für dieses Skript: Es rät nicht herum. Findet der Umbau unten keine Karten oder
 * keinen Commander, bricht der Lauf mit dem rohen Deck-Objekt im Fehlertext ab - so ist in einer
 * Minute erkennbar, welches Feld jetzt anders heißt. Ein stiller Fehlschlag wäre hier besonders
 * teuer, weil er einen halb leeren Korpus erzeugte, der erst Wochen später auffiele.
 */
const ARCHIDEKT_PAUSE = 2000; // 30 Anfragen/Minute - deren Limiter setzt bei etwa 40 ein.

function archidektListenUrl(seite) {
  return (
    'https://archidekt.com/api/decks/v3/' +
    `?formats=${encodeURIComponent(ARCHIDEKT_FORMAT)}` +
    // Aufsteigend nach Erstellzeit ist die einzige STABILE Reihenfolge: Nach -updatedAt wandern
    // Decks zwischen den Seiten, sobald jemand sie bearbeitet - ein fortgesetzter Lauf übersähe
    // dann Decks und zöge andere doppelt.
    '&orderBy=createdAt' +
    `&page=${seite}&pageSize=50`
  );
}

function kartenNameAusEintrag(eintrag) {
  return (
    eintrag?.card?.oracleCard?.name ?? eintrag?.card?.name ?? eintrag?.oracleCard?.name ?? null
  );
}

function archidektZuRohdeck(deck) {
  // Kategorien, die laut Deck NICHT zum Deck gehören: Maybeboard, Sideboard, "Considering", ...
  const ausgeschlossen = new Set(
    (deck.categories ?? [])
      .filter((k) => k?.includedInDeck === false)
      .map((k) => k?.name)
      .filter(Boolean),
  );

  const cards = [];
  const commanders = [];

  for (const eintrag of deck.cards ?? []) {
    const name = kartenNameAusEintrag(eintrag);
    if (!name) continue;

    const kategorien = eintrag.categories ?? [];
    if (kategorien.some((k) => ausgeschlossen.has(k))) continue;
    // "Maybeboard" ist bei Archidekt zusätzlich ein Modifikator auf dem Eintrag selbst.
    if ((eintrag.modifier ?? '').toLowerCase() === 'maybeboard') continue;

    cards.push({ name, quantity: eintrag.quantity ?? 1 });
    if (kategorien.includes('Commander')) commanders.push(name);
  }

  // Rückfallweg, falls die Commander nicht über die Kategorie, sondern als eigenes Feld kommen.
  if (commanders.length === 0) {
    for (const eintrag of deck.commander ?? []) {
      const name = kartenNameAusEintrag(eintrag) ?? eintrag?.name;
      if (name) commanders.push(name);
    }
  }

  if (cards.length === 0 || commanders.length === 0) {
    throw new Error(
      'Archidekt-Antwort nicht verstanden - weder Karten noch Commander gefunden. ' +
        'Vermutlich haben sich Feldnamen geändert; hier das rohe Deck-Objekt (gekürzt):\n' +
        JSON.stringify(deck).slice(0, 2000),
    );
  }

  return {
    source: 'archidekt',
    sourceDeckId: deck.id,
    sourceUpdatedAt: deck.updatedAt ?? deck.createdAt ?? null,
    format: 'Commander',
    commanders,
    cards,
  };
}

async function* archidektRohdecks(gesehen, zustand) {
  let seite = Number(zustand.cursor ?? '0') + 1;
  let ersteAntwortGezeigt = false;

  for (;;) {
    const liste = await holeJson(archidektListenUrl(seite));
    const treffer = liste?.results ?? [];
    if (treffer.length === 0) {
      console.log(`Seite ${seite} ist leer - Ende der Liste.`);
      return;
    }

    if (!ersteAntwortGezeigt) {
      // Einmalige Kontrolle im Lauf-Protokoll, dass die Feldnamen noch die erwarteten sind -
      // dieselbe Vorsichtsmaßnahme wie in scripts/sync-spellbook-bracket.js.
      console.log('  Felder des ersten Listeneintrags:', Object.keys(treffer[0]).sort().join(', '));
      ersteAntwortGezeigt = true;
    }

    for (const eintrag of treffer) {
      const id = String(eintrag.id);
      if (gesehen.has(id)) continue;

      await sleep(ARCHIDEKT_PAUSE);
      const deck = await holeJson(`https://archidekt.com/api/decks/${id}/`);
      if (!deck) continue;

      yield { roh: archidektZuRohdeck(deck), cursor: null };
    }

    // Cursor erst NACH einer vollständig abgearbeiteten Seite fortschreiben.
    yield { roh: null, cursor: String(seite) };
    seite++;
    await sleep(ARCHIDEKT_PAUSE);
  }
}

// =====================================================================================
// Hauptlauf
// =====================================================================================
async function main() {
  const begonnen = Date.now();
  console.log(
    `Deck-Korpus-Import, Quelle "${QUELLE}"${TROCKENLAUF ? ' (Trockenlauf, es wird nichts geschrieben)' : ''}.`,
  );

  const wissen = await ladeKartenwissen();
  const zustand = await ladeZustand();
  const gesehen = TROCKENLAUF ? new Set() : await ladeGesehene();
  console.log(
    `Stand: ${zustand.deckCount} Decks im Korpus, ${gesehen.size} bereits gesichtet, Cursor ${zustand.cursor ?? '(Anfang)'}.`,
  );

  const schreiber = new KorpusSchreiber(zustand);
  const quelle =
    QUELLE === 'archidekt'
      ? archidektRohdecks(gesehen, zustand)
      : QUELLE === 'statsfinity'
        ? statsfinityRohdecks(gesehen)
        : preconRohdecks(gesehen);

  let letzterCursor = zustand.cursor;
  let beispielGezeigt = false;
  let abbruchgrund = 'Quelle erschöpft';
  // Festhalten, BEVOR der Schreiber zustand.deckCount hochzählt: sonst zählte jeder
  // weggeschriebene Block doppelt (einmal in deckCount, einmal in geschrieben) und der Lauf
  // hörte viel zu früh auf.
  const deckCountZuBeginn = zustand.deckCount;
  let letzteSicherung = Date.now();

  for await (const { roh, cursor } of quelle) {
    if (cursor != null) letzterCursor = cursor;
    if (!roh) continue;

    schreiber.geprueft++;
    schreiber.merkeGesehen(roh.sourceDeckId);

    const ergebnis = pruefeDeck(roh, wissen);
    if (!ergebnis.ok) {
      schreiber.merkeVerwurf(ergebnis.grund);
    } else {
      if (TROCKENLAUF && !beispielGezeigt) {
        console.log('  Beispielzeile:', JSON.stringify(ergebnis.zeile).slice(0, 500));
        beispielGezeigt = true;
      }
      await schreiber.nimmAuf(ergebnis.zeile, letzterCursor);
      schreiber.geschrieben++;
    }

    if (PRUEF_LIMIT > 0 && schreiber.geprueft >= PRUEF_LIMIT) {
      abbruchgrund = `--limit=${PRUEF_LIMIT} erreicht`;
      break;
    }
    if (Date.now() - letzteSicherung >= SICHERUNG_ALLE_MS) {
      await schreiber.schreibeBlock(letzterCursor);
      letzteSicherung = Date.now();
    }
    if (deckCountZuBeginn + schreiber.geschrieben >= ZIEL_DECKS) {
      abbruchgrund = `Ziel von ${ZIEL_DECKS} Decks erreicht`;
      break;
    }
    if ((Date.now() - begonnen) / 60000 >= MAX_MINUTEN) {
      abbruchgrund = `Zeitgrenze von ${MAX_MINUTEN} Minuten erreicht`;
      break;
    }
  }

  await schreiber.schreibeBlock(letzterCursor);

  const dauer = ((Date.now() - begonnen) / 60000).toFixed(1);
  const verworfen = Object.entries(schreiber.rejects)
    .sort((a, b) => b[1] - a[1])
    .map(([grund, anzahl]) => `${anzahl}x ${grund}`)
    .join(', ');

  console.log(
    `\nFertig (${abbruchgrund}) nach ${dauer} Minuten.\n` +
      `  geprüft:    ${schreiber.geprueft}\n` +
      `  übernommen: ${schreiber.geschrieben}\n` +
      `  verworfen:  ${verworfen || 'nichts'}\n` +
      `  Korpus:     ${zustand.deckCount} Decks aus Quelle "${QUELLE}"`,
  );

  // Die Verwerfungsquote ist die wichtigste Kontrollanzeige dieses Skripts: Kippt sie auf fast
  // alles, hat sich die Antwortform der Quelle geändert - dann ist ein weiterer Lauf sinnlos.
  if (schreiber.geprueft >= 50 && schreiber.geschrieben / schreiber.geprueft < 0.1) {
    console.warn(
      '\nWARNUNG: Über 90 % der Decks wurden verworfen. Das ist fast sicher kein Datenproblem,\n' +
        'sondern ein Auslesefehler - erst den häufigsten Grund oben klären, bevor weitergelaufen wird.',
    );
  }
}

main().catch((err) => {
  console.error('\nAbbruch:', err.message);
  process.exit(1);
});
