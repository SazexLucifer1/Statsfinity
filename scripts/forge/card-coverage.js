// Abdeckungsbericht: Welche Commander-legalen Karten kennt Forge, und welche davon kann der
// Forge-Bot nicht sinnvoll spielen?
// Plan und Begründung: scripts/forge/README.md
//
// WOZU: Die Bracket-Simulation spielt mit der Regel-Engine von Forge (Open Source, Java). Forge hat
// fast jede Karte als Skript, aber eben nur fast. Zwei Lücken zählen:
//   fehlt     - Forge kennt die Karte gar nicht. Ein Deck mit dieser Karte lässt sich nicht laden.
//   bot-nein  - Forge kennt die Karte, markiert sie aber mit "AI:RemoveDeck:All": Die Regeln sind
//               umgesetzt, der Bot weiß aber nicht, wann er sie sinnvoll spielt. Im Spiel liegt sie
//               dann meist tot auf der Hand.
// Diese Liste ist die Grundlage für die Absprache "welche Karten müssen wir selbst lösen".
//
// Aufruf (kein Supabase, kein Secret - beide Quellen sind Dateien):
//
//   node scripts/forge/card-coverage.js <forge-res-ordner> <scryfall-oracle-cards.jsonl[.gz]> [ausgabe.md]
//
// forge-res-ordner: das Verzeichnis "res" einer Forge-Installation (enthält "cardsfolder").
// Die Scryfall-Datei ist der Bulk-Export "oracle_cards" (https://api.scryfall.com/bulk-data).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [resDir, scryfallFile, ausgabe] = process.argv.slice(2);
if (!resDir || !scryfallFile) {
  console.error(
    'Aufruf: node scripts/forge/card-coverage.js <forge-res> <oracle-cards.jsonl[.gz]> [ausgabe.md]',
  );
  process.exit(1);
}

/** Schreibweise-unabhängiger Schlüssel: ohne Akzente, klein, ohne Mehrfach-Leerzeichen. */
function schluessel(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Liest alle Kartenskripte. Ein Skript kann mehrere Seiten haben (getrennt durch "ALTERNATE");
 * gezählt wird die Vorderseite, denn nur unter ihrem Namen steht die Karte in einer Deckliste.
 * Die Bot-Markierung gilt für die ganze Karte, sobald sie auf irgendeiner Seite steht.
 */
function leseForge(cardsfolder) {
  const karten = new Map();
  for (const buchstabe of fs.readdirSync(cardsfolder)) {
    const ordner = path.join(cardsfolder, buchstabe);
    if (!fs.statSync(ordner).isDirectory()) continue;
    for (const datei of fs.readdirSync(ordner)) {
      if (!datei.endsWith('.txt')) continue;
      const text = fs.readFileSync(path.join(ordner, datei), 'utf8');
      const name = /^Name:(.+)$/m.exec(text)?.[1]?.trim();
      if (!name) continue;
      karten.set(schluessel(name), {
        name,
        botNein: /^AI:RemoveDeck:All\b/m.test(text),
      });
    }
  }
  return karten;
}

function leseScryfall(datei) {
  let roh = fs.readFileSync(datei);
  if (roh[0] === 0x1f && roh[1] === 0x8b) roh = zlib.gunzipSync(roh);
  const text = roh.toString('utf8').trim();
  const zeilen = text.startsWith('[')
    ? JSON.parse(text)
    : text.split('\n').map((z) => JSON.parse(z));
  return zeilen.filter((k) => k.legalities?.commander === 'legal');
}

const forge = leseForge(path.join(resDir, 'cardsfolder'));
const legal = leseScryfall(scryfallFile);

const fehlt = [];
const botNein = [];
for (const karte of legal) {
  const vorne = karte.card_faces?.[0]?.name ?? karte.name;
  const eintrag = forge.get(schluessel(vorne)) ?? forge.get(schluessel(karte.name));
  const zeile = {
    name: karte.name,
    typ: karte.type_line ?? karte.card_faces?.[0]?.type_line ?? '',
    set: karte.set?.toUpperCase() ?? '',
    gameChanger: karte.game_changer === true,
    edhrecRang: karte.edhrec_rank ?? null,
  };
  if (!eintrag) fehlt.push(zeile);
  else if (eintrag.botNein) botNein.push(zeile);
}

// Nach Beliebtheit sortiert: Eine Lücke bei einer Karte, die in jedem dritten Deck steckt, zählt mehr
// als eine bei einer Karte, die niemand spielt.
const nachRang = (a, b) => (a.edhrecRang ?? 1e9) - (b.edhrecRang ?? 1e9);
fehlt.sort(nachRang);
botNein.sort(nachRang);

const prozent = (n) => ((100 * n) / legal.length).toFixed(2).replace('.', ',');
const tabelle = (liste) =>
  [
    '| # | Karte | Typ | EDHREC-Rang | Game Changer |',
    '| - | ----- | --- | ----------- | ------------ |',
    ...liste.map(
      (k, i) =>
        `| ${i + 1} | ${k.name} | ${k.typ} | ${k.edhrecRang ?? '–'} | ${k.gameChanger ? 'ja' : ''} |`,
    ),
  ].join('\n');

const bericht = [
  '# Forge-Kartenabdeckung (Commander-legal)',
  '',
  `Stand Scryfall: ${path.basename(scryfallFile)} · Forge-Kartenskripte: ${forge.size}`,
  '',
  `- Commander-legale Karten: **${legal.length}**`,
  `- Forge kennt sie nicht: **${fehlt.length}** (${prozent(fehlt.length)} %)`,
  `- Forge kennt sie, der Bot spielt sie nicht („AI:RemoveDeck:All“): **${botNein.length}** (${prozent(botNein.length)} %)`,
  `- Voll spielbar: **${legal.length - fehlt.length - botNein.length}** (${prozent(legal.length - fehlt.length - botNein.length)} %)`,
  '',
  'Beide Listen sind nach EDHREC-Rang sortiert – oben stehen die Karten, die am häufigsten gespielt werden.',
  '',
  `## Fehlen in Forge (${fehlt.length})`,
  '',
  tabelle(fehlt),
  '',
  `## Bot spielt sie nicht (${botNein.length})`,
  '',
  tabelle(botNein),
  '',
].join('\n');

if (ausgabe) {
  fs.writeFileSync(ausgabe, bericht);
  console.log(`Bericht geschrieben: ${ausgabe}`);
}
console.log(bericht.split('\n').slice(0, 10).join('\n'));
