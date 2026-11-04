/**
 * Lädt die Scan-Proben des Kartenscanners (src/app/scan-sample.service.ts) in einen Ordner:
 * je Probe das Kamerabild, falls vorhanden die Ecke in voller Auflösung, und eine samples.json mit
 * Ergebnis, Zwischenwerten und Korrektur. Für Messungen am Scanner gegen echte Fälle.
 *
 *   node scripts/scan-proben-laden.mjs <zielordner> [--seit=2026-11-04]
 *
 * Braucht keinen Schlüssel außer dem eingecheckten Anon-Key: Das Verzeichnis ist lesbar, die
 * Bilder über ihre Adresse (sql/scan-proben-2026-11-04.sql). Schon geladene Bilder werden
 * übersprungen.
 *
 * Als "richtige Antwort" gilt result, überschrieben von correction (andere Sprache/Foil);
 * correction.removed = der Treffer war falsch, die richtige Karte ist dann unbekannt.
 */
import fs from 'node:fs';
import path from 'node:path';

const client = fs.readFileSync(new URL('../src/app/supabase.client.ts', import.meta.url), 'utf8');
const url = /https:\/\/[a-z0-9]+\.supabase\.co/.exec(client)?.[0];
const key = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(client)?.[0];
if (!url || !key)
  throw new Error('Supabase-Adresse oder Anon-Key nicht in supabase.client.ts gefunden');

const target = process.argv[2];
if (!target) throw new Error('Zielordner fehlt: node scripts/scan-proben-laden.mjs <ordner>');
const since = process.argv.find((a) => a.startsWith('--seit='))?.slice(7);
fs.mkdirSync(target, { recursive: true });

const headers = { apikey: key, Authorization: `Bearer ${key}` };
const rows = [];
for (let from = 0; ; from += 1000) {
  const query = new URLSearchParams({ select: '*', order: 'created_at.asc' });
  if (since) query.set('created_at', `gte.${since}`);
  const res = await fetch(`${url}/rest/v1/scan_samples?${query}`, {
    headers: { ...headers, Range: `${from}-${from + 999}` },
  });
  if (!res.ok) throw new Error(`Verzeichnis: HTTP ${res.status} ${await res.text()}`);
  const page = await res.json();
  rows.push(...page);
  if (page.length < 1000) break;
}

let loaded = 0;
for (const row of rows) {
  for (const p of [row.image_path, row.corner_path].filter(Boolean)) {
    const file = path.join(target, p.replace(/\//g, '_'));
    if (fs.existsSync(file)) continue;
    const res = await fetch(`${url}/storage/v1/object/public/scan-samples/${p}`);
    if (!res.ok) {
      console.warn(`Bild fehlt: ${p} (HTTP ${res.status})`);
      continue;
    }
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    loaded++;
  }
}
fs.writeFileSync(path.join(target, 'samples.json'), JSON.stringify(rows, null, 1));
console.log(`${rows.length} Proben, ${loaded} Bilder neu geladen -> ${target}`);
