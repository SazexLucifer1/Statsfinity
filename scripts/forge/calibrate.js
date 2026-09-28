// Kalibrierungsturnier der Test-Decks: Trennen die fünf Stufen überhaupt?
// Auswahl und Ergebnisse: sim/testdecks/README.md
//
// WOZU: Die Einstufung eines Decks misst, wie oft es gegen die Test-Decks einer Stufe gewinnt. Das
// taugt nur, wenn die Test-Decks selbst sauber gestuft sind. Zwei Proben:
//
//   innen  - die vier Decks einer Stufe gegeneinander. Erwartet: jedes um 25 % (fairer Anteil im 4er-Pod).
//            Ein Deck weit darüber ist zu stark für seine Stufe, eins weit darunter zu schwach.
//   stufe  - ein Deck der Stufe k gegen drei Decks der Stufe k-1. Erwartet: deutlich über 25 %.
//            Liegt es bei 25 % oder darunter, ist Stufe k nicht stärker als k-1 - die Stufen trennen nicht.
//
//   node scripts/forge/calibrate.js <forge-checkout> [--spiele 20] [--parallel 3] [--zeitlimit 600]
//        [--nur innen|stufe] [--stufen 1,2,3] [--aus ergebnis.json]
//
// Schreibt nach jeder Partie den Zwischenstand in die JSON-Datei (Standard: sim/testdecks/kalibrierung.json),
// ein abgebrochener Lauf verliert also nichts. Am Ende eine Markdown-Tabelle auf der Konsole.

const fs = require('fs');
const path = require('path');
const { spielePartie, parallel } = require('./forge-partie');

const argv = process.argv.slice(2);
const forgeDir = argv[0];
const opt = (name, std) => {
  const i = argv.indexOf(`--${name}`);
  return i > 0 ? argv[i + 1] : std;
};
if (!forgeDir || forgeDir.startsWith('--')) {
  console.error(
    'Aufruf: node scripts/forge/calibrate.js <forge-checkout> [--spiele 20] [--parallel 3]',
  );
  process.exit(1);
}
const SPIELE = Number(opt('spiele', 20));
const PARALLEL = Number(opt('parallel', 3));
const ZEITLIMIT = Number(opt('zeitlimit', 600));
const NUR = opt('nur', null);
const STUFEN = opt('stufen', '1,2,3,4,5').split(',').map(Number);
const DECKS_DIR = path.join(__dirname, '..', '..', 'sim', 'testdecks');
const AUS = opt('aus', path.join(DECKS_DIR, 'kalibrierung.json'));

// Forge will alle Decks einer Partie in EINEM Ordner (-D) - deshalb Dateinamen mit Stufen-Präfix
// in einen gemeinsamen Arbeitsordner kopieren.
const arbeit = path.join(DECKS_DIR, '.lauf');
fs.mkdirSync(arbeit, { recursive: true });
const decks = {};
for (let s = 1; s <= 5; s++) {
  const ordner = path.join(DECKS_DIR, `b${s}`);
  decks[s] = fs
    .readdirSync(ordner)
    .filter((f) => f.endsWith('.dck'))
    .sort()
    .map((f) => {
      const ziel = `b${s}-${f}`;
      fs.copyFileSync(path.join(ordner, f), path.join(arbeit, ziel));
      return ziel;
    });
}

// Fester Zufall: derselbe Aufruf spielt dieselben Aufstellungen.
let zustand = 20260928;
const zufall = () => (zustand = (zustand * 1103515245 + 12345) % 2147483648) / 2147483648;
const ziehe = (liste, n) => [...liste].sort(() => zufall() - 0.5).slice(0, n);

/** Alle Partien des Laufs: Aufstellung, Probe, und welcher Platz das "geprüfte" Deck ist. */
const partien = [];
for (const s of STUFEN) {
  if (NUR !== 'stufe') {
    for (let i = 0; i < SPIELE; i++) {
      // Sitzreihenfolge rotiert, sonst hätte immer dasselbe Deck den ersten Zug.
      const d = decks[s];
      const sitz = d.map((_, k) => d[(k + i) % d.length]);
      partien.push({ probe: 'innen', stufe: s, sitz, geprueft: null });
    }
  }
  if (NUR !== 'innen' && s > 1) {
    for (let i = 0; i < SPIELE; i++) {
      const pruefling = decks[s][i % decks[s].length];
      const gegner = ziehe(decks[s - 1], 3);
      const platz = i % 4;
      const sitz = [...gegner];
      sitz.splice(platz, 0, pruefling);
      partien.push({ probe: 'stufe', stufe: s, sitz, geprueft: platz });
    }
  }
}

const ergebnisse = fs.existsSync(AUS) ? JSON.parse(fs.readFileSync(AUS, 'utf8')) : [];
const schon = new Set(ergebnisse.map((e) => JSON.stringify([e.probe, e.sitz])));
const offen = partien.filter((p) => !schon.has(JSON.stringify([p.probe, p.sitz])));
console.log(
  `${partien.length} Partien geplant, ${partien.length - offen.length} schon gespielt, ${offen.length} offen.`,
);

let fertig = 0;
parallel(
  offen.map(
    (p, i) => () =>
      spielePartie({
        forgeDir,
        deckDir: arbeit,
        decks: p.sitz,
        zeitlimit: ZEITLIMIT,
        seed: 1000 + i,
      }),
  ),
  PARALLEL,
  (i, r) => {
    const p = offen[i];
    const eintrag = {
      ...p,
      sieger: r.siegerPlatz == null ? null : p.sitz[r.siegerPlatz],
      runde: r.runde,
      remis: r.remis,
      verloren: r.verloren.map((v) => ({ deck: p.sitz[v.platz], grund: v.grund })),
      dauerS: Math.round(r.dauerMs / 1000),
      fehler: r.fehler,
    };
    ergebnisse.push(eintrag);
    fs.writeFileSync(AUS, JSON.stringify(ergebnisse, null, 1));
    fertig++;
    console.log(
      `[${fertig}/${offen.length}] ${p.probe} B${p.stufe}: ${eintrag.sieger ?? (r.fehler ? 'FEHLER ' + r.fehler : 'Remis')}` +
        ` (Runde ${r.runde ?? '?'}, ${eintrag.dauerS}s)`,
    );
  },
).then(() => {
  console.log('\n' + bericht(ergebnisse));
});

function bericht(alle) {
  const zeilen = [
    '| Probe | Stufe | Deck | Partien | Siege | Winrate | Remis |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: |',
  ];
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '–');
  for (const s of STUFEN) {
    for (const probe of ['innen', 'stufe']) {
      const teil = alle.filter((e) => e.stufe === s && e.probe === probe && !e.fehler);
      if (!teil.length) continue;
      const kandidaten =
        probe === 'innen' ? decks[s] : [...new Set(teil.map((e) => e.sitz[e.geprueft]))];
      for (const d of kandidaten) {
        const mit = probe === 'innen' ? teil : teil.filter((e) => e.sitz[e.geprueft] === d);
        const siege = mit.filter((e) => e.sieger === d).length;
        const remis = mit.filter((e) => e.remis).length;
        zeilen.push(
          `| ${probe} | ${s} | ${d.replace(/\.dck$/, '')} | ${mit.length} | ${siege} | ${pct(siege, mit.length)} | ${remis} |`,
        );
      }
    }
  }
  return zeilen.join('\n');
}
