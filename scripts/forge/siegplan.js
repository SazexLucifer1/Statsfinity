// Siegplan eines Decks für den Combo-Pilot der Forge-Bots (scripts/forge/pilot/ComboPilot.java).
// Befund, warum es ihn braucht: sim/testdecks/README.md ("Erster Lauf") - ohne ihn gewinnt kein Bot per Combo.
//
// Holt von Commander Spellbook (find-my-combos) alle Combos, die vollständig im Deck stecken, behält die
// spielbeendenden und bringt sie in zwei Formen zu Forge:
//
//   .combos-Datei  - eine Combo je Zeile, Format im Kopf von ComboPilot.java. Der Pilot führt eine Combo vor,
//                    sobald alle Teile in ihren Zonen liegen und das Mana reicht.
//   KeyCards       - alle Teile als Metadaten der .dck. Forge lässt Tutoren bevorzugt Key Cards suchen und den
//                    Bot sie nicht abwerfen - das Suchen und Schützen der Teile kostet so keinen eigenen Code.
//
// Was "spielbeendend" heißt, entscheidet istSiegCombo() aus src/app/goldfish-sim.ts (die WEITE Definition,
// dieselbe wie im Goldfish-Simulator). Sie steht bewusst nur dort und wird hier per esbuild eingebunden -
// zwei Fassungen derselben Regel sind in diesem Projekt schon einmal auseinandergelaufen (CLAUDE.md).

const os = require('os');
const path = require('path');
const { holeJson } = require('./deck-quellen');

let siegRegel = null;
function istSiegCombo(produces) {
  if (!siegRegel) {
    const esbuild = require('esbuild');
    const ziel = path.join(os.tmpdir(), `statsfinity-siegregel-${process.pid}.cjs`);
    esbuild.buildSync({
      entryPoints: [path.join(__dirname, '..', '..', 'src', 'app', 'goldfish-sim.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: ziel,
      logLevel: 'error',
    });
    siegRegel = require(ziel).istSiegCombo;
  }
  return siegRegel(produces);
}

/** "{3}{U}{U}" -> "3 U U" (Forge-Schreibweise); "{X}" und Beschreibungen ("at most") fallen weg. */
function forgeMana(spellbook) {
  const teile = [...(spellbook ?? '').matchAll(/\{([^}]+)\}/g)]
    .map((m) => m[1])
    .filter((t) => t !== 'X');
  return teile.join(' ');
}

/**
 * Platzhalter wie "Permanent Castable for {C}{C}" (Zone H): Anzahl und höchster Manawert. Platzhalter in
 * anderen Zonen kann der Pilot nicht prüfen - solche Combos fallen weg (null), statt dass der Bot eine Combo
 * vorführt, deren Bedingung niemand geprüft hat.
 */
function platzhalter(requires) {
  let anzahl = 0;
  let maxMv = 0;
  for (const r of requires ?? []) {
    if (!r.zoneLocations?.includes('H')) return null;
    const symbole = [...r.template.name.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    if (!symbole.length) return null;
    const mv = symbole.reduce((s, x) => s + (/^\d+$/.test(x) ? Number(x) : 1), 0);
    anzahl++;
    maxMv = Math.max(maxMv, mv);
  }
  return { anzahl, maxMv };
}

/**
 * @param {{ commander: {name:string}[], main: {name:string, anzahl:number}[] }} deck  Forge-Namen
 * @returns {{ zeilen: string[], keyCards: string[], combos: number }}
 */
function siegplanFuer(deck) {
  const antwort = holeJson('https://backend.commanderspellbook.com/find-my-combos', {
    method: 'POST',
    body: JSON.stringify({
      commanders: deck.commander.map((k) => ({ card: k.name })),
      main: deck.main.map((k) => ({ card: k.name, quantity: k.anzahl })),
    }),
  });
  const combos = [];
  for (const c of antwort.results?.included ?? []) {
    const ergebnisse = c.produces.map((p) => p.feature.name);
    if (!istSiegCombo(ergebnisse)) continue;
    const extra = platzhalter(c.requires);
    if (!extra) continue;
    const teile = c.uses.map((u) => ({
      // Spellbook schreibt doppelseitige Karten als "Vorne // Hinten", Forge führt sie unter der Vorderseite.
      name: u.card.name.split(' // ')[0],
      zonen: (u.zoneLocations ?? []).join('') || 'B',
    }));
    const ergebnis = ergebnisse.find((e) => istSiegCombo([e])) ?? ergebnisse[0];
    combos.push({
      teile,
      zeile: [
        teile.map((t) => `${t.name}@${t.zonen}`).join(';'),
        forgeMana(c.manaNeeded),
        `${extra.anzahl}:${extra.maxMv}`,
        ergebnis.replace(/\|/g, '/'),
      ].join(' | '),
    });
  }
  // Kleine Combos zuerst: Sie sind schneller zusammen, und der Pilot prüft in dieser Reihenfolge.
  combos.sort((a, b) => a.teile.length - b.teile.length);
  const keyCards = [...new Set(combos.flatMap((c) => c.teile.map((t) => t.name)))];
  return { zeilen: combos.map((c) => c.zeile), keyCards, combos: combos.length };
}

module.exports = { siegplanFuer, forgeMana };
