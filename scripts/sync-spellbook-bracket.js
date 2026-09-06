// Nächtlicher Abgleich der Bracket-Grunddaten von Commander Spellbook in die eigene
// Supabase-Datenbank.
// Tabellen und ausführliche Begründung: sql/spellbook-cache-2026-09-06.sql
// Ausgelöst von .github/workflows/spellbook-sync.yml (täglich 05:00 UTC + manuell).
//
// Kurz: Die offiziellen Bracket-Kriterien brauchen drei Angaben, die es bei Scryfall nicht gibt -
// Mass Land Denial, Extra-Turns und Tutoren - plus die Liste der Zwei-Karten-Combos. Bisher holt
// die App das bei JEDEM Deck-Öffnen live über /api/estimate-bracket. Dieses Skript holt es einmal
// pro Nacht von EINEM Server; danach ist die Bracket-Einstufung ohne Netzwerkaufruf rechenbar.
//
// Braucht den Supabase SERVICE-ROLE-Key (nicht den öffentlichen Anon-Key aus supabase.client.ts) -
// die Tabellen sind bewusst für jeden lesbar, aber für niemanden schreibbar (nur eine
// select-Policy, siehe Migration). Der Service-Role-Key umgeht RLS. NIE committen - als
// Umgebungsvariable übergeben:
//
//   SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/sync-spellbook-bracket.js
//
// Idempotent: kann gefahrlos mehrfach laufen.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://jkkelwpnrgzbvopszwrl.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error(
    'Fehlt: SUPABASE_SERVICE_ROLE_KEY als Umgebungsvariable setzen (siehe Kommentar oben).',
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const API = 'https://backend.commanderspellbook.com';

/**
 * Aussagekräftiger User-Agent, damit der Nachtlauf für Commander Spellbook als Statsfinity
 * erkennbar ist - gleiche Höflichkeit wie im Scryfall-Abgleich. Aus dem Browser heraus ginge das
 * gar nicht (User-Agent ist dort ein verbotener Header), hier serverseitig greift es.
 */
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Statsfinity/1.0 (+https://github.com/SazexLucifer1/Statsfinity)',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Muss exakt normalizeCardName() aus src/app/array-utils.ts entsprechen - dieser Wert ist der
 * Schlüssel, unter dem die App die Zeilen wieder nachschlägt, und zugleich derselbe Schlüssel wie
 * scryfall_cards.front_name_normalized. Weicht er auch nur um ein Zeichen ab, findet die App gar
 * nichts und fällt still auf die alten Näherungen zurück. Dieses Skript läuft ohne
 * Angular/TypeScript und kann die Funktion deshalb nicht importieren (gleiche Situation wie bei
 * normalizeCardName() in scripts/sync-scryfall-bulk.js).
 */
function normalizeCardName(name) {
  return name.toLowerCase().replace(/[’‘´`]/g, "'");
}

/** Wie überall in der App wird auf dem Namen VOR " // " nachgeschlagen. */
function frontName(name) {
  return name.split(' // ')[0].trim();
}

const normalizedFrontName = (name) => normalizeCardName(frontName(name));

/**
 * Wiederholt bei Netz-/Rate-Limit-Fehlern mit wachsender Pause - übernommen aus
 * scripts/sync-scryfall-bulk.js, samt der dort teuer gelernten Lehre: der GRUND muss im
 * Fehlertext landen, sonst lässt sich ein Fehlschlag aus dem Lauf-Protokoll heraus nicht
 * einordnen. Geduldig, weil ein Lauf über 120 Seiten geht und ein einzelner Aussetzer nicht die
 * ganze Nacht kosten soll.
 */
const VERSUCHE = 6;

async function fetchJson(url) {
  let letzterGrund = 'unbekannt';

  for (let versuch = 0; versuch < VERSUCHE; versuch++) {
    let wartezeit = 3000 * 2 ** versuch; // 3, 6, 12, 24, 48 s
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.json();
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`HTTP ${res.status}`);
      }
      letzterGrund = `HTTP ${res.status}`;
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0)
        wartezeit = Math.max(wartezeit, retryAfter * 1000);
    } catch (err) {
      letzterGrund = err.message;
      if (versuch === VERSUCHE - 1) break;
    }
    console.log(
      `    Versuch ${versuch + 1}/${VERSUCHE} fehlgeschlagen (${letzterGrund}), erneut in ${wartezeit / 1000}s ...`,
    );
    await sleep(wartezeit);
  }

  throw new Error(`${url} -> nach ${VERSUCHE} Versuchen aufgegeben, zuletzt: ${letzterGrund}`);
}

/**
 * Läuft eine paginierte Liste über die "next"-Verweise ab.
 *
 * Bewusst NICHT über &offset= gesteuert: Spellbook deckelt die Seitengröße serverseitig auf 100,
 * egal was limit sagt, und liefert bei zu großem limit stillschweigend weniger - eine
 * offset-Schleife mit limit=500 überspringt dann 400 Einträge pro Seite. Die "next"-Verweise sind
 * die einzige Variante, die garantiert nichts auslässt.
 */
async function ladeAlleSeiten(startUrl, aufZeile) {
  let url = startUrl;
  let seiten = 0;
  let gesehen = 0;
  const zeilen = [];

  while (url) {
    const data = await fetchJson(url);
    const treffer = data.results ?? [];

    if (seiten === 0 && treffer.length > 0) {
      // Einmalige Kontrolle im Lauf-Protokoll, dass Spellbooks Feldnamen noch die sind, die wir
      // erwarten - eine stille Umbenennung dort würde sonst erst in der App auffallen, als
      // plötzlich leere Tutoren- und Combo-Listen.
      console.log('  Felder des ersten Eintrags:', Object.keys(treffer[0]).sort().join(', '));
    }

    for (const eintrag of treffer) {
      gesehen++;
      const zeile = aufZeile(eintrag);
      if (zeile) zeilen.push(zeile);
    }

    seiten++;
    if (seiten % 20 === 0) console.log(`  ${seiten} Seiten, ${gesehen} Einträge gesichtet ...`);
    url = data.next ?? null;
  }

  return { zeilen, seiten, gesehen };
}

/**
 * Schreibt eine Tabelle neu: alles hochladen (mit dem Zeitstempel dieses Laufs), danach alles
 * löschen, was einen älteren Zeitstempel trägt - das sind genau die Zeilen, die es in der Quelle
 * nicht mehr gibt.
 *
 * Bewusst so herum und nicht "erst leeren, dann füllen": supabase-js kennt keine Transaktion über
 * mehrere Aufrufe. Bräche der Lauf zwischen Leeren und Füllen ab, stünde die Tabelle bis zur
 * nächsten Nacht leer da und die App zeigte kommentarlos "keine Tutoren, keine Combos". So ist
 * der schlimmste Fall dagegen ein Bestand aus zwei Läufen - nie ein leerer.
 */
async function schreibeTabelle(tabelle, konflikt, zeilen, laufBegonnen) {
  for (let i = 0; i < zeilen.length; i += 500) {
    const { error } = await supabase
      .from(tabelle)
      .upsert(zeilen.slice(i, i + 500), { onConflict: konflikt });
    if (error) throw new Error(`Upsert in ${tabelle} fehlgeschlagen: ${error.message}`);
  }

  const { error, count } = await supabase
    .from(tabelle)
    .delete({ count: 'exact' })
    .lt('synced_at', laufBegonnen);
  if (error) throw new Error(`Aufräumen in ${tabelle} fehlgeschlagen: ${error.message}`);
  if (count) console.log(`  ${count} veraltete Zeilen aus ${tabelle} entfernt.`);
}

async function writeSyncState(id, rowCount) {
  const { error } = await supabase
    .from('spellbook_sync_state')
    .upsert({ id, synced_at: new Date().toISOString(), row_count: rowCount }, { onConflict: 'id' });
  if (error)
    throw new Error(`Konnte spellbook_sync_state (${id}) nicht schreiben: ${error.message}`);
}

// =====================================================================================
// Teil 1: Kartenmarkierungen (Mass Land Denial / Extra-Turn / Tutor)
// =====================================================================================

async function syncKartenFlags(laufBegonnen) {
  console.log('--- Teil 1: Kartenmarkierungen ---');

  const { zeilen, seiten, gesehen } = await ladeAlleSeiten(`${API}/cards/?limit=100`, (card) => {
    // Nur Karten mit mindestens einem Flag - siehe Begründung in der Migration. Die übrigen
    // ~7.900 tragen lauter "false" und beantworten keine einzige Frage.
    if (!card.massLandDenial && !card.extraTurn && !card.tutor) return null;
    return {
      name_normalized: normalizedFrontName(card.name),
      mass_land_denial: card.massLandDenial ?? false,
      extra_turn: card.extraTurn ?? false,
      tutor: card.tutor ?? false,
      synced_at: laufBegonnen,
    };
  });

  // Ein leeres Ergebnis ist nie richtig: die Listen sind kuratiert und ändern sich nur langsam.
  // Wäre es leer, hätte Spellbook die Felder umbenannt - dann lieber laut abbrechen, als die
  // Tabelle stillschweigend leerzuräumen und die Tutoren aus der App verschwinden zu lassen.
  if (zeilen.length === 0) {
    throw new Error(
      'Keine einzige markierte Karte gefunden - Feldnamen bei Commander Spellbook geprüft? ' +
        'Erwartet werden massLandDenial / extraTurn / tutor. Abbruch, um die Tabelle nicht zu leeren.',
    );
  }

  await schreibeTabelle('spellbook_card_flags', 'name_normalized', zeilen, laufBegonnen);
  await writeSyncState('card_flags', zeilen.length);

  const zaehle = (feld) => zeilen.filter((z) => z[feld]).length;
  console.log(
    `Teil 1 fertig: ${zeilen.length} markierte Karten aus ${gesehen} (${seiten} Seiten) - ` +
      `${zaehle('mass_land_denial')} Mass Land Denial, ${zaehle('extra_turn')} Extra-Turn, ${zaehle('tutor')} Tutoren.`,
  );
}

// =====================================================================================
// Teil 2: Zwei-Karten-Combos
// =====================================================================================

async function syncCombos(laufBegonnen) {
  console.log('--- Teil 2: Zwei-Karten-Combos ---');

  // "cards=2" ist Spellbooks eigene Suchsyntax und filtert schon serverseitig auf das, was das
  // Bracket-Kriterium meint - 3.985 statt 108.535 Varianten.
  const url = `${API}/variants/?q=${encodeURIComponent('cards=2')}&limit=100`;

  const { zeilen, seiten, gesehen } = await ladeAlleSeiten(url, (variant) => {
    const uses = variant.uses ?? [];
    // Die Suche liefert vereinzelt auch Varianten mit nur einer Karte plus "requires"-Vorlagen
    // (gemessen: 3 von 3.985). Die sind hier nicht abbildbar und werden übersprungen.
    if (uses.length !== 2) return null;
    const [a, b] = uses;
    if (!a?.card?.name || !b?.card?.name) return null;

    return {
      id: variant.id,
      card_a_normalized: normalizedFrontName(a.card.name),
      card_b_normalized: normalizedFrontName(b.card.name),
      a_must_be_commander: a.mustBeCommander ?? false,
      b_must_be_commander: b.mustBeCommander ?? false,
      mana_value_needed: variant.manaValueNeeded ?? null,
      bracket_tag: variant.bracketTag ?? null,
      popularity: variant.popularity ?? null,
      synced_at: laufBegonnen,
    };
  });

  if (zeilen.length === 0) {
    throw new Error(
      'Keine einzige Zwei-Karten-Combo gefunden - Suchsyntax "cards=2" bei Commander Spellbook ' +
        'geprüft? Abbruch, um die Tabelle nicht zu leeren.',
    );
  }

  await schreibeTabelle('spellbook_two_card_combos', 'id', zeilen, laufBegonnen);
  await writeSyncState('two_card_combos', zeilen.length);

  console.log(
    `Teil 2 fertig: ${zeilen.length} Zwei-Karten-Combos aus ${gesehen} Varianten (${seiten} Seiten).`,
  );
}

async function main() {
  // EIN Zeitstempel für den ganzen Lauf, gegen den am Ende jeder Tabelle aufgeräumt wird. Würde
  // je Zeile new Date() genommen, wäre die Grenze zum Aufräumen unscharf.
  const laufBegonnen = new Date().toISOString();
  await syncKartenFlags(laufBegonnen);
  await syncCombos(laufBegonnen);
  console.log('Abgleich abgeschlossen.');
}

main().catch((err) => {
  console.error('Abgleich fehlgeschlagen:', err.message);
  process.exit(1);
});
