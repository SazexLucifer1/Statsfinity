// Rechnet den Deck-Korpus in die Empfehlungszahlen um.
// Tabellen, Bucket und ausführliche Begründung: sql/deck-corpus-2026-09-08.sql
// Befüllt wird der Korpus von scripts/import-deck-corpus.js.
// Ausgelöst von .github/workflows/deck-corpus-import.yml (Job "aggregate", nur von Hand).
//
// Liest die gepackten Rohdecks aus dem Bucket "deck-corpus" und schreibt daraus:
//
//   deck_corpus_commanders       - wie viele Decks je Commander im Korpus stehen
//   deck_corpus_commander_cards  - wie oft eine Karte in den Decks eines Commanders vorkommt
//   deck_corpus_card_baseline    - wie oft eine Karte überhaupt vorkommt, gemessen an den Decks,
//                                  in denen sie farblich spielbar wäre
//
// Das ist fachlich der Ersatz für das, was EdhrecService.getCommanderRecommendations() heute von
// fremden Servern holt - nur eben auf dem eigenen Bestand gerechnet.
//
// Braucht den Supabase SERVICE-ROLE-Key:
//
//   SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/aggregate-deck-corpus.js [--min-decks=1] [--dry-run]
//
// Idempotent: rechnet jedes Mal alles neu. Es gibt keinen Zwischenstand, der kaputtgehen könnte -
// die Rohdecks im Bucket sind die einzige Wahrheit, und die fasst dieses Skript nie an.

const { gunzipSync } = require('node:zlib');

const argumente = process.argv.slice(2);
const flagGesetzt = (name) => argumente.includes(`--${name}`);
const parameter = (name, vorgabe) => {
  const treffer = argumente.find((a) => a.startsWith(`--${name}=`));
  return treffer ? treffer.slice(name.length + 3) : vorgabe;
};

/**
 * Ab wie vielen Decks ein Commander eigene Kartenzahlen bekommt.
 *
 * Vorgabe 1, weil der Korpus klein anfängt: Solange er nur aus Precons und den eigenen Decks
 * besteht, hat fast jeder Commander genau ein Deck - eine höhere Schwelle ließe die Tabelle
 * schlicht leer. Sobald echte Mengen dazukommen, gehört der Wert auf etwa 10 hochgesetzt;
 * darunter sind die Prozentangaben ohnehin Rauschen ("100 % der Decks spielen X" bei einem Deck).
 */
const MIN_DECKS = Number(parameter('min-decks', '1'));

/** Karten unterhalb dieser Deckzahl je Commander landen nicht in der Tabelle. */
const MIN_KARTE = Number(parameter('min-karte', '2'));

/** Höchstens so viele Karten je Commander - die Vorschlagsliste zeigt nie mehr als ein paar Dutzend. */
const MAX_KARTEN_JE_COMMANDER = Number(parameter('max-karten', '400'));

const TROCKENLAUF = flagGesetzt('dry-run');

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://jkkelwpnrgzbvopszwrl.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error(
    'Fehlt: SUPABASE_SERVICE_ROLE_KEY als Umgebungsvariable setzen (siehe Kommentar oben).',
  );
  process.exit(1);
}

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const commanderSchluessel = (namen) => [...namen].sort().join('|');
const farbSchluessel = (farben) => [...farben].sort().join('') || 'C';

// =====================================================================================
// Rohdecks aus dem Bucket
// =====================================================================================

/**
 * Die verbindliche Inhaltsliste des Korpus steht in deck_corpus_files, nicht im Bucket-Listing:
 * Ein abgebrochener Import kann eine unvollständig hochgeladene Datei hinterlassen, und die darf
 * hier nicht mitzählen. Verzeichnet wird eine Datei erst nach erfolgreichem Upload.
 */
async function ladeDateiliste() {
  const { data, error } = await supabase
    .from('deck_corpus_files')
    .select('path, source, deck_count')
    .order('path', { ascending: true });
  if (error) throw new Error(`deck_corpus_files lesen fehlgeschlagen: ${error.message}`);
  return data ?? [];
}

async function* deckZeilen(dateien) {
  for (const datei of dateien) {
    const { data, error } = await supabase.storage.from('deck-corpus').download(datei.path);
    if (error) throw new Error(`${datei.path} herunterladen fehlgeschlagen: ${error.message}`);

    const text = gunzipSync(Buffer.from(await data.arrayBuffer())).toString('utf8');
    for (const zeile of text.split('\n')) {
      if (!zeile) continue;
      yield JSON.parse(zeile);
    }
  }
}

// =====================================================================================
// Kartenwissen für die Bezugsgröße
// =====================================================================================

/** Farbidentität je Karte - nötig, um zu wissen, in wie vielen Decks eine Karte spielbar WÄRE. */
async function ladeKartenfarben() {
  const farben = new Map();
  const SEITE = 1000;

  for (let von = 0; ; von += SEITE) {
    const { data, error } = await supabase
      .from('scryfall_cards')
      .select('front_name_normalized, color_identity')
      .order('front_name_normalized', { ascending: true })
      .range(von, von + SEITE - 1);
    if (error) throw new Error(`scryfall_cards lesen fehlgeschlagen: ${error.message}`);
    for (const zeile of data) farben.set(zeile.front_name_normalized, zeile.color_identity ?? []);
    if (data.length < SEITE) break;
  }

  return farben;
}

// =====================================================================================
// Schreiben
// =====================================================================================

/**
 * Schreibt eine Tabelle neu: alles hochladen (mit dem Zeitstempel dieses Laufs), danach alles
 * löschen, was einen älteren Zeitstempel trägt.
 *
 * Bewusst so herum und nicht "erst leeren, dann füllen" - dieselbe Überlegung wie in
 * scripts/sync-spellbook-bracket.js: supabase-js kennt keine Transaktion über mehrere Aufrufe.
 * Bräche der Lauf zwischen Leeren und Füllen ab, stünde die Empfehlungstabelle leer da. So ist
 * der schlimmste Fall ein Bestand aus zwei Läufen - nie ein leerer.
 */
async function schreibeTabelle(tabelle, konflikt, zeilen, laufBegonnen) {
  if (TROCKENLAUF) {
    console.log(`  [Trockenlauf] ${tabelle}: ${zeilen.length} Zeilen würden geschrieben.`);
    return;
  }

  for (let i = 0; i < zeilen.length; i += 500) {
    const { error } = await supabase
      .from(tabelle)
      .upsert(zeilen.slice(i, i + 500), { onConflict: konflikt });
    if (error) throw new Error(`Upsert in ${tabelle} fehlgeschlagen: ${error.message}`);
  }

  const { error, count } = await supabase
    .from(tabelle)
    .delete({ count: 'exact' })
    .lt('refreshed_at', laufBegonnen);
  if (error) throw new Error(`Aufräumen in ${tabelle} fehlgeschlagen: ${error.message}`);
  console.log(
    `  ${tabelle}: ${zeilen.length} Zeilen geschrieben, ${count ?? 0} veraltete entfernt.`,
  );
}

// =====================================================================================
// Hauptlauf
// =====================================================================================
async function main() {
  const laufBegonnen = new Date().toISOString();
  console.log(`Deck-Korpus auswerten${TROCKENLAUF ? ' (Trockenlauf)' : ''} ...`);

  const dateien = await ladeDateiliste();
  if (dateien.length === 0) {
    throw new Error(
      'Keine Dateien in deck_corpus_files - erst scripts/import-deck-corpus.js laufen lassen.',
    );
  }
  console.log(
    `${dateien.length} Datei(en), laut Verzeichnis ${dateien.reduce((s, d) => s + d.deck_count, 0)} Decks.`,
  );

  const kartenfarben = await ladeKartenfarben();
  console.log(`Kartenfarben geladen: ${kartenfarben.size} Karten.`);

  // ---------------------------------------------------------------------------------
  // 1. Durchgang: Decks zählen
  //
  //    Zwei Durchgänge statt einem, damit der Speicherbedarf auch bei mehreren hunderttausend
  //    Decks beschränkt bleibt: Erst steht fest, welche Commander überhaupt genug Decks haben,
  //    und nur für die werden im zweiten Durchgang Karten gezählt.
  // ---------------------------------------------------------------------------------
  const gesehen = new Set();
  const commander = new Map(); // commanderKey -> { namen, farben, decks }
  const decksJeFarbkombi = new Map(); // "BGUW" -> Anzahl
  const kartenGesamt = new Map(); // Kartenname -> in wie vielen Decks überhaupt
  let decksGesamt = 0;
  let doppelte = 0;

  for await (const deck of deckZeilen(dateien)) {
    const id = `${deck.source}:${deck.sourceDeckId}`;
    if (gesehen.has(id)) {
      doppelte++;
      continue;
    }
    gesehen.add(id);
    decksGesamt++;

    const schluessel = commanderSchluessel(deck.commanders);
    const eintrag = commander.get(schluessel);
    if (eintrag) {
      eintrag.decks++;
    } else {
      commander.set(schluessel, {
        namen: [...deck.commanders].sort(),
        farben: deck.colorIdentity ?? [],
        decks: 1,
      });
    }

    const farbe = farbSchluessel(deck.colorIdentity ?? []);
    decksJeFarbkombi.set(farbe, (decksJeFarbkombi.get(farbe) ?? 0) + 1);

    for (const karte of deck.cards) {
      kartenGesamt.set(karte, (kartenGesamt.get(karte) ?? 0) + 1);
    }
  }

  console.log(
    `1. Durchgang: ${decksGesamt} Decks, ${commander.size} verschiedene Commander` +
      `${doppelte > 0 ? `, ${doppelte} Doppelte übersprungen` : ''}.`,
  );

  const zaehlbar = new Set(
    [...commander].filter(([, e]) => e.decks >= MIN_DECKS).map(([schluessel]) => schluessel),
  );
  console.log(`  davon mit mindestens ${MIN_DECKS} Deck(s): ${zaehlbar.size}.`);

  // ---------------------------------------------------------------------------------
  // 2. Durchgang: Karten je Commander zählen
  // ---------------------------------------------------------------------------------
  const kartenJeCommander = new Map(); // commanderKey -> Map<Karte, Anzahl>
  gesehen.clear();

  for await (const deck of deckZeilen(dateien)) {
    const id = `${deck.source}:${deck.sourceDeckId}`;
    if (gesehen.has(id)) continue;
    gesehen.add(id);

    const schluessel = commanderSchluessel(deck.commanders);
    if (!zaehlbar.has(schluessel)) continue;

    let zaehler = kartenJeCommander.get(schluessel);
    if (!zaehler) {
      zaehler = new Map();
      kartenJeCommander.set(schluessel, zaehler);
    }
    for (const karte of deck.cards) {
      zaehler.set(karte, (zaehler.get(karte) ?? 0) + 1);
    }
  }

  console.log(`2. Durchgang: Karten für ${kartenJeCommander.size} Commander gezählt.`);

  // ---------------------------------------------------------------------------------
  // Bezugsgröße je Karte
  //
  //   playable_decks = alle Korpus-Decks, deren Farbidentität die der Karte enthält. Über die 32
  //   möglichen Farbkombinationen summiert - eine Karte ist in einem Deck spielbar, wenn ihre
  //   Farben eine Teilmenge der Deckfarben sind.
  //
  //   Der Bezug auf die spielbaren statt auf ALLE Decks ist der entscheidende Punkt: Sonst sähe
  //   jede einfarbige Karte künstlich selten aus, nur weil die meisten Decks sie gar nicht
  //   spielen dürfen.
  // ---------------------------------------------------------------------------------
  const baselineZeilen = [];
  for (const [karte, anzahl] of kartenGesamt) {
    const farben = kartenfarben.get(karte);
    if (!farben) continue; // Karte nicht in scryfall_cards - kann nach dem Import nur passieren,
    // wenn der Scryfall-Abgleich zwischenzeitlich Karten verloren hat.

    let spielbar = 0;
    for (const [kombi, decks] of decksJeFarbkombi) {
      if (farben.every((f) => kombi.includes(f))) spielbar += decks;
    }

    baselineZeilen.push({
      front_name_normalized: karte,
      playable_decks: spielbar,
      deck_count: anzahl,
      share: spielbar > 0 ? anzahl / spielbar : 0,
      refreshed_at: laufBegonnen,
    });
  }

  const baseline = new Map(baselineZeilen.map((z) => [z.front_name_normalized, z.share]));

  // ---------------------------------------------------------------------------------
  // Zeilen bauen
  // ---------------------------------------------------------------------------------
  const commanderZeilen = [...commander].map(([schluessel, e]) => ({
    commander_key: schluessel,
    commander_names: e.namen,
    color_identity: e.farben,
    deck_count: e.decks,
    refreshed_at: laufBegonnen,
  }));

  const kartenZeilen = [];
  for (const [schluessel, zaehler] of kartenJeCommander) {
    const deckZahl = commander.get(schluessel).decks;
    const sortiert = [...zaehler]
      .filter(([, anzahl]) => anzahl >= MIN_KARTE)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_KARTEN_JE_COMMANDER);

    for (const [karte, anzahl] of sortiert) {
      const anteil = anzahl / deckZahl;
      kartenZeilen.push({
        commander_key: schluessel,
        front_name_normalized: karte,
        deck_count: anzahl,
        share: anteil,
        synergy: anteil - (baseline.get(karte) ?? 0),
        refreshed_at: laufBegonnen,
      });
    }
  }

  console.log('Schreiben ...');
  await schreibeTabelle(
    'deck_corpus_card_baseline',
    'front_name_normalized',
    baselineZeilen,
    laufBegonnen,
  );
  await schreibeTabelle('deck_corpus_commanders', 'commander_key', commanderZeilen, laufBegonnen);
  await schreibeTabelle(
    'deck_corpus_commander_cards',
    'commander_key,front_name_normalized',
    kartenZeilen,
    laufBegonnen,
  );

  // Kurze Sichtprüfung im Protokoll: Ganz oben müssen die üblichen Verdächtigen stehen (Sol Ring,
  // Arcane Signet, Command Tower). Steht dort etwas anderes, stimmt die Namensnormalisierung
  // nicht - und das fällt hier auf, nicht erst in der App.
  const haeufigste = [...kartenGesamt]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([karte, anzahl]) => `${karte} (${anzahl})`);
  console.log(`\nHäufigste Karten im Korpus: ${haeufigste.join(', ')}`);
  console.log(
    `Fertig: ${decksGesamt} Decks, ${commanderZeilen.length} Commander, ${kartenZeilen.length} Kartenzeilen.`,
  );
}

main().catch((err) => {
  console.error('\nAbbruch:', err.message);
  process.exit(1);
});
