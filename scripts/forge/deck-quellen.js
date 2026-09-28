// Decklisten holen und in Forges Format (.dck) bringen.
// Gemeinsam für testdeck-export.js (die festen Test-Decks) und einstufen.js (das zu prüfende Deck),
// damit beide Karten auf genau dieselbe Weise übersetzen.
//
// Drei Quellen, alle ohne Secret:
//   statsfinity - öffentliche Decks aus der App (Anon-Key, wie der Browser)
//   archidekt   - https://archidekt.com/api/decks/<id>/
//   edhtop16    - Turnier-Siegerlisten über https://edhtop16.com/api/graphql

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SUPABASE_URL = 'https://jkkelwpnrgzbvopszwrl.supabase.co';

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
function leseForgeNamen(resDir) {
  const cardsfolder = path.join(resDir, 'cardsfolder');
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
  // Mit Service-Role-Key (GitHub Action) auch private Decks, sonst wie der Browser nur öffentliche.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || anonKey();
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const [deck] = holeJson(`${SUPABASE_URL}/rest/v1/decks?select=name&id=eq.${id}`, {
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

const QUELLEN = { statsfinity: ausStatsfinity, archidekt: ausArchidekt, edhtop16: ausEdhtop16 };

/**
 * Übersetzt ein geholtes Deck in eine Forge-Deckliste.
 *
 * Kennt Forge eine Karte nicht, landet sie in `unbekannt` - der Aufrufer entscheidet, ob das ein
 * Abbruch ist (Test-Decks) oder ein Hinweis (zu prüfendes Deck). Stillschweigend weglassen wäre das
 * Schlechteste: Das Deck spielte dann mit 99 Karten und niemand merkte es.
 *
 * @param {object} deck      Ergebnis einer Quelle ({ name, commander, main, link })
 * @param {Map} forgeNamen   aus leseForgeNamen()
 * @param {object} [o]
 * @param {Record<string,string>} [o.ersatz]  Karte -> Ersatzkarte (für Karten, die Forge nicht kennt)
 * @param {string[]} [o.kuerzen]              Karten, von denen Exemplare fallen, bis es 100 sind
 * @param {string} o.name                     Name in der .dck (Forge nennt den Spieler danach)
 * @param {string} [o.kommentar]
 * @param {boolean} [o.siegplan]  Combos von Commander Spellbook holen: KeyCards in die .dck, Zeilen für die
 *                                .combos-Datei des Combo-Piloten (siehe siegplan.js)
 */
function zuForgeDeck(
  deck,
  forgeNamen,
  { ersatz = {}, kuerzen = [], name, kommentar = '', siegplan = false },
) {
  const unbekannt = [];
  const uebersetze = (karte) => {
    const roh = bereinige(karte.name);
    const vorne = roh.split(' // ')[0];
    const forgeName = forgeNamen.get(schluessel(ersatz[roh] ?? ersatz[vorne] ?? vorne));
    if (!forgeName) unbekannt.push(roh);
    return { name: forgeName ?? roh, anzahl: karte.anzahl };
  };
  const commander = deck.commander.map(uebersetze);

  // Doppelte Einträge (dieselbe Karte in zwei Kategorien) zusammenfassen; unbekannte fallen raus.
  const main = new Map();
  for (const k of deck.main.map(uebersetze)) {
    if (unbekannt.includes(k.name)) continue;
    main.set(k.name, (main.get(k.name) ?? 0) + k.anzahl);
  }

  let karten = commander.length + [...main.values()].reduce((a, b) => a + b, 0);
  for (const kname of kuerzen) {
    while (karten > 100 && (main.get(kname) ?? 0) > 1) {
      main.set(kname, main.get(kname) - 1);
      karten--;
    }
  }

  // Erst nach der Übersetzung: Spellbook und der Pilot vergleichen mit Forges Kartennamen.
  const plan = siegplan
    ? require('./siegplan').siegplanFuer({
        commander,
        main: [...main.entries()].map(([n, a]) => ({ name: n, anzahl: a })),
      })
    : null;

  const dck = [
    '[metadata]',
    `Name=${name}`,
    ...(kommentar ? [`Comment=${kommentar}`] : []),
    ...(plan?.keyCards.length ? [`KeyCards=${plan.keyCards.join(';')}`] : []),
    '[Commander]',
    ...commander.map((k) => `1 ${k.name}`),
    '[Main]',
    ...[...main.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, a]) => `${a} ${n}`),
    '',
  ].join('\n');
  return {
    dck,
    combos: plan ? plan.zeilen.join('\n') + '\n' : null,
    siegCombos: plan?.combos ?? 0,
    commander: commander.map((k) => k.name),
    karten,
    unbekannt,
  };
}

module.exports = { QUELLEN, leseForgeNamen, zuForgeDeck, holeJson, schluessel, SUPABASE_URL };
