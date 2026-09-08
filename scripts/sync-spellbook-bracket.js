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
// Seit dem Combo-Finder holt derselbe Durchgang zusätzlich ALLE Combos bis fünf Karten samt
// Ergebnis und Ablauf (Tabellen und Begründung: sql/spellbook-combos-2026-09-07.sql). Die
// Zwei-Karten-Combos fallen dabei als Teilmenge mit ab - es wird bewusst nur EINMAL
// heruntergeladen, nicht zweimal mit verschiedenen Suchen.
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
const VERSUCHE = 8;

/**
 * Mindestpause zwischen zwei Seitenabrufen.
 *
 * Nachgemessen, nachdem ein Lauf nach 136 Anfragen an Spellbooks Rate-Limit gescheitert war
 * (HTTP 429 ab Seite 54 von 1.085, sechs Wiederholungen über drei Minuten halfen nicht): Deren
 * Kontingent liegt bei etwa 130 Anfragen je Zeitfenster, und ungebremst schafft der Lauf gut zwei
 * Seiten pro Sekunde - er reißt es also nach knapp einer Minute zuverlässig.
 *
 * Eine Sekunde Pause hält uns mit rund 60 Anfragen pro Minute klar darunter. Der Preis sind rund
 * 20 Minuten mehr Laufzeit für die 1.085 Combo-Seiten. Das ist für einen Nachtlauf kein Preis -
 * ein abgebrochener Lauf, der 95 % der Daten nicht holt, dagegen schon.
 */
const PAUSE_JE_SEITE = 1000;

/**
 * Mindestwartezeit nach einem 429. Der normale Backoff (3, 6, 12 s ...) ist gegen ein
 * Kontingent-pro-Minute wirkungslos - er versucht es immer wieder innerhalb desselben Fensters.
 * Eine Minute wartet das Fenster sicher aus.
 */
const PAUSE_NACH_LIMIT = 60000;

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
      if (res.status === 429) wartezeit = Math.max(wartezeit, PAUSE_NACH_LIMIT);
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
    if (url) await sleep(PAUSE_JE_SEITE);
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
// Teil 2: Alle Combos bis fünf Karten - und die Zwei-Karten-Combos als Teilmenge daraus
// =====================================================================================

/**
 * Bis zu wie vielen Karten eine Combo gespiegelt wird.
 *
 * Nachgemessen an Spellbooks API: cards<=3 sind 51.295 Combos, cards<=4 sind 98.274, cards<=5
 * sind 108.487 - also praktisch der ganze Bestand (108.535 Varianten insgesamt). Der Combo-Finder
 * braucht alle Größen, weil "zwei Karten liegen im Deck, die dritte fehlt" derselbe Vorschlag ist
 * wie "eine liegt, die zweite fehlt".
 */
const MAX_KARTEN_JE_COMBO = 5;

/** Ab so vielen gepufferten Zeilen wird geschrieben - siehe schreibeBlock(). */
const PUFFER = 500;

/**
 * Schreibt einen Block und wirft bei Fehlschlag - anders als der Rest des Skripts wird hier
 * seitenweise geschrieben statt am Ende alles auf einmal: 108.500 Combos mit Ablaufbeschreibung
 * plus 350.000 Kartenzeilen erst vollständig im Speicher zu sammeln wäre eine unnötige
 * Viertelgigabyte.
 */
async function schreibeBlock(tabelle, konflikt, zeilen) {
  if (zeilen.length === 0) return;
  const { error } = await supabase.from(tabelle).upsert(zeilen, { onConflict: konflikt });
  if (error) throw new Error(`Upsert in ${tabelle} fehlgeschlagen: ${error.message}`);
}

/** Entfernt, was in der Quelle nicht mehr vorkommt - dieselbe Logik wie in schreibeTabelle(). */
async function raeumeAuf(tabelle, laufBegonnen) {
  const { error, count } = await supabase
    .from(tabelle)
    .delete({ count: 'exact' })
    .lt('synced_at', laufBegonnen);
  if (error) throw new Error(`Aufräumen in ${tabelle} fehlgeschlagen: ${error.message}`);
  if (count) console.log(`  ${count} veraltete Zeilen aus ${tabelle} entfernt.`);
}

/**
 * Gibt es die Spalte spellbook_combos.mana_needed schon?
 *
 * Sie kam später dazu (siehe sql/spellbook-combos-2026-09-07.sql), und die Migrationen dieses
 * Projekts laufen von Hand. Ohne diese Prüfung stürbe der ganze Nachtlauf an einer noch nicht
 * eingespielten Migration - und mit ihm die Bracket-Grunddaten, die davon gar nicht abhängen.
 * Lieber die Manaangabe eine Nacht später als alles gar nicht.
 */
async function hatManaSpalte() {
  const { error } = await supabase.from('spellbook_combos').select('mana_needed').limit(1);
  if (!error) return true;
  console.warn(
    'Spalte spellbook_combos.mana_needed fehlt - die Manaangaben bleiben diesmal leer. ' +
      'sql/spellbook-combos-2026-09-07.sql im Supabase-SQL-Editor ausführen, dann sind sie beim ' +
      `nächsten Lauf dabei. (${error.message})`,
  );
  return false;
}

async function syncCombos(laufBegonnen) {
  console.log(`--- Teil 2: Combos bis ${MAX_KARTEN_JE_COMBO} Karten ---`);
  const manaSpalte = await hatManaSpalte();

  // "cards<=5" ist Spellbooks eigene Suchsyntax und filtert schon serverseitig.
  let url = `${API}/variants/?q=${encodeURIComponent(`cards<=${MAX_KARTEN_JE_COMBO}`)}&limit=100`;

  let seiten = 0;
  let gesehen = 0;
  let combos = 0;
  let kartenzeilen = 0;
  let zweier = 0;

  let comboPuffer = [];
  let kartenPuffer = [];
  let zweierPuffer = [];

  // Die Combos MÜSSEN vor ihren Kartenzeilen stehen: spellbook_combo_cards zeigt per Fremdschlüssel
  // auf spellbook_combos, ein Kartenblock ohne seine Combo würde abgewiesen.
  const leerePuffer = async () => {
    await schreibeBlock('spellbook_combos', 'id', comboPuffer);
    await schreibeBlock('spellbook_combo_cards', 'combo_id,name_normalized', kartenPuffer);
    await schreibeBlock('spellbook_two_card_combos', 'id', zweierPuffer);
    comboPuffer = [];
    kartenPuffer = [];
    zweierPuffer = [];
  };

  while (url) {
    const data = await fetchJson(url);
    const treffer = data.results ?? [];

    if (seiten === 0 && treffer.length > 0) {
      // Einmalige Kontrolle im Lauf-Protokoll, dass Spellbooks Feldnamen noch die sind, die wir
      // erwarten - eine stille Umbenennung dort würde sonst erst in der App auffallen, als
      // plötzlich leere Combo-Listen.
      console.log('  Felder des ersten Eintrags:', Object.keys(treffer[0]).sort().join(', '));
    }

    for (const variant of treffer) {
      gesehen++;
      const uses = variant.uses ?? [];
      if (uses.length < 2) continue;

      // Combos, die zusätzlich eine VORLAGE brauchen ("Permanent Castable for {C}", "Man-Land
      // that Enters Untapped"), bleiben draußen. Sie sind über eine Kartenliste nicht prüfbar:
      // Der Combo-Finder würde "dir fehlt nur diese eine Karte" behaupten, obwohl daneben noch
      // eine Karte mit einer bestimmten Eigenschaft nötig ist.
      //
      // Genau hier lag ein Fehler: Ohne diese Prüfung zählte "uses.length === 2" auch solche
      // Combos als Zwei-Karten-Combo. Die Tabelle wuchs dadurch von 3.982 auf 5.190 Zeilen - und
      // weil sie das offizielle Bracket-Kriterium trägt, hätte das Decks zu hoch eingestuft.
      // Spellbooks eigene Suche "cards=2" kennt diese Combos zu Recht nicht.
      if ((variant.requires ?? []).length > 0) continue;

      // Karten je Combo eindeutig machen: die Quelle führt eine doppelt genutzte Karte über
      // "quantity", nicht als zweiten Eintrag - ein doppelter Name wäre also eine Eigenheit der
      // Daten und würde am Primärschlüssel (combo_id, name_normalized) scheitern.
      const karten = new Map();
      for (const u of uses) {
        const name = u?.card?.name;
        if (!name) continue;
        const key = normalizedFrontName(name);
        const bisher = karten.get(key);
        karten.set(key, {
          combo_id: variant.id,
          name_normalized: key,
          must_be_commander: (bisher?.must_be_commander ?? false) || (u.mustBeCommander ?? false),
          synced_at: laufBegonnen,
        });
      }
      if (karten.size !== uses.length) {
        // Namen konnten nicht aufgelöst werden oder doppelten sich - dann stimmt card_count nicht
        // mehr zur Kartenliste, und die Suchfunktion in der Datenbank zählt falsch.
        continue;
      }

      comboPuffer.push({
        id: variant.id,
        card_count: karten.size,
        produces: (variant.produces ?? []).map((p) => p?.feature?.name).filter(Boolean),
        description: variant.description ?? '',
        ...(manaSpalte ? { mana_needed: variant.manaNeeded || null } : {}),
        mana_value_needed: variant.manaValueNeeded ?? null,
        bracket_tag: variant.bracketTag ?? null,
        popularity: variant.popularity ?? null,
        synced_at: laufBegonnen,
      });
      for (const zeile of karten.values()) kartenPuffer.push(zeile);
      combos++;
      kartenzeilen += karten.size;

      // Die Zwei-Karten-Combos fallen hier als Teilmenge mit ab - die Bracket-Einstufung liest
      // weiterhin ihre eigene schmale Tabelle (siehe sql/spellbook-combos-2026-09-07.sql).
      if (uses.length === 2) {
        const [a, b] = uses;
        if (a?.card?.name && b?.card?.name) {
          zweierPuffer.push({
            id: variant.id,
            card_a_normalized: normalizedFrontName(a.card.name),
            card_b_normalized: normalizedFrontName(b.card.name),
            a_must_be_commander: a.mustBeCommander ?? false,
            b_must_be_commander: b.mustBeCommander ?? false,
            mana_value_needed: variant.manaValueNeeded ?? null,
            bracket_tag: variant.bracketTag ?? null,
            popularity: variant.popularity ?? null,
            synced_at: laufBegonnen,
          });
          zweier++;
        }
      }
    }

    if (comboPuffer.length >= PUFFER) await leerePuffer();

    seiten++;
    if (seiten % 50 === 0) {
      console.log(`  ${seiten} Seiten, ${gesehen} Combos gesichtet, ${combos} geschrieben ...`);
    }
    url = data.next ?? null;
    if (url) await sleep(PAUSE_JE_SEITE);
  }

  await leerePuffer();

  // Ein leeres Ergebnis ist nie richtig - lieber laut abbrechen, als die Tabellen stillschweigend
  // leerzuräumen und Combo-Finder wie Bracket-Kriterium aus der App verschwinden zu lassen.
  if (combos === 0) {
    throw new Error(
      `Keine einzige Combo gefunden - Suchsyntax "cards<=${MAX_KARTEN_JE_COMBO}" bei Commander ` +
        'Spellbook geprüft? Abbruch, um die Tabellen nicht zu leeren.',
    );
  }
  if (zweier === 0) {
    throw new Error(
      'Combos gefunden, aber keine einzige mit genau zwei Karten - das kann nicht stimmen und ' +
        'würde die Bracket-Einstufung leerräumen. Abbruch.',
    );
  }

  // Erst die Kartenzeilen, dann die Combos: eine gelöschte Combo nimmt ihre Karten per
  // "on delete cascade" ohnehin mit, andersherum blieben Kartenzeilen zu noch existierenden
  // Combos stehen, die dort inzwischen nicht mehr mitspielen.
  await raeumeAuf('spellbook_combo_cards', laufBegonnen);
  await raeumeAuf('spellbook_combos', laufBegonnen);
  await raeumeAuf('spellbook_two_card_combos', laufBegonnen);

  await writeSyncState('combos', combos);
  await writeSyncState('combo_cards', kartenzeilen);
  await writeSyncState('two_card_combos', zweier);

  console.log(
    `Teil 2 fertig: ${combos} Combos (${kartenzeilen} Kartenzeilen) aus ${gesehen} Varianten ` +
      `(${seiten} Seiten), darunter ${zweier} mit genau zwei Karten.`,
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
