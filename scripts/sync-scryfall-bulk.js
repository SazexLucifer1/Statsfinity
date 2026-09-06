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

/** Wiederholt bei Netz-/Rate-Limit-Fehlern mit wachsender Pause - analog ScryfallService.fetchWithRetry(). */
async function fetchJson(url, { allow404 = false } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.json();
      // Scryfall antwortet bei null Treffern mit 404 - das ist ein gültiges Ergebnis, kein Fehler
      // (dieselbe Unterscheidung trifft ScryfallService.fetchWithRetry()).
      if (res.status === 404 && allow404) return null;
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`${url} -> HTTP ${res.status}`);
      }
    } catch (err) {
      if (attempt === 3) throw err;
    }
    await sleep(2000 * (attempt + 1));
  }
  throw new Error(`${url} -> nach 4 Versuchen aufgegeben`);
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
  const { error } = await supabase
    .from('scryfall_sync_state')
    .upsert(
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
    query:
      '(otag:counterspell or otag:counterspell-noncreature or otag:counterspell-creature or otag:counterspell-sorcery or otag:counterspell-instant or otag:counterspell-artifact or otag:counterspell-enchantment or otag:counterspell-planeswalker or otag:counterspell-ability or otag:counterspell-reusable or otag:counterspell-exile or otag:counterspell-free)',
  },
  { key: 'boardwipe', query: 'otag:board-wipe' },
  {
    key: 'ramp',
    query: '(otag:ramp or otag:land-ramp or otag:extra-land or otag:play-additional-land) -t:land',
  },
  { key: 'draw', query: 'otag:draw' },
  { key: 'tokens', query: 'o:create o:token' },
  { key: 'lifegain', query: 'otag:lifegain' },
  { key: 'counters', query: 'otag:gives-1-1-counters' },
  { key: 'proliferate', query: 'keyword:proliferate' },
  {
    key: 'reanimate',
    query:
      '(otag:reanimate or otag:reanimate-creature or otag:reanimate-artifact or otag:reanimate-enchantment or otag:reanimate-planeswalker or otag:reanimate-permanent)',
  },
  { key: 'sacrifice', query: 'otag:sacrifice-outlet' },
  { key: 'extracombat', query: 'otag:extra-combat' },
];

async function ladeKategorie(query) {
  const namen = new Set();
  let url = `${API}/cards/search?q=${encodeURIComponent(query)}&unique=cards`;
  let seiten = 0;

  while (url) {
    // allow404: Scryfall antwortet bei null Treffern mit 404. Das ist ein gültiges Ergebnis und
    // trifft aktuell tatsächlich zu - "otag:gives-1-1-counters" (Kachel "+1/+1-Marken") findet
    // nichts mehr, das Tag existiert bei Scryfall nicht. Diese Kategorie steht daher schon vor
    // dieser Umstellung dauerhaft auf 0; das Skript darf daran nicht scheitern.
    const seite = await fetchJson(url, { allow404: true });
    if (!seite) break;
    seiten++;
    for (const karte of seite.data ?? []) namen.add(normalizedFrontName(karte.name));
    url = seite.has_more ? seite.next_page : null;
    if (url) await sleep(100); // Scryfalls empfohlene Pause zwischen Anfragen
  }

  return { namen, seiten };
}

async function syncEffekte() {
  console.log('--- Teil 2: Effekt-Kategorien ---');
  let gesamt = 0;

  for (const { key, query } of EFFEKT_KATEGORIEN) {
    const { namen, seiten } = await ladeKategorie(query);
    console.log(`  ${key}: ${namen.size} Karten (${seiten} Seiten)`);

    // Ersetzen statt zusammenführen, damit Karten verschwinden, deren Tag Scryfall zurückgenommen
    // hat. supabase-js kennt keine Transaktion über mehrere Aufrufe - für ein paar Sekunden
    // mitten in der Nacht kann eine Kategorie deshalb unvollständig sein. Bewusst akzeptiert;
    // dafür bleibt das Skript ohne eigene Datenbankfunktion auskommend.
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
