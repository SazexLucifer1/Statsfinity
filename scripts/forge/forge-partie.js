// Spielt EINE Commander-Partie mit Forge (Bot gegen Bot) und liest das Ergebnis aus der Ausgabe.
// Gemeinsamer Baustein für das Kalibrierungsturnier (calibrate.js) und später die Einstufung.
// Befunde zum Ausgabeformat: scripts/forge/README.md
//
// Eine Partie = ein Java-Prozess. Das kostet je Partie einige Sekunden Start (Kartenskripte laden),
// ist aber bei 40+ Sekunden Spielzeit vernachlässigbar - und ein hängender oder abstürzender Bot
// reißt so nur seine eigene Partie mit, nicht den ganzen Lauf.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Das gebaute Forge-Jar im Checkout von forge-setup.sh. */
function forgeJar(forgeDir) {
  const target = path.join(forgeDir, 'forge-gui-desktop', 'target');
  const jar = fs
    .readdirSync(target)
    .find((f) => /^forge-gui-desktop-.*-jar-with-dependencies\.jar$/.test(f));
  if (!jar)
    throw new Error(
      `Kein Forge-Jar in ${target} - erst scripts/forge/forge-setup.sh laufen lassen.`,
    );
  return path.join(target, jar);
}

/**
 * Liest die Ergebniszeilen einer Partie. Forge schreibt sie im Modus -q als "Game Outcome:"-Zeilen:
 *   Game Outcome: Turn 38
 *   Game Outcome: Ai(1)-name has lost because life total reached 0
 *   Game Outcome: Ai(2)-name has won because all opponents have lost
 * "Turn" zählt die Züge ALLER Spieler; die Runde ist ceil(Turn / Spielerzahl).
 */
function leseErgebnis(ausgabe, spielerzahl) {
  const zug = Number(/Game Outcome: Turn (\d+)/.exec(ausgabe)?.[1] ?? NaN);
  // "has won because all opponents have lost", aber auch "... due to effect of spell 'Combo: ...'" - der
  // Combo-Pilot (scripts/forge/pilot) gewinnt über einen Zauber dieses Namens.
  const sieger = [
    ...ausgabe.matchAll(/Game Outcome: Ai\((\d+)\)-.* has won (?:because |due to |by )?(.*)/g),
  ];
  const verloren = [
    ...ausgabe.matchAll(/Game Outcome: Ai\((\d+)\)-.* has lost (?:because |due to )(.+)/g),
  ].map((m) => ({
    platz: Number(m[1]) - 1,
    grund: m[2].trim(),
  }));
  // Mehr als ein Sieger ist kein Ergebnis, sondern ein Forge-Fehler (gesehen mit der Such-KI) - Remis.
  const remis = /ended in a Draw|Stopping slow match as draw/.test(ausgabe) || sieger.length !== 1;
  const siegGrund = remis ? null : sieger[0][2].trim();
  return {
    siegerPlatz: remis ? null : Number(sieger[0][1]) - 1,
    siegGrund,
    comboSieg: !!siegGrund && /Combo:/.test(siegGrund),
    zuege: Number.isFinite(zug) ? zug : null,
    runde: Number.isFinite(zug) ? Math.ceil(zug / spielerzahl) : null,
    verloren,
    remis,
  };
}

/**
 * @param {object} o
 * @param {string} o.forgeDir     Checkout von Forge (enthält forge-gui/ und forge-gui-desktop/)
 * @param {string} o.deckDir      Ordner, in dem ALLE Decks dieser Partie liegen (Forge will -D + Dateinamen)
 * @param {string[]} o.decks      Dateinamen relativ zu deckDir, in Sitzreihenfolge
 * @param {number} [o.zeitlimit]  Sekunden, danach wertet Forge die Partie als Remis
 * @param {number} [o.seed]
 * @param {string[]} [o.profile]  AI-Profil je Platz (Forge -a), optional
 */
function spielePartie({ forgeDir, deckDir, decks, zeitlimit = 600, seed, profile }) {
  const args = [
    '-Xmx2g',
    '-Djava.awt.headless=true',
    '-jar',
    forgeJar(forgeDir),
    'sim',
    '-D',
    path.resolve(deckDir),
    '-d',
    ...decks,
    '-f',
    'Commander',
    '-n',
    '1',
    '-c',
    String(zeitlimit),
    '-q',
  ];
  if (seed != null) args.push('-s', String(seed));
  if (profile?.length) args.push('-a', ...profile);

  return new Promise((resolve) => {
    const start = Date.now();
    // Forge sucht res/ relativ zum Arbeitsverzeichnis.
    const p = spawn('java', args, {
      cwd: path.join(forgeDir, 'forge-gui'),
      // Der Combo-Pilot liest <Deckname>.combos aus diesem Ordner (siehe scripts/forge/pilot).
      env: { ...process.env, FORGE_COMBO_DIR: path.resolve(deckDir) },
    });
    let ausgabe = '';
    p.stdout.on('data', (d) => (ausgabe += d));
    p.stderr.on('data', (d) => (ausgabe += d));
    // Sicherheitsnetz über Forges eigenem Zeitlimit: ein festgefahrener JVM-Prozess darf den Lauf nicht blockieren.
    const notbremse = setTimeout(() => p.kill('SIGKILL'), (zeitlimit + 120) * 1000);
    p.on('close', () => {
      clearTimeout(notbremse);
      const fehler = /Could not load deck[^\n]*/.exec(ausgabe)?.[0] ?? null;
      resolve({
        ...leseErgebnis(ausgabe, decks.length),
        dauerMs: Date.now() - start,
        fehler,
        ausgabe,
      });
    });
  });
}

/** Führt Aufgaben mit höchstens `parallel` gleichzeitig aus. */
async function parallel(aufgaben, anzahl, beiErgebnis) {
  let naechste = 0;
  const arbeiter = Array.from({ length: anzahl }, async () => {
    while (naechste < aufgaben.length) {
      const i = naechste++;
      beiErgebnis(i, await aufgaben[i]());
    }
  });
  await Promise.all(arbeiter);
}

module.exports = { spielePartie, leseErgebnis, parallel, forgeJar };
