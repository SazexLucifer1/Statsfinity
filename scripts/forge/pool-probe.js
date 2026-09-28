// Forge-Probe am Archidekt-Vorrat: Trennt Forge die Brackets überhaupt?
//
// WOZU: Die Kalibrierung (calibrate.js, sim/testdecks/README.md) hat gezeigt, dass unsere Test-Decks die
// Stufen nicht trennen. Offen ist, ob das an den Test-Decks liegt oder an Forge selbst. Die Decks in
// archidekt_deck_pool tragen eine Stufe, die ihr Ersteller angegeben hat - ein unabhängiger Maßstab. Je Stufe
// spielt eine Stichprobe davon gegen dieselben festen Gegner; steigt die Winrate mit der Stufe, misst Forge
// etwas. Ausgewertet über die AUC (0,5 = trennt nicht), wie deck_sim_auc() für die Goldfish-Simulation.
//
//   spielen:   node scripts/forge/pool-probe.js <forge-checkout> --bracket 3
//                [--decks 20] [--spiele 20] [--gegner 4] [--parallel 3] [--zeitlimit 900]
//                [--ids 123,456]   (statt der Auswahl aus der Datenbank, z. B. ohne Service-Key)
//                [--teil 0/2]      (spielt nur jedes zweite ausgewählte Deck - zwei Runner je Stufe)
//                [--aus teil-b3.json]
//   auswerten: node scripts/forge/pool-probe.js --auswerten teil-b1.json teil-b2.json …
//
// "spielen" braucht SUPABASE_SERVICE_ROLE_KEY (der Vorrat ist nur für Developer lesbar), außer mit --ids.
// Stand nach jeder Partie in der Ausgabedatei; ein zweiter Aufruf mit derselben Datei spielt nur, was fehlt.
// Workflow: .github/workflows/forge-pool-probe.yml

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spielePartie, parallel } = require('./forge-partie');
const { QUELLEN, leseForgeNamen, zuForgeDeck, holeJson, SUPABASE_URL } = require('./deck-quellen');

const argv = process.argv.slice(2);
const opt = (name, std) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : std;
};
const TESTDECKS = path.join(__dirname, '..', '..', 'sim', 'testdecks');

/** Mann-Whitney-AUC: Anteil der Paare (a aus oben, b aus unten) mit a > b, Gleichstand halb. */
function auc(unten, oben) {
  if (!unten.length || !oben.length) return null;
  let summe = 0;
  for (const a of oben) for (const b of unten) summe += a > b ? 1 : a === b ? 0.5 : 0;
  return summe / (unten.length * oben.length);
}

// ---------------------------------------------------------------- auswerten
if (argv[0] === '--auswerten') {
  const decks = argv
    .slice(1)
    .filter((f) => fs.existsSync(f))
    .flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')).decks ?? []);
  console.log(bericht(decks));
  process.exit(0);
}

function bericht(decks) {
  const mitSpielen = decks
    .map((d) => {
      const gueltig = d.partien.filter((p) => !p.fehler);
      const siege = gueltig.filter((p) => p.gewonnen).length;
      return {
        ...d,
        spiele: gueltig.length,
        siege,
        combo: gueltig.filter((p) => p.gewonnen && p.comboSieg).length,
        rate: gueltig.length ? siege / gueltig.length : null,
      };
    })
    .filter((d) => d.spiele > 0);
  const raten = (b) => mitSpielen.filter((d) => d.bracket === b).map((d) => d.rate);
  const pct = (x) => (x == null ? '–' : `${Math.round(100 * x)} %`);
  const zahl = (x) => (x == null ? '–' : x.toFixed(3).replace('.', ','));

  const z = [
    '### Winrate je angegebener Stufe (gegen drei Test-Decks, fair 25 %)',
    '',
    '| Stufe | Decks | Partien | Siege | davon Combo | Winrate | Median je Deck |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (let b = 1; b <= 5; b++) {
    const teil = mitSpielen.filter((d) => d.bracket === b);
    if (!teil.length) continue;
    const spiele = teil.reduce((s, d) => s + d.spiele, 0);
    const siege = teil.reduce((s, d) => s + d.siege, 0);
    const combo = teil.reduce((s, d) => s + d.combo, 0);
    const sortiert = teil.map((d) => d.rate).sort((a, b2) => a - b2);
    const median = sortiert[Math.floor(sortiert.length / 2)];
    z.push(
      `| ${b} | ${teil.length} | ${spiele} | ${siege} | ${combo} | ${pct(siege / spiele)} | ${pct(median)} |`,
    );
  }
  z.push(
    '',
    '### Trennschärfe (AUC der Deck-Winraten, 0,5 = trennt nicht, 1 = trennt perfekt)',
    '',
    '| Vergleich | AUC |',
    '| --- | ---: |',
  );
  for (const [u, o] of [
    [[1], [2]],
    [[2], [3]],
    [[3], [4]],
    [[4], [5]],
    [
      [1, 2],
      [4, 5],
    ],
  ]) {
    const wert = auc(u.flatMap(raten), o.flatMap(raten));
    z.push(`| ${u.join('–')} gegen ${o.join('–')} | ${zahl(wert)} |`);
  }
  z.push(
    '',
    '### Decks',
    '',
    '| Stufe | Deck | Commander | Partien | Siege | Winrate |',
    '| ---: | --- | --- | ---: | ---: | ---: |',
  );
  for (const d of [...mitSpielen].sort((a, b) => a.bracket - b.bracket || b.rate - a.rate)) {
    const name = d.name.replace(/\|/g, '/');
    z.push(
      `| ${d.bracket} | [${name}](${d.link}) | ${d.commander.join(' + ')} | ${d.spiele} | ${d.siege} | ${pct(d.rate)} |`,
    );
  }
  return z.join('\n');
}

// ---------------------------------------------------------------- spielen
const forgeDir = argv[0];
const BRACKET = Number(opt('bracket', 0));
if (!forgeDir || forgeDir.startsWith('--') || !(BRACKET >= 1 && BRACKET <= 5)) {
  console.error('Aufruf: node scripts/forge/pool-probe.js <forge-checkout> --bracket 1..5');
  process.exit(1);
}
const DECKS = Number(opt('decks', 20));
const SPIELE = Number(opt('spiele', 20));
const GEGNER = Number(opt('gegner', 4));
const PARALLEL = Number(opt('parallel', 3));
const ZEITLIMIT = Number(opt('zeitlimit', 900));
const AUS = opt('aus', `teil-b${BRACKET}.json`);
// Eine Partie dauert bis zu vier Minuten; 400 Partien auf einem Runner kämen an GitHubs 6-Stunden-Grenze.
// Deshalb teilen sich mehrere Runner eine Stufe: Alle wählen dieselben Decks, jeder spielt seinen Anteil.
const [TEIL, TEILE] = opt('teil', '0/1').split('/').map(Number);

const stand = fs.existsSync(AUS)
  ? JSON.parse(fs.readFileSync(AUS, 'utf8'))
  : { bracket: BRACKET, gegner: GEGNER, decks: [], verworfen: [] };

const arbeit = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pool-'));
const forgeNamen = leseForgeNamen(path.join(forgeDir, 'forge-gui', 'res'));

// Gegner: die Test-Decks einer Stufe (Standard B4 - innen ausgeglichen, siehe sim/testdecks/README.md).
const gegner = fs
  .readdirSync(path.join(TESTDECKS, `b${GEGNER}`))
  .filter((f) => f.endsWith('.dck'))
  .sort()
  .map((f) => {
    fs.copyFileSync(path.join(TESTDECKS, `b${GEGNER}`, f), path.join(arbeit, `b${GEGNER}-${f}`));
    const combos = path.join(TESTDECKS, `b${GEGNER}`, f.replace(/\.dck$/, '.combos'));
    if (fs.existsSync(combos)) fs.copyFileSync(combos, path.join(arbeit, path.basename(combos)));
    return `b${GEGNER}-${f}`;
  });

/** Kandidaten aus dem Vorrat, fest gemischt: derselbe Aufruf zieht dieselben Decks. */
function kandidaten() {
  if (opt('ids')) return opt('ids').split(',').map(Number);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('SUPABASE_SERVICE_ROLE_KEY fehlt - ohne ihn nur mit --ids <archidekt-ids>.');
    process.exit(1);
  }
  const ids = [];
  for (let seite = 0; ; seite++) {
    const zeilen = holeJson(
      `${SUPABASE_URL}/rest/v1/archidekt_deck_pool?select=archidekt_id` +
        `&creator_bracket=eq.${BRACKET}&legal=is.true&order=archidekt_id&limit=1000&offset=${seite * 1000}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    ids.push(...zeilen.map((z) => z.archidekt_id));
    if (zeilen.length < 1000) break;
  }
  let zustand = 20260928 + BRACKET;
  const zufall = () => (zustand = (zustand * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(zufall() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  console.log(`${ids.length} legale Decks mit Stufe ${BRACKET} im Vorrat.`);
  return ids;
}

/** Holt ein Archidekt-Deck und prüft, ob Forge es vollständig spielen kann. null = verworfen (mit Grund). */
function vorbereiten(id) {
  const datei = `pool-${id}.dck`;
  try {
    const quelle = QUELLEN.archidekt(id);
    // Erst ohne Siegplan prüfen - Spellbook nur für Decks fragen, die auch gespielt werden.
    const probe = zuForgeDeck(quelle, forgeNamen, { name: `pool-${id}` });
    const grund = probe.unbekannt.length
      ? `Forge kennt nicht: ${probe.unbekannt.join(', ')}`
      : !probe.commander.length
        ? 'kein Commander'
        : probe.karten !== 100
          ? `${probe.karten} Karten`
          : null;
    if (grund) return { id, grund };
    const f = zuForgeDeck(quelle, forgeNamen, { name: `pool-${id}`, siegplan: true });
    fs.writeFileSync(path.join(arbeit, datei), f.dck);
    fs.writeFileSync(path.join(arbeit, `pool-${id}.combos`), f.combos);
    return {
      deck: {
        id,
        bracket: BRACKET,
        name: quelle.name,
        link: quelle.link,
        commander: f.commander,
        siegCombos: f.siegCombos,
        partien: [],
      },
    };
  } catch (e) {
    return { id, grund: `Abruf fehlgeschlagen: ${e.message.split('\n')[0]}` };
  }
}

// Schon ausgewählte Decks (fortgesetzter Lauf) wieder vorbereiten, dann auffüllen bis DECKS.
for (const d of stand.decks) {
  const r = vorbereiten(d.id);
  if (!r.deck) console.warn(`Deck ${d.id} lässt sich nicht mehr vorbereiten: ${r.grund}`);
}
const gesehen = new Set([...stand.decks.map((d) => d.id), ...stand.verworfen.map((v) => v.id)]);
if (stand.decks.length < DECKS) {
  for (const id of kandidaten()) {
    if (stand.decks.length >= DECKS) break;
    if (gesehen.has(id)) continue;
    const r = vorbereiten(id);
    if (r.deck) {
      stand.decks.push(r.deck);
      console.log(
        `+ ${r.deck.name} (${r.deck.commander.join(' + ')}, ${r.deck.siegCombos} Sieg-Combos)`,
      );
    } else {
      stand.verworfen.push(r);
      console.log(`- ${id}: ${r.grund}`);
    }
    fs.writeFileSync(AUS, JSON.stringify(stand, null, 1));
  }
}
console.log(`${stand.decks.length} Decks, ${stand.verworfen.length} verworfen.`);

// Feste, ausgeglichene Aufstellung wie in einstufen.js: Dreiergruppen der Gegner reihum, Platz rotiert.
const gruppen = gegner.map((_, weg) => gegner.filter((__, k) => k !== weg));
const offen = [];
for (const [index, d] of stand.decks.entries()) {
  if (index % TEILE !== TEIL) continue;
  const schon = new Set(d.partien.map((p) => p.nr));
  for (let nr = 0; nr < SPIELE; nr++) {
    if (schon.has(nr)) continue;
    const platz = nr % 4;
    const sitz = [...gruppen[Math.floor(nr / 4) % gruppen.length]];
    sitz.splice(platz, 0, `pool-${d.id}.dck`);
    offen.push({ deck: d, nr, sitz, platz });
  }
}
console.log(`${offen.length} Partien offen, ${PARALLEL} parallel.`);

let fertig = 0;
let fehlerAmAnfang = 0;
parallel(
  offen.map(
    (p) => () =>
      spielePartie({
        forgeDir,
        deckDir: arbeit,
        decks: p.sitz,
        zeitlimit: ZEITLIMIT,
        seed: (p.deck.id % 100000) + p.nr,
      }),
  ),
  PARALLEL,
  (i, r) => {
    const p = offen[i];
    p.deck.partien.push({
      nr: p.nr,
      platz: p.platz,
      gewonnen: r.siegerPlatz === p.platz,
      comboSieg: r.siegerPlatz === p.platz && r.comboSieg,
      sieger: r.siegerPlatz == null ? null : p.sitz[r.siegerPlatz],
      remis: r.remis,
      runde: r.runde,
      dauerS: Math.round(r.dauerMs / 1000),
      fehler: r.fehler,
    });
    fs.writeFileSync(AUS, JSON.stringify(stand, null, 1));
    fehlerAmAnfang = fertig < 3 && r.fehler ? fehlerAmAnfang + 1 : fehlerAmAnfang;
    if (fertig === 2 && fehlerAmAnfang === 3) {
      console.error(`Abbruch, die ersten drei Partien sind gescheitert: ${r.fehler}`);
      process.exit(1);
    }
    fertig++;
    const ergebnis = r.fehler
      ? `FEHLER ${r.fehler}`
      : r.siegerPlatz === p.platz
        ? 'SIEG'
        : r.remis
          ? 'Remis'
          : 'verloren';
    console.log(
      `[${fertig}/${offen.length}] ${p.deck.name}: ${ergebnis} (Runde ${r.runde ?? '?'}, ${Math.round(r.dauerMs / 1000)}s)`,
    );
  },
).then(() => {
  console.log('\n' + bericht(stand.decks));
  fs.rmSync(arbeit, { recursive: true, force: true });
});
