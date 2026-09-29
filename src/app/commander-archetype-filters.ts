/**
 * Deck-Archetypen (Strategie), die ein Spieler seinem Deck zuordnen kann - Auswahl im Deck-Kopf,
 * gespeichert in decks.edhrec_tag und im öffentlichen Stöbern filterbar. Die Beschriftungen stehen
 * unter archetypeFilter.* in i18n/search.ts.
 */
export const COMMANDER_ARCHETYPE_FILTERS: readonly { value: string }[] = [
  { value: 'tribal' },
  { value: 'grouphug' },
  { value: 'landfall' },
  { value: 'wheels' },
  { value: 'mill' },
  { value: 'blink' },
  { value: 'reanimator' },
  { value: 'countersmatter' },
  { value: 'artifactsmatter' },
  { value: 'sacrifice' },
  { value: 'ramp' },
  { value: 'lifegain' },
  { value: 'extracombat' },
  { value: 'tokens' },
  { value: 'proliferate' },
  { value: 'storm' },
  { value: 'stax' },
  { value: 'enchantress' },
  { value: 'equipmentmatters' },
  { value: 'voltron' },
  { value: 'aristocrats' },
  { value: 'spellslinger' },
  { value: 'superfriends' },
  { value: 'politics' },
  { value: 'control' },
  { value: 'combo' },
];
