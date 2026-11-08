// Nächtlicher Abgleich der Scryfall-Kartendaten in die eigene Supabase-Datenbank.
// Tabellen und ausführliche Begründung: sql/scryfall-cache-2026-09-06.sql
// Ausgelöst von .github/workflows/scryfall-sync.yml (täglich 04:00 UTC + manuell).
//
// Kurz: Bisher fragt JEDER Nutzer bei JEDEM Deck-Öffnen live bei Scryfall nach - allein die
// Analyse-Kacheln lösen rund 100 aufeinander folgende Suchanfragen aus (~1 Minute Wartezeit,
// siehe ScryfallService.classifyCards()). Scryfall verweist für solche Mengen ausdrücklich auf
// seine Bulk-Daten. Dieses Skript holt sie einmal pro Nacht von EINEM Server ab.
//
// Braucht den Supabase SERVICE-ROLE-Key (nicht den öffentlichen Anon-Key aus supabase.client.ts) -
// die Tabellen sind bewusst für jeden lesbar, aber für niemanden schreibbar (nur eine
// select-Policy, siehe Migration). Der Service-Role-Key umgeht RLS. NIE committen - als
// Umgebungsvariable übergeben:
//
//   SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/sync-scryfall-bulk.js
//
// Idempotent: kann gefahrlos mehrfach laufen. Teil 1 bricht sogar früh ab, wenn Scryfalls Datei
// unverändert ist, ohne die 24 MB überhaupt zu laden.

const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://jkkelwpnrgzbvopszwrl.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error(
    'Fehlt: SUPABASE_SERVICE_ROLE_KEY als Umgebungsvariable setzen (siehe Kommentar oben).',
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const API = 'https://api.scryfall.com';

/**
 * --force: die Bulk-Datei auch dann laden, wenn sich bei Scryfall nichts geändert hat.
 *
 * Gebraucht wird das nach einer SCHEMA-Änderung. Der Lauf bricht sonst früh ab, sobald der
 * gespeicherte Stand dem bei Scryfall entspricht (so möchte es Scryfall selbst) - eine gerade erst
 * angelegte Spalte bliebe damit leer, bis Scryfall von sich aus eine neue Datei baut, und niemand
 * käme auf die Idee, dass genau das der Grund ist. Genau dieser Fall ist beim Nachrüsten von
 * power/toughness eingetreten: Migration gelaufen, Abgleich angestoßen, Spalten trotzdem leer.
 */
const FORCE = process.argv.includes('--force');

/**
 * Scryfall bittet ausdrücklich um einen aussagekräftigen User-Agent. Aus dem Browser heraus geht
 * das gar nicht (User-Agent ist dort ein verbotener Header und wird stillschweigend verworfen -
 * die Angabe in ScryfallService.buildHeaders() hat faktisch keine Wirkung). Hier, serverseitig,
 * greift sie: der Nachtlauf ist für Scryfall als Statsfinity erkennbar.
 */
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Statsfinity/1.0 (+https://github.com/SazexLucifer1/Statsfinity)',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Muss exakt normalizeCardName() aus src/app/array-utils.ts entsprechen - dieser Wert ist der
 * Schlüssel, unter dem die App die Zeilen wieder nachschlägt. Weicht er auch nur um ein Zeichen
 * ab, findet die App gar nichts und fällt still auf Scryfall zurück. Dieses Skript läuft ohne
 * Angular/TypeScript und kann die Funktion deshalb nicht importieren (gleiche Situation wie bei
 * findCard() in scripts/backfill-deck-color-identity.js).
 */
function normalizeCardName(name) {
  return name.toLowerCase().replace(/[’‘´`]/g, "'");
}

/** Wie überall in der App wird auf dem Namen VOR " // " nachgeschlagen (siehe findCardsBulk()). */
function frontName(name) {
  return name.split(' // ')[0].trim();
}

const normalizedFrontName = (name) => normalizeCardName(frontName(name));

/**
 * Wiederholt bei Netz-/Rate-Limit-Fehlern mit wachsender Pause - analog
 * ScryfallService.fetchWithRetry(), aber deutlich geduldiger: der erste echte Lauf scheiterte hier
 * (Run #1, otag:removal Seite 23 von 37), obwohl die Seite selbst einwandfrei ist. Vier Versuche
 * mit 2/4/6 s reichten also nicht.
 *
 * Wichtig ist außerdem, dass der GRUND im Fehlertext landet: die erste Fassung meldete nur "nach
 * 4 Versuchen aufgegeben" und verschluckte, ob es 429, 5xx oder ein Verbindungsabbruch war -
 * damit ließ sich der Fehlschlag aus dem Lauf-Protokoll heraus nicht einordnen.
 */
const VERSUCHE = 6;

async function fetchMitWiederholung(url, { allow404 = false } = {}) {
  let letzterGrund = 'unbekannt';

  for (let versuch = 0; versuch < VERSUCHE; versuch++) {
    let wartezeit = 3000 * 2 ** versuch; // 3, 6, 12, 24, 48 s
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return res;
      // Scryfall antwortet bei null Treffern mit 404 - das ist ein gültiges Ergebnis, kein Fehler
      // (dieselbe Unterscheidung trifft ScryfallService.fetchWithRetry()).
      if (res.status === 404 && allow404) return null;
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`HTTP ${res.status}`);
      }
      letzterGrund = `HTTP ${res.status}`;
      // Bei 429 sagt Scryfall oft selbst, wie lange zu warten ist - das schlägt jede eigene Schätzung.
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0)
        wartezeit = Math.max(wartezeit, retryAfter * 1000);
    } catch (err) {
      // Verbindungsabbrüche landen hier - anders als ein Statuscode sind sie sonst unsichtbar.
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

async function fetchJson(url, options) {
  const res = await fetchMitWiederholung(url, options);
  return res ? await res.json() : null;
}

async function readSyncState(id) {
  const { data, error } = await supabase
    .from('scryfall_sync_state')
    .select('source_updated_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Konnte scryfall_sync_state (${id}) nicht lesen: ${error.message}`);
  return data;
}

async function writeSyncState(id, sourceUpdatedAt, rowCount) {
  const { error } = await supabase.from('scryfall_sync_state').upsert(
    {
      id,
      source_updated_at: sourceUpdatedAt,
      synced_at: new Date().toISOString(),
      row_count: rowCount,
    },
    { onConflict: 'id' },
  );
  if (error)
    throw new Error(`Konnte scryfall_sync_state (${id}) nicht schreiben: ${error.message}`);
}

// =====================================================================================
// Teil 1: Kartendaten aus der oracle_cards-Bulk-Datei
// =====================================================================================

/**
 * Marken/Embleme bewusst überspringen: ihre Namen kollidieren mit echten Karten (viele
 * verschiedene "Wizard"-/"Zombie"-Marken), und die App lädt sie ohnehin nie über den Namen,
 * sondern über Druck-IDs (ScryfallService.findCardsByIds()) - wofür diese Oracle-ID-Tabelle
 * gar nicht die Quelle ist.
 */
const UEBERSPRUNGENE_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series']);

/**
 * 1:1-Portierung von ScryfallService.toCard() (scryfall.service.ts) auf die Spalten der Tabelle.
 * Jede Abweichung hier zeigt sich in der App als falsches Bild oder fehlende Manaquelle, deshalb
 * sind die Sonderfälle von dort mitsamt Begründung übernommen.
 */
function toRow(data) {
  const backFace = data.card_faces?.[1];
  // image_uris auf Face 2 fehlt bei Adventure/Split (die teilen sich ein Bild) - nur wenn es
  // eins hat, ist es eine "echte" umdrehbare Rückseite (Transform/Modal-DFC).
  const hasFlippableBack = !!backFace?.image_uris?.normal;

  // Bei doppelseitigen Karten (z.B. MDFC-Ländern) steht produced_mana je nach Karte oben oder nur
  // auf den Faces - beide Quellen zusammenführen, sonst fehlt die halbe Manabasis.
  let producedMana = data.produced_mana;
  if (!producedMana && Array.isArray(data.card_faces)) {
    const ausFaces = data.card_faces.flatMap((face) => face?.produced_mana ?? []);
    if (ausFaces.length > 0) producedMana = [...new Set(ausFaces)];
  }

  return {
    oracle_id: data.oracle_id,
    name: data.name,
    front_name_normalized: normalizedFrontName(data.name),
    type_line: data.type_line ?? null,
    cmc: data.cmc ?? null,
    mana_cost: data.mana_cost || data.card_faces?.[0]?.mana_cost || null,
    color_identity: data.color_identity ?? [],
    produced_mana: producedMana ?? null,
    game_changer: data.game_changer ?? false,
    oracle_text: data.oracle_text || data.card_faces?.[0]?.oracle_text || null,
    keywords: data.keywords ?? [],
    image_url:
      data.image_uris?.normal ??
      data.card_faces?.[0]?.image_uris?.normal ??
      data.image_uris?.art_crop ??
      data.card_faces?.[0]?.image_uris?.art_crop ??
      null,
    back_image_url: hasFlippableBack ? backFace.image_uris.normal : null,
    back_type_line: hasFlippableBack ? (backFace.type_line ?? null) : null,
    // Rückseitentext nur bei echten umdrehbaren Karten - bei Split/Adventure ist "Face 2" nur die
    // zweite Hälfte derselben Karte, und ihr Text als "Rückseite" wäre schlicht falsch.
    back_oracle_text: hasFlippableBack ? (backFace.oracle_text ?? null) : null,
    // Wörtlich wie bei Scryfall, "*" und "1+*" eingeschlossen (siehe
    // sql/scryfall-sim-fields-2026-09-16.sql). Bei doppelseitigen Karten steht beides nur auf den
    // Faces - ohne den Rückgriff hätte jede Transform-Kreatur keine Stärke.
    power: data.power ?? data.card_faces?.[0]?.power ?? null,
    toughness: data.toughness ?? data.card_faces?.[0]?.toughness ?? null,
    // "not_legal" und "banned" landen beide auf false - fuer die Frage, ob ein Deck in die
    // Bracket-Eichung darf, ist der Unterschied ohne Belang (siehe
    // sql/scryfall-commander-legality-2026-09-16.sql).
    commander_legal: data.legalities?.commander === 'legal',
    all_parts:
      data.all_parts?.map((p) => ({
        id: p.id,
        component: p.component,
        name: p.name,
        typeLine: p.type_line,
      })) ?? null,
    synced_at: new Date().toISOString(),
  };
}

async function upsertKarten(rows) {
  const { error } = await supabase.from('scryfall_cards').upsert(rows, { onConflict: 'oracle_id' });
  if (error) throw new Error(`Upsert in scryfall_cards fehlgeschlagen: ${error.message}`);
}

async function syncKarten() {
  console.log('--- Teil 1: Kartendaten ---');
  const eintrag = await fetchJson(`${API}/bulk-data/oracle_cards`);
  console.log(
    `Scryfalls oracle_cards: Stand ${eintrag.updated_at}, ${(eintrag.compressed_size / 1e6).toFixed(1)} MB gepackt.`,
  );

  const stand = await readSyncState('cards');
  if (
    !FORCE &&
    stand?.source_updated_at &&
    new Date(stand.source_updated_at).getTime() === new Date(eintrag.updated_at).getTime()
  ) {
    console.log(
      'Unverändert seit dem letzten Lauf - Datei wird gar nicht erst geladen (so möchte es Scryfall). Mit --force trotzdem laden, z.B. nach einer neuen Spalte.',
    );
    return;
  }

  const res = await fetch(eintrag.jsonl_download_uri, {
    headers: { 'User-Agent': HEADERS['User-Agent'] },
  });
  if (!res.ok) throw new Error(`Download der Bulk-Datei fehlgeschlagen: HTTP ${res.status}`);

  // Streamend verarbeiten: die Datei ist entpackt rund 160 MB - komplett in den Speicher zu laden
  // wäre auf einem kleinen Runner unnötig riskant.
  const zeilen = readline.createInterface({
    input: Readable.fromWeb(res.body).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  let block = [];
  let geschrieben = 0;
  let uebersprungen = 0;
  let ersteZeileProtokolliert = false;

  for await (const zeile of zeilen) {
    const inhalt = zeile.trim().replace(/,$/, '');
    // Scryfall liefert die Datei als JSONL, historisch aber auch als ein großes JSON-Array -
    // dessen Klammern hier einfach überspringen, statt am Format zu scheitern.
    if (!inhalt || inhalt === '[' || inhalt === ']') continue;

    let data;
    try {
      data = JSON.parse(inhalt);
    } catch {
      uebersprungen++;
      continue;
    }

    if (!data.oracle_id || !data.name || UEBERSPRUNGENE_LAYOUTS.has(data.layout)) {
      uebersprungen++;
      continue;
    }

    if (!ersteZeileProtokolliert) {
      // Einmalige Kontrolle im Lauf-Protokoll, dass Scryfalls Feldnamen noch die sind, die
      // toRow() erwartet - eine stille Umbenennung bei Scryfall würde sonst erst in der App
      // auffallen, als fehlende Bilder.
      console.log('Felder der ersten Karte:', Object.keys(data).sort().join(', '));
      ersteZeileProtokolliert = true;
    }

    block.push(toRow(data));
    if (block.length >= 500) {
      await upsertKarten(block);
      geschrieben += block.length;
      block = [];
      if (geschrieben % 5000 === 0) console.log(`  ${geschrieben} Karten geschrieben ...`);
    }
  }

  if (block.length > 0) {
    await upsertKarten(block);
    geschrieben += block.length;
  }

  // Bewusst KEIN Löschen von Zeilen, die in der neuen Datei fehlen: Scryfall nimmt Oracle-IDs
  // praktisch nie zurück, und ein Fehler mittendrin würde sonst die halbe Tabelle leeren.
  await writeSyncState('cards', eintrag.updated_at, geschrieben);
  console.log(
    `Teil 1 fertig: ${geschrieben} Karten geschrieben, ${uebersprungen} übersprungen (Marken/Embleme).`,
  );
}

// =====================================================================================
// Teil 2: Effekt-Kategorien
// =====================================================================================

/**
 * Dieselbe Liste wie in der App: src/app/card-effect-filters.ts (Kartensuche, Deck-Filter,
 * Sammlung, Cube) - direkt geladen statt abgeschrieben (Node 22 entfernt die Typangaben selbst,
 * der Workflow startet zur Sicherheit mit --experimental-strip-types). Die zwölf Kategorien der
 * Analyse-Kacheln (EFFECT_TAG_CATEGORIES in deck-effects.service.ts) stehen dort mit
 * zeichengleicher Abfrage. Scryfalls otag:-Suche ist hierarchisch (eine Karte mit Unter-Tag
 * matcht auch das Eltern-Tag), einige Kategorien sind gar keine Tag-Abfragen ("o:create o:token",
 * "keyword:proliferate", "-t:land") - weil hier dieselbe Abfrage an dieselbe Suchmaschine geht,
 * kommen dieselben Zahlen heraus wie bei einer Live-Abfrage aus dem Browser.
 *
 * Seit 05.11.2026 rund 70 statt 12 Kategorien (Effekt-Filter mit Mehrfachauswahl) - der Teil
 * dauert damit einige Minuten länger.
 */
const EFFEKT_KATEGORIEN = require('../src/app/card-effect-filters.ts').CARD_EFFECT_FILTERS.map(
  (f) => ({ key: f.value, query: f.query }),
);

/** Scryfall liefert pro Ergebnisseite höchstens so viele Treffer - gilt für JSON wie für CSV. */
const TREFFER_PRO_SEITE = 175;

/**
 * Zerlegt EINE CSV-Zeile nach RFC4180 (Anführungszeichen, verdoppelte Anführungszeichen als
 * Escape, Kommas innerhalb eines Feldes). Nötig, weil sehr viele Kartennamen ein Komma enthalten
 * ("Krenko, Mob Boss") und Scryfall solche Felder quotet - ein naives split(',') würde sie
 * zerreißen und die Kategorien still mit Namensfragmenten füllen.
 */
function parseCsvLine(line) {
  const felder = [];
  let feld = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c !== '"') feld += c;
      else if (line[i + 1] === '"') {
        feld += '"';
        i++;
      } else inQuotes = false;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      felder.push(feld);
      feld = '';
    } else feld += c;
  }

  felder.push(feld);
  return felder;
}

/**
 * Trennt den CSV-Text in Datensätze. Nicht einfach an "\n" splitten: ein gequotetes Feld darf
 * selbst Zeilenumbrüche enthalten, ein Datensatz kann also über mehrere Textzeilen gehen. Ein
 * Datensatz ist zu Ende, sobald die Anzahl der Anführungszeichen darin gerade ist.
 */
function splitCsvRecords(text) {
  const records = [];
  let aktuell = '';
  let quotes = 0;

  for (const line of text.split('\n')) {
    aktuell = aktuell ? `${aktuell}\n${line}` : line;
    quotes += (line.match(/"/g) ?? []).length;
    if (quotes % 2 === 0) {
      if (aktuell.trim()) records.push(aktuell);
      aktuell = '';
    }
  }
  if (aktuell.trim()) records.push(aktuell);

  return records;
}

/**
 * Holt alle Kartennamen einer Kategorie.
 *
 * Bewusst format=csv statt JSON: Scryfalls JSON-Suche liefert vollständige Kartenobjekte, also
 * rund 892 kB je Ergebnisseite, obwohl hier NUR der Name gebraucht wird. Über alle 139 Seiten
 * waren das ~110 MB in wenigen Minuten - vermutlich der Grund, warum Run #1 mitten in
 * "otag:removal" abbrach, obwohl die betroffene Seite einzeln abgerufen einwandfrei antwortet.
 * Dieselbe Seite als CSV ist rund 49 kB, also etwa ein Zwanzigstel. Die Treffermengen sind
 * geprüft identisch (extracombat 46, proliferate 99, counterspell 546).
 *
 * CSV kennt kein "has_more"/"next_page", deshalb wird über page=N geblättert. Schluss ist bei
 * einer nicht vollen Seite - und zur Sicherheit auch bei 404, falls die letzte Seite zufällig
 * exakt voll war.
 */
async function ladeKategorie(query) {
  const namen = new Set();
  let seiten = 0;

  for (let page = 1; ; page++) {
    const url = `${API}/cards/search?q=${encodeURIComponent(query)}&unique=cards&format=csv&page=${page}`;
    // allow404: Scryfall antwortet bei null Treffern mit 404. Das ist ein gültiges Ergebnis, kein
    // Fehler - genau daran wäre das Skript sonst gescheitert, als "otag:gives-1-1-counters"
    // (Kachel "+1/+1-Marken") ins Leere lief, weil Scryfall dieses Tag zurückgezogen hatte.
    // Aktuell liefert jede Kategorie Treffer; die Behandlung bleibt trotzdem, weil ein
    // zurückgezogenes Tag jederzeit wieder passieren kann.
    const res = await fetchMitWiederholung(url, { allow404: true });
    if (!res) break;
    seiten++;

    const records = splitCsvRecords(await res.text());
    const spalten = parseCsvLine(records[0] ?? '');
    const nameIdx = spalten.indexOf('name');
    // Lieber laut scheitern als still leere Kategorien schreiben, falls Scryfall die Spalten umbaut.
    if (nameIdx < 0) throw new Error(`CSV ohne Spalte "name" (Spalten: ${spalten.join('|')})`);

    const zeilen = records.slice(1);
    for (const zeile of zeilen) namen.add(normalizedFrontName(parseCsvLine(zeile)[nameIdx]));

    if (zeilen.length < TREFFER_PRO_SEITE) break;
    // Deutlich großzügiger als Scryfalls Mindestempfehlung von 50-100 ms: über 139 Seiten hinweg
    // greift offenbar ein Dauerlast-Budget. Mit 250 ms kamen im Testlauf immer noch drei 429er
    // (Scryfall antwortete jeweils mit "Retry-After: 60"), und 60 s Zwangspause kosten mehr als
    // die zusätzlichen Pausen hier. Die Wiederholung oben bleibt trotzdem die eigentliche
    // Absicherung - dieser Wert soll den Fall nur seltener machen, nicht ausschließen.
    await sleep(500);
  }

  return { namen, seiten };
}

async function syncEffekte() {
  console.log('--- Teil 2: Effekt-Kategorien ---');

  // ERST alle Kategorien vollständig laden, DANN schreiben. Vorher wurde je Kategorie sofort
  // gelöscht und eingefügt - bricht der Lauf dann bei Kategorie 5 ab (genau das ist in Run #1
  // passiert), stehen 1-4 in der Tabelle und 5-12 fehlen. Die App würde für die fehlenden
  // Kategorien einfach 0 anzeigen, ohne dass irgendwo ein Fehler sichtbar wäre. Die ~23.000
  // kurzen Zeichenketten im Speicher zu halten kostet dagegen praktisch nichts.
  const geladen = [];
  const leereKategorien = [];
  for (const { key, query } of EFFEKT_KATEGORIEN) {
    const { namen, seiten } = await ladeKategorie(query);
    console.log(`  ${key}: ${namen.size} Karten (${seiten} Seiten)`);
    // Eine leere Kategorie ist fast immer ein zurückgezogenes Tagger-Tag, kein echtes Ergebnis -
    // genau so konnte sich "otag:gives-1-1-counters" monatelang verstecken: die Kachel stand auf 0
    // und nichts wies darauf hin. Deshalb hier laut werden. Bewusst nur eine Warnung und kein
    // Abbruch: eine Kategorie kann legitim leer sein, und der Rest des Abgleichs soll trotzdem
    // durchlaufen.
    if (namen.size === 0) {
      console.warn(
        `  ::warning::Kategorie "${key}" liefert null Treffer - Abfrage prüfen: ${query}`,
      );
      leereKategorien.push(key);
    }
    geladen.push({ key, namen });
  }

  let gesamt = 0;
  for (const { key, namen } of geladen) {
    // Ersetzen statt zusammenführen, damit Karten verschwinden, deren Tag Scryfall zurückgenommen
    // hat. supabase-js kennt keine Transaktion über mehrere Aufrufe - für einen kurzen Moment
    // mitten in der Nacht kann eine Kategorie deshalb unvollständig sein. Bewusst akzeptiert;
    // dafür kommt das Skript ohne eigene Datenbankfunktion aus.
    const { error: deleteError } = await supabase
      .from('scryfall_card_effects')
      .delete()
      .eq('category', key);
    if (deleteError)
      throw new Error(`Konnte Kategorie ${key} nicht leeren: ${deleteError.message}`);

    const rows = [...namen].map((name) => ({ category: key, front_name_normalized: name }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('scryfall_card_effects').insert(rows.slice(i, i + 500));
      if (error) throw new Error(`Insert für Kategorie ${key} fehlgeschlagen: ${error.message}`);
    }

    gesamt += rows.length;
  }

  await writeSyncState('effects', null, gesamt);
  console.log(`Teil 2 fertig: ${gesamt} Zeilen über ${EFFEKT_KATEGORIEN.length} Kategorien.`);
  if (leereKategorien.length > 0) {
    console.warn(
      `ACHTUNG: ohne Treffer geblieben: ${leereKategorien.join(', ')} - die zugehörigen Kacheln stehen damit auf 0.`,
    );
  }
}

// =====================================================================================
// Teil 3: Bannlisten aller Formate (sql/format-bannliste-2026-09-23.sql)
// =====================================================================================

/**
 * App-Formatname (DECK_FORMATS in src/app/models.ts, so steht er in decks.format) -> Scryfalls
 * Formatschlüssel. Nicht alles heißt gleich: das App-"Brawl" ist Scryfalls "standardbrawl", das
 * App-"Historic Brawl" ist Scryfalls "brawl". Kommt in der App ein Format dazu, gehört es hierher -
 * sonst bleibt seine Bannliste still leer. Dieselbe Zuordnung steht als SCRYFALL_FORMAT in
 * src/app/models.ts (die Kartensuche beim Hinzufügen filtert damit auf das Deck-Format).
 */
const BANN_FORMATE = {
  Standard: 'standard',
  Pioneer: 'pioneer',
  Modern: 'modern',
  Legacy: 'legacy',
  Vintage: 'vintage',
  Pauper: 'pauper',
  Commander: 'commander',
  'Pauper Commander': 'paupercommander',
  Brawl: 'standardbrawl',
  'Historic Brawl': 'brawl',
  Alchemy: 'alchemy',
  Explorer: 'explorer',
  Timeless: 'timeless',
};

async function syncBannlisten() {
  console.log('--- Teil 3: Bannlisten ---');

  // Wie bei Teil 2: erst alles laden, dann schreiben - ein Abbruch mittendrin soll keine halb
  // geleerte Bannliste hinterlassen. Eine leere Liste ist hier dagegen ein gültiges Ergebnis
  // (Timeless und Brawl haben zeitweise keine Bans; Scryfall antwortet dann mit 404).
  const geladen = [];
  for (const [format, schluessel] of Object.entries(BANN_FORMATE)) {
    const zeilen = new Map();
    const { namen: gebannt } = await ladeKategorie(`banned:${schluessel}`);
    for (const name of gebannt) zeilen.set(name, 'banned');
    // Beschränkt ("restricted", höchstens ein Exemplar) gibt es nur in Vintage.
    if (schluessel === 'vintage') {
      const { namen: beschraenkt } = await ladeKategorie('restricted:vintage');
      for (const name of beschraenkt) if (!zeilen.has(name)) zeilen.set(name, 'restricted');
    }
    console.log(`  ${format}: ${zeilen.size} Karten`);
    geladen.push({ format, zeilen });
    await sleep(500);
  }

  let gesamt = 0;
  for (const { format, zeilen } of geladen) {
    const { error: deleteError } = await supabase
      .from('format_banlist')
      .delete()
      .eq('format', format);
    if (deleteError)
      throw new Error(`Konnte Bannliste ${format} nicht leeren: ${deleteError.message}`);

    const rows = [...zeilen].map(([name, status]) => ({
      format,
      name_normalized: name,
      status,
    }));
    if (rows.length > 0) {
      const { error } = await supabase.from('format_banlist').insert(rows);
      if (error) throw new Error(`Insert für Bannliste ${format} fehlgeschlagen: ${error.message}`);
    }
    gesamt += rows.length;
  }

  await writeSyncState('banlist', null, gesamt);
  console.log(`Teil 3 fertig: ${gesamt} Zeilen über ${geladen.length} Formate.`);
}

// =====================================================================================
// Teil 4: Wer Commander sein darf (sql/karten-cache-ausbau-2026-10-22.sql)
// =====================================================================================

/**
 * Scryfalls eigene Liste "is:commander" (Regel 903.3 samt "can be your commander") und die
 * Backgrounds - damit die App die Commander-Vorschläge beim Tippen aus der eigenen Datenbank
 * bedienen kann (card_name_suggestions()). ~20 kleine CSV-Seiten, unabhängig von der Bulk-Datei.
 * Fehlt die Tabelle noch, wird Teil 4 übersprungen statt den ganzen Lauf scheitern zu lassen.
 */
async function syncCommanderNamen() {
  console.log('--- Teil 4: Commander-Liste ---');
  const { namen: commander } = await ladeKategorie('is:commander');
  await sleep(500);
  const { namen: backgrounds } = await ladeKategorie('t:background');
  const zeilen = new Map();
  for (const name of backgrounds) zeilen.set(name, 'background');
  for (const name of commander) zeilen.set(name, 'commander');
  // Lieber die alte Liste behalten als eine leere schreiben, falls Scryfall gerade nichts liefert.
  if (commander.size < 1000) {
    throw new Error(`Nur ${commander.size} Commander gefunden - Liste bleibt unverändert.`);
  }

  const { error: deleteError } = await supabase
    .from('scryfall_commander_names')
    .delete()
    .neq('name_normalized', '');
  if (deleteError) {
    if (['42P01', 'PGRST205'].includes(deleteError.code)) {
      console.log(
        'Tabelle scryfall_commander_names fehlt (Migration noch nicht gelaufen) - übersprungen.',
      );
      return;
    }
    throw new Error(`Konnte Commander-Liste nicht leeren: ${deleteError.message}`);
  }
  const rows = [...zeilen].map(([name_normalized, kind]) => ({ name_normalized, kind }));
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabase
      .from('scryfall_commander_names')
      .insert(rows.slice(i, i + 1000));
    if (error) throw new Error(`Insert für Commander-Liste fehlgeschlagen: ${error.message}`);
  }
  await writeSyncState('commander_names', null, rows.length);
  console.log(`Teil 4 fertig: ${commander.size} Commander, ${backgrounds.size} Backgrounds.`);
}

// =====================================================================================
// Teil 5: Preise - je Karte der günstigste, je Druck der echte
// (sql/karten-cache-ausbau-2026-10-22.sql, sql/druck-cache-alle-drucke-2026-11-06.sql)
// =====================================================================================

/**
 * Wie ScryfallService.cheapestPrices() live (eur>0, nicht digital, billigster Druck), nur für alle
 * Karten auf einmal aus der default_cards-Datei (~80 MB gepackt, alle Drucke). Auch Karten ohne
 * Preis bekommen eine Zeile (eur null) - sonst fragte die App bei jedem Deck erneut nach ihnen.
 * Im selben Durchgang je Druck der echte Preis (normal und Foil) samt Seltenheit, Setname und
 * Legalitäten - für die Sammlung zählt der Druck, nicht die billigste Variante. Fehlen die
 * Tabellen noch, wird der jeweilige Teil übersprungen.
 */
async function syncPreise() {
  console.log('--- Teil 5: Preise ---');
  const cardmarket = await ladeCardmarketPreise();
  const eintrag = await fetchJson(`${API}/bulk-data/default_cards`);
  const res = await fetch(eintrag.jsonl_download_uri, {
    headers: { 'User-Agent': HEADERS['User-Agent'] },
  });
  if (!res.ok) throw new Error(`Download von default_cards fehlgeschlagen: HTTP ${res.status}`);
  const zeilen = readline.createInterface({
    input: Readable.fromWeb(res.body).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  const preise = new Map();
  const foilPreise = new Map();
  const drucke = new Map(); // "set/nummer" -> kompakter Druck
  for await (const zeile of zeilen) {
    const inhalt = zeile.trim().replace(/,$/, '');
    if (!inhalt || inhalt === '[' || inhalt === ']') continue;
    let data;
    try {
      data = JSON.parse(inhalt);
    } catch {
      continue;
    }
    if (!data.digital && data.id && data.set && data.collector_number) {
      const key = `${data.set}/${data.collector_number}`.toLowerCase();
      // default_cards hat je Druck eine Zeile; sollte es doch zwei geben, gewinnt die englische.
      if (!drucke.has(key) || data.lang === 'en')
        drucke.set(key, kompakterDruck(data, key, cardmarket));
    }
    if (!data.name || data.digital || UEBERSPRUNGENE_LAYOUTS.has(data.layout)) continue;
    const name = normalizedFrontName(data.name);
    const eur = parseFloat(data.prices?.eur);
    const bisher = preise.get(name);
    if (eur > 0 && (bisher == null || eur < bisher)) preise.set(name, eur);
    else if (!preise.has(name)) preise.set(name, null);
    const foil = parseFloat(data.prices?.eur_foil);
    const foilBisher = foilPreise.get(name);
    if (foil > 0 && (foilBisher == null || foil < foilBisher)) foilPreise.set(name, foil);
  }
  // Manche Karten gibt es bei Cardmarket nur als Foil (z.B. die Warhammer-Commander) - dann zählt
  // der günstigste Foil-Preis statt gar keiner.
  for (const [name, eur] of preise) {
    if (eur == null && foilPreise.has(name)) preise.set(name, foilPreise.get(name));
  }
  const mitPreis = [...preise.values()].filter((eur) => eur != null).length;
  // Lieber die Preise von gestern behalten als eine halb gelesene Datei schreiben.
  if (mitPreis < 20000) {
    throw new Error(`Nur ${mitPreis} Karten mit Preis gelesen - Preise bleiben unverändert.`);
  }

  const start = new Date().toISOString();
  const rows = [...preise].map(([name_normalized, eur]) => ({
    name_normalized,
    eur,
    synced_at: start,
  }));
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabase
      .from('scryfall_card_prices')
      .upsert(rows.slice(i, i + 1000), { onConflict: 'name_normalized' });
    if (error) {
      if (i === 0 && ['42P01', 'PGRST205'].includes(error.code)) {
        console.log(
          'Tabelle scryfall_card_prices fehlt (Migration noch nicht gelaufen) - übersprungen.',
        );
        return;
      }
      throw new Error(`Upsert der Preise fehlgeschlagen: ${error.message}`);
    }
  }
  const { error: cleanupError } = await supabase
    .from('scryfall_card_prices')
    .delete()
    .lt('synced_at', start);
  if (cleanupError) console.warn('Alte Preiszeilen nicht gelöscht:', cleanupError.message);

  await writeSyncState('prices', eintrag.updated_at, rows.length);
  console.log(`Teil 5 fertig: ${rows.length} Karten, davon ${mitPreis} mit Preis.`);
  await schreibeDrucke([...drucke.values()]);
}

/**
 * Reihenfolge der Bits in scryfall_prints.legal_mask. GLEICH HALTEN mit LEGALITY_FORMATS in
 * src/app/collection.service.ts - sonst gilt eine Karte in der App im falschen Format als legal.
 * Neue Formate nur hinten anhängen (höchstens 31).
 */
const LEGALITY_FORMATS = [
  'standard',
  'future',
  'historic',
  'timeless',
  'gladiator',
  'pioneer',
  'explorer',
  'modern',
  'legacy',
  'pauper',
  'vintage',
  'penny',
  'commander',
  'oathbreaker',
  'standardbrawl',
  'brawl',
  'alchemy',
  'paupercommander',
  'duel',
  'oldschool',
  'premodern',
  'predh',
];

/**
 * Cardmarkets öffentliche Preisdatei (Magic, ~27 MB, einmal täglich neu): je Cardmarket-Produkt
 * Durchschnitte und günstigstes Angebot. Die App nimmt avg7 als Preis einer Sammlungskarte und low
 * für Karten im Zustand "Played" (Wunsch des Users, 08.11.2026; sql/cardmarket-preise-zustand-
 * 2026-11-08.sql). Ein Produkt umfasst alle Sprachen eines Drucks. Scheitert der Download, gibt es
 * null zurück - dann schreibt der Lauf die Cardmarket-Spalten gar nicht und die Werte von gestern
 * bleiben stehen.
 */
const CARDMARKET_PREISE =
  'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json';

async function ladeCardmarketPreise() {
  try {
    const res = await fetch(CARDMARKET_PREISE, {
      headers: { 'User-Agent': HEADERS['User-Agent'] },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const preise = new Map();
    for (const p of data.priceGuides ?? []) {
      preise.set(p.idProduct, {
        cm_avg7: cmPreis(p.avg7),
        cm_avg7_foil: cmPreis(p['avg7-foil']),
        cm_low: cmPreis(p.low),
        cm_low_foil: cmPreis(p['low-foil']),
        // Wählbare Preisbasis der Sammlung (sql/sammlung-preisbasis-2026-11-08.sql).
        cm_avg1: cmPreis(p.avg1),
        cm_avg1_foil: cmPreis(p['avg1-foil']),
        cm_avg30: cmPreis(p.avg30),
        cm_avg30_foil: cmPreis(p['avg30-foil']),
        cm_trend: cmPreis(p.trend),
        cm_trend_foil: cmPreis(p['trend-foil']),
      });
    }
    // Wie bei Scryfall: lieber gestern behalten als eine halb gelesene Datei schreiben.
    if (preise.size < 50000) throw new Error(`nur ${preise.size} Produkte`);
    console.log(`  Cardmarket-Preise: ${preise.size} Produkte (Stand ${data.createdAt}).`);
    return preise;
  } catch (err) {
    console.warn(
      `Cardmarket-Preisdatei nicht geladen (${err.message}) - Spalten bleiben unverändert.`,
    );
    return null;
  }
}

function cmPreis(wert) {
  return typeof wert === 'number' && wert > 0 ? wert : null;
}

/** Spalten je Migration - fehlt eine Migration, schreibt der Lauf ohne ihre Spalten weiter. */
const CM_SPALTEN = [
  {
    migration: 'sql/sammlung-preisbasis-2026-11-08.sql',
    spalten: ['cm_avg1', 'cm_avg1_foil', 'cm_avg30', 'cm_avg30_foil', 'cm_trend', 'cm_trend_foil'],
  },
  {
    migration: 'sql/cardmarket-preise-zustand-2026-11-08.sql',
    spalten: ['cm_avg7', 'cm_avg7_foil', 'cm_low', 'cm_low_foil'],
  },
];
const LEERE_CM_PREISE = Object.fromEntries(
  CM_SPALTEN.flatMap((g) => g.spalten).map((spalte) => [spalte, null]),
);

function kompakterDruck(data, print_key, cardmarket) {
  const preis = (wert) => {
    const zahl = parseFloat(wert);
    return zahl > 0 ? zahl : null;
  };
  let legal_mask = 0;
  LEGALITY_FORMATS.forEach((format, bit) => {
    const status = data.legalities?.[format];
    if (status === 'legal' || status === 'restricted') legal_mask |= 1 << bit;
  });
  return {
    scryfall_id: data.id,
    print_key,
    rarity: data.rarity ?? null,
    set_name: data.set_name ?? null,
    illustration_id: data.illustration_id ?? data.card_faces?.[0]?.illustration_id ?? null,
    eur: preis(data.prices?.eur),
    eur_foil: preis(data.prices?.eur_foil),
    legal_mask,
    // Ohne Preisdatei gar nicht schreiben (Upsert lässt fehlende Spalten unangetastet).
    ...(cardmarket ? (cardmarket.get(data.cardmarket_id) ?? LEERE_CM_PREISE) : {}),
  };
}

/** Alle Drucke nach scryfall_prints; was heute nicht mehr in der Datei stand, fliegt raus. */
async function schreibeDrucke(drucke) {
  // Gleiche Sicherung wie bei den Preisen: eine abgebrochene Datei soll nicht die Hälfte löschen.
  if (drucke.length < 50000) {
    console.warn(`Nur ${drucke.length} Drucke gelesen - Druck-Infos bleiben unverändert.`);
    return;
  }
  const start = new Date().toISOString();
  // Doppelte IDs unter verschiedenen Nummern würden den Upsert-Block sprengen.
  const nachId = new Map(drucke.map((d) => [d.scryfall_id, { ...d, synced_at: start }]));
  let rows = [...nachId.values()];
  for (let i = 0; i < rows.length; i += 1000) {
    let { error } = await supabase
      .from('scryfall_prints')
      .upsert(rows.slice(i, i + 1000), { onConflict: 'scryfall_id' });
    // Cardmarket-Spalten fehlen (Migration noch nicht gelaufen): ohne sie weiter, die neueste
    // Migration zuerst.
    for (const gruppe of CM_SPALTEN) {
      if (!(error && i === 0 && ['PGRST204', '42703'].includes(error.code))) break;
      console.log(`Cardmarket-Spalten fehlen - ${gruppe.migration} ausführen.`);
      rows = rows.map((row) =>
        Object.fromEntries(Object.entries(row).filter(([k]) => !gruppe.spalten.includes(k))),
      );
      ({ error } = await supabase
        .from('scryfall_prints')
        .upsert(rows.slice(i, i + 1000), { onConflict: 'scryfall_id' }));
    }
    if (error) {
      if (i === 0 && ['42P01', 'PGRST205'].includes(error.code)) {
        console.log(
          'Tabelle scryfall_prints fehlt (Migration noch nicht gelaufen) - übersprungen.',
        );
        return;
      }
      throw new Error(`Upsert der Druck-Infos fehlgeschlagen: ${error.message}`);
    }
  }
  const { error } = await supabase.from('scryfall_prints').delete().lt('synced_at', start);
  if (error) console.warn('Alte Druck-Infos nicht gelöscht:', error.message);
  console.log(`  ${rows.length} Drucke mit Preis-Infos geschrieben.`);
}

async function main() {
  await syncKarten();
  await syncEffekte();
  await syncBannlisten();
  await syncCommanderNamen();
  await syncPreise();
  console.log('Abgleich abgeschlossen.');
}

main().catch((err) => {
  console.error('Abgleich fehlgeschlagen:', err.message);
  process.exit(1);
});
