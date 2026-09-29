import { Injectable, inject } from '@angular/core';
import { supabase } from './supabase.client';
import { ScryfallService, ScryfallCard } from './scryfall.service';
import { CardDataService } from './card-data.service';
import { isPlayerWinner } from './match-utils';
import { sleep } from './array-utils';
import { parseSubtypes } from './deck-analyse';
import { GroupService } from './group.service';
import { PreconService } from './precon.service';
import { COLORLESS, COLOR_AXES, FILTER_COLORS } from './color-filter-match';
import { DeckFormat, GameMode } from './models';

export interface Deck {
  id: string;
  /** Nur bei einem Deck eines echten Accounts gesetzt - exklusiv zu playerId, siehe DeckOwner. */
  userId: string | null;
  /** Nur bei einem Deck eines "virtuellen" Spielers ohne eigenen Login gesetzt - exklusiv zu userId. */
  playerId: string | null;
  /** Gruppe des Spielers, falls playerId gesetzt ist - für die Bearbeitungsrechte-Prüfung (nur der Gruppen-Admin darf ein spielerbesitztes Deck bearbeiten). */
  groupId: string | null;
  name: string;
  format: DeckFormat | null;
  updatedAt: string;
  /** Zeitpunkt der Deck-Anlage (unverändert seit dem Import, im Gegensatz zu updatedAt) - für den Jahresfilter in der Deck-Auswahl. */
  createdAt: string;
  isPrecon: boolean;
  /** Nur bei Precons gesetzt (aus MTGJSON, siehe PreconService) - das tatsächliche Release-Jahr des Precons, NICHT das Jahr des Imports in diese App. Für den Jahresfilter in der Deck-Auswahl. */
  preconReleaseYear: number | null;
  /** EDHREC-Theme-Tag-Slug (z.B. "ramp", "aristocrats") - steuert die EDHREC-Vorschläge im Bearbeiten-Modus. */
  edhrecTag: string | null;
  /** Privat gestellte Decks tauchen nicht auf, wenn andere User dieses Profil ansehen - Standard ist sichtbar (opt-in privat, nicht opt-in sichtbar). */
  isPrivate: boolean;
  /** Als "Outdated" markierte Decks sind standardmäßig in der Deck-Liste ausgeblendet (z.B. für Decks, die nicht mehr gespielt werden, aber nicht gelöscht werden sollen). */
  isOutdated: boolean;
  /**
   * Gesetzt = gelöschtes Deck ("Grabstein", siehe deleteDeck()): ohne Kartenliste, bleibt nur,
   * damit Partien Name, Besitzer und Farbidentität behalten. Listen und Suche blenden es aus,
   * Statistiken zählen es weiter.
   */
  deletedAt: string | null;
  /**
   * Selbst gewählter Kreaturtyp (z. B. "Elf") aus decks.commander_types[0]. Beim Import einmal mit
   * dem Typ des Commanders vorbefüllt, danach rein manuell (updateDeckArchetype()).
   */
  creatureType: string | null;
  /** Selbst gewählte Bracket-Stufe 1-5, null = automatisch (dann gilt bracketAuto). */
  bracket: number | null;
  /**
   * Zuletzt berechnete Automatik-Stufe (bracket.ts), gespeichert, damit Listen ein Abzeichen ohne
   * Kartenliste zeigen können.
   */
  bracketAuto: number | null;
  bracketAutoAt: string | null;
}

/**
 * Ein Deck gehört einem Account ODER einem virtuellen Spieler, nie beidem (decks_owner_xor_check).
 */
export type DeckOwner = { kind: 'user'; userId: string } | { kind: 'player'; playerId: string };

export interface DeckGameStats {
  games: number;
  wins: number;
  winRate: number;
  /** Zuletzt in einem Match erfasster Commander dieses Decks, falls vorhanden (für das Kartenbild). */
  commander?: string;
}

export interface CommanderGameStats {
  commander: string;
  games: number;
  wins: number;
  winRate: number;
  /** Nur bei geliehenem Deck: das fremde Deck, damit es aus der Liste geöffnet werden kann. */
  borrowedDeck?: BorrowedDeckInfo;
}

export interface BorrowedDeckInfo {
  id: string;
  name: string;
  /** Anzeigename des Besitzers, falls auflösbar (z.B. bei einem Deck aus einer anderen Gruppe nicht). */
  ownerName: string | null;
  /**
   * Gespeichertes Commander-Bild (deck_cards.image_url) - spart einen Scryfall-Lookup, der am
   * Rate-Limit scheitern kann.
   */
  commanderImageUrl: string | null;
}

/**
 * Warum ein gespielter Commander kein eigenes Deck hat - bestimmt die Liste im Profil: `none` =
 * Deck fehlt (anlegen/verlinken lohnt), `borrowed` = Deck einer anderen Person gespielt, `cube` =
 * Cube-/Draft-Spiel, dafür gibt es nie ein Deck.
 */
export type UnassignedCommanderCategory = 'none' | 'borrowed' | 'cube';

export interface UnassignedCommanderStats extends CommanderGameStats {
  category: UnassignedCommanderCategory;
}

/**
 * Persönliche Statistik eines Accounts über ALLE seine Gruppen (Profil-Tab; der Stats-Tab bleibt je
 * Gruppe).
 */
export interface CrossGroupPersonalStats {
  totalGames: number;
  totalWins: number;
  winRate: number;
  /** Anzahl verschiedener Gruppen, aus denen Spiele in die Gesamtwertung eingeflossen sind. */
  groupCount: number;
  topCommander: CommanderGameStats | null;
}

export interface MostUsedCardStats {
  cardName: string;
  imageUrl: string | null;
  /** Anzahl tatsächlich gespielter Partien über alle Decks hinweg, die diese Karte enthalten. */
  gameCount: number;
  /** Anzahl verschiedener Decks, die diese Karte enthalten (unabhängig von Partienanzahl). */
  deckCount: number;
}

export interface ColorStat {
  /**
   * Eine der fünf Farben oder 'C' für farblose Decks. 'C' ist eine eigene Achse: ein farbloses Deck
   * zählt nur dort.
   */
  color: 'W' | 'U' | 'B' | 'R' | 'G' | 'C';
  /** Anzahl tatsächlich gespielter Partien mit Decks, deren Farbidentität diese Farbe enthält. */
  gameCount: number;
  /** Anzahl verschiedener Decks, deren Farbidentität diese Farbe enthält. */
  deckCount: number;
}

export interface ColorComboStat {
  /** Farbidentität eines Decks (leer = farblos), sortiert in WUBRG-Reihenfolge. */
  colors: ('W' | 'U' | 'B' | 'R' | 'G')[];
  /** Anzahl tatsächlich gespielter Partien mit Decks genau dieser Farbidentität. */
  gameCount: number;
  /** Anzahl verschiedener Decks genau dieser Farbidentität. */
  deckCount: number;
}

/**
 * "Meistgespielte Karten" (ohne Länder), Farb- und Farbkombinations-Rangliste über alle Gruppen
 * (getCardAndColorStats()). Precons zählen nicht.
 */
export interface CardAndColorStats {
  mostUsedCards: MostUsedCardStats[];
  colorRanking: ColorStat[];
  colorComboRanking: ColorComboStat[];
}

/**
 * Eintrag der weltweiten Decks-/Commander-Rangliste aus global_deck_commander_stats() (SECURITY
 * DEFINER, RLS sähe nur eigene Gruppen). Bewusst ohne Spielernamen fremder Gruppen.
 */
export interface GlobalDeckStat {
  /** Für den "Ansehen"-Sprung zur Deck-Detailansicht. */
  deckId: string;
  name: string;
  commanderImageUrl: string | null;
  games: number;
  wins: number;
  winRate: number;
}

export interface GlobalCommanderStat {
  name: string;
  commanderImageUrl: string | null;
  games: number;
  wins: number;
  winRate: number;
}

/** Übersichts-Kacheln der Global-Ansicht (Stats-Tab) - siehe DeckService.getGlobalOverviewStats(). */
export interface GlobalOverviewStats {
  /** Echte Matches, ohne die Verlierer-Platzhalter des Excel-Imports. */
  games: number;
  /** Spieler mit mindestens einem gewerteten Match. */
  players: number;
  /** Angelegte, öffentliche Nicht-Precon-Decks. */
  decks: number;
}

export interface DeckCard {
  cardName: string;
  quantity: number;
  imageUrl: string | null;
  typeLine: string | null;
  cmc: number;
  isCommander: boolean;
  /** Frei vergebene eigene Sortier-Tags (z.B. "Removal", "Wincon") - eine Karte kann mehrere haben. */
  customTags: string[];
  /** Steht in der engeren Auswahl (Maybeboard) statt wirklich im Deck - zählt nicht zur Deckgröße/Analyse. */
  isMaybeboard: boolean;
  /** Marke (Token), die eine andere Karte im Deck erzeugt - kein eigener Deckeintrag, zählt nicht zur Deckgröße/Analyse. */
  isToken: boolean;
  /**
   * Scryfalls kartenübergreifende ID, nur bei Marken gesetzt - viele verschiedene Marken heißen
   * gleich.
   */
  scryfallOracleId: string | null;
}

export interface DeckChangeEntry {
  changedAt: string;
  cardName: string;
  changeType: 'added' | 'removed';
  quantity: number;
}

const SECTION_HEADER =
  /^(deck|decklist|main|mainboard|main deck|sideboard|maybeboard|commander|companion)\s*:?\s*$/i;
/**
 * "3 Island", "3x Island", "3× Island" (so zeigt die eigene Deck-Ansicht die Anzahl, siehe
 * normalisiereDeckAnsicht).
 */
const QUANTITY_LINE = /^(\d+)\s*[x×]?\s+(.+)$/i;
/**
 * Set-Kürzel + Sammelnummer ("Sol Ring (SOC) 128"), ausgelesen, weil sie genau einen Druck und
 * damit das gewählte Artwork benennen. Die Nummer darf - und / enthalten (Moxfield "The List":
 * "ORI-221"), sonst bliebe der Zusatz im Namen und die Karte wäre unauffindbar.
 */
const SET_AND_COLLECTOR_NUMBER_SUFFIX = /\s*\(([A-Za-z0-9]{2,6})\)\s*([A-Za-z0-9★†+/-]*)\s*$/;
/** Archidekt hängt hinter die Kategorien noch seine Sammlungs-Markierung: "... [Removal] ^Have,#37d67a^". */
const ARCHIDEKT_COLLECTION_SUFFIX = /\s*\^[^^]*\^\s*$/;
/** Archidekt-Kategorie am Zeilenende: "[Removal]", "[Commander{top}]", "[Maybeboard{noDeck}{noPrice},Recursion]". */
const ARCHIDEKT_CATEGORY_SUFFIX = /\s*\[([^\]]*)\]\s*$/;
/** TappedOut/MTGO-Markierungen in der Zeile: "*CMDR*" (Commander), "*F*"/"*E*" (Foil/Etched). */
const INLINE_MARKER = /\s*\*([A-Za-z]{1,9})\*/g;
/** Cockatrice und Magic Workstation stellen jeder Sideboard-Zeile "SB:" voran. */
const SIDEBOARD_PREFIX = /^SB:\s*/i;
/** Moxfield trennt die Hälften einer geteilten Karte mit einem einfachen Schrägstrich ("Revival / Revenge"), Scryfall kennt nur den doppelten. */
const SINGLE_SLASH_SPLIT = /\s+\/\s+/g;

/** Eine Zeile, die NUR aus einer Anzahl besteht ("1×", "3x", "12") - so bricht der Browser die Kartenzeilen der Deck-Ansicht um. */
const NUR_ANZAHL_ZEILE = /^(\d+)\s*[x×]?$/i;

/** Überschrift der Deck-Ansicht: der Abschnittsname plus seine Kartenzahl in Klammern ("Kreatur (27)", "Land (33 + 5 MDFC)"). */
const ANSICHT_UEBERSCHRIFT = /^(.+?)\s*\((\d+[^)]*)\)$/;

/**
 * Abschnittsnamen der eigenen Deck-Ansicht (beide Sprachen), nur zum Erkennen des Formats.
 * Umgeformt wird jede Zeile mit Klammer-Zahl, damit auch Tag-Gruppen ("Ramp (12)") tragen.
 */
const ANSICHT_ABSCHNITTE = new Set([
  'commander',
  'planeswalker',
  'battle',
  'kreatur',
  'creature',
  'legendäre kreatur',
  'legendary creature',
  'spontanzauber',
  'instant',
  'hexerei',
  'sorcery',
  'artefakt',
  'artifact',
  'verzauberung',
  'enchantment',
  'land',
  'sonstiges',
  'other',
  'ohne tag',
  'no tag',
  'maybeboard',
  'tokens',
]);

/**
 * Formt eine aus der eigenen Deck-Ansicht kopierte Liste in "Anzahl Name" um; null, wenn der Text
 * nicht so aussieht. Der Browser liefert dort Überschriften mit Kartenzahl ("Commander (1)") und
 * die Anzahl ("1×") in eigener Zeile - ungefiltert entstand ein kaputtes Deck. Die Tokens-Gruppe
 * fällt weg: das sind keine Deckkarten.
 */
function normalisiereDeckAnsicht(lines: string[]): string[] | null {
  const siehtDanachAus = lines.some(
    (line) =>
      NUR_ANZAHL_ZEILE.test(line) ||
      ANSICHT_ABSCHNITTE.has((line.match(ANSICHT_UEBERSCHRIFT)?.[1] ?? '').trim().toLowerCase()),
  );
  if (!siehtDanachAus) return null;

  const out: string[] = [];
  /** Anzahl aus der vorigen Zeile, die noch auf ihren Kartennamen wartet. */
  let offeneAnzahl: string | null = null;
  let inTokens = false;

  for (const line of lines) {
    if (!line) continue;

    const anzahl = line.match(NUR_ANZAHL_ZEILE);
    if (anzahl) {
      offeneAnzahl = anzahl[1];
      continue;
    }

    // Eine Überschrift steht nie zwischen Anzahl und Name - diese Bedingung hält Kartennamen
    // heraus, die zufällig auf eine Klammer-Zahl enden.
    const ueberschrift = offeneAnzahl === null ? line.match(ANSICHT_UEBERSCHRIFT) : null;
    if (ueberschrift) {
      const abschnitt = ueberschrift[1].trim().toLowerCase();
      inTokens = abschnitt === 'tokens' || abschnitt === 'token';
      // Jede andere Überschrift (auch ein eigener Tag) wird zu "Deck:", damit ein vorheriger
      // Commander-/Maybeboard-Abschnitt sicher endet.
      out.push(
        abschnitt === 'commander'
          ? 'Commander:'
          : abschnitt === 'maybeboard' || abschnitt === 'sideboard'
            ? 'Maybeboard:'
            : 'Deck:',
      );
      continue;
    }

    if (inTokens) {
      offeneAnzahl = null;
      continue;
    }

    // Die wartende Anzahl gilt nur für eine Zeile, die selbst keine mitbringt - sonst machte eine
    // einzelne verirrte Zahl in einer ganz gewöhnlichen Liste aus "1 Sol Ring" ein "100 1 Sol Ring".
    out.push(offeneAnzahl && !QUANTITY_LINE.test(line) ? `${offeneAnzahl} ${line}` : line);
    offeneAnzahl = null;
  }

  return out;
}

/**
 * Erkennt Exporte ohne Beschriftung, die nur Leerzeilen nutzen: Moxfield stellt den Commander als
 * eigenen Block voran, MTGGoldfish hängt das Sideboard an. Nur wenn die Liste nirgends eine
 * Überschrift hat.
 */
function blockRoles(lines: string[]): Map<number, 'commander' | 'sideboard'> {
  const roles = new Map<number, 'commander' | 'sideboard'>();
  const blocks: { lineNumbers: number[]; cards: number }[] = [];
  let current: { lineNumbers: number[]; cards: number } | null = null;

  for (const [lineNumber, line] of lines.entries()) {
    if (!line) {
      current = null;
      continue;
    }
    // Erst die Überschrift prüfen, dann den Kommentar überspringen - deckstats.net schreibt seine
    // Abschnitte als "//Commander", die wäre sonst als bloßer Kommentar durchgerutscht.
    if (SECTION_HEADER.test(line.replace(/^\/\/\s*/, ''))) return roles;
    if (line.startsWith('//') || line.startsWith('#')) continue;
    if (!current) {
      current = { lineNumbers: [], cards: 0 };
      blocks.push(current);
    }
    current.lineNumbers.push(lineNumber);
    const match = line.match(QUANTITY_LINE);
    current.cards += match ? parseInt(match[1], 10) : 1;
  }

  if (blocks.length < 2) return roles;
  const first = blocks[0];
  const last = blocks[blocks.length - 1];

  // Moxfield: ein bis zwei Karten ganz vorn (Commander, optional Partner/Hintergrund).
  if (first.lineNumbers.length <= 2) {
    for (const lineNumber of first.lineNumbers) roles.set(lineNumber, 'commander');
  }

  // MTGGoldfish: genau zwei Blöcke, vorn ein ganzes Deck, hinten höchstens 15 Karten.
  if (blocks.length === 2 && first.cards >= 40 && last.cards <= 15) {
    for (const lineNumber of last.lineNumbers) roles.set(lineNumber, 'sideboard');
  }

  return roles;
}

/** Eine geparste Decklist-Zeile (siehe DeckService.parseDecklistText()). */
export interface ParsedDecklistEntry {
  name: string;
  quantity: number;
  isCommander: boolean;
  /**
   * Stand allein im ersten Block einer Liste ohne Überschriften (Moxfield-Commander). Nur eine
   * Vermutung, erst saveDeck() bestätigt sie anhand der Kartendaten.
   */
  isCommanderCandidate: boolean;
  /** Stand unter einer "Maybeboard"-Überschrift - gehört in die engere Auswahl, nicht ins Deck. */
  isMaybeboard: boolean;
  /** Set-Kürzel aus der Zeile, falls das Exportformat eines mitliefert ("Sol Ring (SOC) 128" -> "SOC"). */
  setCode: string | null;
  /** Sammelnummer zum Set-Kürzel ("Sol Ring (SOC) 128" -> "128") - nur zusammen mit setCode brauchbar. */
  collectorNumber: string | null;
}

/** Für den Precon-Namensabgleich in backfillPreconReleaseYears - fängt zumindest Whitespace-Abweichungen zwischen gespeichertem Decknamen und MTGJSON-Katalogeintrag ab (echte Umbenennungen bleiben davon unberührt, dafür gibt es keine zuverlässige Heuristik). */
function normalizePreconName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Kann die Karte Commander sein? Legendäre Kreaturen und alles, was es sich im Regeltext erlaubt
 * (Backgrounds, Planeswalker, Doctor's companion).
 */
function canBeCommander(card: ScryfallCard | undefined): boolean {
  if (!card) return false;
  const typeLine = card.typeLine ?? '';
  if (/legendary/i.test(typeLine) && /creature/i.test(typeLine)) return true;
  return /can be your commander/i.test(card.oracleText ?? '');
}

/** Wie DeckViewerService.saveEdits() für nachträgliche Commander-Wechsel - hier für den Import-/Neuanlage-Pfad in saveDeck(). */
function commanderMetadataFrom(
  parsed: { name: string; isCommander: boolean }[],
  cardMap: Map<string, ScryfallCard>
): { colorIdentity: string[]; commanderTypes: string[] } {
  const commanderCards = parsed
    .filter((p) => p.isCommander)
    .map((p) => cardMap.get(p.name.toLowerCase()))
    .filter((c): c is ScryfallCard => !!c);

  return {
    colorIdentity: [...new Set(commanderCards.flatMap((c) => c.colorIdentity ?? []))].sort(),
    commanderTypes: [...new Set(commanderCards.flatMap((c) => parseSubtypes(c.typeLine)))].sort(),
  };
}

/** Erkennt eine bereits nummerierte Fassung am Ende des Decknamens ("Atraxa (2)"). */
const VERSIONS_SUFFIX = /\s*\((\d+)\)\s*$/;

/**
 * Name der Deck-Kopie: "Atraxa" → "Atraxa (2)", "Atraxa (2)" → "Atraxa (3)", belegte Nummern
 * (`vorhandene`, Decks desselben Besitzers) werden übersprungen.
 */
export function deckKopieName(original: string, vorhandene: string[]): string {
  const basis = original.replace(VERSIONS_SUFFIX, '').trim() || original.trim();
  const start = Number.parseInt(original.match(VERSIONS_SUFFIX)?.[1] ?? '1', 10);
  const belegt = new Set(vorhandene.map((n) => n.trim().toLowerCase()));

  let nummer = Math.max(2, start + 1);
  while (belegt.has(`${basis} (${nummer})`.toLowerCase())) nummer++;
  return `${basis} (${nummer})`;
}

@Injectable({ providedIn: 'root' })
export class DeckService {
  private readonly scryfall = inject(ScryfallService);
  private readonly cardData = inject(CardDataService);
  private readonly groupService = inject(GroupService);
  private readonly preconService = inject(PreconService);

  /**
   * Spaltenliste der Deck-Abfragen. Die Bracket-Spalten (sql/deck-bracket-2026-09-06.sql) fehlen,
   * bis die Migration von Hand läuft; fest in der Liste ließe PostgREST jede Abfrage mit 42703
   * scheitern. Deshalb wird beim ersten 42703 auf eine Bracket-Spalte für die Sitzung abgeschaltet
   * und ohne sie wiederholt.
   */
  private static bracketSpaltenVerfuegbar = true;

  /**
   * Dasselbe für die Grabstein-Spalte (sql/deck-grabstein-loeschen-2026-09-21.sql): Spalte und
   * Filter hängen an diesem Schalter, die Abfragen greifen ihn beim zweiten Versuch auf.
   */
  private static grabsteinSpalteVerfuegbar = true;

  private static readonly BASIS_SPALTEN =
    'id, user_id, player_id, name, format, updated_at, created_at, is_precon, precon_release_year, edhrec_tag, is_private, is_outdated, commander_types, players ( group_id )';
  private static readonly BRACKET_SPALTEN = 'bracket, bracket_auto, bracket_auto_at';

  private static deckColumns(): string {
    const mitBracket = DeckService.bracketSpaltenVerfuegbar
      ? `${DeckService.BASIS_SPALTEN}, ${DeckService.BRACKET_SPALTEN}`
      : DeckService.BASIS_SPALTEN;
    return DeckService.grabsteinSpalteVerfuegbar ? `${mitBracket}, deleted_at` : mitBracket;
  }

  /**
   * Blendet Grabsteine aus (ohne Migration entfällt der Filter). Öffentlich, weil PublicDeckService
   * dieselbe Regel braucht.
   */
  static nurLebende<T extends { is(column: string, value: null): T }>(query: T): T {
    return DeckService.grabsteinSpalteVerfuegbar ? query.is('deleted_at', null) : query;
  }

  /**
   * true = Fehler kam von fehlenden Bracket-Spalten; schaltet für die Sitzung um, der Aufrufer
   * wiederholt.
   */
  private static istFehlendeBracketSpalte(error: { code?: string; message?: string } | null): boolean {
    if (!error || !DeckService.bracketSpaltenVerfuegbar) return false;
    // Nur die genannte Spalte zählt - ein beliebiger 42703 schaltete sonst die Bracket-Abzeichen
    // wegen einer anderen Migration ab.
    if (error.code !== '42703') return false;
    const message = error.message ?? '';
    if (message && !message.includes('bracket')) return false;
    console.warn(
      'Bracket-Spalten fehlen noch - sql/deck-bracket-2026-09-06.sql im Supabase-SQL-Editor ausführen. Decks werden solange ohne Bracket geladen.'
    );
    DeckService.bracketSpaltenVerfuegbar = false;
    return true;
  }

  /** true = Fehler kam von der fehlenden Grabstein-Spalte (siehe grabsteinSpalteVerfuegbar). */
  private static istFehlendeGrabsteinSpalte(error: { code?: string; message?: string } | null): boolean {
    if (!error || !DeckService.grabsteinSpalteVerfuegbar) return false;
    if (error.code !== '42703') return false;
    const message = error.message ?? '';
    if (message && !message.includes('deleted')) return false;
    console.warn(
      'Spalte deleted_at fehlt noch - sql/deck-grabstein-loeschen-2026-09-21.sql im Supabase-SQL-Editor ausführen. Bis dahin gibt es keine Grabsteine, und Decks mit Partien lassen sich nicht löschen.'
    );
    DeckService.grabsteinSpalteVerfuegbar = false;
    return true;
  }

  /**
   * true = eine fehlende Spalte wurde gerade abgeschaltet, ein neuer Versuch lohnt. Fehlen beide
   * Migrationen, fällt je Versuch ein Schalter (bis zu zwei Wiederholungen).
   */
  static fehlendeSpalteAbgeschaltet(error: { code?: string; message?: string } | null): boolean {
    return DeckService.istFehlendeBracketSpalte(error) || DeckService.istFehlendeGrabsteinSpalte(error);
  }

  /**
   * DeckOwner → players.id: bei einem Account eine je Gruppe, bei einem virtuellen Spieler die
   * playerId selbst.
   */
  async resolvePlayerIds(owner: DeckOwner): Promise<string[]> {
    if (owner.kind === 'player') return [owner.playerId];
    const { data } = await supabase.from('players').select('id').eq('user_id', owner.userId);
    return (data ?? []).map((p) => p.id);
  }

  async loadDecksForOwner(owner: DeckOwner): Promise<Deck[]> {
    const abfrage = () => {
      const query = DeckService.nurLebende(
        supabase
          .from('decks')
          .select(DeckService.deckColumns())
          .order('updated_at', { ascending: false })
      );
      return owner.kind === 'user'
        ? query.eq('user_id', owner.userId)
        : query.eq('player_id', owner.playerId);
    };

    let { data, error } = await abfrage();
    // Migration noch nicht ausgeführt - ohne die Bracket-/Grabstein-Spalten erneut versuchen, statt
    // die Deck-Liste leer zu lassen (siehe deckColumns()).
    for (let versuch = 0; versuch < 2 && DeckService.fehlendeSpalteAbgeschaltet(error); versuch++)
      ({ data, error } = await abfrage());

    if (error) {
      console.error('Konnte Decks nicht laden:', error);
      return [];
    }

    return (data as any[]).map((row) => ({
      id: row.id,
      userId: row.user_id,
      playerId: row.player_id,
      groupId: row.players?.group_id ?? null,
      name: row.name,
      format: row.format,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      isPrecon: row.is_precon,
      preconReleaseYear: row.precon_release_year ?? null,
      edhrecTag: row.edhrec_tag,
      isPrivate: row.is_private ?? false,
      isOutdated: row.is_outdated ?? false,
      creatureType: row.commander_types?.[0] ?? null,
      deletedAt: row.deleted_at ?? null,
      bracket: row.bracket ?? null,
      bracketAuto: row.bracket_auto ?? null,
      bracketAutoAt: row.bracket_auto_at ?? null,
    }));
  }

  /**
   * Einzelnes Deck per ID, auch Grabsteine - der Aufrufer soll erkennen, dass es das Deck nicht
   * mehr gibt.
   */
  async getDeckById(deckId: string): Promise<Deck | null> {
    const abfrage = () =>
      supabase.from('decks').select(DeckService.deckColumns()).eq('id', deckId).maybeSingle();

    let { data, error } = await abfrage();
    // Siehe loadDecksForOwner(): ohne die fehlenden Spalten erneut versuchen, statt gar kein Deck zu liefern.
    for (let versuch = 0; versuch < 2 && DeckService.fehlendeSpalteAbgeschaltet(error); versuch++)
      ({ data, error } = await abfrage());

    if (error || !data) {
      console.error('Konnte Deck nicht laden:', error);
      return null;
    }

    const row = data as any;
    return {
      id: row.id,
      userId: row.user_id,
      playerId: row.player_id,
      groupId: row.players?.group_id ?? null,
      name: row.name,
      format: row.format,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      isPrecon: row.is_precon,
      preconReleaseYear: row.precon_release_year ?? null,
      edhrecTag: row.edhrec_tag,
      isPrivate: row.is_private ?? false,
      isOutdated: row.is_outdated ?? false,
      creatureType: row.commander_types?.[0] ?? null,
      deletedAt: row.deleted_at ?? null,
      bracket: row.bracket ?? null,
      bracketAuto: row.bracket_auto ?? null,
      bracketAutoAt: row.bracket_auto_at ?? null,
    };
  }

  async loadDeckCards(deckId: string): Promise<DeckCard[]> {
    const { data, error } = await supabase
      .from('deck_cards')
      .select(
        'card_name, quantity, image_url, type_line, cmc, is_commander, custom_tags, is_maybeboard, is_token, scryfall_oracle_id'
      )
      .eq('deck_id', deckId)
      .order('card_name', { ascending: true });

    if (error) {
      console.error('Konnte Deck-Karten nicht laden:', error);
      return [];
    }

    return data.map((row) => ({
      cardName: row.card_name,
      quantity: row.quantity,
      imageUrl: row.image_url,
      typeLine: row.type_line,
      cmc: row.cmc ?? 0,
      isCommander: row.is_commander,
      customTags: row.custom_tags ?? [],
      isMaybeboard: row.is_maybeboard ?? false,
      isToken: row.is_token ?? false,
      scryfallOracleId: row.scryfall_oracle_id ?? null,
    }));
  }

  async loadChangeLog(deckId: string): Promise<DeckChangeEntry[]> {
    const { data, error } = await supabase
      .from('deck_change_log')
      .select('changed_at, card_name, change_type, quantity')
      .eq('deck_id', deckId)
      .order('changed_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('Konnte Änderungsverlauf nicht laden:', error);
      return [];
    }

    return data.map((row) => ({
      changedAt: row.changed_at,
      cardName: row.card_name,
      changeType: row.change_type,
      quantity: row.quantity,
    }));
  }

  /**
   * Parst eine eingefügte Decklist ("1 Sol Ring", "1x Sol Ring"). Kommentarzeilen (//, #) zählen
   * als Überschriften (Commander, Maybeboard); doppelte Namen werden summiert.
   */
  parseDecklistText(text: string): ParsedDecklistEntry[] {
    const merged = new Map<string, ParsedDecklistEntry>();
    const rohZeilen = text.split('\n').map((line) => line.trim());
    // Aus der eigenen Deck-Ansicht kopiert? Dann erst in ein normales "Anzahl Name"-Format bringen.
    const lines = normalisiereDeckAnsicht(rohZeilen) ?? rohZeilen;
    const roles = blockRoles(lines);
    let section: 'main' | 'commander' | 'maybeboard' = 'main';

    for (const [lineNumber, line] of lines.entries()) {
      if (!line) {
        // Eine Leerzeile beendet in den meisten Exporten die Commander-Sektion ohne neue
        // Überschrift. Das Maybeboard steht dagegen am Ende und hat Leerzeilen zwischen
        // Unterkategorien - es bleibt bis zur nächsten Überschrift.
        if (section === 'commander') section = 'main';
        continue;
      }

      const headerMatch = line.replace(/^\/\/\s*/, '').match(SECTION_HEADER);
      if (headerMatch || line.startsWith('//') || line.startsWith('#')) {
        if (headerMatch) {
          const header = headerMatch[1].toLowerCase();
          // Sideboard und Companion sind keine Deckkarten - sie gehören in die engere Auswahl.
          // Vorher fielen beide auf "main" zurück und landeten mitten in der Kartenliste.
          section =
            header === 'commander'
              ? 'commander'
              : header === 'maybeboard' || header === 'sideboard' || header === 'companion'
                ? 'maybeboard'
                : 'main';
        }
        continue;
      }

      // Erst die Zeilen-Markierungen der Seiten abtrennen (z. B. Archidekt-Kategorien), bis nur
      // "Anzahl Name Druck" bleibt.
      let rest = line;
      let isCommanderLine = section === 'commander';
      let isMaybeboardLine = section === 'maybeboard' || roles.get(lineNumber) === 'sideboard';

      if (SIDEBOARD_PREFIX.test(rest)) {
        isMaybeboardLine = true;
        rest = rest.replace(SIDEBOARD_PREFIX, '');
      }

      rest = rest.replace(ARCHIDEKT_COLLECTION_SUFFIX, '');

      const category = rest.match(ARCHIDEKT_CATEGORY_SUFFIX);
      if (category) {
        rest = rest.replace(ARCHIDEKT_CATEGORY_SUFFIX, '');
        // "[Maybeboard{noDeck}{noPrice},Recursion]" -> ["maybeboard", "recursion"]. Die geschweiften
        // Zusätze sind Archidekt-Optionen, keine Kategorienamen.
        const names = category[1].split(',').map((part) =>
          part
            .replace(/\{[^}]*\}/g, '')
            .trim()
            .toLowerCase(),
        );
        if (names.includes('commander')) isCommanderLine = true;
        if (names.includes('maybeboard')) isMaybeboardLine = true;
      }

      const match = rest.match(QUANTITY_LINE);
      const rawName = (match ? match[2] : rest)
        .replace(INLINE_MARKER, (_full, marker: string) => {
          if (/^(cmdr|commander)$/i.test(marker)) isCommanderLine = true;
          return '';
        })
        .trim();
      const printing = rawName.match(SET_AND_COLLECTOR_NUMBER_SUFFIX);
      const name = rawName
        .replace(SET_AND_COLLECTOR_NUMBER_SUFFIX, '')
        .replace(SINGLE_SLASH_SPLIT, ' // ')
        .trim();
      const quantity = match ? parseInt(match[1], 10) : 1;
      if (!name) continue;

      const setCode = printing?.[1] ?? null;
      const collectorNumber = printing?.[2] || null;
      const isMaybeboard = isMaybeboardLine;
      // Nur eine Vermutung, solange die Zeile nicht ohnehin schon als Commander markiert ist.
      const isCommanderCandidate = !isCommanderLine && roles.get(lineNumber) === 'commander';

      const key = name.toLowerCase();
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          name,
          quantity,
          isCommander: isCommanderLine,
          isCommanderCandidate,
          isMaybeboard,
          setCode,
          collectorNumber,
        });
        continue;
      }

      if (existing.isMaybeboard === isMaybeboard) {
        existing.quantity += quantity;
      } else if (existing.isMaybeboard) {
        // Karte in Maybeboard UND Deck: das Deck gewinnt, die Maybeboard-Zeile zählt nicht mit.
        existing.quantity = quantity;
        existing.isMaybeboard = false;
        if (setCode) {
          existing.setCode = setCode;
          existing.collectorNumber = collectorNumber;
        }
      }
      if (isCommanderLine) existing.isCommander = true;
      if (isCommanderCandidate) existing.isCommanderCandidate = true;
      if (!existing.setCode && setCode) {
        existing.setCode = setCode;
        existing.collectorNumber = collectorNumber;
      }
    }

    return [...merged.values()];
  }

  /**
   * Legt ein Deck an (ohne existingDeckId) oder ersetzt die Kartenliste und schreibt die Differenz
   * in den Änderungsverlauf.
   */
  async saveDeck(
    owner: DeckOwner,
    name: string,
    format: DeckFormat | null,
    rawText: string,
    existingDeckId: string | null,
    isPrecon = false,
    edhrecTag: string | null = null,
    /** Nur bei Precons relevant - tatsächliches Release-Jahr aus MTGJSON (siehe PreconSummary.releaseYear), NICHT das Import-Datum. */
    preconReleaseYear: number | null = null
  ): Promise<string | null> {
    const parsed = this.parseDecklistText(rawText);
    if (parsed.length === 0) return null;

    const cardMap = await this.cardData.findCardsBulk(parsed.map((p) => p.name));
    // Nennt die Liste Set und Nummer, genau diesen Druck nachschlagen (das gewählte Artwork).
    const printings = await this.scryfall.findPrintingsBySetAndNumber(
      parsed
        .filter((p) => p.setCode && p.collectorNumber)
        .map((p) => ({ name: p.name, setCode: p.setCode!, collectorNumber: p.collectorNumber! }))
    );
    // Farb-/Typ-Metadaten fürs öffentliche Stöbern gleich beim Import schreiben. Die
    // Moxfield-Commander-Vermutung wird erst hier geprüft und nur übernommen, wenn die Liste sonst
    // keinen Commander nennt.
    if (!parsed.some((p) => p.isCommander)) {
      for (const entry of parsed) {
        if (entry.isCommanderCandidate && canBeCommander(cardMap.get(entry.name.toLowerCase()))) {
          entry.isCommander = true;
        }
      }
    }

    const { colorIdentity, commanderTypes } = commanderMetadataFrom(parsed, cardMap);

    let deckId = existingDeckId;
    /** Kartenname (klein) -> bisher gespeichertes Bild, damit ein von Hand gewähltes Artwork eine Deck-Aktualisierung übersteht (siehe cardRows unten). */
    const previousImages = new Map<string, string | null>();

    if (deckId) {
      const { data: oldRows, error: oldError } = await supabase
        .from('deck_cards')
        .select('card_name, quantity, image_url')
        .eq('deck_id', deckId);

      if (oldError) {
        console.error('Konnte bisherige Kartenliste nicht laden:', oldError);
        return null;
      }

      const oldByKey = new Map((oldRows ?? []).map((r) => [r.card_name.toLowerCase(), r]));
      for (const row of oldRows ?? []) previousImages.set(row.card_name.toLowerCase(), row.image_url ?? null);
      const newByKey = new Map(parsed.map((p) => [p.name.toLowerCase(), p]));

      const changeRows: {
        deck_id: string;
        card_name: string;
        change_type: 'added' | 'removed';
        quantity: number;
      }[] = [];

      for (const [key, p] of newByKey) {
        const oldQty = oldByKey.get(key)?.quantity ?? 0;
        if (p.quantity > oldQty) {
          changeRows.push({
            deck_id: deckId,
            card_name: p.name,
            change_type: 'added',
            quantity: p.quantity - oldQty,
          });
        }
      }
      for (const [key, old] of oldByKey) {
        const newQty = newByKey.get(key)?.quantity ?? 0;
        if (newQty < old.quantity) {
          changeRows.push({
            deck_id: deckId,
            card_name: old.card_name,
            change_type: 'removed',
            quantity: old.quantity - newQty,
          });
        }
      }

      if (changeRows.length > 0) {
        const { error: logError } = await supabase.from('deck_change_log').insert(changeRows);
        if (logError) console.error('Konnte Änderungsverlauf nicht speichern:', logError);
      }

      const { error: deleteError } = await supabase.from('deck_cards').delete().eq('deck_id', deckId);
      if (deleteError) {
        console.error('Konnte alte Kartenliste nicht ersetzen:', deleteError);
        return null;
      }

      const { error: updateError } = await supabase
        .from('decks')
        .update({
          name,
          format,
          edhrec_tag: edhrecTag,
          color_identity: colorIdentity,
          commander_types: commanderTypes,
          updated_at: new Date().toISOString(),
        })
        .eq('id', deckId);
      if (updateError) {
        console.error('Konnte Deck nicht aktualisieren:', updateError);
        return null;
      }
    } else {
      const { data, error } = await supabase
        .from('decks')
        .insert({
          user_id: owner.kind === 'user' ? owner.userId : null,
          player_id: owner.kind === 'player' ? owner.playerId : null,
          name,
          format,
          is_precon: isPrecon,
          precon_release_year: preconReleaseYear,
          edhrec_tag: edhrecTag,
          color_identity: colorIdentity,
          commander_types: commanderTypes,
        })
        .select('id')
        .single();

      if (error || !data) {
        console.error('Konnte Deck nicht anlegen:', error);
        return null;
      }
      deckId = data.id;
    }

    const cardRows = parsed.map((p) => {
      const key = p.name.toLowerCase();
      const card = cardMap.get(key);
      return {
        deck_id: deckId,
        card_name: p.name,
        quantity: p.quantity,
        // Reihenfolge: benannter Druck, dann das bisherige Bild (evtl. von Hand gewählt), zuletzt
        // Scryfalls Standarddruck.
        image_url: printings.get(key)?.imageUrl ?? previousImages.get(key) ?? card?.imageUrl ?? null,
        type_line: card?.typeLine ?? null,
        cmc: card?.cmc ?? 0,
        is_commander: p.isCommander,
        is_maybeboard: p.isMaybeboard,
      };
    });

    const { error: insertError } = await supabase.from('deck_cards').insert(cardRows);
    if (insertError) {
      console.error('Konnte Kartenliste nicht speichern:', insertError);
      return null;
    }

    // Nur bei einem brandneuen Deck: alte, bislang nur namentlich getrackte Matches nachträglich
    // mit diesem Deck verknüpfen (siehe backfillDeckLinks für die genauen Regeln).
    if (!existingDeckId) {
      const commanderEntry = parsed.find((p) => p.isCommander);
      if (commanderEntry) {
        await this.backfillDeckLinks(deckId!, owner, commanderEntry.name);
      }
    }

    return deckId;
  }

  /**
   * Verknüpft alte, unverknüpfte Matches mit einem neuen Deck - nur Partien, in denen DIESER
   * Besitzer den gleichnamigen Commander spielte (nicht namensbasiert über alle Spieler), nie
   * Cube/Draft.
   */
  private async backfillDeckLinks(deckId: string, owner: DeckOwner, commanderName: string): Promise<void> {
    const playerIds = await this.resolvePlayerIds(owner);
    if (playerIds.length === 0) return;

    const { data: candidateRows } = await supabase
      .from('match_players')
      .select('match_id')
      .in('player_id', playerIds)
      .is('deck_id', null)
      .ilike('commander_name', commanderName);

    const matchIds = await this.eligibleMatchIdsExcludingCubeDraft([...new Set((candidateRows ?? []).map((r) => r.match_id))]);
    if (matchIds.length === 0) return;

    const { error } = await supabase
      .from('match_players')
      .update({ deck_id: deckId })
      .in('match_id', matchIds)
      .in('player_id', playerIds)
      .is('deck_id', null)
      .ilike('commander_name', commanderName);

    if (error) {
      console.error('Konnte alte Matches nicht nachträglich verknüpfen:', error);
    }
  }

  /**
   * Filtert match_ids auf Nicht-Cube/Draft-Spiele (gleiche Regel wie
   * MtgService.resolveAutoDeckLinks).
   */
  private async eligibleMatchIdsExcludingCubeDraft(matchIds: string[]): Promise<string[]> {
    if (matchIds.length === 0) return [];

    const { data, error } = await supabase
      .from('matches')
      .select('id')
      .in('id', matchIds)
      .not('game_mode', 'in', '(Cube,Draft)');

    if (error) {
      console.error('Konnte Spielmodus für Deck-Verknüpfung nicht prüfen:', error);
      return [];
    }

    return (data ?? []).map((m) => m.id);
  }

  /**
   * Gegenrichtung zu backfillDeckLinks: vorhandenes Deck mit passendem Commander für ein neues
   * Match ohne Deckwahl.
   */
  async findDeckIdByCommander(owner: DeckOwner, commanderName: string): Promise<string | null> {
    // Gelöschte Decks (Grabsteine) bleiben hier außen vor - sie haben keine Kartenliste mehr, und
    // ein neues Match soll sich nie an ein Deck hängen, das es nicht mehr gibt.
    let deckQuery = DeckService.nurLebende(supabase.from('decks').select('id'));
    deckQuery = owner.kind === 'user' ? deckQuery.eq('user_id', owner.userId) : deckQuery.eq('player_id', owner.playerId);
    const { data: deckRows, error: deckError } = await deckQuery;

    if (deckError || !deckRows || deckRows.length === 0) return null;

    const { data, error } = await supabase
      .from('deck_cards')
      .select('deck_id')
      .eq('is_commander', true)
      .ilike('card_name', commanderName)
      .in(
        'deck_id',
        deckRows.map((d) => d.id)
      )
      .limit(2);

    if (error || !data || data.length === 0) return null;
    // Zwei eigene Decks mit demselben Commander -> nicht raten, welches gemeint ist. Lieber
    // unverknüpft lassen (wie "kein Treffer") als eine potenziell falsche Zuordnung zu setzen.
    if (data.length > 1 && data[1].deck_id !== data[0].deck_id) return null;
    return data[0].deck_id;
  }

  /**
   * Reparatur für Alt-Daten: löst unverknüpfte Commander-Namen des Users mit der aktuellen
   * Erkennung neu auf, korrigiert sie und verknüpft sie mit passenden eigenen Decks.
   */
  async repairCommanderNames(
    owner: DeckOwner,
    onProgress?: (done: number, total: number) => void
  ): Promise<{ checked: number; fixed: number; linked: number }> {
    const playerIds = await this.resolvePlayerIds(owner);
    if (playerIds.length === 0) return { checked: 0, fixed: 0, linked: 0 };

    const { data: rows } = await supabase
      .from('match_players')
      .select('commander_name, partner_commander_name')
      .in('player_id', playerIds)
      .is('deck_id', null);

    if (!rows) return { checked: 0, fixed: 0, linked: 0 };

    const uniqueNames = new Set<string>();
    for (const r of rows) {
      if (r.commander_name) uniqueNames.add(r.commander_name);
      if (r.partner_commander_name) uniqueNames.add(r.partner_commander_name);
    }

    const list = [...uniqueNames];
    const resolvedNames = new Map<string, string>(); // alter Name -> korrigierter Name
    let done = 0;

    for (const name of list) {
      const resolved = await this.scryfall.resolveCommanderCandidate(name);
      if (resolved && resolved !== name) resolvedNames.set(name, resolved);
      done++;
      onProgress?.(done, list.length);
      await sleep(400); // Scryfalls Rate-Limit respektieren, sonst schlagen die Anfragen mit 429 fehl.
    }

    let fixed = 0;
    for (const [oldName, newName] of resolvedNames) {
      const { error: commanderError } = await supabase
        .from('match_players')
        .update({ commander_name: newName })
        .in('player_id', playerIds)
        .eq('commander_name', oldName);
      if (!commanderError) fixed++;

      await supabase
        .from('match_players')
        .update({ partner_commander_name: newName })
        .in('player_id', playerIds)
        .eq('partner_commander_name', oldName);
    }

    // Jetzt (ggf. korrigierte) Namen mit vorhandenen eigenen Decks abgleichen - Cube-/Draft-Spiele
    // bleiben dabei bewusst unverknüpft (siehe eligibleMatchIdsExcludingCubeDraft).
    const finalNames = new Set(list.map((n) => resolvedNames.get(n) ?? n));
    let linked = 0;
    for (const name of finalNames) {
      const deckId = await this.findDeckIdByCommander(owner, name);
      if (!deckId) continue;

      const { data: candidateRows } = await supabase
        .from('match_players')
        .select('match_id')
        .in('player_id', playerIds)
        .is('deck_id', null)
        .ilike('commander_name', name);

      const matchIds = await this.eligibleMatchIdsExcludingCubeDraft([...new Set((candidateRows ?? []).map((r) => r.match_id))]);
      if (matchIds.length === 0) continue;

      const { error: linkError } = await supabase
        .from('match_players')
        .update({ deck_id: deckId })
        .in('match_id', matchIds)
        .in('player_id', playerIds)
        .is('deck_id', null)
        .ilike('commander_name', name);
      if (!linkError) linked++;
    }

    return { checked: list.length, fixed, linked };
  }

  /**
   * Reparatur: trägt fehlende precon_release_year per Namensabgleich mit MTGJSON nach (sonst
   * unsichtbar im Jahresfilter). Mehrdeutige Namen bleiben unverändert.
   */
  async backfillPreconReleaseYears(
    owner: DeckOwner,
    onProgress?: (done: number, total: number) => void
  ): Promise<{ checked: number; updated: number; catalogUnavailable: boolean; unmatchedNames: string[] }> {
    const decks = await this.loadDecksForOwner(owner);
    const missing = decks.filter((d) => d.isPrecon && d.preconReleaseYear === null);
    if (missing.length === 0) return { checked: 0, updated: 0, catalogUnavailable: false, unmatchedNames: [] };

    const precons = await this.preconService.getAllPrecons();
    if (precons.length === 0) {
      // MTGJSON nicht erreichbar - von "0 Treffer" unterscheiden.
      return { checked: missing.length, updated: 0, catalogUnavailable: true, unmatchedNames: [] };
    }

    const yearsByName = new Map<string, Set<number>>();
    for (const p of precons) {
      const key = normalizePreconName(p.name);
      const set = yearsByName.get(key) ?? new Set<number>();
      set.add(p.releaseYear);
      yearsByName.set(key, set);
    }

    let updated = 0;
    let done = 0;
    const unmatchedNames: string[] = [];
    for (const deck of missing) {
      const years = yearsByName.get(normalizePreconName(deck.name));
      if (years && years.size === 1) {
        const [year] = years;
        const { error } = await supabase.from('decks').update({ precon_release_year: year }).eq('id', deck.id);
        if (!error) updated++;
        else unmatchedNames.push(deck.name);
      } else {
        unmatchedNames.push(deck.name);
      }
      done++;
      onProgress?.(done, missing.length);
    }

    return { checked: missing.length, updated, catalogUnavailable: false, unmatchedNames };
  }

  /**
   * Wie repairCommanderNames(), aber für die ganze Gruppe (Host): vereinheitlicht z. B. deutsche
   * Excel-Namen mit englischen. Verknüpft nicht mit Decks.
   */
  async repairCommanderNamesForGroup(
    groupId: string,
    onProgress?: (done: number, total: number) => void
  ): Promise<{ checked: number; fixed: number }> {
    if (!this.groupService.hasPermission('player.repairNamesGroupwide')) return { checked: 0, fixed: 0 };

    const { data: playerRows } = await supabase.from('players').select('id').eq('group_id', groupId);
    if (!playerRows || playerRows.length === 0) return { checked: 0, fixed: 0 };
    const playerIds = playerRows.map((p) => p.id);

    const { data: rows } = await supabase
      .from('match_players')
      .select('commander_name, partner_commander_name')
      .in('player_id', playerIds);

    if (!rows) return { checked: 0, fixed: 0 };

    const uniqueNames = new Set<string>();
    for (const r of rows) {
      if (r.commander_name) uniqueNames.add(r.commander_name);
      if (r.partner_commander_name) uniqueNames.add(r.partner_commander_name);
    }

    const list = [...uniqueNames];
    const resolvedNames = new Map<string, string>(); // alter Name -> korrigierter Name
    let done = 0;

    for (const name of list) {
      const resolved = await this.scryfall.resolveCommanderCandidate(name);
      if (resolved && resolved !== name) resolvedNames.set(name, resolved);
      done++;
      onProgress?.(done, list.length);
      await sleep(400); // Scryfalls Rate-Limit respektieren, sonst schlagen die Anfragen mit 429 fehl.
    }

    let fixed = 0;
    for (const [oldName, newName] of resolvedNames) {
      const { error: commanderError } = await supabase
        .from('match_players')
        .update({ commander_name: newName })
        .in('player_id', playerIds)
        .eq('commander_name', oldName);
      if (!commanderError) fixed++;

      await supabase
        .from('match_players')
        .update({ partner_commander_name: newName })
        .in('player_id', playerIds)
        .eq('partner_commander_name', oldName);
    }

    return { checked: list.length, fixed };
  }

  /** Zahl der Partien mit diesem Deck - entscheidet über Grabstein und steht im Löschdialog. */
  async matchCountForDeck(deckId: string): Promise<number> {
    const { count, error } = await supabase
      .from('match_players')
      .select('id', { count: 'exact', head: true })
      .eq('deck_id', deckId);

    if (error) {
      console.error('Konnte die Partien des Decks nicht zählen:', error);
      return 0;
    }
    return count ?? 0;
  }

  /**
   * Löscht ein Deck: 'hart' ohne Partien vollständig; 'weich' mit Partien nur Kartenliste und
   * Verlauf, die Zeile bleibt als Grabstein (deleted_at, geretteter Commander), keine Statistik
   * ändert sich. 'migration-fehlt': es wird nichts gelöscht - hartes Löschen würde genau den
   * Statistikverlust anrichten.
   */
  async deleteDeck(deckId: string): Promise<'hart' | 'weich' | 'migration-fehlt' | 'fehler'> {
    const games = await this.matchCountForDeck(deckId);

    if (games === 0) {
      const { error } = await supabase.from('decks').delete().eq('id', deckId);
      if (error) {
        console.error('Konnte Deck nicht löschen:', error);
        return 'fehler';
      }
      return 'hart';
    }

    // Reihenfolge ist wichtig: erst den Grabstein setzen, dann die Karten löschen. Scheitert der
    // erste Schritt (fehlende Migration), ist das Deck noch unversehrt.
    const commander = (await this.getStoredCommanders([deckId])).get(deckId);
    const { error: markError } = await supabase
      .from('decks')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_commander_name: commander?.name ?? null,
        deleted_commander_image_url: commander?.imageUrl ?? null,
        deleted_card_names: await this.zaehlbareKartennamen(deckId),
      })
      .eq('id', deckId);

    if (markError) {
      if (markError.code === '42703') {
        DeckService.istFehlendeGrabsteinSpalte(markError);
        return 'migration-fehlt';
      }
      console.error('Konnte Deck nicht als gelöscht markieren:', markError);
      return 'fehler';
    }

    const { error: cardsError } = await supabase.from('deck_cards').delete().eq('deck_id', deckId);
    if (cardsError) console.error('Konnte die Kartenliste des gelöschten Decks nicht entfernen:', cardsError);

    const { error: logError } = await supabase.from('deck_change_log').delete().eq('deck_id', deckId);
    if (logError) console.error('Konnte den Änderungsverlauf des gelöschten Decks nicht entfernen:', logError);

    return 'weich';
  }

  /**
   * Kopie eines Decks als "zweite Version": Karten (samt Artwork, Tags, Marken, Maybeboard) und
   * Metadaten, aber keine Partien, Statistik oder Verlauf. Nicht über saveDeck(), das Artworks
   * verlöre und per backfillDeckLinks() alte Partien anhängen würde.
   */
  async duplicateDeck(deckId: string, newName: string): Promise<string | null> {
    // Bracket-Spalten wie überall optional (siehe deckColumns()) - fehlt die Migration, wird eben
    // ohne Bracket kopiert, statt die ganze Kopie an einem 42703 scheitern zu lassen.
    const quellSpalten = () => {
      const basis =
        'user_id, player_id, name, format, is_precon, precon_release_year, edhrec_tag, color_identity, commander_types, is_private';
      return DeckService.bracketSpaltenVerfuegbar ? `${basis}, ${DeckService.BRACKET_SPALTEN}` : basis;
    };
    const abfrage = () => supabase.from('decks').select(quellSpalten()).eq('id', deckId).maybeSingle();

    let { data, error } = await abfrage();
    for (let versuch = 0; versuch < 2 && DeckService.fehlendeSpalteAbgeschaltet(error); versuch++)
      ({ data, error } = await abfrage());

    if (error || !data) {
      console.error('Konnte das zu kopierende Deck nicht laden:', error);
      return null;
    }
    const quelle = data as any;

    const { data: karten, error: kartenError } = await supabase
      .from('deck_cards')
      .select(
        'card_name, quantity, image_url, type_line, cmc, is_commander, custom_tags, is_maybeboard, is_token, scryfall_oracle_id'
      )
      .eq('deck_id', deckId);

    if (kartenError) {
      console.error('Konnte die Kartenliste des zu kopierenden Decks nicht laden:', kartenError);
      return null;
    }

    const neueZeile: Record<string, unknown> = {
      user_id: quelle.user_id,
      player_id: quelle.player_id,
      name: newName,
      format: quelle.format,
      is_precon: quelle.is_precon ?? false,
      precon_release_year: quelle.precon_release_year ?? null,
      edhrec_tag: quelle.edhrec_tag ?? null,
      color_identity: quelle.color_identity ?? [],
      commander_types: quelle.commander_types ?? [],
      is_private: quelle.is_private ?? false,
      // is_outdated bleibt bewusst auf dem Spalten-Default (false): Eine gerade angelegte zweite
      // Version ist das Gegenteil von veraltet, auch wenn das Original ausgemustert ist.
    };
    if (DeckService.bracketSpaltenVerfuegbar) {
      // Die Kartenliste ist identisch, also gilt auch die geschätzte Stufe unverändert weiter -
      // sonst stünde die Kopie in der Liste ohne Abzeichen da, bis sie einmal geöffnet wurde.
      neueZeile['bracket'] = quelle.bracket ?? null;
      neueZeile['bracket_auto'] = quelle.bracket_auto ?? null;
      neueZeile['bracket_auto_at'] = quelle.bracket_auto_at ?? null;
    }

    const { data: angelegt, error: insertError } = await supabase
      .from('decks')
      .insert(neueZeile)
      .select('id')
      .single();

    if (insertError || !angelegt) {
      console.error('Konnte die Deck-Kopie nicht anlegen:', insertError);
      return null;
    }
    const neueId: string = angelegt.id;

    const kartenZeilen = (karten ?? []).map((row) => ({
      deck_id: neueId,
      card_name: row.card_name,
      quantity: row.quantity,
      image_url: row.image_url,
      type_line: row.type_line,
      cmc: row.cmc ?? 0,
      is_commander: row.is_commander,
      custom_tags: row.custom_tags ?? [],
      is_maybeboard: row.is_maybeboard ?? false,
      is_token: row.is_token ?? false,
      scryfall_oracle_id: row.scryfall_oracle_id ?? null,
    }));

    if (kartenZeilen.length > 0) {
      const { error: kartenInsertError } = await supabase.from('deck_cards').insert(kartenZeilen);
      if (kartenInsertError) {
        console.error('Konnte die Kartenliste der Kopie nicht speichern:', kartenInsertError);
        // Kein halbes Deck stehen lassen: Die Kopie hat noch keine einzige Partie, ein hartes
        // Löschen ist hier gefahrlos (anders als in deleteDeck()).
        await supabase.from('decks').delete().eq('id', neueId);
        return null;
      }
    }

    return neueId;
  }

  /** Fügt eine Karte hinzu oder erhöht ihre Anzahl. */
  async addCardToDeck(deckId: string, card: ScryfallCard, quantity = 1, isMaybeboard = false): Promise<boolean> {
    const { data: existing, error: lookupError } = await supabase
      .from('deck_cards')
      .select('id, quantity')
      .eq('deck_id', deckId)
      .ilike('card_name', card.name)
      .maybeSingle();

    if (lookupError) {
      console.error('Konnte Deck-Karte nicht nachschlagen:', lookupError);
      return false;
    }

    if (existing) {
      // Beim Erhöhen bleibt der Maybeboard-Status unangetastet (Verschieben über
      // setCardMaybeboardFlag()).
      const { error } = await supabase
        .from('deck_cards')
        .update({ quantity: existing.quantity + quantity })
        .eq('id', existing.id);
      if (error) {
        console.error('Konnte Kartenanzahl nicht erhöhen:', error);
        return false;
      }
    } else {
      const { error } = await supabase.from('deck_cards').insert({
        deck_id: deckId,
        card_name: card.name,
        quantity,
        image_url: card.imageUrl ?? null,
        type_line: card.typeLine ?? null,
        cmc: card.cmc ?? 0,
        is_commander: false,
        is_maybeboard: isMaybeboard,
      });
      if (error) {
        console.error('Konnte Karte nicht hinzufügen:', error);
        return false;
      }
    }

    await supabase.from('deck_change_log').insert({
      deck_id: deckId,
      card_name: card.name,
      change_type: 'added',
      quantity,
    });
    await supabase.from('decks').update({ updated_at: new Date().toISOString() }).eq('id', deckId);
    return true;
  }

  /** Entfernt eine bestimmte Anzahl Kopien einer Karte (Standard: alle) aus dem Deck. */
  async removeCardFromDeck(deckId: string, cardName: string, quantity?: number): Promise<boolean> {
    const { data: existing, error: lookupError } = await supabase
      .from('deck_cards')
      .select('id, quantity')
      .eq('deck_id', deckId)
      .ilike('card_name', cardName)
      .maybeSingle();

    if (lookupError || !existing) {
      if (lookupError) console.error('Konnte Deck-Karte nicht nachschlagen:', lookupError);
      return false;
    }

    const removeQty = Math.min(quantity ?? existing.quantity, existing.quantity);
    const remaining = existing.quantity - removeQty;

    if (remaining > 0) {
      const { error } = await supabase.from('deck_cards').update({ quantity: remaining }).eq('id', existing.id);
      if (error) {
        console.error('Konnte Kartenanzahl nicht verringern:', error);
        return false;
      }
    } else {
      const { error } = await supabase.from('deck_cards').delete().eq('id', existing.id);
      if (error) {
        console.error('Konnte Karte nicht entfernen:', error);
        return false;
      }
    }

    await supabase.from('deck_change_log').insert({
      deck_id: deckId,
      card_name: cardName,
      change_type: 'removed',
      quantity: removeQty,
    });
    await supabase.from('decks').update({ updated_at: new Date().toISOString() }).eq('id', deckId);
    return true;
  }

  /** Ändert Name, EDHREC-Tag und Spielformat eines bestehenden Decks, ohne die Kartenliste anzufassen. */
  async updateDeckInfo(
    deckId: string,
    name: string,
    edhrecTag: string | null,
    format: DeckFormat | null
  ): Promise<boolean> {
    const { error } = await supabase
      .from('decks')
      .update({ name, edhrec_tag: edhrecTag, format, updated_at: new Date().toISOString() })
      .eq('id', deckId);

    if (error) {
      console.error('Konnte Deckname/Tag/Format nicht ändern:', error);
      return false;
    }
    return true;
  }

  /**
   * Setzt Archetyp (edhrec_tag) und Kreaturtyp (commander_types) fürs öffentliche Stöbern - immer
   * beide, der unveränderte kommt vom Aufrufer.
   */
  async updateDeckArchetype(deckId: string, edhrecTag: string | null, creatureType: string | null): Promise<boolean> {
    const { error } = await supabase
      .from('decks')
      .update({ edhrec_tag: edhrecTag, commander_types: creatureType ? [creatureType] : [] })
      .eq('id', deckId);

    if (error) {
      console.error('Konnte Archetyp/Kreaturtyp nicht ändern:', error);
      return false;
    }
    return true;
  }

  /** Stellt ein Deck privat/sichtbar - private Decks tauchen nicht mehr auf, wenn andere User dieses Profil ansehen. */
  async setDeckPrivate(deckId: string, isPrivate: boolean): Promise<boolean> {
    const { error } = await supabase.from('decks').update({ is_private: isPrivate }).eq('id', deckId);

    if (error) {
      console.error('Konnte Sichtbarkeit nicht ändern:', error);
      return false;
    }
    return true;
  }

  /** Markiert/entmarkiert ein Deck als "Outdated" - solche Decks sind standardmäßig in der Deck-Liste ausgeblendet, ohne dass sie gelöscht werden müssen. */
  async setDeckOutdated(deckId: string, isOutdated: boolean): Promise<boolean> {
    const { error } = await supabase.from('decks').update({ is_outdated: isOutdated }).eq('id', deckId);

    if (error) {
      console.error('Konnte Outdated-Status nicht ändern:', error);
      return false;
    }
    return true;
  }

  /** Selbst gewählte Stufe setzen, null = automatisch. */
  async setDeckBracket(deckId: string, bracket: number | null): Promise<boolean> {
    const { error } = await supabase.from('decks').update({ bracket }).eq('id', deckId);

    if (error) {
      console.error('Konnte Bracket nicht ändern:', error);
      return false;
    }
    return true;
  }

  /**
   * Schreibt das Automatik-Ergebnis zurück. Ohne updated_at - das sortiert die Liste nach
   * inhaltlichen Änderungen. Fehler nur in die Konsole (ohne Migration wird eben neu gerechnet).
   */
  async saveDeckAutoBracket(deckId: string, bracketAuto: number): Promise<boolean> {
    const { error } = await supabase
      .from('decks')
      .update({ bracket_auto: bracketAuto, bracket_auto_at: new Date().toISOString() })
      .eq('id', deckId);

    if (error) {
      console.error('Konnte das automatisch bestimmte Bracket nicht speichern:', error);
      return false;
    }
    return true;
  }

  /** Markiert/entmarkiert eine bereits im Deck vorhandene Karte als Commander (z.B. wenn der Import keinen erkannt hat). */
  async setCardCommanderFlag(deckId: string, cardName: string, isCommander: boolean): Promise<boolean> {
    const { error } = await supabase
      .from('deck_cards')
      .update({ is_commander: isCommander })
      .eq('deck_id', deckId)
      .ilike('card_name', cardName);

    if (error) {
      console.error('Konnte Commander-Markierung nicht ändern:', error);
      return false;
    }
    return true;
  }

  /**
   * Pflegt decks.color_identity nach Commander-Änderung (Farbfilter im Stöbern). commander_types
   * bleibt manuell.
   */
  async updateDeckCommanderMetadata(deckId: string, colorIdentity: string[]): Promise<boolean> {
    const { error } = await supabase
      .from('decks')
      .update({ color_identity: colorIdentity })
      .eq('id', deckId);

    if (error) {
      console.error('Konnte Commander-Metadaten (Farbe/Typal) nicht aktualisieren:', error);
      return false;
    }
    return true;
  }

  /** Verschiebt eine bereits im Deck vorhandene Karte zwischen Hauptdeck und Maybeboard. */
  async setCardMaybeboardFlag(deckId: string, cardName: string, isMaybeboard: boolean): Promise<boolean> {
    const { error } = await supabase
      .from('deck_cards')
      .update({ is_maybeboard: isMaybeboard })
      .eq('deck_id', deckId)
      .ilike('card_name', cardName);

    if (error) {
      console.error('Konnte Maybeboard-Status nicht ändern:', error);
      return false;
    }
    return true;
  }

  /** Fügt eine per Scan gefundene Marke neu hinzu - kein Zusammenführen mit gleichnamigen Karten (das übernimmt scanForTokens() vorher), kein Eintrag im Änderungsverlauf (automatisch erkannt, kein manueller Deck-Edit). */
  async addTokenToDeck(
    deckId: string,
    token: { name: string; imageUrl?: string | null; typeLine?: string | null; oracleId?: string | null },
    quantity = 1
  ): Promise<boolean> {
    const { error } = await supabase.from('deck_cards').insert({
      deck_id: deckId,
      card_name: token.name,
      quantity,
      image_url: token.imageUrl ?? null,
      type_line: token.typeLine ?? null,
      cmc: 0,
      is_commander: false,
      is_token: true,
      scryfall_oracle_id: token.oracleId ?? null,
    });
    if (error) {
      console.error('Konnte Marke nicht hinzufügen:', error);
      return false;
    }
    await supabase.from('decks').update({ updated_at: new Date().toISOString() }).eq('id', deckId);
    return true;
  }

  /**
   * Trägt die oracleId bei alten Marken nach (Abgleich auch über image_url, weil Marken gleich
   * heißen können).
   */
  async backfillTokenOracleId(deckId: string, cardName: string, imageUrl: string, oracleId: string): Promise<boolean> {
    const { error } = await supabase
      .from('deck_cards')
      .update({ scryfall_oracle_id: oracleId })
      .eq('deck_id', deckId)
      .ilike('card_name', cardName)
      .eq('image_url', imageUrl)
      .is('scryfall_oracle_id', null);
    if (error) {
      console.error('Konnte Marken-ID nicht nachtragen:', error);
      return false;
    }
    return true;
  }

  /** Ersetzt nur das Bild einer Karte (anderes Artwork/Edition) - Name/Menge/Commander-Status bleiben unverändert. */
  async updateCardImage(deckId: string, cardName: string, imageUrl: string): Promise<boolean> {
    const { error } = await supabase
      .from('deck_cards')
      .update({ image_url: imageUrl })
      .eq('deck_id', deckId)
      .ilike('card_name', cardName);

    if (error) {
      console.error('Konnte Kartenbild nicht ändern:', error);
      return false;
    }
    return true;
  }

  /** Setzt die eigenen Sortier-Tags einer Karte komplett neu (ersetzt die bisherige Liste). */
  async setCardTags(deckId: string, cardName: string, tags: string[]): Promise<boolean> {
    const { error } = await supabase
      .from('deck_cards')
      .update({ custom_tags: tags })
      .eq('deck_id', deckId)
      .ilike('card_name', cardName);

    if (error) {
      console.error('Konnte Tags nicht ändern:', error);
      return false;
    }
    return true;
  }

  /** Lädt ein eigenes Bild in den "deck-art"-Storage-Bucket hoch und liefert die öffentliche URL - für ein selbst gewähltes Artwork statt einer Scryfall-Edition. */
  async uploadCustomCardArt(userId: string, file: File): Promise<string | null> {
    if (!file.type.startsWith('image/')) return null;
    if (file.size > 10 * 1024 * 1024) return null;

    const ext = file.name.split('.').pop() ?? 'jpg';
    const path = `${userId}/${crypto.randomUUID()}.${ext}`;

    const { error } = await supabase.storage
      .from('deck-art')
      .upload(path, file, { contentType: file.type });

    if (error) {
      console.error('Konnte eigenes Kartenbild nicht hochladen:', error);
      return null;
    }

    const { data } = supabase.storage.from('deck-art').getPublicUrl(path);
    return data.publicUrl;
  }

  /**
   * Deck-Statistik über ALLE Gruppen. Mit pilotPlayerIds nur Partien dieser Spieler ("Meine/Alle
   * Spiele").
   */
  async getDeckStats(deckId: string, pilotPlayerIds?: string[]): Promise<DeckGameStats> {
    let query = supabase
      .from('match_players')
      .select('team, is_archenemy, players ( display_name ), matches ( game_mode, winner_name, counts_in_general_stats )')
      .eq('deck_id', deckId);
    if (pilotPlayerIds && pilotPlayerIds.length > 0) {
      query = query.in('player_id', pilotPlayerIds);
    }
    const { data, error } = await query;

    if (error || !data) {
      console.error('Konnte Deck-Statistik nicht laden:', error);
      return { games: 0, wins: 0, winRate: 0 };
    }

    let games = 0;
    let wins = 0;
    for (const row of data as any[]) {
      const match = row.matches;
      const playerName = row.players?.display_name;
      if (!match || !playerName || match.counts_in_general_stats === false) continue;
      games++;
      if (isPlayerWinner(match.game_mode, match.winner_name, playerName, row.team, row.is_archenemy)) {
        wins++;
      }
    }

    return { games, wins, winRate: games > 0 ? (wins / games) * 100 : 0 };
  }

  /** Wie getDeckStats() für viele Decks in einer Anfrage. */
  async getDeckStatsForDecks(deckIds: string[]): Promise<Map<string, DeckGameStats>> {
    const result = new Map<string, DeckGameStats>();
    if (deckIds.length === 0) return result;

    const { data, error } = await supabase
      .from('match_players')
      .select(
        'deck_id, commander_name, team, is_archenemy, players ( display_name ), matches ( game_mode, winner_name, counts_in_general_stats )'
      )
      .in('deck_id', deckIds);

    if (error || !data) {
      console.error('Konnte Deck-Statistiken nicht laden:', error);
      return result;
    }

    const raw = new Map<string, { games: number; wins: number; commander?: string }>();
    for (const row of data as any[]) {
      const deckId = row.deck_id as string | null;
      const match = row.matches;
      const playerName = row.players?.display_name;
      if (!deckId || !match || !playerName || match.counts_in_general_stats === false) continue;

      const entry = raw.get(deckId) ?? { games: 0, wins: 0 };
      entry.games++;
      if (row.commander_name) entry.commander = row.commander_name;
      if (isPlayerWinner(match.game_mode, match.winner_name, playerName, row.team, row.is_archenemy)) {
        entry.wins++;
      }
      raw.set(deckId, entry);
    }

    for (const [deckId, s] of raw) {
      result.set(deckId, {
        games: s.games,
        wins: s.wins,
        winRate: s.games > 0 ? (s.wins / s.games) * 100 : 0,
        commander: s.commander,
      });
    }
    return result;
  }

  /**
   * Hinterlegter Commander (is_commander) je Deck samt gewähltem Bild - Rückfall für Listen ohne
   * Partie. Bei Partnern nur einer.
   */
  async getStoredCommanders(deckIds: string[]): Promise<Map<string, { name: string; imageUrl: string | null }>> {
    const result = new Map<string, { name: string; imageUrl: string | null }>();
    if (deckIds.length === 0) return result;

    const { data, error } = await supabase
      .from('deck_cards')
      .select('deck_id, card_name, image_url')
      .eq('is_commander', true)
      .in('deck_id', deckIds);

    if (error || !data) {
      console.error('Konnte hinterlegte Commander nicht laden:', error);
      return result;
    }

    for (const row of data) {
      if (!result.has(row.deck_id)) result.set(row.deck_id, { name: row.card_name, imageUrl: row.image_url });
    }

    // Gelöschte Decks haben keine Kartenzeilen mehr - ihr Commander steht im Grabstein. Ohne
    // diesen Nachschlag verlören Rangliste und Match-Verlauf beim Löschen ihr Kartenbild.
    const ohneTreffer = deckIds.filter((id) => !result.has(id));
    if (ohneTreffer.length > 0) {
      for (const [deckId, info] of await this.getDeletedDeckInfos(ohneTreffer)) {
        if (info.name) result.set(deckId, { name: info.name, imageUrl: info.imageUrl });
      }
    }

    return result;
  }

  /**
   * Kartennamen, die in "Meistgespielte Karten" zählen (ohne Länder, Marken, Maybeboard, je Name
   * einmal) - beim Löschen in deleted_card_names gerettet. Nur Namen: Mengen zählen nicht,
   * Bild-URLs kosten Platz.
   */
  private async zaehlbareKartennamen(deckId: string): Promise<string[]> {
    const { data, error } = await supabase
      .from('deck_cards')
      .select('card_name, type_line, is_maybeboard, is_token')
      .eq('deck_id', deckId);

    if (error || !data) {
      console.error('Konnte die Kartennamen des Decks nicht sichern:', error);
      return [];
    }

    const namen = new Set<string>();
    for (const row of data as any[]) {
      if ((row.is_maybeboard ?? false) || (row.is_token ?? false)) continue;
      if (((row.type_line as string | null) ?? '').includes('Land')) continue;
      namen.add(row.card_name as string);
    }
    return [...namen];
  }

  /** Gerettete Kartennamen der Grabsteine je Deck; lebende Decks fehlen in der Map. */
  private async geretteteKartennamen(deckIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (deckIds.length === 0 || !DeckService.grabsteinSpalteVerfuegbar) return result;

    const { data, error } = await supabase
      .from('decks')
      .select('id, deleted_card_names')
      .in('id', deckIds)
      .not('deleted_at', 'is', null);

    if (error) {
      if (!DeckService.istFehlendeGrabsteinSpalte(error)) {
        console.error('Konnte die geretteten Kartennamen nicht laden:', error);
      }
      return result;
    }

    for (const row of (data ?? []) as any[]) {
      const namen = (row.deleted_card_names ?? []) as string[];
      if (namen.length > 0) result.set(row.id, namen);
    }
    return result;
  }

  /** Gerettete Commander-Angaben der Grabsteine; lebende Decks fehlen in der Map. */
  async getDeletedDeckInfos(deckIds: string[]): Promise<Map<string, { name: string | null; imageUrl: string | null }>> {
    const result = new Map<string, { name: string | null; imageUrl: string | null }>();
    if (deckIds.length === 0 || !DeckService.grabsteinSpalteVerfuegbar) return result;

    const { data, error } = await supabase
      .from('decks')
      .select('id, deleted_commander_name, deleted_commander_image_url')
      .in('id', deckIds)
      .not('deleted_at', 'is', null);

    if (error) {
      // Fehlt die Migration noch, gibt es auch keine Grabsteine - einmal warnen und ab dann still.
      if (!DeckService.istFehlendeGrabsteinSpalte(error)) console.error('Konnte gelöschte Decks nicht laden:', error);
      return result;
    }

    for (const row of (data ?? []) as any[]) {
      result.set(row.id, { name: row.deleted_commander_name ?? null, imageUrl: row.deleted_commander_image_url ?? null });
    }
    return result;
  }

  /**
   * Farbidentität je Deck-ID für Statistiken über schon geladene Matches. Private fremde Decks
   * fehlen (RLS) - dieselbe stille Auslassung wie beim deckName-Join.
   */
  async getColorIdentities(deckIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (deckIds.length === 0) return result;

    const { data, error } = await supabase
      .from('decks')
      .select('id, color_identity')
      .in('id', deckIds);

    if (error || !data) {
      console.error('Konnte Farbidentität der Decks nicht laden:', error);
      return result;
    }

    for (const row of data) {
      result.set(row.id, (row.color_identity as string[] | null) ?? []);
    }
    return result;
  }

  /**
   * Ruft eine Global-Statistik-Funktion auf, mit Rückfall auf die parameterlose Fassung bei
   * PGRST202 (Filter-Migration fehlt). null, wenn auch das scheitert.
   */
  private async callGlobalStatsRpc(
    fn: string,
    params: Record<string, unknown>,
    label: string
  ): Promise<any[] | null> {
    const first = await supabase.rpc(fn, params);
    if (!first.error) return (first.data ?? []) as any[];

    if (first.error.code === 'PGRST202') {
      console.warn(`${label}: SQL-Migration ausstehend, zeige ungefilterte Zahlen.`);
      const legacy = await supabase.rpc(fn);
      if (!legacy.error) return (legacy.data ?? []) as any[];
      console.error(label, legacy.error);
      return null;
    }

    console.error(label, first.error);
    return null;
  }

  /**
   * Weltweite Decks-/Commander-Rangliste (global_deck_commander_stats). modes/formats null = kein
   * Filter.
   */
  async getGlobalDeckCommanderStats(
    modes: GameMode[] | null = null,
    formats: DeckFormat[] | null = null
  ): Promise<{
    decks: GlobalDeckStat[];
    commanders: GlobalCommanderStat[];
  }> {
    const empty = { decks: [], commanders: [] };
    const data = await this.callGlobalStatsRpc(
      'global_deck_commander_stats',
      { p_modes: modes, p_formats: formats },
      'Konnte weltweite Decks&Commander-Statistik nicht laden:'
    );

    if (!data) return empty;

    const decks: GlobalDeckStat[] = [];
    const commanders: GlobalCommanderStat[] = [];
    for (const row of data as any[]) {
      const games = Number(row.games);
      const wins = Number(row.wins);
      const winRate = games > 0 ? (wins / games) * 100 : 0;
      if (row.bucket === 'deck') {
        decks.push({
          deckId: row.deck_id,
          name: row.name,
          commanderImageUrl: row.commander_image_url,
          games,
          wins,
          winRate,
        });
      } else {
        commanders.push({
          name: row.name,
          commanderImageUrl: row.commander_image_url,
          games,
          wins,
          winRate,
        });
      }
    }
    return { decks, commanders };
  }

  /**
   * Weltweite Übersichtszahlen (global_overview_stats). Ohne Migration null, die Kacheln bleiben
   * aus.
   */
  async getGlobalOverviewStats(
    modes: GameMode[] | null = null,
    formats: DeckFormat[] | null = null
  ): Promise<GlobalOverviewStats | null> {
    const { data, error } = await supabase.rpc('global_overview_stats', {
      p_modes: modes,
      p_formats: formats,
    });

    if (error) {
      console.warn('Konnte weltweite Übersichtszahlen nicht laden:', error);
      return null;
    }

    const row = (data as any[] | null)?.[0];
    if (!row) return null;

    return {
      games: Number(row.games ?? 0),
      players: Number(row.players ?? 0),
      decks: Number(row.decks ?? 0),
    };
  }

  /**
   * Weltweite Farben/Farbkombinationen (global_color_and_combo_stats), gleiche Form wie
   * getCardAndColorStats().
   */
  async getGlobalColorAndComboStats(
    modes: GameMode[] | null = null,
    formats: DeckFormat[] | null = null
  ): Promise<{
    colorRanking: ColorStat[];
    colorComboRanking: ColorComboStat[];
  }> {
    const empty = { colorRanking: [], colorComboRanking: [] };
    const rows = await this.callGlobalStatsRpc(
      'global_color_and_combo_stats',
      { p_modes: modes, p_formats: formats },
      'Konnte weltweite Farbstatistik nicht laden:'
    );

    if (!rows) return empty;

    const colorRanking: ColorStat[] = COLOR_AXES.map((color) => {
      const row = rows.find((r) => r.kind === 'axis' && r.colors?.[0] === color);
      return { color, gameCount: Number(row?.games ?? 0), deckCount: Number(row?.decks ?? 0) };
    });
    const colorComboRanking: ColorComboStat[] = rows
      .filter((r) => r.kind === 'combo')
      .map((r) => ({
        colors: r.colors as ColorComboStat['colors'],
        gameCount: Number(r.games),
        deckCount: Number(r.decks),
      }));

    return { colorRanking, colorComboRanking };
  }

  /**
   * Commander-Statistik über alle Gruppen für Spiele ohne EIGENES Deck, je Eintrag mit `category`
   * (siehe UnassignedCommanderCategory). Ein Commander aus normalen und Cube-Spielen erscheint in
   * beiden Listen.
   *
   * "Geliehen" nur, wenn die Partie mit einem fremden Deck verknüpft ist - kein Raten über den
   * Namen mehr (das schlug am 23.09.2026 fremde Partien falschen Decks zu).
   */
  async getUnassignedCommanderStats(owner: DeckOwner): Promise<UnassignedCommanderStats[]> {
    const playerIds = await this.resolvePlayerIds(owner);
    if (playerIds.length === 0) return [];

    const { data, error } = await supabase
      .from('match_players')
      .select(
        'commander_name, team, is_archenemy, deck_id, players ( display_name ), matches ( game_mode, winner_name, counts_in_general_stats )'
      )
      .in('player_id', playerIds)
      .not('commander_name', 'is', null);

    if (error || !data) {
      console.error('Konnte Commander-Statistik nicht laden:', error);
      return [];
    }

    const ownDeckIds = await this.ownDeckIds(owner);

    // Zeilen mit eigenem Deck fallen raus (die stehen bereits in der Deck-Liste), alles andere
    // wird vorsortiert.
    const relevant: { commander: string; won: boolean; deckId: string | null; cube: boolean }[] = [];
    for (const row of data as any[]) {
      const match = row.matches;
      const playerName = row.players?.display_name;
      const commander = row.commander_name as string | null;
      if (!match || !playerName || !commander || match.counts_in_general_stats === false) continue;

      const deckId = (row.deck_id as string | null) ?? null;
      if (deckId && ownDeckIds.has(deckId)) continue;

      relevant.push({
        commander,
        won: isPlayerWinner(match.game_mode, match.winner_name, playerName, row.team, row.is_archenemy),
        deckId,
        cube: match.game_mode === 'Cube' || match.game_mode === 'Draft',
      });
    }
    if (relevant.length === 0) return [];

    const borrowedDeckIds = new Set<string>(relevant.filter((r) => r.deckId).map((r) => r.deckId as string));
    const borrowedDecks = await this.borrowedDeckInfos([...borrowedDeckIds]);

    // Schlüssel ist Kategorie + Name, damit derselbe Commander aus einer Cube-Runde und aus einem
    // normalen Spiel nicht zu einer Zeile verschmilzt.
    const stats = new Map<string, UnassignedCommanderStats>();
    for (const row of relevant) {
      const deckId = row.deckId;
      const category: UnassignedCommanderCategory = row.cube ? 'cube' : deckId ? 'borrowed' : 'none';

      const key = `${category}::${row.commander}`;
      const entry =
        stats.get(key) ??
        ({
          commander: row.commander,
          games: 0,
          wins: 0,
          winRate: 0,
          category,
          ...(deckId && borrowedDecks.has(deckId) ? { borrowedDeck: borrowedDecks.get(deckId) } : {}),
        } as UnassignedCommanderStats);
      entry.games++;
      if (row.won) entry.wins++;
      stats.set(key, entry);
    }

    return [...stats.values()]
      .map((entry) => ({ ...entry, winRate: entry.games > 0 ? (entry.wins / entry.games) * 100 : 0 }))
      .sort((a, b) => b.wins - a.wins || b.winRate - a.winRate);
  }

  /** IDs aller Decks eines Besitzers - um beim Auswerten von match_players eigene von fremden (geliehenen) Decks zu trennen. */
  private async ownDeckIds(owner: DeckOwner): Promise<Set<string>> {
    let query = supabase.from('decks').select('id');
    query = owner.kind === 'user' ? query.eq('user_id', owner.userId) : query.eq('player_id', owner.playerId);
    const { data, error } = await query;

    if (error) {
      console.error('Konnte eigene Deck-IDs nicht laden:', error);
      return new Set();
    }
    return new Set((data ?? []).map((d) => d.id as string));
  }

  /** Name und Besitzer zu Deck-IDs - für die Anzeige geliehener Decks und zum Öffnen aus der Liste heraus. */
  private async borrowedDeckInfos(deckIds: string[]): Promise<Map<string, BorrowedDeckInfo>> {
    const result = new Map<string, BorrowedDeckInfo>();
    if (deckIds.length === 0) return result;

    const [{ data: deckRows, error }, storedCommanders] = await Promise.all([
      supabase.from('decks').select('id, name, user_id, player_id').in('id', deckIds),
      this.getStoredCommanders(deckIds),
    ]);
    if (error || !deckRows || deckRows.length === 0) {
      if (error) console.error('Konnte geliehene Decks nicht laden:', error);
      return result;
    }

    const userIds = [...new Set(deckRows.map((d) => d.user_id).filter((id): id is string => Boolean(id)))];
    const playerIds = [...new Set(deckRows.map((d) => d.player_id).filter((id): id is string => Boolean(id)))];

    // Ein Account kann in mehreren Gruppen unter verschiedenen Namen spielen - hier zählt nur, dass
    // überhaupt ein Name danebensteht, deshalb gewinnt der erste Treffer.
    const nameByUser = new Map<string, string>();
    if (userIds.length > 0) {
      const { data } = await supabase.from('players').select('user_id, display_name').in('user_id', userIds);
      for (const p of data ?? []) if (!nameByUser.has(p.user_id)) nameByUser.set(p.user_id, p.display_name);
    }

    const nameByPlayer = new Map<string, string>();
    if (playerIds.length > 0) {
      const { data } = await supabase.from('players').select('id, display_name').in('id', playerIds);
      for (const p of data ?? []) nameByPlayer.set(p.id, p.display_name);
    }

    for (const deck of deckRows) {
      const ownerName = (deck.user_id ? nameByUser.get(deck.user_id) : null) ?? (deck.player_id ? nameByPlayer.get(deck.player_id) : null);
      result.set(deck.id, {
        id: deck.id,
        name: deck.name,
        ownerName: ownerName ?? null,
        commanderImageUrl: storedCommanders.get(deck.id)?.imageUrl ?? null,
      });
    }
    return result;
  }

  /**
   * Persönliche Gesamtstatistik über alle Gruppen: zählt jedes Spiel, ignoriert stats_locked
   * (sperrt nur die geteilte Rangliste). year = nur dieses Kalenderjahr.
   */
  async getCrossGroupPersonalStats(userId: string, year?: number): Promise<CrossGroupPersonalStats> {
    const { data: playerRows, error: playerError } = await supabase
      .from('players')
      .select('id, group_id')
      .eq('user_id', userId);

    if (playerError || !playerRows || playerRows.length === 0) {
      if (playerError) console.error('Konnte Spieler-Zeilen für Gesamtstatistik nicht laden:', playerError);
      return { totalGames: 0, totalWins: 0, winRate: 0, groupCount: 0, topCommander: null };
    }

    const playerIds = playerRows.map((p) => p.id);
    const groupCount = new Set(playerRows.map((p) => p.group_id)).size;

    const { data, error } = await supabase
      .from('match_players')
      .select(
        'commander_name, team, is_archenemy, players ( display_name ), matches ( game_mode, winner_name, counts_in_general_stats, played_at )'
      )
      .in('player_id', playerIds);

    if (error || !data) {
      console.error('Konnte gruppenübergreifende Statistik nicht laden:', error);
      return { totalGames: 0, totalWins: 0, winRate: 0, groupCount, topCommander: null };
    }

    let totalGames = 0;
    let totalWins = 0;
    const commanderStats = new Map<string, { games: number; wins: number }>();

    for (const row of data as any[]) {
      const match = row.matches;
      const playerName = row.players?.display_name;
      if (!match || !playerName || match.counts_in_general_stats === false) continue;
      // Jahresfilter im Client: Filter auf eingebettete Tabellen bräuchte einen Inner-Join, die
      // Zeilenzahl ist klein.
      if (year != null && new Date(match.played_at).getFullYear() !== year) continue;

      totalGames++;
      const won = isPlayerWinner(match.game_mode, match.winner_name, playerName, row.team, row.is_archenemy);
      if (won) totalWins++;

      const commander = row.commander_name as string | null;
      if (commander) {
        const entry = commanderStats.get(commander) ?? { games: 0, wins: 0 };
        entry.games++;
        if (won) entry.wins++;
        commanderStats.set(commander, entry);
      }
    }

    const topCommander =
      [...commanderStats.entries()]
        .map(([commander, s]) => ({
          commander,
          games: s.games,
          wins: s.wins,
          winRate: s.games > 0 ? (s.wins / s.games) * 100 : 0,
        }))
        .sort((a, b) => b.games - a.games || b.winRate - a.winRate)[0] ?? null;

    return {
      totalGames,
      totalWins,
      winRate: totalGames > 0 ? (totalWins / totalGames) * 100 : 0,
      groupCount,
      topCommander,
    };
  }

  /**
   * Meistgespielte Karten (ohne Länder), Farben (5 + farblos) und Farbkombinationen über alle
   * Gruppen, je Eintrag gameCount (nach Partien gewichtet) und deckCount. Eine Karte zählt je Deck
   * einmal; Länder per Typzeile; Precons zählen nicht. year wie bei getCrossGroupPersonalStats().
   */
  async getCardAndColorStats(owner: DeckOwner, year?: number): Promise<CardAndColorStats> {
    const empty: CardAndColorStats = { mostUsedCards: [], colorRanking: [], colorComboRanking: [] };
    const playerIds = await this.resolvePlayerIds(owner);
    if (playerIds.length === 0) return empty;

    const { data: matchData, error: matchError } = await supabase
      .from('match_players')
      .select('deck_id, matches ( counts_in_general_stats, played_at )')
      .in('player_id', playerIds)
      .not('deck_id', 'is', null);

    if (matchError || !matchData) {
      console.error('Konnte Deck-Partienanzahl für Karten-/Farbstatistik nicht laden:', matchError);
      return empty;
    }

    const gamesPerDeck = new Map<string, number>();
    for (const row of matchData as any[]) {
      const deckId = row.deck_id as string | null;
      if (!deckId || row.matches?.counts_in_general_stats === false) continue;
      // Siehe getCrossGroupPersonalStats(): Jahresfilter clientseitig. Ein Deck, das im gewählten
      // Jahr nicht gespielt wurde, fällt damit ganz aus der Karten-/Farbstatistik heraus.
      if (year != null && new Date(row.matches?.played_at).getFullYear() !== year) continue;
      gamesPerDeck.set(deckId, (gamesPerDeck.get(deckId) ?? 0) + 1);
    }

    const allDeckIds = [...gamesPerDeck.keys()];
    if (allDeckIds.length === 0) return empty;

    const { data: deckRows, error: deckError } = await supabase
      .from('decks')
      .select('id, color_identity, is_precon')
      .in('id', allDeckIds);

    if (deckError) console.error('Konnte Deck-Metadaten für die Karten-/Farbstatistik nicht laden:', deckError);

    // Precon-Decks bewusst ausgeschlossen - siehe Doc-Kommentar oben.
    const nonPreconDeckRows = ((deckRows ?? []) as any[]).filter((d) => !d.is_precon);
    const deckIds = nonPreconDeckRows.map((d) => d.id as string);
    if (deckIds.length === 0) return empty;

    const { data: cardRows, error: cardError } = await supabase
      .from('deck_cards')
      .select('deck_id, card_name, quantity, image_url, type_line, is_maybeboard, is_token')
      .in('deck_id', deckIds);

    if (cardError) console.error('Konnte Deckkarten für die Kartenstatistik nicht laden:', cardError);

    // Grabsteine haben keine deck_cards mehr - ihre Kartennamen kommen aus deleted_card_names.
    const geretteteKarten = await this.geretteteKartennamen(deckIds);

    /**
     * Achsen der Farbstatistik. 'C' = Decks ohne Farbidentität; mehrfarbige Decks zählen mehrfach.
     */
    const colorCounts = new Map<string, { gameCount: number; deckCount: number }>();
    const comboCounts = new Map<string, { colors: string[]; gameCount: number; deckCount: number }>();
    for (const row of nonPreconDeckRows) {
      const games = gamesPerDeck.get(row.id) ?? 0;
      if (games === 0) continue;

      const colors = FILTER_COLORS.filter((c) => ((row.color_identity ?? []) as string[]).includes(c));
      // Farblose Decks zählen auf 'C' statt gar nicht.
      for (const color of colors.length > 0 ? colors : [COLORLESS]) {
        const entry = colorCounts.get(color) ?? { gameCount: 0, deckCount: 0 };
        entry.gameCount += games;
        entry.deckCount += 1;
        colorCounts.set(color, entry);
      }

      const comboKey = colors.join('');
      const combo = comboCounts.get(comboKey) ?? { colors, gameCount: 0, deckCount: 0 };
      combo.gameCount += games;
      combo.deckCount += 1;
      comboCounts.set(comboKey, combo);
    }

    const cardCounts = new Map<string, { gameCount: number; deckCount: number; imageUrl: string | null }>();
    for (const row of (cardRows ?? []) as any[]) {
      if ((row.is_maybeboard ?? false) || (row.is_token ?? false)) continue;
      const typeLine = (row.type_line as string | null) ?? '';
      if (typeLine.includes('Land')) continue;

      const games = gamesPerDeck.get(row.deck_id) ?? 0;
      if (games === 0) continue;

      // Je Deck nur einmal, unabhängig von quantity.
      const entry = cardCounts.get(row.card_name) ?? { gameCount: 0, deckCount: 0, imageUrl: null };
      entry.gameCount += games;
      entry.deckCount += 1;
      if (!entry.imageUrl && row.image_url) entry.imageUrl = row.image_url;
      cardCounts.set(row.card_name, entry);
    }

    // Dasselbe für Grabsteine (Auswahl schon beim Löschen erfolgt).
    for (const [grabsteinId, namen] of geretteteKarten) {
      const games = gamesPerDeck.get(grabsteinId) ?? 0;
      if (games === 0) continue;

      for (const cardName of namen) {
        const entry = cardCounts.get(cardName) ?? { gameCount: 0, deckCount: 0, imageUrl: null };
        entry.gameCount += games;
        entry.deckCount += 1;
        cardCounts.set(cardName, entry);
      }
    }

    // Immer alle sechs Achsen, auch die mit 0 - das Netzdiagramm im Profil braucht eine feste
    // Achsenmenge, sonst ändert es je nach Deckbestand die Form.
    const colorRanking = COLOR_AXES.map((color) => ({
      color,
      gameCount: colorCounts.get(color)?.gameCount ?? 0,
      deckCount: colorCounts.get(color)?.deckCount ?? 0,
    })).sort((a, b) => b.gameCount - a.gameCount);
    const colorComboRanking = [...comboCounts.values()]
      .map((c) => ({ colors: c.colors as ColorComboStat['colors'], gameCount: c.gameCount, deckCount: c.deckCount }))
      .sort((a, b) => b.gameCount - a.gameCount);
    // Volle Liste statt nur Top 5 - das Profil-Tab schneidet je nach gewähltem Modus (Partien/Decks) selbst zu.
    const mostUsedCards = [...cardCounts.entries()]
      .map(([cardName, s]) => ({ cardName, imageUrl: s.imageUrl, gameCount: s.gameCount, deckCount: s.deckCount }))
      .sort((a, b) => b.gameCount - a.gameCount);

    return { mostUsedCards, colorRanking, colorComboRanking };
  }

  /**
   * Verlinkt die Matches eines Commanders (eigene Spieler-Einträge) manuell mit einem Deck.
   * Übernimmt auch Partien an FREMDEN Decks (Leihe), sonst käme man aus einer Leih-Zuordnung nie
   * heraus. Partien an einem anderen EIGENEN Deck bleiben unangetastet.
   */
  async linkCommanderToDeck(owner: DeckOwner, commander: string, deckId: string): Promise<boolean> {
    const playerIds = await this.resolvePlayerIds(owner);
    if (playerIds.length === 0) return false;

    const ownDeckIds = await this.ownDeckIds(owner);

    const { data: rows, error: readError } = await supabase
      .from('match_players')
      .select('id, deck_id')
      .in('player_id', playerIds)
      .eq('commander_name', commander);

    if (readError) {
      console.error('Konnte Partien zum Commander nicht laden:', readError);
      return false;
    }

    const rowIds = (rows ?? [])
      .filter((row) => !row.deck_id || !ownDeckIds.has(row.deck_id as string))
      .map((row) => row.id as string);
    if (rowIds.length === 0) return true;

    const { error } = await supabase.from('match_players').update({ deck_id: deckId }).in('id', rowIds);

    if (error) {
      console.error('Konnte Commander nicht mit Deck verlinken:', error);
      return false;
    }
    return true;
  }

  /**
   * Löst die Verknüpfung aller Matches eines Decks (eigene Spieler-Einträge); sie landen wieder
   * unter "Commander ohne Deck".
   */
  async unlinkDeckMatches(owner: DeckOwner, deckId: string): Promise<boolean> {
    const playerIds = await this.resolvePlayerIds(owner);
    if (playerIds.length === 0) return false;

    const { error } = await supabase
      .from('match_players')
      .update({ deck_id: null })
      .in('player_id', playerIds)
      .eq('deck_id', deckId);

    if (error) {
      console.error('Konnte Deck nicht entlinken:', error);
      return false;
    }
    return true;
  }
}
