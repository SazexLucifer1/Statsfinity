/**
 * Archetyp-Filter für die Commander-Suche (Deck-STRATEGIE, filtert Commander selbst über
 * is:commander + Query). Getrennt von CARD_EFFECT_FILTERS, das beschreibt, was eine einzelne Karte tut.
 *
 * Wo ein verlässlicher Scryfall-Oracle-Tag (otag:) existiert, wird er genutzt, sonst eine Text-
 * Heuristik (o:"..."). Niedrig-konfident und noch live zu prüfen: voltron, aristocrats, combo.
 */
export interface CommanderArchetypeFilter {
  value: string;
  query: string;
}

export const COMMANDER_ARCHETYPE_FILTERS: CommanderArchetypeFilter[] = [
  // --- gut belegte Oracle-Tags ---
  { value: 'tribal', query: 'otag:tribal' },
  { value: 'grouphug', query: '(otag:group-hug or otag:group-slug)' },
  { value: 'landfall', query: 'otag:landfall' },
  { value: 'wheels', query: 'otag:wheel' },
  { value: 'mill', query: 'otag:mill' },
  { value: 'blink', query: '(otag:blink or otag:flicker)' },
  { value: 'reanimator', query: 'otag:reanimate' },
  { value: 'countersmatter', query: 'otag:counters-matter' },
  { value: 'artifactsmatter', query: 'otag:synergy-artifact' },
  { value: 'sacrifice', query: 'otag:sacrifice-outlet' },
  { value: 'ramp', query: 'otag:ramp' },
  { value: 'lifegain', query: 'otag:lifegain' },
  { value: 'extracombat', query: 'otag:extra-combat' },
  { value: 'tokens', query: 'o:create o:token' },
  { value: 'proliferate', query: 'keyword:proliferate' },
  { value: 'storm', query: '(keyword:storm or otag:storm-count-matters)' },

  // --- naheliegender Proxy-Tag statt exaktem Treffer ---
  { value: 'stax', query: '(otag:tax or otag:prison or otag:pillowfort)' },
  { value: 'enchantress', query: '(oracletag:enchantress or o:"whenever you cast an enchantment spell")' },
  { value: 'equipmentmatters', query: 'otag:synergy-equipment' },

  // --- kein passender Oracle-Tag, handgebaute Text-/Keyword-Heuristik ---
  { value: 'voltron', query: '(otag:synergy-equipment or otag:synergy-aura or o:equip or o:"aura you control")' },
  {
    value: 'aristocrats',
    query:
      '(otag:sacrifice-outlet or o:"whenever a creature you control dies" or o:"whenever another creature you control dies")',
  },
  {
    value: 'spellslinger',
    query:
      '(otag:synergy-instant or otag:synergy-sorcery or o:"instant or sorcery spell" or o:"whenever you cast an instant or sorcery spell")',
  },
  {
    value: 'superfriends',
    // Bewusst Singular UND Plural: "a planeswalker you control" (z.B. Carth the Lion) vs.
    // "planeswalkers you control" - eine reine Plural-Suche übersieht echte Superfriends-Commander.
    query: '(otag:synergy-planeswalker or o:"planeswalkers you control" or o:"a planeswalker you control")',
  },
  { value: 'politics', query: '(o:monarch or o:goad or o:"vote for")' },
  { value: 'control', query: '(otag:removal or otag:boardwipe or otag:counterspell)' },
  { value: 'combo', query: '(otag:combo-piece or otag:infinite-combo)' },
];
