/**
 * Effekt-Kategorien ("was tut eine Karte") - EINE Liste für Kartensuche, Deck-Editor, Deck-Filter,
 * Cube, Sammlung und den nächtlichen Abgleich (`scripts/sync-scryfall-bulk.js` liest genau diese
 * Datei per `require`). Fast alles sind Scryfalls Oracle-Tags (`otag:`), geprüft am 05.11.2026 -
 * ein zurückgezogenes Tag liefert null Treffer, der Nachtlauf warnt dann.
 *
 * otag: ist hierarchisch: ein Unter-Tag matcht auch das Eltern-Tag (creature-removal ⊂ removal,
 * animate-artifact ⊂ animate). Deshalb dürfen beide nebeneinander stehen.
 *
 * Die drei rein deck-lokalen Einträge (tutor/extraturn/mld) stehen in LOCAL_EFFECT_FILTERS: Sie
 * kommen aus Spellbook-Merkmalen bzw. der Deck-Analyse, nicht aus einer Scryfall-Abfrage, und
 * lassen sich deshalb in einer Live-Suche bei Scryfall nicht anbieten.
 *
 * Diese Datei darf nichts importieren - der Nachtlauf lädt sie direkt mit Node.
 */
export type EffectGroup =
  'interaction' | 'resources' | 'creatures' | 'graveyard' | 'tokens' | 'other';

export interface CardEffectFilter {
  value: string;
  query: string;
  group: EffectGroup;
}

export const EFFECT_GROUPS: readonly EffectGroup[] = [
  'interaction',
  'resources',
  'creatures',
  'graveyard',
  'tokens',
  'other',
];

/**
 * Die zwölf Schlüssel der Analyse-Kacheln (EFFECT_TAG_CATEGORIES in deck-effects.service.ts)
 * müssen hier mit zeichengleicher Abfrage stehen - Kacheln, Filter und Nachtlauf teilen sich die
 * Kategorie in `scryfall_card_effects`.
 */
export const CARD_EFFECT_FILTERS: CardEffectFilter[] = [
  // Interaktion
  { value: 'removal', query: 'otag:removal', group: 'interaction' },
  { value: 'creatureremoval', query: 'otag:creature-removal', group: 'interaction' },
  { value: 'artifactremoval', query: 'otag:artifact-removal', group: 'interaction' },
  { value: 'enchantmentremoval', query: 'otag:enchantment-removal', group: 'interaction' },
  { value: 'boardwipe', query: 'otag:board-wipe', group: 'interaction' },
  { value: 'counterspell', query: 'otag:counterspell', group: 'interaction' },
  { value: 'edict', query: 'otag:edict', group: 'interaction' },
  { value: 'bounce', query: 'otag:bounce', group: 'interaction' },
  { value: 'theft', query: 'otag:theft', group: 'interaction' },
  { value: 'tapper', query: 'otag:tapper', group: 'interaction' },
  { value: 'pacifism', query: 'otag:pacifism', group: 'interaction' },
  { value: 'burn', query: 'otag:burn', group: 'interaction' },
  { value: 'drain', query: 'otag:drain-life', group: 'interaction' },
  { value: 'handdisruption', query: 'otag:hand-disruption', group: 'interaction' },
  { value: 'graveyardhate', query: 'otag:graveyard-hate', group: 'interaction' },
  { value: 'hatebear', query: 'otag:hatebear', group: 'interaction' },
  { value: 'fog', query: 'otag:fog', group: 'interaction' },
  // Ressourcen & Karten
  { value: 'ramp', query: 'otag:ramp -t:land', group: 'resources' },
  { value: 'manarock', query: 'otag:mana-rock', group: 'resources' },
  { value: 'manadork', query: 'otag:mana-dork', group: 'resources' },
  { value: 'landramp', query: 'otag:land-ramp', group: 'resources' },
  { value: 'extraland', query: 'otag:extra-land', group: 'resources' },
  { value: 'ritual', query: 'otag:ritual', group: 'resources' },
  { value: 'manadoubler', query: 'otag:mana-doubler', group: 'resources' },
  { value: 'costreducer', query: 'otag:cost-reducer', group: 'resources' },
  { value: 'draw', query: 'otag:draw', group: 'resources' },
  { value: 'drawengine', query: 'otag:draw-engine', group: 'resources' },
  { value: 'cantrip', query: 'otag:cantrip', group: 'resources' },
  { value: 'impulsedraw', query: 'otag:impulse-draw', group: 'resources' },
  { value: 'loot', query: 'otag:loot', group: 'resources' },
  { value: 'rummage', query: 'otag:rummage', group: 'resources' },
  { value: 'wheel', query: 'otag:wheel', group: 'resources' },
  { value: 'discardoutlet', query: 'otag:discard-outlet', group: 'resources' },
  // Kreaturen & Kampf
  { value: 'animate', query: 'otag:animate', group: 'creatures' },
  { value: 'animateartifact', query: 'otag:animate-artifact', group: 'creatures' },
  { value: 'animateland', query: 'otag:animate-land', group: 'creatures' },
  { value: 'anthem', query: 'otag:anthem', group: 'creatures' },
  { value: 'protection', query: 'otag:protection', group: 'creatures' },
  { value: 'givesflying', query: 'otag:gives-flying', group: 'creatures' },
  { value: 'givestrample', query: 'otag:gives-trample', group: 'creatures' },
  { value: 'giveshaste', query: 'otag:gives-haste', group: 'creatures' },
  { value: 'givesindestructible', query: 'otag:gives-indestructible', group: 'creatures' },
  { value: 'giveshexproof', query: 'otag:gives-hexproof', group: 'creatures' },
  { value: 'giveslifelink', query: 'otag:gives-lifelink', group: 'creatures' },
  { value: 'untapper', query: 'otag:untapper', group: 'creatures' },
  { value: 'extracombat', query: 'otag:extra-combat', group: 'creatures' },
  { value: 'clone', query: 'otag:clone', group: 'creatures' },
  { value: 'flicker', query: 'otag:flicker', group: 'creatures' },
  // Friedhof
  { value: 'reanimate', query: 'otag:reanimate', group: 'graveyard' },
  { value: 'recursion', query: 'otag:recursion', group: 'graveyard' },
  { value: 'regrowth', query: 'otag:regrowth', group: 'graveyard' },
  { value: 'castfromgraveyard', query: 'otag:cast-from-graveyard', group: 'graveyard' },
  { value: 'mill', query: 'otag:mill', group: 'graveyard' },
  { value: 'selfmill', query: 'otag:self-mill', group: 'graveyard' },
  { value: 'sacrifice', query: 'otag:sacrifice-outlet', group: 'graveyard' },
  { value: 'deathtrigger', query: 'otag:death-trigger', group: 'graveyard' },
  // Marken & Zähler
  // "o:create o:token" statt Tag: trifft auch "create two"/"create X" (siehe deck-effects.service.ts).
  { value: 'tokens', query: 'o:create o:token', group: 'tokens' },
  { value: 'tokendoubler', query: 'otag:token-doubler', group: 'tokens' },
  { value: 'copytoken', query: 'otag:copy-token', group: 'tokens' },
  // Oracle-Text statt Tag: otag:gives-1-1-counters gibt es nicht mehr.
  { value: 'counters', query: 'o:"+1/+1 counter"', group: 'tokens' },
  { value: 'countersmatter', query: 'otag:counters-matter', group: 'tokens' },
  { value: 'counterdoubler', query: 'otag:counter-doubler', group: 'tokens' },
  { value: 'proliferate', query: 'keyword:proliferate', group: 'tokens' },
  // Sonstiges
  { value: 'lifegain', query: 'otag:lifegain', group: 'other' },
  { value: 'copyspell', query: 'otag:copy-spell', group: 'other' },
  { value: 'punisher', query: 'otag:punisher', group: 'other' },
  { value: 'alternatewin', query: 'otag:alternate-win-condition', group: 'other' },
];

/** Deck-lokale Kategorien ohne Scryfall-Abfrage (query ''), siehe Kopfkommentar. */
export const LOCAL_EFFECT_FILTERS: CardEffectFilter[] = [
  { value: 'mld', query: '', group: 'interaction' },
  { value: 'tutor', query: '', group: 'resources' },
  { value: 'extraturn', query: '', group: 'other' },
];

/** Alle Kategorien - für Stellen, die lokal filtern (Sammlung, Cube-Sammlungsmodus, Deck-Filter). */
export const ALL_EFFECT_FILTERS: CardEffectFilter[] = [
  ...CARD_EFFECT_FILTERS,
  ...LOCAL_EFFECT_FILTERS,
];

/**
 * Auswahl im Effekt-Filter (ui/effect-filter): beliebig viele Kategorien, verknüpft mit "alle
 * müssen zutreffen" (`all`) oder "mindestens eine" (`any`). Leere Menge = kein Filter.
 */
export interface EffectSelection {
  keys: ReadonlySet<string>;
  mode: 'all' | 'any';
}

export const EMPTY_EFFECT_SELECTION: EffectSelection = { keys: new Set(), mode: 'all' };

export function effectSelectionActive(sel: EffectSelection): boolean {
  return sel.keys.size > 0;
}

/**
 * Scryfall-Abfrage zur Auswahl - undefined ohne Auswahl. Kategorien ohne Abfrage (lokale) fallen
 * weg; die Live-Suchen bieten sie gar nicht erst an.
 */
export function effectSelectionQuery(sel: EffectSelection): string | undefined {
  const queries = CARD_EFFECT_FILTERS.filter((f) => sel.keys.has(f.value)).map((f) => f.query);
  if (queries.length === 0) return undefined;
  if (queries.length === 1) return queries[0];
  // Jede Abfrage in Klammern: "otag:ramp -t:land" besteht selbst aus zwei Gliedern.
  const parts = queries.map((q) => `(${q})`);
  return sel.mode === 'all' ? parts.join(' ') : `(${parts.join(' or ')})`;
}

/** Ob eine Karte zur Auswahl passt - `has(key)` sagt, ob sie in Kategorie `key` fällt. */
export function matchesEffectSelection(
  sel: EffectSelection,
  has: (key: string) => boolean,
): boolean {
  if (sel.keys.size === 0) return true;
  const keys = [...sel.keys];
  return sel.mode === 'all' ? keys.every(has) : keys.some(has);
}
