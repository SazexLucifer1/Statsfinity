// Importiert fremde Commander-Decks von Archidekt in den eigenen Auswertungsvorrat
// (Tabellen und ausführliche Begründung: sql/archidekt-deck-pool-2026-09-15.sql).
// Ausgelöst von .github/workflows/archidekt-import.yml (nur manuell, kein Nachtlauf).
//
// Wozu: Um die eigene Bracket-Einstufung aus src/app/bracket.ts gegen die Realität zu prüfen,
// braucht es Decks mit einer Stufe, die jemand ANDERS festgelegt hat. Archidekt hat dafür das Feld
// edhBracket, das der Deck-Besitzer selbst setzt, und lässt sich danach filtern.
//
// Braucht den Supabase SERVICE-ROLE-Key (nicht den öffentlichen Anon-Key aus supabase.client.ts) -
// die Tabellen sind nur für Developer lesbar und für niemanden über RLS schreibbar. Der
// Service-Role-Key umgeht RLS. NIE committen - als Umgebungsvariable übergeben:
//
//   SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/import-archidekt-decks.js --bracket 3 --anzahl 25
//
// Mehrere Stufen in einem Lauf, indem das Paar wiederholt wird:
//
//   ... --bracket 1 --anzahl 10 --bracket 5 --anzahl 10
//
// Mit --dry-run läuft alles bis zum Schreiben durch und zeigt nur, was passieren würde. Das
// braucht KEINEN Service-Role-Key und ist der schnellste Weg, den Import zu prüfen.
//
// Idempotent: kann gefahrlos mehrfach laufen. Ein zweiter Lauf mit denselben Angaben fügt nichts
// doppelt hinzu, sondern sucht weiter, bis er die gewünschte Anzahl NEUER Decks zusammenhat.

const crypto = require('crypto');

// @supabase/supabase-js wird absichtlich erst im Schreibpfad geladen (siehe main()), damit
// --dry-run ohne installierte node_modules läuft - das ist der schnellste Weg, den Import zu
// prüfen, und der soll nicht an einem fehlenden npm install scheitern.

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://jkkelwpnrgzbvopszwrl.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Archidekt wird ausschließlich über den Apex-Host angesprochen.
 *
 * Nicht über api.archidekt.com und nicht über www.archidekt.com: Beide sind aus der
 * Entwicklungsumgebung heraus gesperrt (der Proxy lehnt den CONNECT ab), und gebraucht werden sie
 * auch nicht - die öffentliche API liegt vollständig unter archidekt.com/api/.
 *
 * Aus dem BROWSER wäre dieser Import übrigens gar nicht möglich: Archidekt antwortet mit
 * "access-control-allow-origin: http://localhost:3000", also einem festen fremden Origin. Ein
 * fetch aus der App heraus scheitert damit immer an CORS, egal was in public/_headers steht.
 * Darum ist das hier ein serverseitiges Skript und keine Funktion in der App.
 */
const API = 'https://archidekt.com/api';

/** Nur Commander/EDH - deckFormat 3 in Archidekts Nummerierung. */
const FORMAT_COMMANDER = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Aussagekräftiger User-Agent, damit der Lauf für Archidekt als Statsfinity erkennbar ist -
 * gleiche Höflichkeit wie im Scryfall- und im Spellbook-Abgleich.
 */
const HEADERS = {
  'User-Agent': 'Statsfinity/1.0 (https://github.com/SazexLucifer1/Statsfinity; Deck-Import)',
  Accept: 'application/json',
};

/**
 * Muss exakt normalizeCardName() aus src/app/array-utils.ts entsprechen - dieser Wert ist der
 * Schlüssel, über den sich ein importiertes Deck später auf scryfall_cards.front_name_normalized
 * joinen lässt. Weicht er auch nur um ein Zeichen ab, findet die Auswertung die Kartendetails
 * nicht und die ganze Bracket-Rechnung läuft ins Leere. Dieses Skript läuft ohne
 * Angular/TypeScript und kann die Funktion deshalb nicht importieren (gleiche Situation wie bei
 * normalizeCardName() in scripts/sync-scryfall-bulk.js und scripts/sync-spellbook-bracket.js).
 */
function normalizeCardName(name) {
  return name.toLowerCase().replace(/[’‘´`]/g, "'");
}

/** Wie überall in der App wird auf dem Namen VOR " // " nachgeschlagen. */
function frontName(name) {
  return name.split(' // ')[0].trim();
}

const normalizedFrontName = (name) => normalizeCardName(frontName(name));

// =====================================================================================
// Rate-Limit
//
// Archidekt veröffentlicht keine Obergrenze, also wird bewusst zurückhaltend angefragt statt
// ausgetestet, wo es knallt. Die Zahlen sind an scripts/sync-spellbook-bracket.js angelehnt, wo
// ein Lauf schon einmal an einem Rate-Limit gescheitert ist (HTTP 429 nach 136 Anfragen).
//
// Drei Bremsen greifen zusammen:
//   1. ALLE Anfragen laufen streng der Reihe nach - nie parallel. Ein Promise.all über 25
//      Deck-Abrufe wäre der schnellste Weg in ein Timeout und genau das, was hier nicht passieren
//      soll.
//   2. PAUSE_JE_ANFRAGE zwischen zwei Anfragen, also rund eine Anfrage pro Sekunde.
//   3. MAX_ANFRAGEN als harte Obergrenze für den ganzen Lauf. Sie begrenzt die Laufzeit auch dann,
//      wenn die Suche unerwartet viele Seiten mit lauter Duplikaten liefert.
//
// Ein Deck kostet eine Anfrage, eine Suchseite (60 Treffer) ebenfalls eine. Nicht jedes geprüfte
// Deck wird aufgenommen (Kartenzahl, fehlender Commander, Duplikate), 1.000 aufgenommene Decks
// kosten also eher 1.400 bis 1.800 Anfragen - bei einer Sekunde Pause rund eine halbe Stunde. Das
// ist für einen von Hand ausgelösten Lauf in Ordnung: Die Sekundenpause ist das Einzige, was
// zuverlässig vor einem Rate-Limit schützt, und sie wird für mehr Tempo NICHT angetastet.
//
// Ein Abbruch mitten im Lauf kostet übrigens nur Zeit, keine Daten: Jedes Deck wird einzeln
// geschrieben, und beim nächsten Lauf sorgt der Bestandsabgleich dafür, dass er dort weitermacht,
// wo der letzte aufhörte.
// =====================================================================================
const PAUSE_JE_ANFRAGE = 1000;
const PAUSE_NACH_LIMIT = 60000;
const VERSUCHE = 6;

/**
 * Harte Obergrenze für den ganzen Lauf. Großzügig über dem, was MAX_DECKS_JE_LAUF im Normalfall
 * braucht (rund 1.400-1.800), damit nicht ein Lauf mit vielen aussortierten Decks kurz vor dem
 * Ziel abbricht - aber eng genug, dass ein Lauf, der ins Leere läuft, nicht stundenlang weitergeht.
 */
const MAX_ANFRAGEN = 3000;

/** Obergrenze für --anzahl. Mehr als das gehört auf mehrere Läufe verteilt. */
const MAX_DECKS_JE_LAUF = 1000;

/** Archidekt liefert immer 60 Treffer je Seite, pageSize wird serverseitig ignoriert. */
const TREFFER_JE_SEITE = 60;

/**
 * Reißleine, falls die Suche endlos Seiten mit lauter bereits bekannten Decks liefert.
 *
 * 100 Seiten sind 6.000 geprüfte Kandidaten je Stufe - genug, um auch bei einem gut gefüllten
 * Vorrat noch 1.000 neue Decks zu finden. Nachgemessen: Archidekts Suche blättert weit über die
 * angezeigten "count: 1000" hinaus (Seite 400 liefert noch 60 Treffer, ohne Überschneidung zu
 * Seite 1), der Vorrat ist also nicht die Grenze.
 */
const MAX_SEITEN_JE_BRACKET = 100;

let anfragenGesamt = 0;
let letzteAnfrage = 0;

/**
 * Holt eine JSON-Antwort, hält dabei die Mindestpause ein und wiederholt bei Netz-,
 * Rate-Limit- und Serverfehlern mit wachsender Pause.
 *
 * Der GRUND landet im Fehlertext - ohne ihn lässt sich ein Fehlschlag aus dem Lauf-Protokoll
 * heraus nicht einordnen (teuer gelernte Lehre aus den beiden Sync-Skripten).
 */
async function fetchJson(pfad) {
  if (anfragenGesamt >= MAX_ANFRAGEN) {
    throw new Error(
      `Anfrage-Obergrenze von ${MAX_ANFRAGEN} erreicht - Lauf abgebrochen, bevor Archidekt uns bremst. Mit kleinerem --anzahl erneut laufen lassen.`,
    );
  }

  const seit = Date.now() - letzteAnfrage;
  if (letzteAnfrage && seit < PAUSE_JE_ANFRAGE) await sleep(PAUSE_JE_ANFRAGE - seit);

  let letzterGrund = 'unbekannt';

  for (let versuch = 0; versuch < VERSUCHE; versuch++) {
    let wartezeit = 3000 * 2 ** versuch; // 3, 6, 12, 24, 48 s
    try {
      anfragenGesamt++;
      letzteAnfrage = Date.now();
      const res = await fetch(API + pfad, { headers: HEADERS });
      if (res.ok) return await res.json();
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status}`);
      letzterGrund = `HTTP ${res.status}`;
      if (res.status === 429) wartezeit = Math.max(wartezeit, PAUSE_NACH_LIMIT);
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0)
        wartezeit = Math.max(wartezeit, retryAfter * 1000);
    } catch (err) {
      letzterGrund = err.message;
      if (versuch === VERSUCHE - 1) break;
    }
    console.log(
      `    Versuch ${versuch + 1}/${VERSUCHE} fehlgeschlagen (${letzterGrund}), erneut in ${wartezeit / 1000}s ...`,
    );
    await sleep(wartezeit);
  }

  throw new Error(`${pfad} -> nach ${VERSUCHE} Versuchen aufgegeben, zuletzt: ${letzterGrund}`);
}

// =====================================================================================
// Deck aus Archidekts Antwort in unsere Form bringen
// =====================================================================================

/**
 * Baut die Kartenliste eines Decks.
 *
 * Zwei Dinge, die hier bewusst passieren:
 *
 * 1. Maybeboard, Sideboard und "Considering" fliegen raus. Archidekt führt sie als Kategorien mit
 *    includedInDeck = false; ohne diesen Filter käme ein Deck auf deutlich mehr als 100 Karten und
 *    würde an der Prüfung unten scheitern, obwohl es in Ordnung ist.
 * 2. Mengen werden je normalisiertem Namen zusammengefasst. Archidekt kann dieselbe Karte in zwei
 *    Kategorien als zwei Einträge führen; der Primärschlüssel der Kartentabelle erlaubt aber nur
 *    eine Zeile je Karte und Deck.
 */
function baueKarten(deck) {
  const ausgeschlossen = new Set(
    (deck.categories ?? []).filter((k) => k.includedInDeck === false).map((k) => k.name),
  );

  const karten = new Map();

  for (const eintrag of deck.cards ?? []) {
    const kategorien = eintrag.categories ?? [];
    if (kategorien.some((k) => ausgeschlossen.has(k))) continue;

    const anzeigename = eintrag.card?.oracleCard?.name ?? eintrag.card?.name;
    if (!anzeigename) continue;

    const schluessel = normalizedFrontName(anzeigename);
    const menge = Number(eintrag.quantity) || 1;
    const istCommander = kategorien.includes('Commander');

    const vorhanden = karten.get(schluessel);
    if (vorhanden) {
      vorhanden.quantity += menge;
      vorhanden.is_commander = vorhanden.is_commander || istCommander;
    } else {
      karten.set(schluessel, {
        name_normalized: schluessel,
        name: anzeigename,
        quantity: menge,
        is_commander: istCommander,
      });
    }
  }

  return [...karten.values()];
}

/**
 * Fingerabdruck der Kartenliste - die zweite Duplikatsperre.
 *
 * Absichtlich NUR über Menge, normalisierten Namen und Commander-Kennzeichen, sortiert: Zwei
 * Decks mit identischer Liste sollen denselben Hash haben, auch wenn sie anders heißen, anderen
 * Besitzern gehören, andere Kategorien benutzen oder die Karten in anderer Reihenfolge führen.
 * Genau dieser Fall - eine populäre Netdeck-Liste hundertfach kopiert - würde die spätere
 * Auswertung verfälschen.
 */
function kartenHash(karten) {
  const zeilen = karten
    .map((k) => `${k.quantity}|${k.name_normalized}|${k.is_commander ? 'C' : 'M'}`)
    .sort();
  return crypto.createHash('sha256').update(zeilen.join('\n')).digest('hex');
}

/**
 * Prüft, ob ein Deck in den Vorrat gehört, und liefert sonst den Grund.
 *
 * Nur saubere Commander-Decks: Ein Deck ohne erkennbaren Commander oder mit abweichender
 * Kartenzahl ist als Referenz wertlos - die Bracket-Kriterien setzen eine vollständige
 * 100-Karten-Liste voraus. 101 ist erlaubt, weil Partner und Hintergrund zwei Commander bedeuten.
 */
function pruefeDeck(deck, karten) {
  if (deck.deckFormat !== FORMAT_COMMANDER) return 'kein Commander-Format';
  if (deck.private) return 'privat';

  const bracket = deck.edhBracket;
  if (!Number.isInteger(bracket) || bracket < 1 || bracket > 5)
    return 'kein Bracket vom Ersteller angegeben';

  const commander = karten.filter((k) => k.is_commander);
  if (commander.length === 0) return 'kein Commander erkannt';
  if (commander.length > 2) return `${commander.length} Commander`;

  const summe = karten.reduce((s, k) => s + k.quantity, 0);
  if (summe !== 100 && summe !== 101) return `${summe} Karten statt 100`;

  return null;
}

// =====================================================================================
// Suche
// =====================================================================================

/**
 * Eine Seite der Deck-Suche für eine Bracket-Stufe.
 *
 * Wichtig zum Parameter edhBracket: Er nimmt GENAU EINEN Wert. Eine Liste wie "4,5" wird von
 * Archidekt stillschweigend ignoriert - die Antwort sieht dann wie ein Ergebnis aus, ist aber die
 * ungefilterte Liste. Deshalb je Stufe ein eigener Durchgang.
 */
async function sucheSeite(bracket, seite) {
  const qs = new URLSearchParams({
    formats: String(FORMAT_COMMANDER),
    edhBracket: String(bracket),
    orderBy: '-viewCount',
    page: String(seite),
  });
  const data = await fetchJson(`/decks/v3/?${qs}`);
  return data.results ?? [];
}

// =====================================================================================
// Vorhandenen Bestand laden (die Duplikatsperre)
// =====================================================================================

/**
 * Lädt alle bereits vorhandenen Archidekt-IDs und Kartenlisten-Hashes.
 *
 * Beides wird VOR dem Import geladen, damit ein Duplikat gar keine Anfrage an Archidekt kostet
 * (die ID lässt sich schon aus der Suchliste abgleichen). Die unique constraints in der Datenbank
 * bleiben trotzdem die letzte Instanz - nur sie können es wirklich garantieren.
 *
 * Seitenweise, weil Supabase eine Antwort standardmäßig auf 1.000 Zeilen deckelt und der Vorrat
 * größer werden soll.
 */
async function ladeBestand(supabase) {
  const ids = new Set();
  const hashes = new Set();
  const SEITE = 1000;

  for (let von = 0; ; von += SEITE) {
    const { data, error } = await supabase
      .from('archidekt_deck_pool')
      .select('archidekt_id, cards_hash')
      .range(von, von + SEITE - 1);
    if (error) throw new Error(`Bestand konnte nicht geladen werden: ${error.message}`);
    for (const zeile of data) {
      ids.add(Number(zeile.archidekt_id));
      hashes.add(zeile.cards_hash);
    }
    if (data.length < SEITE) break;
  }

  return { ids, hashes };
}

/**
 * Schreibt ein Deck samt Karten.
 *
 * Erst der Deck-Kopf, dann die Karten - schlägt der zweite Schritt fehl, wird der Kopf wieder
 * entfernt, damit kein Deck ohne Kartenliste im Vorrat zurückbleibt (ein solches Deck wäre für
 * jede Auswertung Gift und würde durch den unique constraint auf cards_hash auch einen späteren
 * korrekten Import derselben Liste blockieren).
 */
async function schreibeDeck(supabase, deckZeile, karten) {
  const { data, error } = await supabase
    .from('archidekt_deck_pool')
    .insert(deckZeile)
    .select('id')
    .single();

  if (error) {
    // 23505 = unique violation: zwischen Bestandsabgleich und Insert dazugekommen.
    if (error.code === '23505') return { uebersprungen: 'schon vorhanden' };
    throw new Error(
      `Deck ${deckZeile.archidekt_id} konnte nicht gespeichert werden: ${error.message}`,
    );
  }

  const { error: kartenFehler } = await supabase
    .from('archidekt_deck_pool_cards')
    .insert(karten.map((k) => ({ ...k, deck_id: data.id })));

  if (kartenFehler) {
    await supabase.from('archidekt_deck_pool').delete().eq('id', data.id);
    throw new Error(
      `Karten von Deck ${deckZeile.archidekt_id} konnten nicht gespeichert werden (Deck wieder entfernt): ${kartenFehler.message}`,
    );
  }

  return { uebersprungen: null };
}

// =====================================================================================
// Ein Bracket abarbeiten
// =====================================================================================

async function importiereBracket(supabase, bracket, ziel, bestand, trockenlauf) {
  console.log(`\n=== Bracket ${bracket}: ${ziel} Deck(s) gesucht ===`);

  let aufgenommen = 0;
  const gruende = new Map();
  const merkeGrund = (grund) => gruende.set(grund, (gruende.get(grund) ?? 0) + 1);

  for (let seite = 1; seite <= MAX_SEITEN_JE_BRACKET && aufgenommen < ziel; seite++) {
    const treffer = await sucheSeite(bracket, seite);
    if (treffer.length === 0) {
      console.log(`  Seite ${seite}: keine weiteren Treffer - Suche erschöpft.`);
      break;
    }
    console.log(`  Seite ${seite}: ${treffer.length} Treffer`);

    for (const kurz of treffer) {
      if (aufgenommen >= ziel) break;

      const archidektId = Number(kurz.id);
      if (bestand.ids.has(archidektId)) {
        merkeGrund('Archidekt-ID schon im Vorrat');
        continue;
      }

      const deck = await fetchJson(`/decks/${archidektId}/`);
      const karten = baueKarten(deck);
      const grund = pruefeDeck(deck, karten);
      if (grund) {
        merkeGrund(grund);
        continue;
      }

      const hash = kartenHash(karten);
      if (bestand.hashes.has(hash)) {
        merkeGrund('identische Kartenliste schon im Vorrat');
        continue;
      }

      const commander = karten
        .filter((k) => k.is_commander)
        .map((k) => k.name)
        .sort();

      const deckZeile = {
        archidekt_id: archidektId,
        name: deck.name ?? `Archidekt ${archidektId}`,
        commander_names: commander,
        creator_bracket: deck.edhBracket,
        card_count: karten.reduce((s, k) => s + k.quantity, 0),
        cards_hash: hash,
        owner_username: deck.owner?.username ?? null,
        view_count: Number.isFinite(deck.viewCount) ? deck.viewCount : null,
        archidekt_updated_at: deck.updatedAt ?? null,
      };

      if (trockenlauf) {
        console.log(
          `    + ${deckZeile.name} (${commander.join(' + ')}) - ${deckZeile.card_count} Karten`,
        );
      } else {
        const { uebersprungen } = await schreibeDeck(supabase, deckZeile, karten);
        if (uebersprungen) {
          merkeGrund(uebersprungen);
          continue;
        }
        console.log(`    + ${deckZeile.name} (${commander.join(' + ')})`);
      }

      bestand.ids.add(archidektId);
      bestand.hashes.add(hash);
      aufgenommen++;
    }
  }

  console.log(`  -> ${aufgenommen} von ${ziel} aufgenommen`);
  if (gruende.size > 0) {
    console.log('  Übersprungen:');
    for (const [grund, anzahl] of [...gruende].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(anzahl).padStart(4)}x ${grund}`);
    }
  }
  if (aufgenommen < ziel) {
    console.log(
      `  Hinweis: Es wurden nur ${aufgenommen} neue Decks gefunden. Bei dieser Stufe ist der` +
        ' Vorrat an noch nicht importierten, sauberen Decks offenbar erschöpft.',
    );
  }

  return aufgenommen;
}

// =====================================================================================
// Aufrufparameter
// =====================================================================================

function leseArgumente(argv) {
  const plan = [];
  let trockenlauf = false;
  let offenesBracket = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      trockenlauf = true;
    } else if (arg === '--bracket') {
      const wert = Number(argv[++i]);
      if (!Number.isInteger(wert) || wert < 1 || wert > 5)
        throw new Error(`--bracket braucht eine Stufe von 1 bis 5, bekommen: ${argv[i]}`);
      if (offenesBracket !== null)
        throw new Error(`--bracket ${offenesBracket} hat kein --anzahl bekommen.`);
      offenesBracket = wert;
    } else if (arg === '--anzahl') {
      const wert = Number(argv[++i]);
      if (offenesBracket === null) throw new Error('--anzahl steht ohne vorheriges --bracket.');
      if (!Number.isInteger(wert) || wert < 1)
        throw new Error(`--anzahl braucht eine ganze Zahl ab 1, bekommen: ${argv[i]}`);
      plan.push({ bracket: offenesBracket, anzahl: wert });
      offenesBracket = null;
    } else {
      throw new Error(`Unbekannter Parameter: ${arg}`);
    }
  }

  if (offenesBracket !== null)
    throw new Error(`--bracket ${offenesBracket} hat kein --anzahl bekommen.`);
  if (plan.length === 0)
    throw new Error(
      'Nichts zu tun. Beispiel: node scripts/import-archidekt-decks.js --bracket 3 --anzahl 25',
    );

  const doppelt = plan.map((p) => p.bracket).filter((b, i, alle) => alle.indexOf(b) !== i);
  if (doppelt.length > 0)
    throw new Error(`Bracket ${doppelt[0]} steht mehrfach im Plan - bitte zusammenfassen.`);

  const gesamt = plan.reduce((s, p) => s + p.anzahl, 0);
  if (gesamt > MAX_DECKS_JE_LAUF)
    throw new Error(
      `${gesamt} Decks in einem Lauf sind zu viel (Obergrenze ${MAX_DECKS_JE_LAUF}). Bei einer Anfrage pro Sekunde wäre das mehr als eine halbe Stunde Dauerlast auf einer fremden API - bitte auf mehrere Läufe aufteilen. Das kostet nichts: Bereits importierte Decks werden übersprungen, ein zweiter Lauf macht also dort weiter, wo der erste aufhörte.`,
    );

  return { plan, trockenlauf, gesamt };
}

// =====================================================================================

async function main() {
  const { plan, trockenlauf, gesamt } = leseArgumente(process.argv.slice(2));

  console.log(
    `Archidekt-Import${trockenlauf ? ' (Trockenlauf - es wird nichts geschrieben)' : ''}: ` +
      plan.map((p) => `Bracket ${p.bracket} x${p.anzahl}`).join(', '),
  );
  console.log(
    `Rate-Limit: eine Anfrage pro ${PAUSE_JE_ANFRAGE / 1000}s, streng der Reihe nach, ` +
      `höchstens ${MAX_ANFRAGEN} Anfragen im Lauf. Grobe Schätzung: ` +
      `${Math.ceil((gesamt + gesamt / TREFFER_JE_SEITE + plan.length) * (PAUSE_JE_ANFRAGE / 1000))}s ` +
      'bei lauter Treffern.',
  );

  let supabase = null;
  let bestand = { ids: new Set(), hashes: new Set() };

  if (trockenlauf) {
    console.log(
      'Trockenlauf: ohne Datenbank, der Abgleich gegen den vorhandenen Bestand entfällt also -' +
        ' bereits importierte Decks erscheinen hier als neu.',
    );
  } else {
    if (!SERVICE_ROLE_KEY) {
      console.error(
        'Fehlt: SUPABASE_SERVICE_ROLE_KEY als Umgebungsvariable setzen (siehe Kommentar oben).' +
          ' Zum Ausprobieren ohne Schlüssel: --dry-run',
      );
      process.exit(1);
    }
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    bestand = await ladeBestand(supabase);
    console.log(`Im Vorrat: ${bestand.ids.size} Deck(s).`);
  }

  let aufgenommen = 0;
  for (const { bracket, anzahl } of plan) {
    aufgenommen += await importiereBracket(supabase, bracket, anzahl, bestand, trockenlauf);
  }

  console.log(
    `\nFertig: ${aufgenommen} von ${gesamt} Deck(s) ${trockenlauf ? 'gefunden' : 'importiert'},` +
      ` ${anfragenGesamt} Anfragen an Archidekt.`,
  );
}

main().catch((err) => {
  console.error(`\nAbgebrochen: ${err.message}`);
  process.exit(1);
});
