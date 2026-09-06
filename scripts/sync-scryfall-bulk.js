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
    stand?.source_updated_at &&
    new Date(stand.source_updated_at).getTime() === new Date(eintrag.updated_at).getTime()
  ) {
    console.log(
      'Unverändert seit dem letzten Lauf - Datei wird gar nicht erst geladen (so möchte es Scryfall).',
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
 * WÖRTLICH aus EFFECT_TAG_CATEGORIES in src/app/deck-viewer.service.ts übernommen - key und
 * query müssen zeichengleich bleiben. Genau darin liegt der Trick dieser Lösung: Scryfalls
 * otag:-Suche ist hierarchisch (eine Karte mit Unter-Tag matcht auch das Eltern-Tag) und einige
 * Kategorien sind gar keine Tag-Abfragen ("o:create o:token", "keyword:proliferate", "-t:land").
 * Weil hier dieselbe Abfrage an dieselbe Suchmaschine geht, kommen garantiert dieselben Zahlen
 * heraus wie bei der bisherigen Live-Abfrage aus dem Browser.
 *
 * Ändert sich dort eine Abfrage, muss sie hier nachgezogen werden - sonst zeigt die App Zahlen
 * zu einer Abfrage, die es nicht mehr gibt.
 */
const EFFEKT_KATEGORIEN = [
  { key: 'removal', query: 'otag:removal' },
  {
    key: 'counterspell',
    query: 'otag:counterspell',
  },
  { key: 'boardwipe', query: 'otag:board-wipe' },
  {
    key: 'ramp',
    query: 'otag:ramp -t:land',
  },
  { key: 'draw', query: 'otag:draw' },
  { key: 'tokens', query: 'o:create o:token' },
  { key: 'lifegain', query: 'otag:lifegain' },
  { key: 'counters', query: 'o:"+1/+1 counter"' },
  { key: 'proliferate', query: 'keyword:proliferate' },
  {
    key: 'reanimate',
    query: 'otag:reanimate',
  },
  { key: 'sacrifice', query: 'otag:sacrifice-outlet' },
  { key: 'extracombat', query: 'otag:extra-combat' },
];

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

async function main() {
  await syncKarten();
  await syncEffekte();
  console.log('Abgleich abgeschlossen.');
}

main().catch((err) => {
  console.error('Abgleich fehlgeschlagen:', err.message);
  process.exit(1);
});
