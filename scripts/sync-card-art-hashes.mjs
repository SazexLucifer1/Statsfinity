/**
 * Nachtlauf, Teil 4 des Scryfall-Abgleichs: Artwork-Fingerabdrücke für den Kartenscanner
 * (src/app/card-scan.service.ts). Läuft im Workflow scryfall-sync.yml nach sync-scryfall-bulk.js.
 *
 *   node --experimental-strip-types scripts/sync-card-art-hashes.mjs [--max=20000]
 *
 * Quelle ist Scryfalls Bulk-Datei unique_artwork: genau ein Druck je Artwork (illustration_id),
 * rund 55.000 Stück. Für jeden lädt das Skript das art_crop-Bild und rechnet mit
 * src/app/art-hash.ts (DERSELBEN Datei wie der Browser - deshalb strip-types) einen 64-Bit-
 * Fingerabdruck. Ergebnis sind zwei Dateien im Storage (Bucket card-art-hashes), keine Tabelle:
 * art-hashes.bin (~1,3 MB, alle Karten) und token-art-hashes.bin (Marken, klein, seit 20.10.2026) -
 * der Scanner braucht immer alle auf einmal, und die Datenbank bleibt klein (siehe
 * sql/sammlung-2026-10-17.sql).
 *
 * Inkrementell: Die vorhandene Datei wird zuerst gelesen, nur neue Drucke werden geladen. Der
 * erste Lauf braucht deshalb mehrere Nächte (--max je Lauf, Standard 20.000 Bilder ≈ 30 min),
 * danach sind es je Nacht nur die paar Dutzend neuen Artworks. Die Bilder kommen von Scryfalls CDN
 * (cards.scryfall.io), das kein Rate-Limit der API hat; trotzdem höchstens 6 gleichzeitig.
 *
 * Braucht SUPABASE_SERVICE_ROLE_KEY wie die anderen Abgleiche (der Bucket hat nur eine Lese-Policy).
 */
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import jpeg from 'jpeg-js';
import { createClient } from '@supabase/supabase-js';
import {
  ART_HASH_FILE,
  TOKEN_ART_HASH_FILE,
  artHashId,
  decodeArtHashes,
  encodeArtHashes,
  grayGrid,
  phash,
} from '../src/app/art-hash.ts';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://jkkelwpnrgzbvopszwrl.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) {
  console.error('Fehlt: SUPABASE_SERVICE_ROLE_KEY als Umgebungsvariable setzen.');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const BUCKET = 'card-art-hashes';
const MAX_NEW = Number(process.argv.find((a) => a.startsWith('--max='))?.slice(6) ?? 20000);
const PARALLEL = 6;
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Statsfinity/1.0 (+https://github.com/SazexLucifer1/Statsfinity)',
};
// Embleme und Art-Series-Karten landen nie in einer Sammlung, die der Scanner füllen soll - und
// ihre Artworks würden echte Karten verdrängen, die sich dasselbe Bild teilen.
// Marken (Wunsch des Users, 20.10.2026: der Scanner soll auch sie erkennen) kommen in eine eigene,
// kleine Datei - der Scanner prüft sie mit eigenen Artwork-Lagen nur, wenn keine Karte passt
// (siehe TOKEN_ART_BOXES in art-hash.ts).
const TOKEN_LAYOUTS = new Set(['token', 'double_faced_token']);
const SKIP_LAYOUTS = new Set([
  'emblem',
  'art_series',
  'vanguard',
  'scheme',
  'planar',
]);

async function readBulkEntries() {
  const meta = await (
    await fetch('https://api.scryfall.com/bulk-data/unique_artwork', { headers: HEADERS })
  ).json();
  console.log(
    `unique_artwork: Stand ${meta.updated_at}, ${(meta.compressed_size / 1e6).toFixed(1)} MB gepackt.`,
  );
  const res = await fetch(meta.jsonl_download_uri, {
    headers: { 'User-Agent': HEADERS['User-Agent'] },
  });
  if (!res.ok) throw new Error(`Download der Bulk-Datei fehlgeschlagen: HTTP ${res.status}`);
  const lines = readline.createInterface({
    input: Readable.fromWeb(res.body).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  const entries = [];
  for await (const line of lines) {
    const text = line.trim().replace(/,$/, '');
    if (!text || text === '[' || text === ']') continue;
    const card = JSON.parse(text);
    if (SKIP_LAYOUTS.has(card.layout)) continue;
    if (!card.games?.includes('paper')) continue;
    const art = card.image_uris?.art_crop ?? card.card_faces?.[0]?.image_uris?.art_crop;
    if (!art || card.image_status === 'missing' || card.image_status === 'placeholder') continue;
    entries.push({ id: card.id, art, token: TOKEN_LAYOUTS.has(card.layout) });
  }
  return entries;
}

async function readExisting() {
  const map = new Map();
  for (const file of [ART_HASH_FILE, TOKEN_ART_HASH_FILE]) {
    const { data, error } = await supabase.storage.from(BUCKET).download(file);
    if (error || !data) {
      console.log(`Noch keine Datei ${file} - fange dort bei null an.`);
      continue;
    }
    const index = decodeArtHashes(new Uint8Array(await data.arrayBuffer()));
    for (let i = 0; i < index.count; i++) {
      map.set(artHashId(index, i), { hi: index.hashes[i * 2], lo: index.hashes[i * 2 + 1] });
    }
  }
  console.log(`Vorhandene Fingerabdrücke: ${map.size}.`);
  return map;
}

async function hashImage(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const image = jpeg.decode(new Uint8Array(await res.arrayBuffer()), {
        useTArray: true,
        maxMemoryUsageInMB: 256,
      });
      return phash(grayGrid(image.data, image.width, image.height, 4, [0, 0, 1, 1]));
    } catch (e) {
      if (attempt === 3) {
        console.warn(`Übersprungen (${e.message}): ${url}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return null;
}

const entries = await readBulkEntries();
console.log(
  `Artworks in der Bulk-Datei (Papier): ${entries.length}, davon Marken: ${entries.filter((e) => e.token).length}.`,
);
const existing = await readExisting();
const todo = entries.filter((e) => !existing.has(e.id)).slice(0, MAX_NEW);
console.log(`Neu zu rechnen: ${todo.length}.`);

let done = 0;
let next = 0;
const fresh = new Map();
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    while (next < todo.length) {
      const entry = todo[next++];
      const hash = await hashImage(entry.art);
      if (hash) fresh.set(entry.id, hash);
      if (++done % 1000 === 0) console.log(`  ${done}/${todo.length}`);
    }
  }),
);

// Nur behalten, was Scryfall noch als Artwork führt - zurückgezogene Drucke fallen raus.
for (const [file, token] of [
  [ART_HASH_FILE, false],
  [TOKEN_ART_HASH_FILE, true],
]) {
  const out = [];
  for (const e of entries) {
    if (e.token !== token) continue;
    const hash = fresh.get(e.id) ?? existing.get(e.id);
    if (hash) out.push({ id: e.id, hash });
  }
  const data = encodeArtHashes(out);
  const { error } = await supabase.storage.from(BUCKET).upload(file, data, {
    upsert: true,
    contentType: 'application/octet-stream',
    cacheControl: '86400',
  });
  if (error) {
    console.error(`Hochladen von ${file} fehlgeschlagen:`, error);
    process.exit(1);
  }
  console.log(`${file}: ${out.length} Fingerabdrücke, ${(data.byteLength / 1e6).toFixed(2)} MB.`);
}
