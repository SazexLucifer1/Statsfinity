// NEU
/**
 * Scryfall-Oracle-Tag-Filter für "was tut eine Karte" (z.B. Sacrifice-Outlet, Removal, Ramp) - aus
 * public-card-search.ts/deck-viewer.service.ts extrahiert, damit beide Stellen (und die Commander-
 * Suche nach Farbe/Mechanik) dieselbe, einmal gepflegte Liste nutzen. Bewusst OHNE die 3 rein
 * deck-lokalen Einträge aus deck-viewer.service.ts (tutor/extraturn/mld, query: '' - laufen dort
 * über deck-spezifische Analyse statt Scryfall-Abfrage, ohne Deck-Kontext nicht möglich).
 */
export interface CardEffectFilter {
  value: string;
  query: string;
}

export const CARD_EFFECT_FILTERS: CardEffectFilter[] = [
  { value: 'tokens', query: 'o:create o:token' },
  { value: 'draw', query: 'otag:draw' },
  { value: 'removal', query: 'otag:removal' },
  {
    value: 'counterspell',
    query:
      'otag:counterspell',
  },
  { value: 'boardwipe', query: 'otag:board-wipe' },
  { value: 'ramp', query: 'otag:ramp -t:land' },
  { value: 'lifegain', query: 'otag:lifegain' },
  { value: 'counters', query: 'o:"+1/+1 counter"' },
  { value: 'proliferate', query: 'keyword:proliferate' },
  { value: 'protection', query: 'otag:protection' },
  {
    value: 'reanimate',
    query:
      'otag:reanimate',
  },
  { value: 'recursion', query: 'otag:recursion' },
  { value: 'sacrifice', query: 'otag:sacrifice-outlet' },
  { value: 'extracombat', query: 'otag:extra-combat' },
];
