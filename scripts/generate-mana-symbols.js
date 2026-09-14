// Erzeugt src/app/mana-symbols.generated.ts aus Scryfalls /symbology-Endpunkt.
//
//   node scripts/generate-mana-symbols.js
//
// Warum generiert statt von Hand getippt: Es sind 75 Manasymbole, und welches davon hybrid ist,
// welche Farben es hat und wie viel Manawert es beisteuert, ist nichts, was man aus dem Gedächtnis
// aufschreiben sollte - genau da entstehen die Fehler, die niemand mehr findet. Scryfall liefert
// die Tabelle maschinenlesbar, also wird sie maschinenlesbar übernommen.
//
// Die erzeugte Datei ist eingecheckt (anders als src/app/version.ts): Sie ändert sich nur, wenn
// Wizards ein neues Manasymbol druckt, und ohne sie ließe sich das Projekt nicht bauen.
//
// Gegenprobe zur Regelquelle: Die Symbolliste in CR 107.4 (docs/mtg-regeln.md) muss dieselben
// Symbole nennen. Das Skript prüft das nicht - wer die Datei neu erzeugt, sieht im Diff, ob ein
// Symbol dazugekommen ist, und trägt es dort nach.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const QUELLE = 'https://api.scryfall.com/symbology';
const ZIEL = path.join(__dirname, '..', 'src', 'app', 'mana-symbols.generated.ts');
const UA = 'Statsfinity/1.0 (Manasymbol-Tabelle; https://github.com/SazexLucifer1/Statsfinity)';

async function main() {
  const res = await fetch(QUELLE, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${QUELLE}: HTTP ${res.status}`);
  const { data } = await res.json();

  // represents_mana trennt die Manasymbole von den übrigen Symbolen des Endpunkts ({T}, {Q},
  // {E}, {PW}, {CHAOS} ...). Nur die ersten können in Manakosten stehen.
  const symbole = data
    .filter((s) => s.represents_mana === true)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const zeilen = symbole
    .map((s) => {
      const farben = s.colors.map((f) => `'${f}'`).join(', ');
      // {∞} hat bei Scryfall mana_value null - ein Spaßsymbol ohne Zahl. Als 0 übernommen, damit
      // das Feld überall eine Zahl ist; in echten Manakosten steht das Symbol nie.
      const manawert = s.mana_value === null ? 0 : s.mana_value;
      return (
        `  { symbol: '${s.symbol}', manaValue: ${manawert}, colors: [${farben}], ` +
        `hybrid: ${s.hybrid === true}, phyrexian: ${s.phyrexian === true}, ` +
        `english: ${JSON.stringify(s.english)} },`
      );
    })
    .join('\n');

  const inhalt = `// ERZEUGT von scripts/generate-mana-symbols.js - nicht von Hand ändern.
//
// Quelle: ${QUELLE} (abgerufen am ${new Date().toISOString().slice(0, 10)}),
// gefiltert auf represents_mana === true. Die Bedeutung der Felder steht in mana-symbols.ts,
// die Regelgrundlage in docs/mtg-regeln.md (CR 107.4).

import type { ScryfallManaSymbol } from './mana-symbols';

export const SCRYFALL_MANA_SYMBOLS: readonly ScryfallManaSymbol[] = [
${zeilen}
];
`;

  fs.writeFileSync(ZIEL, inhalt);

  // Durch Prettier schicken, damit ein Neu-Erzeugen den Baum nicht formatierungshalber schmutzig
  // macht - die Datei ist eingecheckt und soll sich nur ändern, wenn Scryfall etwas anderes liefert.
  execFileSync('npx', ['prettier', '--write', ZIEL], { stdio: 'inherit' });

  console.log(
    `${symbole.length} Manasymbole nach ${path.relative(process.cwd(), ZIEL)} geschrieben.`,
  );
}

main().catch((fehler) => {
  console.error('Manasymbol-Tabelle fehlgeschlagen:', fehler);
  process.exit(1);
});
