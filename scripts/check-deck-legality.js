// Prüft alle Decks des Archidekt-Vorrats darauf, ob ihre Karten im Commander überhaupt spielbar
// sind, und markiert sie entsprechend.
// Spalten und Begründung: sql/deck-pool-legality-2026-09-16.sql
// Ausgelöst von .github/workflows/deck-legality.yml (nur von Hand, kein Nachtlauf).
//
// WOZU: Der Vorrat ist die Referenz, gegen die die Bracket-Einstufung geeicht wird. Ein Deck mit
// Karten, die im Commander nicht spielbar sind, beschreibt kein Deck, das jemand an einem Tisch
// spielen könnte - es gehört da nicht hinein. Aufgefallen ist das an einer einzigen Karte: Gleemax,
// eine Silberrand-Scherzkarte mit Manabetrag 1.000.000, hat den durchschnittlichen Manabetrag von
// Bracket 1 im ersten großen Lauf von rund 3 auf 8,16 gehoben.
//
// MARKIEREN STATT LÖSCHEN: Der Import zieht Decks nach ihrer Archidekt-ID. Ein gelöschtes Deck wäre
// beim nächsten Importlauf schlicht wieder da. Eine Markierung am Deck überlebt jeden weiteren
// Import.
//
// Braucht den Supabase SERVICE-ROLE-Key (der Vorrat ist per RLS nur für Developer lesbar):
//
//   SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/check-deck-legality.js
//
// Idempotent: Ein zweiter Lauf schreibt dieselben Werte.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://jkkelwpnrgzbvopszwrl.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error('Fehlt: SUPABASE_SERVICE_ROLE_KEY als Umgebungsvariable setzen (siehe oben).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const dryRun = process.argv.includes('--dry-run');
/** --alle: auch schon geprüfte Decks erneut prüfen (nach einem neuen Scryfall-Abgleich sinnvoll). */
const alle = process.argv.includes('--alle');

/** Höchstens so viele beanstandete Karten je Deck merken - zum Nachsehen reicht eine Handvoll. */
const MAX_GEMERKTE_KARTEN = 10;

const SEITE = 1000;

async function ladeAlle(tabelle, spalten, anpassen = (q) => q) {
  const zeilen = [];
  for (let von = 0; ; von += SEITE) {
    const { data, error } = await anpassen(
      supabase
        .from(tabelle)
        .select(spalten)
        .range(von, von + SEITE - 1),
    );
    if (error) throw new Error(`Laden aus ${tabelle} fehlgeschlagen: ${error.message}`);
    zeilen.push(...data);
    if (data.length < SEITE) return zeilen;
  }
}

async function main() {
  console.log(
    `Legalitätsprüfung${alle ? ' (alle Decks)' : ' (nur ungeprüfte)'}${dryRun ? ', Trockenlauf' : ''}.`,
  );

  console.log('Kartenlegalität laden ...');
  const karten = await ladeAlle('scryfall_cards', 'front_name_normalized, name, commander_legal');

  // ACHTUNG, DER SCHLÜSSEL IST NICHT EINDEUTIG. Mehrere Einträge können denselben normalisierten
  // Vorderseiten-Namen haben - nachgemessen 45 Namen, bei 21 davon ist einer legal und ein anderer
  // nicht:
  //
  //   Savage Lands (Land)                legal     <- die echte Karte
  //   Savage Lands (Card)                nicht     <- ein Eintrag ohne Kartencharakter
  //   Smelt (Instant)                    legal     <- die echte Karte
  //   Smelt // Herd // Saw               nicht     <- eine Playtest-Karte
  //
  // Die erste Fassung merkte sich stur den unspielbaren Eintrag und hat damit 875 Decks allein
  // wegen Savage Lands aussortiert - einem Dreifarben-Land, das in jedem Commander-Deck erlaubt
  // ist. Richtig ist die Frage andersherum: Ein Name ist nur dann nicht spielbar, wenn es GAR
  // KEINE spielbare Fassung von ihm gibt. Existiert eine, darf man die Karte spielen.
  const legaleNamen = new Set();
  const nichtLegal = new Map();
  let unbekannteLegalitaet = 0;
  for (const k of karten) {
    if (k.commander_legal === true) legaleNamen.add(k.front_name_normalized);
    else if (k.commander_legal === null) unbekannteLegalitaet++;
    else if (!nichtLegal.has(k.front_name_normalized)) {
      nichtLegal.set(k.front_name_normalized, k.name);
    }
  }
  let gerettet = 0;
  for (const name of legaleNamen) {
    if (nichtLegal.delete(name)) gerettet++;
  }
  console.log(
    `  ${karten.length} Karten, davon ${nichtLegal.size} im Commander nicht spielbar` +
      (gerettet
        ? ` (${gerettet} Namen haben daneben eine spielbare Fassung und zählen als legal).`
        : '.'),
  );

  if (unbekannteLegalitaet > karten.length / 2) {
    console.error(
      `ABBRUCH: Bei ${unbekannteLegalitaet} von ${karten.length} Karten steht die Legalität auf null.\n` +
        'Die Migration sql/scryfall-commander-legality-2026-09-16.sql ist gelaufen, aber der\n' +
        'Scryfall-Abgleich noch nicht MIT --force. Ohne ihn wuerde dieser Lauf jedes Deck als legal\n' +
        'markieren - und das waere schlimmer als gar keine Markierung.',
    );
    process.exit(1);
  }

  console.log('Kartennamen laden ...');
  const namen = await ladeAlle('archidekt_pool_card_names', 'id, name_normalized');
  const nameNachId = new Map(namen.map((n) => [n.id, n.name_normalized]));

  console.log('Decks laden ...');
  const decks = await ladeAlle('archidekt_deck_pool', 'id, name, creator_bracket, legal', (q) =>
    alle ? q : q.is('legal', null),
  );
  console.log(`  ${decks.length} zu prüfen.`);
  if (decks.length === 0) {
    console.log('Nichts zu tun.');
    return;
  }

  const listen = await ladeAlle('archidekt_deck_pool_cardlists', 'deck_id, card_ids');
  const listeNachDeck = new Map(listen.map((l) => [l.deck_id, l.card_ids]));

  const legaleIds = [];
  const illegale = [];
  let ohneListe = 0;

  for (const deck of decks) {
    const cardIds = listeNachDeck.get(deck.id);
    if (!cardIds) {
      ohneListe++;
      continue;
    }

    const beanstandet = [];
    for (const id of cardIds) {
      const key = nameNachId.get(id);
      const anzeigename = key ? nichtLegal.get(key) : undefined;
      // Unbekannte Karten (nicht in scryfall_cards) machen ein Deck NICHT illegal: Was der
      // Abgleich nicht kennt, kann er auch nicht beanstanden. Ein Deck wegen einer Wissenslücke
      // auszuschliessen waere eine Behauptung, keine Pruefung.
      if (anzeigename && !beanstandet.includes(anzeigename)) beanstandet.push(anzeigename);
    }

    if (beanstandet.length === 0) legaleIds.push(deck.id);
    else illegale.push({ id: deck.id, name: deck.name, karten: beanstandet });
  }

  const gesamt = legaleIds.length + illegale.length;
  console.log(
    `\n${legaleIds.length} legal, ${illegale.length} illegal (${((illegale.length / Math.max(1, gesamt)) * 100).toFixed(1)} %)` +
      (ohneListe ? `, ${ohneListe} ohne Kartenliste übersprungen` : ''),
  );
  zeigeHaeufigsteVerstoesse(illegale);

  if (dryRun) {
    console.log('Trockenlauf - nichts geschrieben.');
    return;
  }

  await schreibe(legaleIds, illegale);
  console.log('Fertig.');
}

/** Welche Karten sorgen am häufigsten für den Ausschluss? Das ist die Zahl, die man sehen will. */
function zeigeHaeufigsteVerstoesse(illegale) {
  const zaehler = new Map();
  for (const deck of illegale) {
    for (const karte of deck.karten) zaehler.set(karte, (zaehler.get(karte) ?? 0) + 1);
  }
  const top = [...zaehler].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (top.length === 0) return;
  console.log('\nHäufigste Gründe:');
  for (const [karte, anzahl] of top) {
    console.log(`  ${String(anzahl).padStart(5)} Decks  ${karte}`);
  }
  console.log('');
}

/**
 * Schreiben in zwei Formen, und das ist Absicht.
 *
 * Die LEGALEN bekommen alle denselben Wert - die gehen paketweise in einer einzigen Anweisung je
 * 500 Decks. Die ILLEGALEN tragen jeweils ihre eigene Kartenliste, die muss einzeln geschrieben
 * werden. Weil sie die Minderheit sind, kostet das wenig; andersherum waeren es 50.000 einzelne
 * Anweisungen.
 */
async function schreibe(legaleIds, illegale) {
  const jetzt = new Date().toISOString();
  const PAKET = 500;

  for (let i = 0; i < legaleIds.length; i += PAKET) {
    const { error } = await supabase
      .from('archidekt_deck_pool')
      .update({ legal: true, illegale_karten: null, legal_geprueft_at: jetzt })
      .in('id', legaleIds.slice(i, i + PAKET));
    if (error) throw new Error(`Markieren der legalen Decks fehlgeschlagen: ${error.message}`);
    if ((i / PAKET) % 20 === 0) {
      console.log(
        `  ${Math.min(i + PAKET, legaleIds.length)}/${legaleIds.length} legale Decks markiert.`,
      );
    }
  }

  for (const deck of illegale) {
    const { error } = await supabase
      .from('archidekt_deck_pool')
      .update({
        legal: false,
        illegale_karten: deck.karten.slice(0, MAX_GEMERKTE_KARTEN),
        legal_geprueft_at: jetzt,
      })
      .eq('id', deck.id);
    if (error) throw new Error(`Markieren von "${deck.name}" fehlgeschlagen: ${error.message}`);
  }
  console.log(`  ${illegale.length} illegale Decks markiert.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
