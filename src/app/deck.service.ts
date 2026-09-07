import { Injectable, inject } from '@angular/core';
import { supabase } from './supabase.client';
import { ScryfallService, ScryfallCard } from './scryfall.service';
import { CardDataService } from './card-data.service';
import { isPlayerWinner } from './match-utils';
import { chunk, sleep } from './array-utils';
import { GroupService } from './group.service';
import { PreconService } from './precon.service';
import { COLORLESS, FILTER_COLORS } from './color-filter-match';
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
   * Vom Spieler selbst gewählter Kreaturtyp (z.B. "Elf") für Typal-/Stammes-Decks, gespeichert in
   * decks.commander_types (siehe updateDeckArchetype()) - beim Import wird die Spalte zwar einmalig
   * mit dem Typ des markierten Commanders vorbefüllt (siehe DeckService.saveDeck()), da aber nicht
   * jeder Stammes-Commander selbst den beworbenen Kreaturtyp trägt, bleibt sie danach rein manuell
   * gepflegt (ändert sich NICHT mehr automatisch mit, wenn später der Commander gewechselt wird).
   * Nur der erste Wert der commander_types-Spalte - die Auswahl im Bearbeiten-Modus ist bewusst ein
   * einzelnes Dropdown, keine Mehrfachauswahl.
   */
  creatureType: string | null;
  /**
   * Selbst festgelegte Commander-Bracket-Stufe 1-5, oder null für "automatisch bestimmen".
   * Angezeigt wird immer bracket, und nur wenn das null ist, bracketAuto.
   */
  bracket: number | null;
  /**
   * Zuletzt berechnete Stufe der Automatik (siehe src/app/bracket.ts). Wird beim Öffnen eines
   * Decks nachgeführt und existiert nur, damit Deck-Liste und Match-Auswahl ein Abzeichen zeigen
   * können, ohne für jedes Deck die ganze Kartenliste nachzuladen.
   */
  bracketAuto: number | null;
  bracketAutoAt: string | null;
}

/**
 * Ein Deck gehört entweder einem echten Account ODER einem virtuellen Spieler ohne eigenen Login -
 * nie beidem (siehe decks_owner_xor_check-Constraint in der DB). Fast alle deck-bezogenen Methoden
 * nehmen diesen Typ statt einer nackten userId entgegen, damit dieselbe Logik für beide Fälle gilt.
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
  /**
   * Nur bei einem geliehenen Deck gefüllt: das fremde Deck, mit dem gespielt wurde - damit es aus
   * der Liste heraus geöffnet werden kann, statt nur als Name dazustehen.
   */
  borrowedDeck?: BorrowedDeckInfo;
}

export interface BorrowedDeckInfo {
  id: string;
  name: string;
  /** Anzeigename des Besitzers, falls auflösbar (z.B. bei einem Deck aus einer anderen Gruppe nicht). */
  ownerName: string | null;
}

/**
 * Warum es zu einem gespielten Commander kein eigenes Deck gibt - entscheidet, in welcher der drei
 * Listen im Profil er landet:
 *
 * - `none`    - es fehlt schlicht ein Deck; genau hier lohnt sich das Anlegen/Verlinken.
 * - `borrowed`- gespielt wurde das Deck einer anderen Person. Ein Deck existiert also sehr wohl,
 *               es gehört nur jemand anderem und hat deshalb in der eigenen Deck-Liste nichts
 *               verloren.
 * - `cube`    - der Commander stammt aus einem Cube-/Draft-Spiel. Dazu wird es nie ein Deck geben,
 *               solche Spiele werden bewusst nie mit einem Deck verknüpft (siehe
 *               eligibleMatchIdsExcludingCubeDraft).
 */
export type UnassignedCommanderCategory = 'none' | 'borrowed' | 'cube';

export interface UnassignedCommanderStats extends CommanderGameStats {
  category: UnassignedCommanderCategory;
}

/** Persönliche Gesamt-Statistik eines Accounts über ALLE Gruppen hinweg, in denen er Mitglied ist
 * (siehe DeckService.getCrossGroupPersonalStats) - fürs Profil-Tab, das Stats-Tab bleibt bewusst
 * pro aktiver Gruppe getrennt. */
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
   * Eine der fünf Manafarben oder 'C' für farblos (Deck mit leerer Farbidentität).
   *
   * Farblos ist eine eigene Achse, keine sechste Farbe: ein farbloses Deck zählt auf 'C' und auf
   * keine der fünf Farben, genau wie im Farbfilter (color-filter-match.ts) und in der
   * Farbkombinations-Rangliste, wo es als leere Farbliste auftaucht.
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

/** Kombinierte "Meistgespielte Karten" (Top 5, ohne Länder), vollständige Farb-Rangliste (alle
 * fünf Farben plus farblos) und Rangliste der genutzten Farbkombinationen über ALLE Gruppen
 * hinweg - siehe DeckService.getCardAndColorStats(). Precon-Decks fließen bewusst in keine dieser
 * Statistiken ein, da sie nicht selbst zusammengestellt wurden. */
export interface CardAndColorStats {
  mostUsedCards: MostUsedCardStats[];
  colorRanking: ColorStat[];
  colorComboRanking: ColorComboStat[];
}

/**
 * Ein Eintrag der weltweiten "Decks"- bzw. "Commander"-Rangliste (GlobalStats-Komponente) - kommt
 * aus der SECURITY DEFINER-Funktion global_deck_commander_stats() (sql/global-stats-functions-*
 * .sql), da RLS einen normalen Client-Query auf die eigenen Gruppen beschränkt. Bewusst OHNE
 * Spielername ("gespielt von X") - das würde erstmals Namen aus fremden, nie für eine weltweite
 * Ansicht freigegebenen Gruppen offenlegen. Zwei getrennte Interfaces statt einem gemeinsamen, weil
 * die beiden Ranglisten in der UI bewusst getrennt sind (anders als im Gruppen-Scope).
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
   * Scryfalls "gleiche Karte über alle Drucke hinweg"-ID - nur bei Marken gesetzt (siehe
   * ScryfallService.getPrintings()). Nötig, weil viele VERSCHIEDENE Marken sich denselben
   * schlichten Namen teilen (z.B. rote/blaue/schwarze "Wizard"-Marken mit unterschiedlichen
   * Werten), Namensgleichheit allein also nicht "gleiche Marke" bedeutet.
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
const QUANTITY_LINE = /^(\d+)\s*x?\s+(.+)$/i;
/** Set-Kürzel + Sammelnummer, wie sie z.B. deckstats.net anhängt: "Sol Ring (SOC) 128" -> "Sol Ring". */
const SET_AND_COLLECTOR_NUMBER_SUFFIX = /\s*\([A-Za-z0-9]{2,6}\)\s*[A-Za-z0-9★]*\s*$/;

function parseSubtypes(typeLine: string | undefined): string[] {
  const parts = (typeLine ?? '').split('—');
  if (parts.length < 2) return [];
  return parts[1].trim().split(/\s+/).filter(Boolean);
}

/** Für den Precon-Namensabgleich in backfillPreconReleaseYears - fängt zumindest Whitespace-Abweichungen zwischen gespeichertem Decknamen und MTGJSON-Katalogeintrag ab (echte Umbenennungen bleiben davon unberührt, dafür gibt es keine zuverlässige Heuristik). */
function normalizePreconName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
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

@Injectable({ providedIn: 'root' })
export class DeckService {
  private readonly scryfall = inject(ScryfallService);
  private readonly cardData = inject(CardDataService);
  private readonly groupService = inject(GroupService);
  private readonly preconService = inject(PreconService);

  /**
   * Spaltenliste für die Deck-Abfragen.
   *
   * Die Bracket-Spalten kommen aus sql/deck-bracket-2026-09-06.sql, und dieses Skript läuft NICHT
   * automatisch mit dem Deployment - es wird von Hand im Supabase-SQL-Editor ausgeführt. Stünden
   * sie fest in der Liste, würde PostgREST bis dahin jede Deck-Abfrage mit "column does not exist"
   * (42703) ablehnen und die komplette Deck-Liste bliebe leer. Ein fehlendes Abzeichen ist ein
   * hinnehmbarer Zustand, eine leere Deck-Liste nicht.
   *
   * Deshalb einmal je Sitzung: beim ersten 42703 auf eine Bracket-Spalte wird abgeschaltet und die
   * Abfrage ohne sie wiederholt. Nach dem Ausführen der Migration greift beim nächsten Laden
   * wieder die vollständige Liste.
   */
  private static bracketSpaltenVerfuegbar = true;

  private static readonly BASIS_SPALTEN =
    'id, user_id, player_id, name, format, updated_at, created_at, is_precon, precon_release_year, edhrec_tag, is_private, is_outdated, commander_types, players ( group_id )';
  private static readonly BRACKET_SPALTEN = 'bracket, bracket_auto, bracket_auto_at';

  private static deckColumns(): string {
    return DeckService.bracketSpaltenVerfuegbar
      ? `${DeckService.BASIS_SPALTEN}, ${DeckService.BRACKET_SPALTEN}`
      : DeckService.BASIS_SPALTEN;
  }

  /**
   * true = der Fehler kam von den noch fehlenden Bracket-Spalten und der Aufrufer soll es ohne sie
   * erneut versuchen. Schaltet dabei gleich für den Rest der Sitzung um.
   */
  private static istFehlendeBracketSpalte(error: { code?: string; message?: string } | null): boolean {
    if (!error || !DeckService.bracketSpaltenVerfuegbar) return false;
    if (error.code !== '42703' && !(error.message ?? '').includes('bracket')) return false;
    console.warn(
      'Bracket-Spalten fehlen noch - sql/deck-bracket-2026-09-06.sql im Supabase-SQL-Editor ausführen. Decks werden solange ohne Bracket geladen.'
    );
    DeckService.bracketSpaltenVerfuegbar = false;
    return true;
  }

  /**
   * Löst einen DeckOwner zu den betroffenen players.id auf - bei einem echten Account können das
   * mehrere sein (eine Spieler-Zeile pro Gruppe), bei einem virtuellen Spieler ist die playerId
   * bereits selbst die einzige relevante ID, kein Lookup nötig. Öffentlich, da auch DeckViewerService
   * das braucht, um "meine Spiele" (Pilot statt Deck-Besitzer) zu filtern - siehe getDeckStats().
   */
  async resolvePlayerIds(owner: DeckOwner): Promise<string[]> {
    if (owner.kind === 'player') return [owner.playerId];
    const { data } = await supabase.from('players').select('id').eq('user_id', owner.userId);
    return (data ?? []).map((p) => p.id);
  }

  async loadDecksForOwner(owner: DeckOwner): Promise<Deck[]> {
    const abfrage = () => {
      const query = supabase
        .from('decks')
        .select(DeckService.deckColumns())
        .order('updated_at', { ascending: false });
      return owner.kind === 'user'
        ? query.eq('user_id', owner.userId)
        : query.eq('player_id', owner.playerId);
    };

    let { data, error } = await abfrage();
    // Migration noch nicht ausgeführt - ohne die Bracket-Spalten erneut versuchen, statt die
    // Deck-Liste leer zu lassen (siehe deckColumns()).
    if (DeckService.istFehlendeBracketSpalte(error)) ({ data, error } = await abfrage());

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
      bracket: row.bracket ?? null,
      bracketAuto: row.bracket_auto ?? null,
      bracketAutoAt: row.bracket_auto_at ?? null,
    }));
  }

  /** Lädt ein einzelnes Deck per ID, unabhängig vom Besitzer - z.B. für den Direkt-Sprung aus der Stats-Rangliste. */
  async getDeckById(deckId: string): Promise<Deck | null> {
    const abfrage = () =>
      supabase.from('decks').select(DeckService.deckColumns()).eq('id', deckId).maybeSingle();

    let { data, error } = await abfrage();
    // Siehe loadDecksForOwner(): ohne Bracket-Spalten erneut versuchen, statt gar kein Deck zu liefern.
    if (DeckService.istFehlendeBracketSpalte(error)) ({ data, error } = await abfrage());

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
   * Parst eine eingefügte Decklist (ein Eintrag pro Zeile, z.B. "1 Sol Ring" oder "1x Sol Ring").
   * Ignoriert Kommentarzeilen (//, #), merkt sich aber, ob eine Zeile unter einer
   * "Commander"-Überschrift steht (z.B. "//Commander" im deckstats.net-Export), um diese Karte(n)
   * separat markieren zu können. Mehrfach vorkommende Kartennamen werden zu einer Zeile mit
   * summierter Anzahl zusammengeführt.
   */
  parseDecklistText(text: string): { name: string; quantity: number; isCommander: boolean }[] {
    const merged = new Map<string, { name: string; quantity: number; isCommander: boolean }>();
    let inCommanderSection = false;

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) {
        // Eine Leerzeile trennt bei den meisten Export-Formaten (deckstats.net, Moxfield,
        // Archidekt, ...) die Commander-Sektion vom Rest der Liste, OHNE dass danach nochmal ein
        // eigener "Deck:"/"Mainboard:"-Header folgt - ohne dieses Zurücksetzen bliebe sonst jede
        // nachfolgende Karte fälschlich als Commander markiert.
        inCommanderSection = false;
        continue;
      }

      const headerMatch = line.replace(/^\/\/\s*/, '').match(SECTION_HEADER);
      if (headerMatch || line.startsWith('//') || line.startsWith('#')) {
        if (headerMatch) inCommanderSection = headerMatch[1].toLowerCase() === 'commander';
        continue;
      }

      const match = line.match(QUANTITY_LINE);
      const rawName = (match ? match[2] : line).trim();
      const name = rawName.replace(SET_AND_COLLECTOR_NUMBER_SUFFIX, '').trim();
      const quantity = match ? parseInt(match[1], 10) : 1;
      if (!name) continue;

      const key = name.toLowerCase();
      const existing = merged.get(key);
      if (existing) {
        existing.quantity += quantity;
        existing.isCommander = existing.isCommander || inCommanderSection;
      } else {
        merged.set(key, { name, quantity, isCommander: inCommanderSection });
      }
    }

    return [...merged.values()];
  }

  /**
   * Legt ein neues Deck an (existingDeckId = undefined) oder ersetzt die Kartenliste eines
   * bestehenden Decks. Beim Ersetzen wird die Differenz zur vorherigen Liste ins
   * Änderungsverlauf-Log geschrieben (was reingekommen/rausgegangen ist), bevor die alten
   * Karten-Zeilen gelöscht und durch die neuen ersetzt werden.
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
    // Farb-/Typal-Metadaten für den öffentlichen Decks-Suchreiter (siehe
    // sql/public-deck-browse-2026-08-26.sql) direkt beim Import/Neuanlegen mitschreiben - vorher
    // wurden sie erst befüllt, sobald später im Deck-Editor die Commander-Markierung geändert
    // wurde (DeckViewerService.saveEdits()), wodurch frisch importierte Decks mit bereits im Text
    // markiertem Commander auf unbestimmte Zeit ungefiltert blieben (color_identity/commander_types
    // blieben beim Spalten-Default '{}').
    const { colorIdentity, commanderTypes } = commanderMetadataFrom(parsed, cardMap);

    let deckId = existingDeckId;

    if (deckId) {
      const { data: oldRows, error: oldError } = await supabase
        .from('deck_cards')
        .select('card_name, quantity')
        .eq('deck_id', deckId);

      if (oldError) {
        console.error('Konnte bisherige Kartenliste nicht laden:', oldError);
        return null;
      }

      const oldByKey = new Map((oldRows ?? []).map((r) => [r.card_name.toLowerCase(), r]));
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
      const card = cardMap.get(p.name.toLowerCase());
      return {
        deck_id: deckId,
        card_name: p.name,
        quantity: p.quantity,
        image_url: card?.imageUrl ?? null,
        type_line: card?.typeLine ?? null,
        cmc: card?.cmc ?? 0,
        is_commander: p.isCommander,
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
   * Verknüpft nachträglich alte Matches mit einem neu angelegten Deck: nur Matches, in denen
   * GENAU DIESER Deck-Besitzer (über alle seine Spieler-Einträge in allen Gruppen hinweg) den
   * gleichnamigen Commander gespielt hat, und die noch keinem Deck zugeordnet sind. Absichtlich
   * NICHT namensbasiert über alle Spieler hinweg, damit ein geliehener Commander in einem alten
   * Match eines anderen Spielers nicht fälschlich diesem Deck zugeschlagen wird. Cube-/Draft-Spiele
   * werden dabei nie verknüpft (siehe eligibleMatchIdsExcludingCubeDraft), auch wenn dort zufällig
   * ein commander-ähnlicher Name eingetragen ist - das sind keine Commander-Decks.
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
   * Filtert eine Liste von match_id's auf die, deren Spiel NICHT im Cube- oder Draft-Modus
   * stattfand - für backfillDeckLinks/repairCommanderNames, die niemals Cube-/Draft-Spiele
   * automatisch mit einem Commander-Deck verknüpfen dürfen (siehe MtgService.resolveAutoDeckLinks
   * für dieselbe Regel beim Anlegen/nachträglichen Bearbeiten eines Matches).
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
   * Umgekehrte Richtung zu backfillDeckLinks: findet ein bereits vorhandenes Deck dieses Users mit
   * passendem (Haupt-)Commander - fürs automatische Verknüpfen, wenn ein NEUES Match (live erstellt
   * oder importiert) angelegt wird, ohne dass der Nutzer explizit ein Deck ausgewählt hat.
   */
  async findDeckIdByCommander(owner: DeckOwner, commanderName: string): Promise<string | null> {
    let deckQuery = supabase.from('decks').select('id');
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
   * Reparatur-Werkzeug für Alt-Daten: geht alle noch unverknüpften Commander-Namen dieses Users
   * (über alle seine Spieler-Einträge/Gruppen hinweg) durch, löst sie mit der aktuellen (besseren)
   * Scryfall-Erkennung neu auf, korrigiert falsch gespeicherte Namen in der DB und verknüpft sie
   * danach - wo möglich - automatisch mit passenden eigenen Decks. Nötig, weil ein Match nach dem
   * Speichern nicht rückwirkend von Verbesserungen an der Namens-Erkennung profitiert.
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
   * Reparatur-Werkzeug für Alt-Daten: ermittelt für bereits importierte Precons, deren Release-Jahr
   * (decks.precon_release_year) noch fehlt, dieses Jahr nachträglich per Namens-Abgleich gegen den
   * MTGJSON-Precon-Katalog. Betrifft alle Precons, die vor Einführung des Jahresfilters (oder auf
   * einem anderen Weg als dem Precon-Import-Dialog) angelegt wurden - ohne dieses Nachtragen bleiben
   * sie für den Jahresfilter in der Deck-Auswahl (Match-Tab) unsichtbar, obwohl sie existieren.
   * Bei mehrdeutigem Namen (derselbe Precon-Name in mehreren Jahren neu aufgelegt) wird bewusst NICHT
   * geraten, der Deck bleibt dann unverändert - analog zu findDeckIdByCommander().
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
      // MTGJSON nicht erreichbar (siehe PreconService.loadIndex) - ohne Katalog kann kein einziger
      // Name abgeglichen werden. Klar von "geprüft, aber kein Treffer" unterscheiden, damit die
      // Rückmeldung im Profil-Tab nicht fälschlich wie ein echtes "0 Treffer"-Ergebnis aussieht.
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
   * Wie repairCommanderNames(), aber für die GANZE Gruppe statt nur den eigenen Account - für den
   * Host gedacht. Löst z.B. den Fall, dass ein Excel-Import einen Commander unaufgelöst auf
   * Deutsch stehen ließ, während eine später live getrackte Partie denselben Commander (korrekt
   * aufgelöst) auf Englisch speichert - beide würden sonst als zwei verschiedene Commander in der
   * Statistik auftauchen. Verknüpft bewusst NICHT automatisch mit Decks (das bleibt Sache von
   * repairCommanderNames() pro Account, da nur der jeweilige Besitzer seine eigenen Decks kennt).
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

  async deleteDeck(deckId: string): Promise<void> {
    const { error } = await supabase.from('decks').delete().eq('id', deckId);
    if (error) {
      console.error('Konnte Deck nicht löschen:', error);
    }
  }

  /**
   * Fügt eine einzelne Karte hinzu (Bearbeitungsmodus in der Deck-Detailansicht). Erhöht die
   * Anzahl, falls die Karte schon drin ist, statt eine zweite Zeile anzulegen. `card` kommt direkt
   * aus der Scryfall-Suche der Add-Karten-UI, damit kein zusätzlicher Lookup nötig ist.
   */
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
      // Menge einer bereits vorhandenen Karte erhöhen lässt ihren aktuellen Maybeboard-Status
      // bewusst unangetastet - das Verschieben zwischen Deck/Maybeboard läuft separat über
      // setCardMaybeboardFlag(), nicht über erneutes Hinzufügen.
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
   * Setzt den vom Spieler selbst gewählten Archetyp (decks.edhrec_tag) und/oder Kreaturtyp
   * (decks.commander_types, als Einzelwert-Array) - für den öffentlichen Decks-Suchreiter (siehe
   * sql/public-deck-browse-2026-08-26.sql), unabhängig von der automatisch aus der
   * Commander-Farbidentität gepflegten decks.color_identity-Spalte (siehe
   * updateDeckCommanderMetadata()). Beide Felder werden hier bewusst gemeinsam geschrieben (auch
   * wenn im UI nur eines von beiden geändert wurde) - der jeweils andere Wert kommt vom Aufrufer
   * unverändert aus dem aktuell angezeigten Deck.
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

  /**
   * Setzt die selbst gewählte Bracket-Stufe. null = "automatisch bestimmen" (dann gilt wieder
   * bracket_auto).
   */
  async setDeckBracket(deckId: string, bracket: number | null): Promise<boolean> {
    const { error } = await supabase.from('decks').update({ bracket }).eq('id', deckId);

    if (error) {
      console.error('Konnte Bracket nicht ändern:', error);
      return false;
    }
    return true;
  }

  /**
   * Schreibt das Ergebnis der Automatik zurück, damit Deck-Liste und Match-Auswahl ein Abzeichen
   * zeigen können, ohne selbst zu rechnen (siehe sql/deck-bracket-2026-09-06.sql).
   *
   * Bewusst OHNE updated_at anzufassen: das ist der Zeitstempel der letzten inhaltlichen Änderung
   * am Deck und sortiert die Deck-Liste. Ein reiner Nachtrag der Automatik ist keine Änderung
   * durch den Nutzer und darf das Deck nicht nach oben schieben.
   *
   * Fehler landen hier nur in der Konsole: Steht die Migration noch aus, soll die Deck-Ansicht
   * trotzdem normal funktionieren - das Bracket wird dann eben bei jedem Öffnen neu gerechnet,
   * statt gespeichert zu werden.
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
   * Pflegt decks.color_identity nach - fürs Farbfilter im öffentlichen Decks-Suchreiter (siehe
   * sql/public-deck-browse-2026-08-26.sql). Wird von DeckViewerService.saveEdits() aufgerufen,
   * sobald sich die Commander-Markierung geändert hat - ohne diese Pflege würde die Spalte sofort
   * wieder veralten. commander_types (Kreaturtyp) wird bewusst NICHT hier mitgepflegt - das ist ein
   * eigenständiges, vom Spieler manuell gesetztes Feld (siehe updateDeckArchetype()), das nicht bei
   * jedem Commander-Wechsel stillschweigend überschrieben werden soll.
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
   * Trägt bei einer bereits vorhandenen Marke ohne oracleId (vor Einführung dieses Felds gescannt)
   * die oracleId nachträglich ein, statt beim erneuten Scan eine doppelte Zeile für dieselbe Marke
   * anzulegen. Matched zusätzlich über image_url, da mehrere Marken denselben Namen aber
   * unterschiedliche Bilder haben können (z.B. verschiedenfarbige "Wizard"-Marken).
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
   * Gesamt-Statistik für ein Deck über ALLE Gruppen hinweg (nicht nur die aktuell aktive). Ohne
   * pilotPlayerIds unabhängig davon, wer es jeweils gespielt hat (eigener Pilot oder ausgeliehen) -
   * im Gegensatz zu den gruppen-gebundenen Stats im Stats-Tab, die nur die aktive Gruppe sehen. Mit
   * pilotPlayerIds (siehe DeckViewerService.resolveMyPlayerIds()) nur die Partien, in denen einer
   * dieser Spieler tatsächlich gespielt hat - für die "Meine Spiele"/"Alle Spiele"-Umschaltung in
   * der Deck-Detailansicht.
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

  /**
   * Wie getDeckStats(), aber für mehrere Decks auf einmal (eine Anfrage statt einer pro Deck) -
   * für Listen, die z.B. nach Winrate/Spielanzahl sortiert werden sollen.
   */
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
   * Der im Deck selbst hinterlegte Commander (deck_cards.is_commander) je Deck-ID - als Fallback
   * für die Deckliste, wenn getDeckStatsForDecks() keinen Commander liefert (noch keine Partie
   * gespielt, z.B. bei einem frisch angelegten leeren Deck). Bei Partner-Commandern wird nur
   * einer davon zurückgegeben, wie auch sonst in der App für Karten-Thumbnails üblich. Liefert
   * auch das dort hinterlegte Bild mit (statt nur den Namen), damit ein individuell gewähltes
   * Artwork (siehe deck-viewer.service.ts selectArtwork) auch im Deckliste-Vorschaubild ankommt,
   * statt dass dort immer nur das generische Scryfall-Standardbild zum Namen gezeigt wird.
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
    return result;
  }

  /**
   * Farbidentität einer Liste von Decks, geschlüsselt nach Deck-ID - für Statistiken, die (anders
   * als getCardAndColorStats) nicht auf einen einzelnen DeckOwner beschränkt sind, sondern gegen
   * bereits anderweitig geladene Matches rechnen (siehe stats-tab.ts groupColorAndComboStats).
   *
   * Liefert für private Decks anderer Nutzer keinen Eintrag (RLS blendet sie aus, siehe
   * sql/security-fixes-2026-08-26.sql) - das ist dieselbe stille Auslassung, die deckStats()/
   * commanderStats() im Stats-Tab beim deckName-Join schon länger haben, kein neuer Sonderfall.
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
   * Ruft eine der beiden Global-Statistik-Funktionen auf und fällt auf ihre alte, parameterlose
   * Fassung zurück, falls die gefilterte Signatur noch nicht existiert (PostgREST-Code PGRST202,
   * d.h. sql/global-stats-format-filter-2026-09-03.sql wurde noch nicht im Supabase-Editor
   * ausgeführt). Ungefilterte Zahlen sind allemal besser als eine leere Seite - ohne diesen
   * Rückfall stand die komplette Global-Ansicht leer da, bis die Migration lief. Nach der Migration
   * greift der Zweig nie mehr. Liefert null, wenn auch der Rückfall scheitert.
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
   * Weltweite "Decks & Commander"-Rangliste über ALLE Spieler der Website hinweg (Stats-Tab,
   * Global-Ansicht) - ruft die serverseitige Funktion global_deck_commander_stats() auf (siehe
   * sql/global-stats-functions-*.sql, sql/global-stats-format-filter-2026-09-03.sql für die
   * modes/formats-Parameter). Muss einmalig im Supabase-SQL-Editor angelegt werden - bis dahin
   * greift der Rückfall in callGlobalStatsRpc() (ungefiltert statt leer).
   * modes/formats = null bedeutet "kein Filter" (Default, entspricht dem bisherigen Verhalten).
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
   * Weltweite Übersichtszahlen (Spiele, aktive Spieler, gebaute Decks) für die Kacheln oben in der
   * Global-Ansicht - ruft global_overview_stats() auf (sql/global-overview-stats-2026-09-04.sql).
   * Anders als die beiden Ranglisten-Funktionen gibt es hier bewusst KEINEN Rückfall auf eine alte
   * Signatur: die Funktion ist neu, es gibt keine ältere Fassung. Solange die Migration nicht im
   * Supabase-SQL-Editor gelaufen ist, kommt null zurück und die Kacheln bleiben ausgeblendet -
   * der Rest der Global-Ansicht funktioniert davon unberührt weiter.
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
   * Weltweite Lieblingsfarben/Farbkombinationen über ALLE Spieler der Website hinweg (Stats-Tab,
   * Global-Ansicht) - ruft global_color_and_combo_stats() auf (siehe
   * sql/global-stats-functions-*.sql, sql/global-stats-format-filter-2026-09-03.sql für die
   * modes/formats-Parameter, null = kein Filter). Liefert dieselbe ColorStat[]/ColorComboStat[]-Form
   * wie getCardAndColorStats(), damit die vorhandene Radar-/Kombinations-Darstellung (inkl.
   * Partien/Decks-Umschalter) unverändert wiederverwendet werden kann.
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

    const COLOR_AXES: readonly ColorStat['color'][] = [...FILTER_COLORS, COLORLESS];
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
   * Commander-Statistik über ALLE Gruppen hinweg für Spiele, zu denen es kein EIGENES Deck gibt
   * (z.B. alte Excel-Importe, live getrackte Spiele ohne Deck-Auswahl, geliehene Decks oder
   * Cube-Runden) - ergänzt getDeckStats() im Profil, wo sonst nur deck-gebundene Spiele auftauchen
   * würden.
   *
   * Jeder Eintrag trägt eine `category` (siehe UnassignedCommanderCategory), denn "kein eigenes
   * Deck" heißt nicht überall dasselbe: Zu einem geliehenen Deck gibt es sehr wohl ein Deck (nur
   * eben das einer anderen Person), und zu einem Cube-Commander wird es nie eines geben. Beides
   * gehört nicht in dieselbe Liste wie ein Commander, für den man tatsächlich noch ein Deck
   * anlegen oder verlinken sollte.
   *
   * Ein Commander, der sowohl in normalen als auch in Cube-Spielen vorkam, erscheint in beiden
   * Listen mit den jeweils zugehörigen Partien - eine gemeinsame Zeile könnte die Winrate keiner
   * der beiden Listen korrekt ausweisen.
   *
   * `linkBorrowed` trägt die per Namen erkannte Leihe auch in der Datenbank nach (deck_id auf das
   * fremde Deck), statt sie nur anzuzeigen: erst dadurch ist die Partie wirklich mit dem Deck
   * verknüpft und taucht beim Besitzer als geliehen gespielte Partie auf - genau wie bei einem über
   * den Ausleih-Picker gewählten Deck. Nur beim eigenen Profil setzen; beim bloßen Ansehen eines
   * fremden Profils darf ein Aufruf keine Daten verändern.
   */
  async getUnassignedCommanderStats(
    owner: DeckOwner,
    options: { linkBorrowed?: boolean } = {}
  ): Promise<UnassignedCommanderStats[]> {
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
    // wird vorsortiert. Der Rest ohne Deck-Verknüpfung muss danach noch gegen die Decks der
    // anderen geprüft werden - deshalb erst sammeln, dann einteilen.
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

    const unlinkedNames = [...new Set(relevant.filter((r) => !r.deckId && !r.cube).map((r) => r.commander))];
    const foreignDeckByCommander = await this.foreignDeckIdsByCommander(unlinkedNames, ownDeckIds);

    if (options.linkBorrowed && foreignDeckByCommander.size > 0) {
      await this.linkBorrowedMatches(owner, unlinkedNames, foreignDeckByCommander);
    }

    const borrowedDeckIds = new Set<string>([
      ...relevant.filter((r) => r.deckId).map((r) => r.deckId as string),
      ...foreignDeckByCommander.values(),
    ]);
    const borrowedDecks = await this.borrowedDeckInfos([...borrowedDeckIds]);

    // Schlüssel ist Kategorie + Name, damit derselbe Commander aus einer Cube-Runde und aus einem
    // normalen Spiel nicht zu einer Zeile verschmilzt.
    const stats = new Map<string, UnassignedCommanderStats>();
    for (const row of relevant) {
      const deckId = row.deckId ?? foreignDeckByCommander.get(row.commander.toLowerCase()) ?? null;
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

  /**
   * Sucht zu Commander-Namen ohne Deck-Verknüpfung ein passendes Deck, das jemand ANDEREM gehört.
   *
   * Hintergrund: Wer sich ein Deck ausleiht und beim Erfassen nur den Commander eingetippt hat
   * (statt das Deck über den Ausleih-Picker zu wählen), hätte sonst einen Commander in der Liste
   * "Commander ohne Deck" stehen, zu dem sehr wohl ein Deck existiert - es gehört nur jemand
   * anderem und darf deshalb nicht in der eigenen Deck-Liste landen.
   *
   * Zwei Namen fallen bewusst durch:
   *
   * - Es gibt ein EIGENES Deck mit diesem Commander. Dann ist die Partie kein Leihfall, sondern
   *   nur (noch) nicht verknüpft - und ohne diese Bedingung würde eine gerade im 🔗-Dialog gelöste
   *   Verknüpfung sofort wieder als "geliehen" gesetzt.
   * - Mehrere fremde Decks passen. Dann steht nicht fest, welches gemeint war; wie in
   *   findDeckIdByCommander() wird lieber gar nichts geraten.
   *
   * Rückgabe: kleingeschriebener Commander-Name -> deck_id des fremden Decks.
   */
  private async foreignDeckIdsByCommander(commanderNames: string[], ownDeckIds: Set<string>): Promise<Map<string, string>> {
    if (commanderNames.length === 0) return new Map();

    const decksByName = new Map<string, { own: boolean; foreign: Set<string> }>();
    for (const batch of chunk(commanderNames, 100)) {
      const { data, error } = await supabase
        .from('deck_cards')
        .select('deck_id, card_name')
        .eq('is_commander', true)
        .in('card_name', batch);

      if (error) {
        console.error('Konnte fremde Decks zu Commander-Namen nicht laden:', error);
        continue;
      }

      for (const row of data ?? []) {
        const key = (row.card_name as string).toLowerCase();
        const entry = decksByName.get(key) ?? { own: false, foreign: new Set<string>() };
        if (ownDeckIds.has(row.deck_id as string)) entry.own = true;
        else entry.foreign.add(row.deck_id as string);
        decksByName.set(key, entry);
      }
    }

    const found = new Map<string, string>();
    for (const [name, entry] of decksByName) {
      if (entry.own || entry.foreign.size !== 1) continue;
      found.set(name, [...entry.foreign][0]);
    }
    return found;
  }

  /**
   * Trägt die per Namen erkannte Leihe in match_players nach: die eigenen Partien mit diesem
   * Commander bekommen die deck_id des fremden Decks. Damit ist die Partie genauso verknüpft wie
   * eine über den Ausleih-Picker erfasste - sie lässt sich aus dem Profil heraus öffnen und
   * zählt beim Besitzer als von jemand anderem gespielte Partie.
   *
   * backfillDeckLinks() macht die eigentliche Arbeit und ist derselbe Weg, den ein neu angelegtes
   * eigenes Deck geht - inklusive der Regel, Cube- und Draft-Partien niemals zu verknüpfen.
   */
  private async linkBorrowedMatches(
    owner: DeckOwner,
    commanderNames: string[],
    foreignDeckByCommander: Map<string, string>
  ): Promise<void> {
    for (const name of commanderNames) {
      const deckId = foreignDeckByCommander.get(name.toLowerCase());
      if (deckId) await this.backfillDeckLinks(deckId, owner, name);
    }
  }

  /** Name und Besitzer zu Deck-IDs - für die Anzeige geliehener Decks und zum Öffnen aus der Liste heraus. */
  private async borrowedDeckInfos(deckIds: string[]): Promise<Map<string, BorrowedDeckInfo>> {
    const result = new Map<string, BorrowedDeckInfo>();
    if (deckIds.length === 0) return result;

    const { data: deckRows, error } = await supabase.from('decks').select('id, name, user_id, player_id').in('id', deckIds);
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
      result.set(deck.id, { id: deck.id, name: deck.name, ownerName: ownerName ?? null });
    }
    return result;
  }

  /**
   * Persönliche Gesamt-Statistik eines Accounts über ALLE Gruppen hinweg (nicht nur die gerade
   * aktive) - fürs Profil-Tab. Anders als getUnassignedCommanderStats() zählt hier JEDES Spiel mit,
   * unabhängig davon, ob ein Deck verlinkt ist, da hier die Gesamtzahl gefragt ist statt einer
   * reinen Commander-Rangliste. Respektiert stats_locked einer Gruppe bewusst NICHT - das sperrt nur
   * die geteilte Rangliste für andere Mitglieder, nicht die eigenen Zahlen für einen selbst.
   *
   * year begrenzt die Auswertung auf ein Kalenderjahr (Jahresfilter der Profil-Statistiken);
   * ohne Angabe zählen alle Partien.
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
      // Jahresfilter clientseitig statt als Query-Bedingung: die Matches hängen hier über einen
      // Join dran, und ein Filter auf die eingebettete Tabelle bräuchte einen Inner-Join-Hinweis -
      // die Zeilenzahl (Partien EINES Accounts) ist klein genug, dass sich das nicht lohnt.
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
   * Meistgespielte Karten (ohne Länder), vollständige Farb-Rangliste (alle 5 Farben plus farblos)
   * und Rangliste der genutzten Farbkombinationen über ALLE Gruppen hinweg. Liefert je Eintrag
   * sowohl gameCount (nach tatsächlich gespielten Partien je Deck gewichtet, ein oft gespieltes
   * Deck zählt stärker) als auch deckCount (reine Deckanzahl, unabhängig von Partien) - das
   * Profil-Tab lässt den Nutzer zwischen beiden Sichten umschalten, ohne neu laden zu müssen. Eine
   * Karte zählt dabei je Deck nur 1x, unabhängig von deck_cards.quantity. Länder (Basic wie
   * Nichtbasis) werden rein anhand der Typzeile erkannt (enthält "Land") - es gibt kein eigenes
   * "isLand"-Flag in deck_cards. Precon-Decks (is_precon) fließen bewusst NICHT ein, da sie nicht
   * selbst zusammengestellt wurden. mostUsedCards liefert die vollständige Liste (nicht nur Top 5) -
   * das Slicen auf die Top 5 je aktivem Modus übernimmt das Profil-Tab.
   *
   * year begrenzt die Auswertung wie bei getCrossGroupPersonalStats() auf ein Kalenderjahr - ein
   * Deck ohne Partie in diesem Jahr fällt damit ganz heraus.
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

    /**
     * Achsen der Farbstatistik. 'C' ist keine sechste Manafarbe, sondern der Gegenfall: Decks ganz
     * OHNE Farbidentität. Mehrfarbige Decks zählen weiterhin auf mehreren Achsen, die sechs Werte
     * summieren sich also nicht auf die Deckanzahl.
     */
    const COLOR_AXES: readonly ColorStat['color'][] = [...FILTER_COLORS, COLORLESS];
    const colorCounts = new Map<string, { gameCount: number; deckCount: number }>();
    const comboCounts = new Map<string, { colors: string[]; gameCount: number; deckCount: number }>();
    for (const row of nonPreconDeckRows) {
      const games = gamesPerDeck.get(row.id) ?? 0;
      if (games === 0) continue;

      const colors = FILTER_COLORS.filter((c) => ((row.color_identity ?? []) as string[]).includes(c));
      // Ein farbloses Deck (leere Farbidentität) zählt auf die eigene Achse 'C' statt auf gar
      // keine - sonst fehlte es in der Farbstatistik komplett, obwohl es in der
      // Farbkombinations-Rangliste darunter längst auftaucht.
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

      // Zählt pro Deck nur 1x mit, unabhängig von deck_cards.quantity - eine Karte, die mehrfach im
      // selben Deck steckt (z.B. bei Nicht-Singleton-Formaten), soll nicht stärker gewichtet werden
      // als eine, die nur einmal drin ist.
      const entry = cardCounts.get(row.card_name) ?? { gameCount: 0, deckCount: 0, imageUrl: null };
      entry.gameCount += games;
      entry.deckCount += 1;
      if (!entry.imageUrl && row.image_url) entry.imageUrl = row.image_url;
      cardCounts.set(row.card_name, entry);
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
   * Verlinkt manuell alle noch unverlinkten Matches eines Commanders (nur eigene Spieler-Einträge)
   * mit einem konkreten Deck - für Fälle, wo die automatische Erkennung (findDeckIdByCommander)
   * nichts findet oder der falsche Commander-Name erkannt wurde.
   */
  async linkCommanderToDeck(owner: DeckOwner, commander: string, deckId: string): Promise<boolean> {
    const playerIds = await this.resolvePlayerIds(owner);
    if (playerIds.length === 0) return false;

    const { error } = await supabase
      .from('match_players')
      .update({ deck_id: deckId })
      .in('player_id', playerIds)
      .eq('commander_name', commander)
      .is('deck_id', null);

    if (error) {
      console.error('Konnte Commander nicht mit Deck verlinken:', error);
      return false;
    }
    return true;
  }

  /**
   * Löst die Deck-Verknüpfung aller Matches eines Decks (nur eigene Spieler-Einträge) wieder -
   * z.B. falls eine automatische oder manuelle Verlinkung ein falsches Deck getroffen hat. Die
   * Matches landen danach wieder unter "Commander ohne Deck".
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
