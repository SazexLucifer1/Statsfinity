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
// Drei Quellen, alle ohne Secret:
//   statsfinity - öffentliche Decks aus der App (Anon-Key, wie der Browser)
//   archidekt   - https://archidekt.com/api/decks/<id>/
//   edhtop16    - Turnier-Siegerlisten über https://edhtop16.com/api/graphql
//
// Jede Karte wird gegen Forges Kartenskripte geprüft. Kennt Forge eine Karte nicht, bricht das Skript
// ab - außer die Auswahl unten nennt ausdrücklich einen Ersatz. Stillschweigend fehlende Karten würden
// ein Deck mit 99 Karten spielen lassen und niemand merkte es.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SUPABASE_URL = 'https://jkkelwpnrgzbvopszwrl.supabase.co';

/**
 * Die Auswahl. Reihenfolge und Dateinamen sind stabil - die Simulation zieht je Partie drei davon.
 *
 * ersatz:   Karten, die Forge nicht kennt, und was stattdessen gespielt wird (immer ein Standardland
 *           der Deckfarbe - das schwächt das Deck minimal, verändert aber keinen Siegplan).
 * kuerzen:  Karten, von denen Exemplare entfernt werden, bis das Deck genau 100 Karten hat.
 */
const TESTDECKS = [
  // Bracket 1 - Archidekt, deren Primer ausdrücklich begründet, warum das Deck Bracket 1 ist.
  {
    stufe: 1,
    datei: 'parnesse-bazaar',
    quelle: 'archidekt',
    id: 25085549,
    plan: 'Exhibition, Gruppenspaß',
  },
  {
    stufe: 1,
    datei: 'ardbert-oops-all-orzhov',
    quelle: 'archidekt',
    id: 13186988,
    plan: 'legendäre Kreaturen, Midrange',
    ersatz: { "Wernog, Rider's Chaplain": 'Plains' },
  },
  {
    stufe: 1,
    datei: 'vhal-cosmic-horror',
    quelle: 'archidekt',
    id: 11556047,
    plan: 'Diebstahl, Themen-Deck',
    ersatz: { 'Arvinox, the Mind Flail': 'Swamp' },
  },
  {
    stufe: 1,
    datei: 'ramos-lucky-charms',
    quelle: 'archidekt',
    id: 22519265,
    plan: 'Fünffarbig, Zaubersprüche',
    ersatz: { 'Far Out': 'Plains' },
  },

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
    datei: 'ivy-x-creatures',
    quelle: 'statsfinity',
    id: '26957e47-420b-4051-800d-3bea60e63253',
    plan: 'Spellslinger, Value',
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
    datei: 'celestial-toymaker',
    quelle: 'statsfinity',
    id: 'beb6e950-9085-4e3c-bb22-2d900f98948e',
    plan: 'Chaos, Control',
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
    datei: 'thrasios-tymna-land-go-open',
    quelle: 'edhtop16',
    id: 'land-go-open-10k-cedh-tournament',
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

// curl statt fetch: Node's fetch ignoriert HTTPS_PROXY, curl nicht - so läuft dasselbe Skript im
// Container hinter dem Proxy und in einer GitHub Action.
function holeJson(url, { method = 'GET', body = null, headers = {} } = {}) {
  const args = ['-sS', '--fail-with-body', '-X', method, url];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  return JSON.parse(
    execFileSync('curl', args, { input: body ?? undefined, maxBuffer: 64 << 20 }).toString(),
  );
}

function anonKey() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'app', 'supabase.client.ts'),
    'utf8',
  );
  return /'(eyJ[^']+)'/.exec(src)[1];
}

const schluessel = (name) =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Forges Kartennamen: Schlüssel der Vorderseite -> Name, wie Forge ihn in einer Deckliste erwartet. */
function leseForgeNamen(cardsfolder) {
  const namen = new Map();
  for (const buchstabe of fs.readdirSync(cardsfolder)) {
    const ordner = path.join(cardsfolder, buchstabe);
    if (!fs.statSync(ordner).isDirectory()) continue;
    for (const datei of fs.readdirSync(ordner)) {
      const text = fs.readFileSync(path.join(ordner, datei), 'utf8');
      const alle = [...text.matchAll(/^Name:(.+)$/gm)].map((m) => m[1].trim());
      if (!alle.length) continue;
      // Split-Karten (Fire // Ice) stehen in Forge unter beiden Hälften, alles andere unter der Vorderseite.
      const split = /^AlternateMode:Split\b/m.test(text) && alle.length > 1;
      namen.set(schluessel(alle[0]), split ? `${alle[0]} // ${alle[1]}` : alle[0]);
    }
  }
  return namen;
}

/**
 * Kartennamen aus der App tragen manchmal die Edition mit ("Skullclamp (PLIST) C17-222") - das
 * entsteht beim Import aus Moxfield-Textlisten. Für Forge zählt nur der Name.
 */
const bereinige = (name) => name.replace(/\s+\([A-Z0-9]{2,6}\)(\s+\S+)?\s*$/, '').trim();

function ausStatsfinity(id) {
  const key = anonKey();
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const [deck] = holeJson(`${SUPABASE_URL}/rest/v1/decks?select=name,is_private&id=eq.${id}`, {
    headers: h,
  });
  if (!deck) throw new Error(`Statsfinity-Deck ${id} nicht gefunden (privat oder gelöscht?)`);
  const karten = holeJson(
    `${SUPABASE_URL}/rest/v1/deck_cards?select=card_name,quantity,is_commander,is_maybeboard,is_token&deck_id=eq.${id}`,
    { headers: h },
  ).filter((k) => !k.is_maybeboard && !k.is_token);
  return {
    name: deck.name,
    commander: karten.filter((k) => k.is_commander).map((k) => ({ name: k.card_name, anzahl: 1 })),
    main: karten
      .filter((k) => !k.is_commander)
      .map((k) => ({ name: k.card_name, anzahl: k.quantity })),
    link: `https://statsfinity.pages.dev/?deck=${id}`,
  };
}

function ausArchidekt(id) {
  const d = holeJson(`https://archidekt.com/api/decks/${id}/`);
  // Kategorien, die Archidekt selbst nicht zum Deck zählt (Maybeboard, Sideboard, Alternativen) -
  // mit Ausnahme der Commander-Kategorie, die manche Nutzer ebenfalls so markiert haben.
  const aussen = new Set(
    d.categories
      .filter((c) => c.includedInDeck === false && c.name !== 'Commander')
      .map((c) => c.name),
  );
  const commander = [];
  const main = [];
  for (const k of d.cards) {
    const kats = k.categories ?? [];
    if (kats.some((c) => aussen.has(c))) continue;
    const eintrag = { name: k.card.oracleCard.name, anzahl: k.quantity };
    (kats.includes('Commander') ? commander : main).push(eintrag);
  }
  return { name: d.name, commander, main, link: `https://archidekt.com/decks/${id}` };
}

function ausEdhtop16(tid) {
  const query = `{ tournament(TID: "${tid}") { name size tournamentDate entries(maxStanding: 1) { decklist commander { name } player { name } maindeck { name } } } }`;
  const t = holeJson('https://edhtop16.com/api/graphql', {
    method: 'POST',
    body: JSON.stringify({ query }),
  }).data.tournament;
  const e = t.entries[0];
  return {
    name: `${e.commander.name} – ${t.name.trim()} (Platz 1, ${e.player.name})`,
    commander: e.commander.name.split(' / ').map((n) => ({ name: n, anzahl: 1 })),
    main: e.maindeck.map((k) => ({ name: k.name, anzahl: 1 })),
    link: e.decklist,
  };
}

const forge = leseForgeNamen(path.join(resDir, 'cardsfolder'));
const QUELLEN = { statsfinity: ausStatsfinity, archidekt: ausArchidekt, edhtop16: ausEdhtop16 };
const uebersicht = [];
let fehler = 0;

for (const t of TESTDECKS) {
  const deck = QUELLEN[t.quelle](t.id);
  const probleme = [];

  const uebersetze = (karte) => {
    const roh = bereinige(karte.name);
    const vorne = roh.split(' // ')[0];
    const ersatz = t.ersatz?.[roh] ?? t.ersatz?.[vorne];
    const forgeName = forge.get(schluessel(ersatz ?? vorne));
    if (!forgeName) probleme.push(roh);
    return { name: forgeName ?? roh, anzahl: karte.anzahl };
  };
  const commander = deck.commander.map(uebersetze);
  const main = deck.main.map(uebersetze);

  // Doppelte Einträge (dieselbe Karte in zwei Kategorien) zusammenfassen.
  const zusammen = new Map();
  for (const k of main) zusammen.set(k.name, (zusammen.get(k.name) ?? 0) + k.anzahl);

  let gesamt = commander.length + [...zusammen.values()].reduce((a, b) => a + b, 0);
  for (const name of t.kuerzen ?? []) {
    while (gesamt > 100 && (zusammen.get(name) ?? 0) > 1) {
      zusammen.set(name, zusammen.get(name) - 1);
      gesamt--;
    }
  }
  if (!commander.length) probleme.push('kein Commander');
  if (gesamt !== 100) probleme.push(`${gesamt} Karten statt 100`);

  if (probleme.length) {
    console.error(`FEHLER B${t.stufe} ${t.datei}: ${probleme.join('; ')}`);
    fehler++;
    continue;
  }

  const dck = [
    '[metadata]',
    `Name=${t.datei}`,
    `Comment=Bracket ${t.stufe} · ${t.plan} · ${deck.name} · ${deck.link}`,
    '[Commander]',
    ...commander.map((k) => `1 ${k.name}`),
    '[Main]',
    ...[...zusammen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, a]) => `${a} ${n}`),
    '',
  ].join('\n');
  const ordner = path.join(zielDir, `b${t.stufe}`);
  fs.mkdirSync(ordner, { recursive: true });
  fs.writeFileSync(path.join(ordner, `${t.datei}.dck`), dck);
  uebersicht.push(`B${t.stufe}  ${t.datei.padEnd(32)} ${commander.map((k) => k.name).join(' + ')}`);
}

console.log(uebersicht.join('\n'));
if (fehler) {
  console.error(`\n${fehler} Deck(s) nicht geschrieben.`);
  process.exit(1);
}
