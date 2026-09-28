// Stuft ein Deck ein: je Stufe N Partien in 4er-Pods gegen drei Test-Decks dieser Stufe (Forge,
// Bot gegen Bot), danach Einstufung über src/app/forge-einstufung.ts.
// Test-Decks und Kalibrierung: sim/testdecks/README.md
//
// Zwei Betriebsarten, damit eine GitHub Action die fünf Stufen auf fünf Runner verteilen kann:
//
//   spielen:     node scripts/forge/einstufen.js <forge-checkout> --deck <statsfinity-deck-id>
//                  [--stufen 1,2,3,4,5] [--spiele 100] [--parallel 2] [--zeitlimit 900] [--aus datei.json]
//                (statt --deck auch --archidekt <id> oder --dck <datei>)
//   auswerten:   node scripts/forge/einstufen.js --auswerten teil1.json teil2.json … [--regel-minimum 3]
//                  [--speichern <statsfinity-deck-id>]   (schreibt nach forge_einstufungen, braucht
//                  SUPABASE_SERVICE_ROLE_KEY; ohne --regel-minimum gilt decks.bracket_auto)
//                  [--auftrag <id>]   (schließt den Auftrag aus der App-Warteschlange ab)
//
// "spielen" schreibt nach jeder Partie den Stand in die Ausgabedatei; ein zweiter Aufruf mit derselben
// Datei spielt nur die fehlenden Partien. Am Ende (bzw. bei "auswerten") steht die Einstufung auf der
// Konsole und als Feld "einstufung" in der Datei.

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

/** forge-einstufung.ts ist TypeScript im App-Code; esbuild bündelt es zur Laufzeit (wie simulate-deck-pool.js). */
function ladeEinstufung() {
  const esbuild = require('esbuild');
  const ziel = path.join(os.tmpdir(), `statsfinity-einstufung-${process.pid}.cjs`);
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', '..', 'src', 'app', 'forge-einstufung.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: ziel,
    logLevel: 'error',
  });
  return require(ziel);
}

/** Fasst die Partien je Stufe zusammen - das, was forge-einstufung.ts und die Datenbank brauchen. */
function zusammenfassen(partien) {
  const je = {};
  for (const p of partien) {
    const s = (je[p.stufe] ??= {
      stufe: p.stufe,
      spiele: 0,
      siege: 0,
      remis: 0,
      siegRunden: [],
      verlustGruende: {},
    });
    if (p.fehler) continue;
    s.spiele++;
    if (p.remis) s.remis++;
    if (p.gewonnen) {
      s.siege++;
      if (p.runde) s.siegRunden.push(p.runde);
    }
    if (p.verlustGrund)
      s.verlustGruende[p.verlustGrund] = (s.verlustGruende[p.verlustGrund] ?? 0) + 1;
  }
  return Object.values(je)
    .sort((a, b) => a.stufe - b.stufe)
    .map((s) => ({
      ...s,
      siegRundeSchnitt: s.siegRunden.length
        ? Math.round((10 * s.siegRunden.reduce((a, b) => a + b, 0)) / s.siegRunden.length) / 10
        : null,
    }));
}

function drucke(stufen, einstufung) {
  console.log('\n| Stufe | Partien | Siege | Winrate | 95-%-Bereich | Remis | Ø Siegrunde |');
  console.log('| ---: | ---: | ---: | ---: | --- | ---: | ---: |');
  for (const s of einstufung.stufen) {
    const z = stufen.find((x) => x.stufe === s.stufe);
    const pct = (x) => `${Math.round(100 * x)} %`;
    console.log(
      `| ${s.stufe} | ${s.spiele} | ${s.siege} | ${pct(s.winrate)} | ${pct(s.unten)}–${pct(s.oben)} | ${s.remis} | ${z?.siegRundeSchnitt ?? '–'} |`,
    );
  }
  console.log(
    `\nEinstufung: Bracket ${einstufung.stufe} (${einstufung.sicherheit})` +
      ` · Simulation ${einstufung.simStufe}` +
      (einstufung.regelMinimum ? ` · Kartenregeln mindestens ${einstufung.regelMinimum}` : ''),
  );
}

// ---------------------------------------------------------------- auswerten
if (argv[0] === '--auswerten') {
  const mitWert = new Set(['--regel-minimum', '--speichern', '--auftrag']);
  const dateien = argv
    .slice(1)
    .filter((a, i, l) => !a.startsWith('--') && !mitWert.has(l[i]) && !mitWert.has(l[i - 1]));
  const teile = dateien.map((d) => JSON.parse(fs.readFileSync(d, 'utf8')));
  const partien = teile.flatMap((t) => t.partien);
  const unbekannt = [...new Set(teile.flatMap((t) => t.deck?.unbekannt ?? []))];
  const stufen = zusammenfassen(partien);
  const deckId = opt('speichern', null);
  const auftragId = opt('auftrag', null);

  // Kein einziges Ergebnis (alle Runner abgestürzt oder Deck nicht ladbar): Das ist ein Fehler, keine
  // Einstufung - ohne Partien käme sonst "Bracket 1" heraus.
  if (!stufen.some((st) => st.spiele > 0)) {
    const grund = partien.find((pa) => pa.fehler)?.fehler ?? 'keine Partie gespielt';
    console.error(`Keine auswertbaren Partien: ${grund}`);
    if (auftragId) auftragAbschliessen(auftragId, { status: 'fehler', fehler: grund });
    process.exit(1);
  }

  // Untergrenze aus den Kartenregeln: die automatische Einstufung, die die App beim Öffnen des Decks
  // speichert (bracket.ts). Von Hand übergeben geht vor.
  let regel = opt('regel-minimum', null);
  if (regel == null && deckId) {
    const [d] = supabase(`decks?select=bracket_auto&id=eq.${deckId}`);
    regel = d?.bracket_auto ?? null;
  }
  const einstufung = ladeEinstufung().einstufen(stufen, regel != null ? Number(regel) : null);
  drucke(stufen, einstufung);
  if (unbekannt.length)
    console.log(`Forge kannte nicht (fehlten im Spiel): ${unbekannt.join(', ')}`);

  if (deckId) {
    const [gespeichert] = supabase('forge_einstufungen', {
      method: 'POST',
      body: JSON.stringify({
        deck_id: deckId,
        stufe: einstufung.stufe,
        sim_stufe: einstufung.simStufe,
        regel_minimum: einstufung.regelMinimum,
        sicherheit: einstufung.sicherheit,
        stufen: stufen.map(({ siegRunden, ...rest }) => rest),
        unbekannte_karten: unbekannt,
        forge_commit: forgeCommit(),
        testdecks_commit: testdecksCommit(),
      }),
    });
    console.log(`Gespeichert in forge_einstufungen (Deck ${deckId}).`);
    if (auftragId)
      auftragAbschliessen(auftragId, { status: 'fertig', einstufung_id: gespeichert.id });
  }
  process.exit(0);
}

/** Schließt einen Auftrag aus der App-Warteschlange ab (forge_einstufung_auftraege). */
function auftragAbschliessen(id, felder) {
  supabase(`forge_einstufung_auftraege?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...felder, fertig_at: new Date().toISOString() }),
  });
}

/** REST-Aufruf mit dem Service-Role-Key - nur die GitHub Action darf in forge_einstufungen schreiben. */
function supabase(pfad, { method = 'GET', body = null } = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key)
    throw new Error('SUPABASE_SERVICE_ROLE_KEY fehlt - ohne ihn nur auswerten, nicht --speichern.');
  return holeJson(`${SUPABASE_URL}/rest/v1/${pfad}`, {
    method,
    body,
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'return=representation' },
  });
}

/** Die gepinnte Forge-Fassung steht an genau einer Stelle: in forge-setup.sh. */
function forgeCommit() {
  const sh = fs.readFileSync(path.join(__dirname, 'forge-setup.sh'), 'utf8');
  return process.env.FORGE_COMMIT || /FORGE_COMMIT:-([0-9a-f]{40})/.exec(sh)[1];
}

/** Letzter Commit, der die Test-Decks geändert hat - zwei Läufe mit verschiedenem Stand sind nicht vergleichbar. */
function testdecksCommit() {
  const { execFileSync } = require('child_process');
  return execFileSync(
    'git',
    [
      'log',
      '-1',
      '--format=%H',
      '--',
      'sim/testdecks/b1',
      'sim/testdecks/b2',
      'sim/testdecks/b3',
      'sim/testdecks/b4',
      'sim/testdecks/b5',
    ],
    {
      cwd: path.join(__dirname, '..', '..'),
    },
  )
    .toString()
    .trim();
}

// ---------------------------------------------------------------- spielen
const forgeDir = argv[0];
if (!forgeDir || forgeDir.startsWith('--')) {
  console.error(
    'Aufruf: node scripts/forge/einstufen.js <forge-checkout> --deck <id> [--stufen 1,2,3,4,5]',
  );
  process.exit(1);
}
const SPIELE = Number(opt('spiele', 100));
const PARALLEL = Number(opt('parallel', 2));
const ZEITLIMIT = Number(opt('zeitlimit', 900));
const STUFEN = opt('stufen', '1,2,3,4,5').split(',').map(Number);

// Das zu prüfende Deck holen und übersetzen.
let quelle;
if (opt('deck')) quelle = QUELLEN.statsfinity(opt('deck'));
else if (opt('archidekt')) quelle = QUELLEN.archidekt(opt('archidekt'));
const arbeit = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-einstufen-'));
const PRUEFLING = 'pruefling.dck';
let info;
if (quelle) {
  const f = zuForgeDeck(quelle, leseForgeNamen(path.join(forgeDir, 'forge-gui', 'res')), {
    name: 'pruefling',
  });
  if (!f.commander.length) {
    console.error('Das Deck hat keinen Commander.');
    process.exit(1);
  }
  if (f.unbekannt.length) {
    // Kein Abbruch: Das Deck spielt ohne diese Karten, die Ergebnisdatei nennt sie. Wer ein Deck mit
    // vielen unbekannten Karten einstuft, sieht das dort.
    console.warn(
      `Forge kennt ${f.unbekannt.length} Karte(n) nicht, sie fehlen im Spiel: ${f.unbekannt.join(', ')}`,
    );
  }
  fs.writeFileSync(path.join(arbeit, PRUEFLING), f.dck);
  info = {
    name: quelle.name,
    link: quelle.link,
    commander: f.commander,
    karten: f.karten,
    unbekannt: f.unbekannt,
  };
} else if (opt('dck')) {
  fs.copyFileSync(opt('dck'), path.join(arbeit, PRUEFLING));
  info = { name: path.basename(opt('dck')), karten: null, unbekannt: [] };
} else {
  console.error('Welches Deck? --deck <statsfinity-id>, --archidekt <id> oder --dck <datei>');
  process.exit(1);
}
console.log(
  `Deck: ${info.name} (${info.commander?.join(' + ') ?? '?'}, ${info.karten ?? '?'} Karten)`,
);

// Test-Decks in denselben Arbeitsordner - Forge will alle Decks einer Partie in einem Ordner (-D).
const testdecks = {};
for (const s of STUFEN) {
  testdecks[s] = fs
    .readdirSync(path.join(TESTDECKS, `b${s}`))
    .filter((f) => f.endsWith('.dck'))
    .sort()
    .map((f) => {
      fs.copyFileSync(path.join(TESTDECKS, `b${s}`, f), path.join(arbeit, `b${s}-${f}`));
      return `b${s}-${f}`;
    });
}

// Die Aufstellung je Partie ist fest (nicht zufällig): Die vier Dreiergruppen aus vier Test-Decks
// wechseln reihum, der Prüfling rückt jede Partie einen Platz weiter. So spielt er gegen jede
// Kombination gleich oft und von jedem Platz gleich oft - bei 100 Partien exakt ausgeglichen.
const plan = [];
for (const s of STUFEN) {
  const d = testdecks[s];
  const gruppen = d.map((_, weg) => d.filter((__, k) => k !== weg));
  for (let i = 0; i < SPIELE; i++) {
    const platz = i % 4;
    const sitz = [...gruppen[Math.floor(i / 4) % gruppen.length]];
    sitz.splice(platz, 0, PRUEFLING);
    plan.push({ stufe: s, nr: i, sitz, platz });
  }
}

const AUS = opt('aus', path.join(process.cwd(), 'einstufung.json'));
const stand = fs.existsSync(AUS)
  ? JSON.parse(fs.readFileSync(AUS, 'utf8'))
  : { deck: info, partien: [] };
const schon = new Set(stand.partien.map((p) => `${p.stufe}-${p.nr}`));
const offen = plan.filter((p) => !schon.has(`${p.stufe}-${p.nr}`));
console.log(`${plan.length} Partien geplant, ${offen.length} offen, ${PARALLEL} parallel.`);

let fertig = 0;
parallel(
  offen.map(
    (p) => () =>
      spielePartie({
        forgeDir,
        deckDir: arbeit,
        decks: p.sitz,
        zeitlimit: ZEITLIMIT,
        seed: p.stufe * 1000 + p.nr,
      }),
  ),
  PARALLEL,
  (i, r) => {
    const p = offen[i];
    const eigenerVerlust = r.verloren.find((v) => v.platz === p.platz);
    stand.partien.push({
      stufe: p.stufe,
      nr: p.nr,
      gegner: p.sitz.filter((d) => d !== PRUEFLING),
      platz: p.platz,
      gewonnen: r.siegerPlatz === p.platz,
      sieger: r.siegerPlatz == null ? null : p.sitz[r.siegerPlatz],
      remis: r.remis,
      runde: r.runde,
      verlustGrund: eigenerVerlust?.grund ?? null,
      dauerS: Math.round(r.dauerMs / 1000),
      fehler: r.fehler,
    });
    fs.writeFileSync(AUS, JSON.stringify(stand, null, 1));
    fertig++;
    const ergebnis = r.fehler
      ? `FEHLER ${r.fehler}`
      : r.siegerPlatz === p.platz
        ? 'SIEG'
        : r.remis
          ? 'Remis'
          : 'verloren';
    console.log(
      `[${fertig}/${offen.length}] B${p.stufe} #${p.nr}: ${ergebnis} (Runde ${r.runde ?? '?'}, ${Math.round(r.dauerMs / 1000)}s)`,
    );
  },
).then(() => {
  const stufen = zusammenfassen(stand.partien);
  const einstufung = ladeEinstufung().einstufen(stufen);
  stand.stufen = stufen;
  stand.einstufung = einstufung;
  fs.writeFileSync(AUS, JSON.stringify(stand, null, 1));
  drucke(stufen, einstufung);
  fs.rmSync(arbeit, { recursive: true, force: true });
});
