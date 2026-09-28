// Erzeugt die Test-Decks der Bracket-Simulation als Forge-Decklisten (.dck).
// Auswahl, Begründungen und Kalibrierung: sim/testdecks/README.md
//
// WOZU: Jedes zu prüfende Deck spielt je 100 Partien gegen drei Test-Decks einer Stufe. Die
// Test-Decks sind damit der Maßstab der ganzen Einstufung - sie stehen deshalb fest im Repo und
// werden nicht bei jedem Lauf neu geladen: Ändert jemand sein Deck in Statsfinity oder auf
// Archidekt, sollen sich nicht stillschweigend alle Ergebnisse verschieben. Dieses Skript ist nur der
// reproduzierbare Weg, auf dem die Dateien entstanden sind (und neu entstehen, wenn die Auswahl
// geändert wird).
//
//   node scripts/forge/testdeck-export.js <forge-res-ordner> [zielordner]   (Standard: sim/testdecks)
//
// Quellen (Statsfinity, Archidekt, EDHTop16) und Übersetzung der Kartennamen: deck-quellen.js
//
// Jede Karte wird gegen Forges Kartenskripte geprüft. Kennt Forge eine Karte nicht, bricht das Skript
// ab - außer die Auswahl unten nennt ausdrücklich einen Ersatz. Stillschweigend fehlende Karten würden
// ein Deck mit 99 Karten spielen lassen und niemand merkte es.

const fs = require('fs');
const path = require('path');
const { QUELLEN, leseForgeNamen, zuForgeDeck } = require('./deck-quellen');

/**
 * Die Auswahl. Reihenfolge und Dateinamen sind stabil - die Simulation zieht je Partie drei davon.
 *
 * ersatz:   Karten, die Forge nicht kennt, und was stattdessen gespielt wird (immer ein Standardland
 *           der Deckfarbe - das schwächt das Deck minimal, verändert aber keinen Siegplan).
 * kuerzen:  Karten, von denen Exemplare entfernt werden, bis das Deck genau 100 Karten hat.
 */
const TESTDECKS = [
  // Bracket 1 hat KEINE Test-Decks (Entscheidung des Users, 28.09.2026): Bracket-1-Decks sind Themen-Decks,
  // die gar nicht auf Sieg gebaut sind - daran lässt sich nichts messen. Bracket 1 ist, was gegen die
  // B2-Test-Decks deutlich zu oft verliert (src/app/forge-einstufung.ts). Die früheren B1-Decks und ihre
  // Kalibrierung stehen in sim/testdecks/README.md.

  // Bracket 2 - unveränderte Precons (Michi)
  {
    stufe: 2,
    datei: 'neyali-rebellion-rising',
    quelle: 'statsfinity',
    id: 'e118b087-73f8-43ee-ae43-56e5a57ab57f',
    plan: 'Tokens, Aggro',
  },
  {
    stufe: 2,
    datei: 'atarka-draconic-destruction',
    quelle: 'statsfinity',
    id: 'd2fce351-30b2-402f-9ec2-accde835e49e',
    plan: 'Drachen, große Kreaturen',
  },
  {
    stufe: 2,
    datei: 'valgavoth-endless-punishment',
    quelle: 'statsfinity',
    id: '635bb2b3-f583-453d-a823-bf610a46d7bb',
    plan: 'Drain, Bestrafung',
  },
  {
    stufe: 2,
    datei: 'szarekh-necron-dynasties',
    quelle: 'statsfinity',
    id: 'c82a5c55-797c-4d87-b32a-2d4ee8eddcab',
    plan: 'Artefakte, Friedhof',
  },

  // Bracket 3 - aufgewertete Decks der Gruppe
  {
    stufe: 3,
    datei: 'ghave-trueffel-time',
    quelle: 'statsfinity',
    id: '85a5d2a5-6e24-4dfe-8435-1b0c49d8952f',
    plan: 'Pilze, Tokens',
  },
  {
    stufe: 3,
    datei: 'sorin-lurrus-inkasso',
    quelle: 'statsfinity',
    id: '15896977-7a79-47cc-9fa3-528304034a8a',
    plan: 'Vampire, Drain',
    kuerzen: ['Plains'],
  },
  {
    stufe: 3,
    datei: 'choco-chocobos',
    quelle: 'statsfinity',
    id: '840cd91a-514e-4341-b443-aafac2f872f8',
    plan: 'Landfall, Vögel',
  },
  {
    stufe: 3,
    datei: 'aesi-moonfall',
    quelle: 'statsfinity',
    id: '9923c84d-6bf7-4950-ac3c-31432ab371f8',
    plan: 'Länder, Ramp',
    kuerzen: ['Forest', 'Island'],
  },

  // Bracket 4 - optimierte Decks der Gruppe
  {
    stufe: 4,
    datei: 'hazezon-azir-in-dune',
    quelle: 'statsfinity',
    id: '9cd527f3-a6e5-4582-99b2-fea5bc3f31de',
    plan: 'Wüsten, Tokens',
  },
  {
    stufe: 4,
    datei: 'marwyn-elf-ramp',
    quelle: 'statsfinity',
    id: '2b207ead-de50-4ffb-b77c-1866d69eaa0f',
    plan: 'Elfen, Ramp',
  },
  {
    stufe: 4,
    datei: 'jodah-f-steht-fuer-freunde',
    quelle: 'statsfinity',
    id: 'f645d9b1-e83d-4a1f-baf8-4a475528d1f9',
    plan: 'Legenden, Kaskade',
  },
  {
    stufe: 4,
    datei: 'muerra-ein-waschbaer',
    quelle: 'statsfinity',
    id: '917db06a-9c7a-4e7a-b613-187abcc398a3',
    plan: 'Artefakte/Verzauberungen, Friedhof',
  },

  // Bracket 5 - Turniersieger 2026 (Platz 1, Liste aus EDHTop16)
  {
    stufe: 5,
    datei: 'witherbloom-breach-the-bay-2',
    quelle: 'edhtop16',
    id: 'breach-the-bay-2',
    plan: 'cEDH',
  },
  {
    stufe: 5,
    datei: 'kinnan-siege-10k',
    quelle: 'edhtop16',
    id: 'level-7s-siege-at-the-castle-10k',
    plan: 'cEDH, Mana-Combo',
  },
  {
    stufe: 5,
    datei: 'thrasios-vial-smasher-fish-bowl',
    quelle: 'edhtop16',
    id: 'the-fishbowl-san-diego-copy-1767729472000',
    plan: 'cEDH, Midrange',
  },
  {
    stufe: 5,
    datei: 'ishai-rograkh-cookout',
    quelle: 'edhtop16',
    id: 'the-cookout-2026',
    plan: 'cEDH, Turbo',
  },
];

const [resDir, zielDir = path.join(__dirname, '..', '..', 'sim', 'testdecks')] =
  process.argv.slice(2);
if (!resDir) {
  console.error('Aufruf: node scripts/forge/testdeck-export.js <forge-res-ordner> [zielordner]');
  process.exit(1);
}

const forgeNamen = leseForgeNamen(resDir);
const uebersicht = [];
let fehler = 0;

for (const t of TESTDECKS) {
  const deck = QUELLEN[t.quelle](t.id);
  const f = zuForgeDeck(deck, forgeNamen, {
    ersatz: t.ersatz,
    kuerzen: t.kuerzen,
    name: t.datei,
    kommentar: `Bracket ${t.stufe} · ${t.plan} · ${deck.name} · ${deck.link}`,
    siegplan: true,
  });
  const probleme = [...f.unbekannt];
  if (!f.commander.length) probleme.push('kein Commander');
  if (f.karten !== 100) probleme.push(`${f.karten} Karten statt 100`);
  if (probleme.length) {
    console.error(`FEHLER B${t.stufe} ${t.datei}: ${probleme.join('; ')}`);
    fehler++;
    continue;
  }
  const ordner = path.join(zielDir, `b${t.stufe}`);
  fs.mkdirSync(ordner, { recursive: true });
  fs.writeFileSync(path.join(ordner, `${t.datei}.dck`), f.dck);
  // Leere Datei statt keiner: So sieht man im Repo, dass das Deck geprüft wurde und keine Sieg-Combo hat.
  fs.writeFileSync(path.join(ordner, `${t.datei}.combos`), f.combos);
  uebersicht.push(
    `B${t.stufe}  ${t.datei.padEnd(32)} ${String(f.siegCombos).padStart(3)} Sieg-Combos  ${f.commander.join(' + ')}`,
  );
}

console.log(uebersicht.join('\n'));
if (fehler) {
  console.error(`\n${fehler} Deck(s) nicht geschrieben.`);
  process.exit(1);
}
