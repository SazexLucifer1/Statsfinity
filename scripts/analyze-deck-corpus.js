// Auswertung: Was macht ein starkes Commander-Deck aus, und welche Kennzahl misst das?
//
// Hintergrund und Ergebnis: docs/deck-metriken-2026-09.md
//
// Dieses Skript gehört NICHT zu den nächtlichen Abgleichen. Es ist ein Forschungslauf, der von
// Hand angestoßen wird, wenn die Zahlen neu erhoben werden sollen:
//
//   node scripts/analyze-deck-corpus.js
//
// Was es tut:
//   1. Baut vier Korpusquellen:
//        a) cEDH-Decks (EDHREC), b) dieselben Commander ohne cEDH-Filter,
//        c) die Commander-Precons der letzten Jahre als Anker am unteren Ende,
//        d) BRACKET-GELABELTE Decks - je Bracket 1 bis 5 ein Deck pro Commander, aus EDHRECs
//           bracket-gefilterten Durchschnittsdecks.
//      Quelle d) ist der Teil, der der Auswertung bis dahin komplett fehlte: ein Deck mit einer
//      Bracket-Angabe, die nicht von uns stammt.
//   2. Rechnet für jedes Deck die Kennzahlen aus src/app/deck-metrics.ts und die Simulation aus
//      src/app/goldfish-sim.ts. Dieselben Funktionen, die später in der App laufen - es gibt
//      bewusst keine zweite Implementierung, die auseinanderdriften könnte.
//   3. Zählt nach, wie viel vom Korpus die Simulation überhaupt erfasst (farbige Kosten, Hybrid,
//      Phyrexia, {X}, Kartenziehen, Manakreaturen) - die Zahlen stehen im Bericht.
//   4. Schreibt Messwerte (CSV) und Bericht (Markdown) nach docs/.
//
// Warum die Bracket-Listen von EDHREC kommen und nicht von Moxfield oder Archidekt: Beide Seiten
// sind aus der Umgebung, in der dieses Skript entstanden ist, nicht erreichbar (die Egress-Policy
// beantwortet den CONNECT mit 403; siehe den Abschnitt "Grenzen" im Bericht). EDHREC liefert je
// Commander und Bracket ein Durchschnittsdeck, gemittelt über die Decks, die es selbst unter diesem
// Bracket führt, und nennt deren Zahl daneben (Feld bracket_counts). Das ist ein Fremdlabel - aber
// ein gemitteltes und keine Einzelliste, und wer es ursprünglich vergibt, war von hier aus nicht
// nachprüfbar. Beides steht so im Bericht.
//
// Kartendaten kommen aus der eigenen Supabase (scryfall_cards, scryfall_card_effects,
// spellbook_*), die der Nachtlauf ohnehin füllt. Das Skript LIEST nur - der öffentliche Anon-Key
// reicht, ein Service-Role-Key ist hier weder nötig noch erwünscht.
//
// Höflichkeit gegenüber EDHREC: eine Anfrage pro Sekunde, aussagekräftiger User-Agent, und die
// heruntergeladenen Decklisten bleiben lokal im Cache-Verzeichnis. Veröffentlicht werden nur die
// gerechneten Zahlen, nicht die fremden Listen.

const fs = require('fs');
const path = require('path');
const { registerHooks } = require('node:module');

// Node löst "./deck-metrics" ohne Endung nicht auf, TypeScript schon. Dieser Haken schließt die
// Lücke und erspart einen Build-Schritt nur für dieses Skript - die Module bleiben damit an genau
// einer Stelle, statt für die Auswertung ein zweites Mal zu existieren.
registerHooks({
  resolve(specifier, context, next) {
    if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      return next(specifier + '.ts', context);
    }
    return next(specifier, context);
  },
});

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://jkkelwpnrgzbvopszwrl.supabase.co';
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impra2Vsd3Bucmd6YnZvcHN6d3JsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMTA3MzAsImV4cCI6MjA5OTY4NjczMH0.2-8ySikqL7fnwJ60HjOiN6NSgVfGc47Mrouct7NlL8M';

const UA = 'Statsfinity/1.0 (Deck-Metrik-Auswertung; https://github.com/SazexLucifer1/Statsfinity)';
const EDHREC = 'https://json.edhrec.com/pages';
const MTGJSON = 'https://mtgjson.com/api/v5';

const CACHE_DIR =
  process.env.CORPUS_CACHE ?? path.join(require('os').tmpdir(), 'statsfinity-korpus');
const DOCS_DIR = path.join(__dirname, '..', 'docs');

/** Ziel-Deckzahl je Korpus. Bewusst als Konstante: die Zahl steht so auch im Bericht. */
const ZIEL_CEDH_DECKS = Number(process.env.ZIEL_CEDH_DECKS ?? 250);
const SIM_SPIELE = Number(process.env.SIM_SPIELE ?? 2000);

/**
 * Die fünf Brackets, wie EDHREC sie in den Pfad schreibt.
 *
 * Die Namen sind die offiziellen Bracket-Bezeichnungen des Commander-Formats; die Zahl daneben ist
 * die Bracket-Stufe. EDHRECs Pfad /pages/average-decks/<commander>/<name>.json liefert das
 * Durchschnittsdeck über genau die Decks dieses Brackets.
 */
const BRACKETS = [
  [1, 'exhibition', 'Exhibition'],
  [2, 'core', 'Core'],
  [3, 'upgraded', 'Upgraded'],
  [4, 'optimized', 'Optimized'],
  [5, 'cedh', 'cEDH'],
];

/** Wie viele Commander in den Bracket-Korpus gehen (EDHRECs Top-Liste der letzten zwei Jahre). */
const ZIEL_BRACKET_COMMANDER = Number(process.env.ZIEL_BRACKET_COMMANDER ?? 100);

/**
 * Ab wie vielen echten Decks ein Bracket-Durchschnitt überhaupt gezählt wird.
 *
 * Ohne diese Schwelle stünde neben einem Durchschnitt aus 4.343 Listen einer aus 7 - und beide
 * zählten im Median gleich viel. EDHREC nennt die Zahl je Bracket selbst (Feld bracket_counts),
 * sie steht deshalb auch in der CSV neben jedem Deck.
 */
const MIN_DECKS_JE_BRACKET = Number(process.env.MIN_DECKS_JE_BRACKET ?? 50);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gleiche Normalisierung wie array-utils.ts - der Schlüssel, unter dem alle Tabellen zusammenfinden.
const normalizeCardName = (name) =>
  name
    .split(' // ')[0]
    .trim()
    .toLowerCase()
    .replace(/[’‘´`]/g, "'");

// =====================================================================================
// 1. Korpora holen
// =====================================================================================

function cacheLesen(name) {
  const datei = path.join(CACHE_DIR, name);
  return fs.existsSync(datei) ? JSON.parse(fs.readFileSync(datei, 'utf8')) : null;
}

function cacheSchreiben(name, daten) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify(daten));
}

async function holen(url, cacheName) {
  const gecacht = cacheName && cacheLesen(cacheName);
  if (gecacht) return gecacht;

  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const daten = await res.json();
  if (cacheName) cacheSchreiben(cacheName, daten);
  await sleep(1000); // eine Anfrage pro Sekunde, siehe Kopfkommentar
  return daten;
}

/** EDHRECs eigene Slug-Regel, wortgleich zu EdhrecService.slugify(). */
function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’,.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Aus einem EDHREC-Durchschnittsdeck die Kartenliste ziehen: [{ name, quantity, isCommander }]. */
function decklisteAus(daten) {
  const deck = daten?.deck;
  if (!deck?.cards) return null;

  const commander = new Set((deck.commander ?? []).map(normalizeCardName));
  const karten = [];
  for (const gruppe of Object.values(deck.cards)) {
    for (const [name, anzahl] of gruppe) {
      karten.push({ name, quantity: anzahl, isCommander: commander.has(normalizeCardName(name)) });
    }
  }
  for (const name of deck.commander ?? []) {
    if (!karten.some((k) => normalizeCardName(k.name) === normalizeCardName(name))) {
      karten.push({ name, quantity: 1, isCommander: true });
    }
  }
  return karten.length >= 50 ? karten : null;
}

/**
 * Korpus 1 und 2: cEDH-Decks und dieselben Commander ohne cEDH-Filter.
 *
 * Die Breitensuche läuft über EDHRECs "ähnliche Commander" - aus den 29 Startpunkten der
 * cEDH-Übersichtsseite werden so mehrere hundert. Dass BEIDE Korpora dieselben Commander haben,
 * ist der Kern der Auswertung: Was sich dann noch unterscheidet, ist die Bauweise, nicht der
 * Commander.
 */
async function holeEdhrecKorpora() {
  const start = await holen(`${EDHREC}/tags/cedh.json`, 'tags-cedh.json');
  if (!start) throw new Error('EDHREC-Übersichtsseite nicht erreichbar');

  const listen = start.container?.json_dict?.cardlists ?? [];
  const warteschlange = listen
    .filter((l) => /Commanders/i.test(l.header))
    .flatMap((l) => l.cardviews.map((c) => c.slug));

  const gesehen = new Set(warteschlange);
  const cedh = [];
  const normal = [];

  while (warteschlange.length > 0 && cedh.length < ZIEL_CEDH_DECKS) {
    const slug = warteschlange.shift();

    const cedhDaten = await holen(`${EDHREC}/average-decks/${slug}/cedh.json`, `cedh-${slug}.json`);
    if (!cedhDaten) continue;

    const liste = decklisteAus(cedhDaten);
    if (liste) cedh.push({ id: slug, name: slug, cards: liste });

    for (const aehnlich of cedhDaten.similar ?? []) {
      const nachbar = slugify(aehnlich);
      if (nachbar && !gesehen.has(nachbar)) {
        gesehen.add(nachbar);
        warteschlange.push(nachbar);
      }
    }

    const normalDaten = await holen(`${EDHREC}/average-decks/${slug}.json`, `normal-${slug}.json`);
    const normalListe = normalDaten && decklisteAus(normalDaten);
    if (normalListe) normal.push({ id: slug, name: slug, cards: normalListe });

    if (cedh.length % 25 === 0) console.log(`  … ${cedh.length} cEDH-Decks`);
  }

  return { cedh, normal };
}

/**
 * Korpus 4: Decks MIT Bracket-Label.
 *
 * Das ist der Teil, der der ersten Auswertung fehlte. Dort hieß es "cEDH" und "nicht cEDH", weil
 * das die einzige Einteilung war, die von außen kam - eine Bracket-Stufe hatte kein einziges Deck.
 * Ohne die lässt sich die eigentliche Frage der Bracket-Automatik ("ist das 3 oder 4?") gar nicht
 * stellen.
 *
 * Woher das Label kommt, gehört zu jeder dieser Zeilen dazu - und was davon nachgeprüft ist:
 *   - NACHGEPRÜFT: EDHREC führt zu jedem eingereichten Deck eine Bracket-Angabe (Feld `bracket` in
 *     /pages/decks/<commander>.json) und liefert unter
 *     /pages/average-decks/<commander>/<bracket>.json das Durchschnittsdeck über genau die so
 *     eingestuften Decks. Wie viele es sind, steht im selben Dokument (bracket_counts); die Zahl
 *     landet in der CSV neben jedem Deck, unterhalb von MIN_DECKS_JE_BRACKET wird verworfen.
 *   - NICHT NACHGEPRÜFT: ob EDHREC die Bracket-Angabe des Deck-Autors von Moxfield bzw. Archidekt
 *     übernimmt oder selbst einstuft. edhrec.com und beide Deckseiten sind aus dieser Umgebung
 *     gesperrt (siehe Kopfkommentar), und json.edhrec.com sagt dazu nichts. Festhalten lässt sich
 *     also: ein Fremdlabel von EDHREC über eine bekannte Zahl echter Listen - nicht mehr.
 *
 * Eine Einzelliste je Deck wäre besser als ein Durchschnitt; sie hätte von Moxfield oder Archidekt
 * kommen müssen und war nicht zu holen.
 */
async function holeBracketKorpora() {
  const top = await holen(`${EDHREC}/commanders/year.json`, 'commanders-year.json');
  const listen = top?.container?.json_dict?.cardlists ?? [];
  const commander = listen
    .flatMap((l) => l.cardviews.map((c) => c.sanitized ?? c.slug))
    .filter(Boolean)
    .slice(0, ZIEL_BRACKET_COMMANDER);

  const decks = [];
  for (const slug of commander) {
    for (const [stufe, pfad, name] of BRACKETS) {
      const daten = await holen(
        `${EDHREC}/average-decks/${slug}/${pfad}.json`,
        `bracket-${pfad}-${slug}.json`,
      );
      const liste = daten && decklisteAus(daten);
      if (!liste) continue;

      const dahinter = Number(daten.bracket_counts?.[String(stufe)] ?? 0);
      if (dahinter < MIN_DECKS_JE_BRACKET) continue;

      decks.push({
        id: `${slug}-${pfad}`,
        name: `${slug} (${name})`,
        cards: liste,
        korpus: `Bracket ${stufe}`,
        bracket: stufe,
        labelQuelle: `EDHREC-Bracket "${pfad}" (Fremdlabel von EDHREC, Herkunft nicht nachgeprüft)`,
        deckeDahinter: dahinter,
        quelle: `${EDHREC}/average-decks/${slug}/${pfad}.json`,
      });
    }
    if (decks.length % 50 === 0 && decks.length > 0) {
      console.log(`  … ${decks.length} Bracket-Decks`);
    }
  }
  return decks;
}

/** Korpus 3: die Commander-Precons 2023-2026 von MTGJSON - der Bracket-2-Anker. */
async function holePrecons() {
  const index = await holen(`${MTGJSON}/DeckList.json`, 'mtgjson-decklist.json');
  if (!index) return [];

  const precons = (index.data ?? []).filter(
    (d) => d.type === 'Commander Deck' && new Date(d.releaseDate).getFullYear() >= 2023,
  );

  const decks = [];
  for (const precon of precons) {
    const daten = await holen(
      `${MTGJSON}/decks/${encodeURIComponent(precon.fileName)}.json`,
      `precon-${precon.fileName}.json`,
    );
    if (!daten?.data) continue;

    const commander = daten.data.commander ?? [];
    const karten = [
      ...commander.map((c) => ({ name: c.name, quantity: c.count, isCommander: true })),
      ...(daten.data.mainBoard ?? []).map((c) => ({
        name: c.name,
        quantity: c.count,
        isCommander: false,
      })),
    ];
    decks.push({ id: precon.fileName, name: precon.name, cards: karten });
  }
  return decks;
}

// =====================================================================================
// 2. Kartendaten aus der eigenen Supabase
// =====================================================================================

async function supabase(pfad, params) {
  const url = `${SUPABASE_URL}/rest/v1/${pfad}?${params}`;
  const res = await fetch(url, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`Supabase ${pfad}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

/** Holt zeilenweise in Seiten zu 1000 - PostgREST liefert nie mehr auf einmal. */
async function supabaseAlle(pfad, params) {
  const alle = [];
  for (let offset = 0; ; offset += 1000) {
    const seite = await supabase(pfad, `${params}&limit=1000&offset=${offset}`);
    alle.push(...seite);
    if (seite.length < 1000) return alle;
  }
}

/** Wie oben, aber die Namensliste in Häppchen - eine in.()-Liste mit 5.000 Namen sprengt die URL. */
async function supabaseNachNamen(pfad, spalten, namensSpalte, namen) {
  const alle = [];
  for (let i = 0; i < namen.length; i += 200) {
    const haeppchen = namen.slice(i, i + 200).map((n) => `"${n.replace(/"/g, '')}"`);
    alle.push(
      ...(await supabaseAlle(
        pfad,
        `select=${spalten}&${namensSpalte}=in.(${encodeURIComponent(haeppchen.join(','))})`,
      )),
    );
  }
  return alle;
}

async function ladeKartendaten(namen) {
  console.log(`  Kartendaten für ${namen.length} verschiedene Karten …`);

  const karten = await supabaseNachNamen(
    'scryfall_cards',
    'front_name_normalized,name,cmc,mana_cost,type_line,oracle_text,produced_mana,game_changer',
    'front_name_normalized',
    namen,
  );
  const effekte = await supabaseNachNamen(
    'scryfall_card_effects',
    'category,front_name_normalized',
    'front_name_normalized',
    namen,
  );
  const flags = await supabaseAlle(
    'spellbook_card_flags',
    'select=name_normalized,mass_land_denial,extra_turn,tutor',
  );

  const kartenNachSchluessel = new Map(karten.map((k) => [k.front_name_normalized, k]));

  const effektNachSchluessel = new Map();
  for (const e of effekte) {
    if (!effektNachSchluessel.has(e.front_name_normalized)) {
      effektNachSchluessel.set(e.front_name_normalized, new Set());
    }
    effektNachSchluessel.get(e.front_name_normalized).add(e.category);
  }

  const flagNachSchluessel = new Map(
    flags.map((f) => [
      f.name_normalized,
      { massLandDenial: f.mass_land_denial, extraTurn: f.extra_turn, tutor: f.tutor },
    ]),
  );

  return { kartenNachSchluessel, effektNachSchluessel, flagNachSchluessel };
}

/**
 * Combos bis drei Karten, die überhaupt eine Karte aus dem Korpus enthalten.
 *
 * Warum bei drei Schluss ist: Es gibt 103.286 Combos, davon 50.333 mit bis zu drei Karten und
 * 367.153 Kartenzeilen insgesamt. Alles zu laden wäre eine Viertelstunde Datentransfer für
 * Combos, die in einem 100-Karten-Deck praktisch nie vollständig liegen. Die Grenze steht hier,
 * damit sie im Bericht genannt werden kann, statt stillschweigend zu wirken.
 */
async function ladeCombos(namen) {
  console.log('  Combos (bis drei Karten) …');
  const zeilen = await supabaseNachNamen(
    'spellbook_combo_cards',
    'combo_id,name_normalized,must_be_commander,spellbook_combos!inner(card_count,produces,mana_value_needed)',
    'name_normalized',
    namen,
  );

  const combos = new Map();
  for (const zeile of zeilen) {
    const meta = zeile.spellbook_combos;
    if (!meta || meta.card_count > 3) continue;

    let combo = combos.get(zeile.combo_id);
    if (!combo) {
      combo = {
        id: zeile.combo_id,
        cards: [],
        mustBeCommander: [],
        manaValueNeeded: meta.mana_value_needed ?? 0,
        produces: meta.produces ?? [],
        cardCount: meta.card_count,
      };
      combos.set(zeile.combo_id, combo);
    }
    combo.cards.push(zeile.name_normalized);
    if (zeile.must_be_commander) combo.mustBeCommander.push(zeile.name_normalized);
  }

  // Combos, von denen wir gar nicht alle Karten gesehen haben, können in keinem Deck vollständig
  // liegen - die fehlende Karte kommt im ganzen Korpus nicht vor.
  return [...combos.values()].filter((c) => c.cards.length === c.cardCount);
}

// =====================================================================================
// 3. Kennzahlen je Deck
// =====================================================================================

/** Aus roher Deckliste plus Kartendaten die Eingabe für deck-metrics.ts / goldfish-sim.ts bauen. */
function baueEingabe(deck, daten, combos) {
  const { kartenNachSchluessel, effektNachSchluessel, flagNachSchluessel } = daten;

  const cards = [];
  let unbekannt = 0;
  for (const zeile of deck.cards) {
    const key = normalizeCardName(zeile.name);
    const info = kartenNachSchluessel.get(key);
    if (!info) {
      unbekannt += zeile.quantity;
      continue;
    }
    cards.push({
      name: info.name,
      key,
      quantity: zeile.quantity,
      cmc: info.cmc ?? 0,
      manaCost: info.mana_cost ?? '',
      typeLine: info.type_line ?? '',
      oracleText: info.oracle_text ?? '',
      producedMana: info.produced_mana ?? [],
      gameChanger: info.game_changer === true,
      isCommander: zeile.isCommander === true,
    });
  }

  const imDeck = new Set(cards.map((c) => c.key));
  const eigeneCombos = combos.filter((c) => c.cards.every((k) => imDeck.has(k)));

  return {
    eingabe: {
      cards,
      combos: eigeneCombos,
      flags: flagNachSchluessel,
      effects: effektNachSchluessel,
    },
    unbekannt,
  };
}

// =====================================================================================
// 4. Statistik
// =====================================================================================

const median = (werte) => quantil(werte, 0.5);

function quantil(werte, q) {
  const s = werte.filter((w) => w !== null && Number.isFinite(w)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const pos = (s.length - 1) * q;
  const unten = Math.floor(pos);
  const oben = Math.ceil(pos);
  return unten === oben ? s[unten] : s[unten] + (s[oben] - s[unten]) * (pos - unten);
}

/**
 * Trennschärfe zweier Gruppen: Wie oft liegt ein zufälliges Deck aus A über einem aus B?
 *
 * 0,5 heißt "die Metrik weiß nichts" (reines Münzwerfen), 1,0 heißt "sie trennt die beiden
 * Gruppen vollständig". Das ist die Zahl, an der im Bericht entschieden wird, ob eine Metrik
 * überhaupt taugt - Mediane allein können weit auseinanderliegen und sich trotzdem so stark
 * überlappen, dass man an einem einzelnen Deck nichts davon hat.
 */
function trennschaerfe(a, b) {
  const x = a.filter((v) => v !== null && Number.isFinite(v));
  const y = b.filter((v) => v !== null && Number.isFinite(v));
  if (x.length === 0 || y.length === 0) return null;

  let treffer = 0;
  for (const xi of x) {
    for (const yi of y) {
      if (xi > yi) treffer += 1;
      else if (xi === yi) treffer += 0.5;
    }
  }
  return treffer / (x.length * y.length);
}

/**
 * Bester Schwellenwert: der Schnitt, bei dem "Anteil richtig erkannter cEDH-Decks minus Anteil
 * falsch erkannter Precons" am größten ist (Youden-Index). Liefert die Schwelle samt beider
 * Anteile - eine Schwelle ohne ihre Fehlerrate wäre eine Zahl ohne Aussage.
 */
function besteSchwelle(positiv, negativ) {
  const kandidaten = [
    ...new Set([...positiv, ...negativ].filter((v) => v !== null && Number.isFinite(v))),
  ].sort((a, b) => a - b);
  const p = positiv.filter((v) => v !== null && Number.isFinite(v));
  const n = negativ.filter((v) => v !== null && Number.isFinite(v));
  if (p.length === 0 || n.length === 0 || kandidaten.length === 0) return null;

  // Die Richtung muss mitkommen: Bei Ländern oder Manawert liegen cEDH-Decks DARUNTER, eine
  // "ab X"-Schwelle wäre dort schlicht falsch herum und würde im Bericht das Gegenteil behaupten.
  let beste = null;
  for (const schwelle of kandidaten) {
    for (const richtung of ['>=', '<=']) {
      const trifft = (v) => (richtung === '>=' ? v >= schwelle : v <= schwelle);
      const tpr = p.filter(trifft).length / p.length;
      const fpr = n.filter(trifft).length / n.length;
      if (!beste || tpr - fpr > beste.j) beste = { schwelle, richtung, tpr, fpr, j: tpr - fpr };
    }
  }
  return beste;
}

// =====================================================================================
// 5. Hauptlauf
// =====================================================================================

/** Welche Kennzahlen im Bericht stehen, in welcher Reihenfolge, und wie sie heißen. */
const METRIKEN = [
  ['A Tempo', 'fastManaCount', 'Fast Mana (erzeugt mehr als es kostet)'],
  ['A Tempo', 'averageCmc', 'Durchschnittlicher Manawert'],
  ['A Tempo', 'cheapCardRatio', 'Anteil Karten für 0-1 Mana'],
  ['A Tempo', 'landCount', 'Länder'],
  ['A Tempo', 'untappedLandPercent', 'Ungetappte Länder (%)'],
  ['A Tempo', 'manaByTurn3', 'Mana in Zug 3 (bestenfalls)'],
  ['A Tempo', 'cheapestWinComboMana', 'Günstigste gewinnende Combo (Mana)'],
  ['A Tempo', 'earliestWinTurn', 'Frühestmöglicher Siegzug'],
  ['A Tempo', 'simMedianWinTurn', 'Simulation: Median-Siegzug'],
  ['A Tempo', 'simWinByTurn4', 'Simulation: Sieg bis Zug 4 (Anteil)'],
  ['A Tempo', 'simWinRate', 'Simulation: Sieg bis Zug 10 (Anteil)'],
  ['B Redundanz', 'completeComboCount', 'Vollständige Combos im Deck'],
  ['B Redundanz', 'winComboCount', 'Davon gewinnende'],
  ['B Redundanz', 'distinctWinLines', 'Verschiedene Siegwege'],
  ['B Redundanz', 'tutorCount', 'Tutoren'],
  ['B Redundanz', 'drawCount', 'Kartenziehen'],
  ['C Interaktion', 'freeInteractionCount', 'Freie Interaktion'],
  ['C Interaktion', 'counterspellCount', 'Konter'],
  ['C Interaktion', 'removalCount', 'Entfernung'],
  ['C Interaktion', 'boardwipeCount', 'Bretträumung'],
  ['C Interaktion', 'rampCount', 'Rampe'],
  ['C Interaktion', 'interactionDensity', 'Interaktionsdichte'],
  ['D Kontrolle', 'gameChangerCount', 'Game Changer'],
  ['D Kontrolle', 'colorCount', 'Farben in der Manabasis'],
];

/**
 * Abdeckung: Wie viel von dem, was in den Decks steht, erfasst die Simulation überhaupt?
 *
 * Diese Zählung gab den Anstoß für den Umbau der Simulation, deshalb läuft sie bei jedem Lauf mit
 * und steht im Bericht. Sie beantwortet nicht "rechnet sie richtig", sondern "schaut sie überhaupt
 * hin" - eine Karte mit farbigen Kosten, die als reine Zahl verrechnet wird, ist keine
 * Ungenauigkeit, sondern eine nicht gestellte Frage.
 */
function abdeckungZaehlen(eingabe, abdeckung, parseManaCost, ziehungenAus) {
  for (const karte of eingabe.cards) {
    const land = /Land/.test(karte.typeLine);
    if (land) {
      abdeckung.laender++;
      if ((karte.producedMana ?? []).length > 0) abdeckung.laenderMitFarbe++;
      continue;
    }

    abdeckung.zauber++;
    const kosten = parseManaCost(karte.manaCost);
    if (kosten.requirements.length > 0) abdeckung.mitFarbe++;
    if (kosten.requirements.some((f) => f.genericAlternative > 0 || f.colors.length > 1)) {
      abdeckung.hybrid++;
    }
    if (kosten.requirements.some((f) => f.lifeAlternative > 0)) abdeckung.phyrexia++;
    if (/\{X\}/i.test(karte.manaCost)) abdeckung.variabel++;
    if (kosten.unknown.length > 0) abdeckung.unbekannteSymbole++;

    const gezogen = ziehungenAus(karte);
    const zieht = gezogen.einmalig > 0 || gezogen.proZug > 0;
    if (zieht) abdeckung.ziehtInDerSimulation++;
    if (eingabe.effects.get(karte.key)?.has('draw')) {
      abdeckung.ziehtLautKategorie++;
      if (zieht) abdeckung.ziehtBeides++;
    }
    if (/Creature/.test(karte.typeLine) && /\{T\}[^:]*:[^.]*\badd\b/i.test(karte.oracleText)) {
      abdeckung.manakreaturen++;
    }
  }
}

async function main() {
  const { computeDeckMetrics } = await import('../src/app/deck-metrics.ts');
  const { simulateGoldfish, _intern } = await import('../src/app/goldfish-sim.ts');
  const { parseManaCost } = await import('../src/app/mana-symbols.ts');

  console.log('1/5  Korpora holen (EDHREC, gedrosselt auf eine Anfrage pro Sekunde) …');
  const { cedh, normal } = await holeEdhrecKorpora();
  const precons = await holePrecons();
  const bracketDecks = await holeBracketKorpora();
  console.log(
    `     cEDH: ${cedh.length} | dieselben Commander ohne Filter: ${normal.length} | ` +
      `Precons: ${precons.length} | mit Bracket-Label: ${bracketDecks.length}`,
  );

  const korpora = [
    ['cEDH', cedh],
    ['Nicht-cEDH', normal],
    ['Precon', precons],
    ...BRACKETS.map(([stufe]) => [
      `Bracket ${stufe}`,
      bracketDecks.filter((d) => d.bracket === stufe),
    ]),
  ];

  console.log('2/5  Kartendaten aus Supabase …');
  const alleNamen = [
    ...new Set(
      korpora.flatMap(([, decks]) =>
        decks.flatMap((d) => d.cards.map((c) => normalizeCardName(c.name))),
      ),
    ),
  ];
  const daten = await ladeKartendaten(alleNamen);
  const combos = await ladeCombos(alleNamen);
  console.log(
    `     ${daten.kartenNachSchluessel.size} Karten, ${combos.length} Combos bis drei Karten`,
  );

  console.log(`3/5  Kennzahlen und Simulation (${SIM_SPIELE} Spiele je Deck) …`);
  const zeilen = [];
  const abdeckung = {
    decks: 0,
    zauber: 0,
    mitFarbe: 0,
    hybrid: 0,
    phyrexia: 0,
    variabel: 0,
    unbekannteSymbole: 0,
    ziehtLautKategorie: 0,
    ziehtInDerSimulation: 0,
    ziehtBeides: 0,
    manakreaturen: 0,
    laender: 0,
    laenderMitFarbe: 0,
  };

  for (const [korpus, decks] of korpora) {
    for (const deck of decks) {
      const { eingabe, unbekannt } = baueEingabe(deck, daten, combos);
      if (eingabe.cards.length < 50) continue;

      const m = computeDeckMetrics(eingabe);
      const sim = simulateGoldfish(eingabe, SIM_SPIELE, 1);

      abdeckung.decks++;
      abdeckungZaehlen(eingabe, abdeckung, parseManaCost, _intern.ziehungenAus);

      zeilen.push({
        korpus,
        bracket: deck.bracket ?? '',
        deck: deck.name,
        labelQuelle: deck.labelQuelle ?? '',
        deckeDahinter: deck.deckeDahinter ?? '',
        quelle: deck.quelle ?? '',
        unbekannteKarten: unbekannt,
        ...m,
        simMedianWinTurn: sim.medianWinTurn,
        simWinByTurn3: sim.winByTurn3,
        simWinByTurn4: sim.winByTurn4,
        simWinByTurn5: sim.winByTurn5,
        simWinRate: sim.winRate,
      });
    }
    console.log(`     ${korpus}: fertig (${zeilen.filter((z) => z.korpus === korpus).length})`);
  }

  console.log('4/5  Auswertung …');
  const werte = (korpus, feld) => zeilen.filter((z) => z.korpus === korpus).map((z) => z[feld]);

  const auswertung = METRIKEN.map(([gruppe, feld, label]) => ({
    gruppe,
    feld,
    label,
    medianCedh: median(werte('cEDH', feld)),
    medianNormal: median(werte('Nicht-cEDH', feld)),
    medianPrecon: median(werte('Precon', feld)),
    auc: trennschaerfe(werte('cEDH', feld), werte('Precon', feld)),
    aucNormal: trennschaerfe(werte('cEDH', feld), werte('Nicht-cEDH', feld)),
    schwelle: besteSchwelle(werte('cEDH', feld), werte('Precon', feld)),
    // Die Bracket-Spalten: Mediane je Stufe und die zwei Grenzen, um die es wirklich geht.
    brackets: BRACKETS.map(([stufe]) => median(werte(`Bracket ${stufe}`, feld))),
    aucHochRunter: trennschaerfe(werte('Bracket 4', feld), werte('Bracket 3', feld)),
    aucSpitze: trennschaerfe(werte('Bracket 5', feld), werte('Bracket 4', feld)),
    schwelle34: besteSchwelle(werte('Bracket 4', feld), werte('Bracket 3', feld)),
  }));

  console.log('5/5  Bericht schreiben …');
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  schreibeCsv(zeilen);
  schreibeBericht(auswertung, zeilen, abdeckung);
  console.log(`     ${path.join(DOCS_DIR, 'deck-metriken-2026-09.md')}`);
}

function schreibeCsv(zeilen) {
  const spalten = Object.keys(zeilen[0]);
  // Feldern in Anführungszeichen, sobald sie Komma, Anführungszeichen oder Zeilenumbruch
  // enthalten - seit die Zeilen auch Herkunft und Label mitführen, ist das kein theoretischer
  // Fall mehr, und eine verrutschte Spalte fällt in einer 1.000-Zeilen-CSV niemandem auf.
  const feld = (w) => {
    if (w === null || w === undefined) return '';
    const text = String(w);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const zeile = (werte) => werte.map(feld).join(',');
  const inhalt = [zeile(spalten), ...zeilen.map((z) => zeile(spalten.map((s) => z[s])))].join('\n');
  fs.writeFileSync(path.join(DOCS_DIR, 'deck-metriken-2026-09.csv'), inhalt + '\n');
}

const zahl = (w, stellen = 2) =>
  w === null || w === undefined
    ? '–'
    : (Math.round(w * 10 ** stellen) / 10 ** stellen).toString().replace('.', ',');

/**
 * Die von Hand geschriebene Einordnung aus dem bestehenden Bericht retten.
 *
 * Ohne das wuerde ein zweiter Lauf genau den Teil ueberschreiben, der die Arbeit wert war: Die
 * Tabellen kann das Skript jederzeit neu erzeugen, die Schluesse daraus nicht. Alles zwischen den
 * beiden Markern bleibt deshalb stehen.
 */
const MARKER_START = '<!-- EINORDNUNG:START -->';
const MARKER_ENDE = '<!-- EINORDNUNG:ENDE -->';

function bestehendeEinordnung(datei) {
  if (!fs.existsSync(datei)) return null;
  const alt = fs.readFileSync(datei, 'utf8');
  const von = alt.indexOf(MARKER_START);
  const bis = alt.indexOf(MARKER_ENDE);
  if (von === -1 || bis === -1 || bis < von) return null;
  return alt.slice(von + MARKER_START.length, bis).trim();
}

function schreibeBericht(auswertung, zeilen, abdeckung) {
  const anzahl = (k) => zeilen.filter((z) => z.korpus === k).length;
  const sortiert = [...auswertung]
    .filter((a) => a.auc !== null)
    .sort((a, b) => Math.abs(b.auc - 0.5) - Math.abs(a.auc - 0.5));
  const nachBracket = [...auswertung]
    .filter((a) => a.aucHochRunter !== null)
    .sort((a, b) => Math.abs(b.aucHochRunter - 0.5) - Math.abs(a.aucHochRunter - 0.5));

  const zeilenText = auswertung
    .map(
      (a) =>
        `| ${a.gruppe} | ${a.label} | ${zahl(a.medianCedh)} | ${zahl(a.medianNormal)} | ${zahl(a.medianPrecon)} | ${zahl(a.auc, 3)} | ${zahl(a.aucNormal, 3)} |`,
    )
    .join('\n');

  const bracketText = auswertung
    .map(
      (a) =>
        `| ${a.label} | ${a.brackets.map((w) => zahl(w)).join(' | ')} | ${zahl(a.aucHochRunter, 3)} | ${zahl(a.aucSpitze, 3)} |`,
    )
    .join('\n');

  const schwellenText = sortiert
    .slice(0, 8)
    .map(
      (a) =>
        `| ${a.label} | ${a.schwelle?.richtung === '<=' ? '≤' : '≥'} ${zahl(a.schwelle?.schwelle)} | ${zahl((a.schwelle?.tpr ?? 0) * 100, 1)} % | ${zahl((a.schwelle?.fpr ?? 0) * 100, 1)} % |`,
    )
    .join('\n');

  const schwellen34Text = nachBracket
    .slice(0, 8)
    .map(
      (a) =>
        `| ${a.label} | ${a.schwelle34?.richtung === '<=' ? '≤' : '≥'} ${zahl(a.schwelle34?.schwelle)} | ${zahl((a.schwelle34?.tpr ?? 0) * 100, 1)} % | ${zahl((a.schwelle34?.fpr ?? 0) * 100, 1)} % |`,
    )
    .join('\n');

  const bracketZeilen = zeilen.filter((z) => z.bracket !== '');
  const bracketUebersicht = BRACKETS.map(([stufe, pfad, name]) => {
    const eigene = zeilen.filter((z) => z.korpus === `Bracket ${stufe}`);
    const dahinter = eigene.reduce((summe, z) => summe + Number(z.deckeDahinter || 0), 0);
    return `| ${stufe} — ${name} | ${eigene.length} | ${dahinter.toLocaleString('de-DE')} | \`/average-decks/<commander>/${pfad}.json\` |`;
  }).join('\n');

  const prozent = (teil, gesamt) => (gesamt === 0 ? '–' : zahl((teil / gesamt) * 100, 1) + ' %');

  const berichtDatei = path.join(DOCS_DIR, 'deck-metriken-2026-09.md');
  const einordnung =
    bestehendeEinordnung(berichtDatei) ??
    '*(Einordnung nach dem Lauf hier eintragen. Alles zwischen den beiden Markern bleibt bei\nkuenftigen Laeufen stehen - die Tabellen darueber werden jedes Mal neu erzeugt.)*';

  const inhalt = `# Was macht ein starkes Commander-Deck aus? Gemessen an ${zeilen.length.toLocaleString('de-DE')} Decks

> Erhoben am ${new Date().toISOString().slice(0, 10)} mit \`node scripts/analyze-deck-corpus.js\`.
> Die Messwerte je Deck stehen in \`deck-metriken-2026-09.csv\` daneben, damit jede Zahl hier
> nachrechenbar ist - eine Zeile je Deck, mit Korpus, Bracket-Label und Fundstelle.

## Was gemessen wurde

| Korpus | Decks | Was es ist | Wer es so nennt |
| --- | --- | --- | --- |
| cEDH | ${anzahl('cEDH')} | EDHRECs Durchschnittsdeck je cEDH-Commander | EDHREC-Tag \`cedh\` |
| Nicht-cEDH | ${anzahl('Nicht-cEDH')} | **Dieselben Commander**, ohne cEDH-Filter | – |
| Precon | ${anzahl('Precon')} | Commander-Precons ab 2023 (MTGJSON) | Wizards (Produkt) |
| Bracket 1-5 | ${bracketZeilen.length} | Durchschnittsdeck je Commander **und Bracket** | die Deck-Autoren selbst |

Die ersten beiden Korpora beantworten die Frage nach der Bauweise: Weil dort dieselben Commander
stehen, misst der Unterschied die **Bauweise** und nicht den Commander. Ein Kinnan-Deck bleibt ein
Kinnan-Deck; was es zum cEDH-Deck macht, steht in den Zahlen dazwischen.

Der vierte Korpus beantwortet die Frage, die die Bracket-Automatik wirklich stellt - und für die
der ersten Auswertung jede Grundlage fehlte: **Wie sieht ein Bracket-3-Deck aus, und wie ein
Bracket-4-Deck?**

### Woher die Bracket-Labels stammen

| Bracket | Decks im Korpus | Echte Listen dahinter | Fundstelle bei EDHREC |
| --- | --- | --- | --- |
${bracketUebersicht}

**Das Label stammt von EDHREC, nicht von uns und nicht aus einer eigenen Heuristik.** EDHREC führt
zu jedem eingereichten Deck eine Bracket-Angabe (Feld \`bracket\` in
\`/pages/decks/<commander>.json\`) und mittelt unter obigen Adressen je Bracket über genau diese
Decks. Die Spalte "Echte Listen dahinter" ist die Zahl, die EDHREC selbst im Feld
\`bracket_counts\` nennt; Durchschnitte unter ${MIN_DECKS_JE_BRACKET} Listen sind verworfen.

Was dabei **nicht** nachgeprüft werden konnte: ob EDHREC die Bracket-Angabe des Deck-Autors von
Moxfield bzw. Archidekt übernimmt oder die Stufe selbst errechnet. \`edhrec.com\` und beide
Deckseiten sind aus der Umgebung dieses Laufs gesperrt, und \`json.edhrec.com\` sagt dazu nichts.
Die belastbare Aussage ist deshalb: ein **Fremdlabel von EDHREC**, erhoben über eine bekannte Zahl
echter Listen — wer es ursprünglich vergibt, steht unter Vorbehalt.

Alle Kennzahlen kommen aus \`src/app/deck-metrics.ts\`, die Simulationswerte aus
\`src/app/goldfish-sim.ts\` (${SIM_SPIELE} Spiele je Deck).
**Die Regeln, nach denen die Simulation spielt, stehen im Kopfkommentar jener Datei**, jede mit
ihrer Nummer aus den Comprehensive Rules; der Wortlaut in \`docs/mtg-regeln.md\`.

## Was die Simulation vom Korpus erfasst

Die alte Simulation rechnete Mana als reine Zahl, kannte kein Kartenziehen und keine
Einsatzverzögerung. Diese Zählung über alle ${abdeckung.decks.toLocaleString('de-DE')} Decks sagt,
wie groß die Lücke war - und damit, worauf die Zahlen weiter unten jetzt beruhen.

| Im Korpus | Anzahl | Anteil |
| --- | --- | --- |
| Zaubersprüche (ohne Länder) | ${abdeckung.zauber.toLocaleString('de-DE')} | 100 % |
| … davon mit farbigen Kosten | ${abdeckung.mitFarbe.toLocaleString('de-DE')} | ${prozent(abdeckung.mitFarbe, abdeckung.zauber)} |
| … davon mit Hybrid-Kosten | ${abdeckung.hybrid.toLocaleString('de-DE')} | ${prozent(abdeckung.hybrid, abdeckung.zauber)} |
| … davon mit Phyrexia-Kosten | ${abdeckung.phyrexia.toLocaleString('de-DE')} | ${prozent(abdeckung.phyrexia, abdeckung.zauber)} |
| … davon mit {X} | ${abdeckung.variabel.toLocaleString('de-DE')} | ${prozent(abdeckung.variabel, abdeckung.zauber)} |
| … mit Manasymbolen, die die Tabelle nicht kennt | ${abdeckung.unbekannteSymbole.toLocaleString('de-DE')} | ${prozent(abdeckung.unbekannteSymbole, abdeckung.zauber)} |
| Karten mit Kategorie "Kartenziehen" | ${abdeckung.ziehtLautKategorie.toLocaleString('de-DE')} | – |
| … davon zieht in der Simulation wirklich | ${abdeckung.ziehtBeides.toLocaleString('de-DE')} | ${prozent(abdeckung.ziehtBeides, abdeckung.ziehtLautKategorie)} |
| Karten, die in der Simulation ziehen (alle) | ${abdeckung.ziehtInDerSimulation.toLocaleString('de-DE')} | – |
| Manakreaturen mit {T} (Einsatzverzögerung) | ${abdeckung.manakreaturen.toLocaleString('de-DE')} | – |
| Länder | ${abdeckung.laender.toLocaleString('de-DE')} | – |
| … davon mit bekannter Farbe | ${abdeckung.laenderMitFarbe.toLocaleString('de-DE')} | ${prozent(abdeckung.laenderMitFarbe, abdeckung.laender)} |

Die Ziehzeilen sind die ehrlichsten: Von den Karten, die Scryfalls Kategorien als Kartenziehen
führen, zieht in der Simulation nur ein knappes Drittel wirklich. Erfasst ist, was **unbedingt**
passiert — beim Wirken eines Instants oder einer Hexerei, beim Ins-Spiel-Kommen, oder in jedem
Versorgungs-, Zieh- oder Endschritt. Alles Bedingte (ein Rhystic Study zieht ohne Gegner nichts),
jede aktivierte Ziehfähigkeit und alles über Kampfschaden bleibt draußen. Die Simulation
unterschätzt Ziehdecks also weiterhin, nur nicht mehr um alles.

## Alle Kennzahlen

Trennschärfe: Wie oft liegt ein zufälliges Deck der ersten Gruppe über einem zufälligen Deck der
zweiten? **0,5 heißt "die Metrik weiß nichts"**; 1,0 und 0,0 trennen beide vollständig, nur in
entgegengesetzte Richtung - bei Ländern und Manawert liegen cEDH-Decks eben DARUNTER. Je weiter ein
Wert von 0,5 entfernt ist, desto mehr sagt die Kennzahl aus.

| Gruppe | Kennzahl | Median cEDH | Median Nicht-cEDH | Median Precon | Trennschärfe vs. Precon | vs. Nicht-cEDH |
| --- | --- | --- | --- | --- | --- | --- |
${zeilenText}

## Dieselben Kennzahlen entlang der Brackets

Hier steht, was die Auswertung vorher nicht konnte. Die fünf Spalten sind Mediane über Decks, deren
Bracket ihre Autoren selbst angegeben haben; die letzten beiden Spalten sind die Grenzen, um die es
in der Praxis geht - **4 gegen 3** und **5 gegen 4**.

| Kennzahl | B1 | B2 | B3 | B4 | B5 | Trennschärfe 4 vs. 3 | 5 vs. 4 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${bracketText}

## Die acht stärksten Trennlinien: cEDH gegen Precon

Schwelle ist jeweils der Schnitt mit dem besten Verhältnis aus Treffern und Fehlalarmen
(Youden-Index) gegenüber den Precons.

| Kennzahl | Schwelle | erkennt cEDH | schlägt bei Precons fälschlich an |
| --- | --- | --- | --- |
${schwellenText}

## Die acht stärksten Trennlinien: Bracket 4 gegen Bracket 3

Dieselbe Rechnung an der Grenze, die eine Bracket-Automatik tatsächlich ziehen muss.

| Kennzahl | Schwelle | erkennt Bracket 4 | schlägt bei Bracket 3 fälschlich an |
| --- | --- | --- | --- |
${schwellen34Text}

## Was daraus folgt

${MARKER_START}
${einordnung}
${MARKER_ENDE}

## Grenzen dieser Auswertung

- **Durchschnittsdecks, keine Einzellisten - auch bei den Bracket-Decks.** EDHRECs Durchschnittsdeck
  glättet Ausreißer. Einzellisten hätten von Moxfield oder Archidekt kommen sollen; beide Seiten
  sind aus der Umgebung, in der dieser Lauf entstand, nicht erreichbar (die Egress-Policy
  beantwortet den CONNECT mit HTTP 403). Der Bracket-Korpus ist deshalb ein Kompromiss: das
  Fremdlabel bleibt, die Streuung innerhalb eines Brackets fehlt. Wer den Lauf in einer Umgebung
  ohne diese Sperre wiederholt, sollte Einzellisten ziehen — die Trennschärfen zwischen
  benachbarten Brackets sind an Mittelwerten systematisch zu hoch.
- **Ein Durchschnitt je Commander und Bracket, nicht je Deck.** 100 Commander × 5 Brackets ergibt
  höchstens 500 Zeilen; dieselben Commander tauchen in mehreren Brackets auf. Die Bracket-Spalten
  vergleichen also dieselben Commander unterschiedlich gebaut - das ist gewollt, macht die Gruppen
  aber nicht unabhängig.
- **Combos nur bis drei Karten.** Alles darüber ist in einem 100-Karten-Deck praktisch nie
  vollständig, treibt aber die Datenmenge ins Unermessliche (siehe \`ladeCombos()\`).
- **Die Simulation kennt nur Combo-Siege.** Ein Deck, das über Kreaturenschaden gewinnt, gewinnt
  dort nie. Alle weiteren Grenzen stehen im Kopfkommentar von \`goldfish-sim.ts\`, jeweils mit der
  Richtung, in die sie das Ergebnis verschieben.
- **Freie Interaktion erkennt nur den Wortlaut "without paying its mana cost"** plus Konter für
  ein Mana. Force of Will ("rather than pay") fällt durchs Raster; das ist in
  \`deck-metrics.spec.ts\` als bekannte Lücke festgehalten.
`;

  fs.writeFileSync(berichtDatei, inhalt);
}

main().catch((fehler) => {
  console.error('Auswertung fehlgeschlagen:', fehler);
  process.exit(1);
});
