/**
 * Ab diesem Datum gelten Spiele als "live getrackt" - alles davor stammt aus dem
 * Excel-Bulk-Import (siehe ExcelImportService), auch wenn es kein explizites Import-Flag gibt
 * (Import-Batches bekommen beim Anlegen immer den 31.12. des gewählten Jahres als Datum).
 */
export const LIVE_TRACKING_START_DATE = new Date('2026-07-17');

/**
 * Offizielle, von Wizards of the Coast mit eigener Banned/Restricted-Liste geführte
 * Spielformate - zur Auswahl beim Anlegen/Bearbeiten eines Decks (decks.format, siehe
 * DeckService.saveDeck()/updateDeckInfo()) UND als Teilmenge der Spielmodi (GameMode) unten, mit
 * denen ein Match erfasst werden kann. Bewusst NICHT übersetzt - das sind feste
 * Format-Eigennamen, keine UI-Texte. Limited-Formate (Draft/Sealed) und rein community-geführte
 * Varianten (Duel Commander, Oathbreaker) sind bewusst ausgeklammert, siehe PR-Beschreibung.
 */
export type DeckFormat =
  | 'Standard'
  | 'Pioneer'
  | 'Modern'
  | 'Legacy'
  | 'Vintage'
  | 'Pauper'
  | 'Commander'
  | 'Pauper Commander'
  | 'Brawl'
  | 'Historic Brawl'
  | 'Alchemy'
  | 'Explorer'
  | 'Timeless';

/**
 * Alphabetisch sortiert, weil diese Liste jedes Format-Dropdown der App füllt (Match-Tab,
 * Turnier, Deck anlegen/bearbeiten, Statistik-Filter): in einem Auswahlfeld sucht man einen
 * Namen, keine Reihenfolge nach Erscheinungsjahr oder Kartenpool. Die Reihenfolge hat sonst
 * keine Bedeutung - gespeichert wird immer der Wert, nie der Index.
 */
export const DECK_FORMATS: DeckFormat[] = [
  'Alchemy',
  'Brawl',
  'Commander',
  'Explorer',
  'Historic Brawl',
  'Legacy',
  'Modern',
  'Pauper',
  'Pauper Commander',
  'Pioneer',
  'Standard',
  'Timeless',
  'Vintage',
];

/**
 * Scryfalls Schlüssel je App-Format (für legal:/banned:-Suchen). Nicht alles heißt gleich: das
 * App-"Brawl" ist Scryfalls "standardbrawl", das App-"Historic Brawl" ist Scryfalls "brawl".
 * Dieselbe Zuordnung steht als BANN_FORMATE in scripts/sync-scryfall-bulk.js (das Skript läuft ohne
 * TypeScript und kann sie nicht importieren) - wer hier etwas ändert, ändert dort mit.
 */
export const SCRYFALL_FORMAT: Record<DeckFormat, string> = {
  Standard: 'standard',
  Pioneer: 'pioneer',
  Modern: 'modern',
  Legacy: 'legacy',
  Vintage: 'vintage',
  Pauper: 'pauper',
  Commander: 'commander',
  'Pauper Commander': 'paupercommander',
  Brawl: 'standardbrawl',
  'Historic Brawl': 'brawl',
  Alchemy: 'alchemy',
  Explorer: 'explorer',
  Timeless: 'timeless',
};

/**
 * Spielkategorie eines Matches/Turniers - orthogonal zum Spielformat (DeckFormat oben): 'Normal'
 * heißt "keine besondere Kategorie, ganz normales 1v1/Multiplayer-Spiel" und wird IMMER mit einem
 * Format kombiniert (z.B. Normal+Commander, Normal+Modern). Two-Headed Giant/Archenemy/Cube/Draft
 * lassen sich ebenfalls mit einem Format kombinieren ("was wirklich gespielt wurde", z.B.
 * Cube+Modern), nur Spezialevent hat bewusst kein Format (siehe Match.format/Tournament.gameFormat).
 */
export type GameMode = 'Normal' | 'Two-Headed Giant' | 'Archenemy' | 'Cube' | 'Draft' | 'Spezialevent';

export const GAME_MODES: GameMode[] = ['Normal', 'Two-Headed Giant', 'Archenemy', 'Cube', 'Draft', 'Spezialevent'];

export type TeamName = 'Team 1' | 'Team 2' | 'Team 3' | 'Team 4' | 'Team 5';

export const TEAM_OPTIONS: TeamName[] = ['Team 1', 'Team 2', 'Team 3', 'Team 4', 'Team 5'];

export interface MatchPlayer {
  name: string;
  commander?: string;
  partnerCommander?: string;
  team?: TeamName;
  /** Für Archenemy-Modus: markiert, ob dieser Spieler der Archenemy ist */
  isArchenemy?: boolean;
  /** Verknüpftes Deck (aus dem Profil-Tab importiert), falls beim Match-Erstellen ausgewählt. */
  deckId?: string;
  /** Nur beim Lesen aus der Historie befüllt (Join), nicht beim Erstellen gesetzt. */
  deckName?: string;
  /** User-ID des Deck-Besitzers (nur bei account-gebundenen Decks) - dient zur Erkennung, ob das Deck hier nur geliehen wurde. */
  deckOwnerId?: string;
  /** players.id des Deck-Besitzers (nur bei einem Deck, das direkt einem accountlosen/virtuellen Spieler gehört). */
  deckOwnerPlayerId?: string;
  /** Nur beim Lesen aus der Historie befüllt (Join). */
  deckIsPrecon?: boolean;
  /**
   * Optionale Zusatz-Info: welchen Platz (1 = Sieger, 2 = zweiter Platz, ...) dieser Spieler in
   * diesem Match belegt hat. Rein informativ - der Sieg/Niederlage-Status (siehe Match.winner)
   * bleibt davon unberührt, jeder Nicht-Sieger zählt weiterhin ganz normal als Niederlage.
   */
  placement?: number;
}

export interface Match {
  id: string;
  /** ISO-Datum des Spiels */
  date: string;
  mode: GameMode;
  /** Gespieltes MTG-Format, kombiniert mit mode (z.B. Cube+Modern) - null nur bei mode 'Spezialevent'. */
  format: DeckFormat | null;
  players: MatchPlayer[];
  /** Name des Gewinners */
  winner: string;
  /** Optional: verwendeter Cube */
  cube?: {
    id: string;
    name: string;
    isCommander: boolean;
  };
  /** Optional: ausgewähltes Draft-Set */
  draftSet?: {
    id: string;
    code?: string;
    name: string;
    releasedAt?: string;
  };
  /** Gesetzt, wenn dieses Spiel Teil eines Turnier-Tisches war - für die Sieger-Korrektur im Verlauf (siehe match-tab.ts setMatchWinner). */
  tournamentMatchId?: string;
  /** Laufende Spielnummer innerhalb des Turnier-Tisches (1., 2., 3. Spiel einer BO3) - für die Gruppierung im Verlauf. */
  tournamentGameNumber?: number;
  /**
   * Default true (normale Matches zählen immer). Bei Turnier-Spielen vom Turnier vererbt (siehe
   * Tournament.countInGeneralStats) - false blendet das Match aus allen Statistik-Aggregaten aus
   * (Stats-Tab, Deck-/Commander-Statistiken, Platzierungsverteilung), bleibt aber im normalen
   * Match-Verlauf sichtbar, da es ja wirklich gespielt wurde.
   */
  countsInGeneralStats: boolean;
}

export interface Cube {
  id: string;
  name: string;
  isCommander: boolean;
}

export interface PlayerStats {
  name: string;
  games: number;
  wins: number;
  winRate: number;
}

export interface CommanderStats {
  commander: string;
  games: number;
  wins: number;
  winRate: number;
  playedBy: string[];
}

export interface DeckStats {
  deckId: string;
  deckName: string;
  isPrecon: boolean;
  games: number;
  wins: number;
  winRate: number;
  pilots: { name: string; borrowed: boolean }[];
  /** Zuletzt in einem Match erfasster Commander dieses Decks, falls vorhanden. */
  commander?: string;
  /** Im Deck selbst hinterlegtes Commander-Bild (deck_cards.image_url), falls vorhanden - hat Vorrang vor der generischen Scryfall-Suche nach dem Namen. */
  commanderImageUrl?: string | null;
  /** true = das Deck wurde gelöscht und steht nur noch als Grabstein in der Datenbank (siehe DeckService.deleteDeck()). Die Zahlen hier bleiben davon unberührt, nur ansehen lässt sich das Deck nicht mehr. */
  isDeleted?: boolean;
}
