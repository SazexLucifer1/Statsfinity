import { Injectable } from '@angular/core';
import { supabase } from './supabase.client';
import { DeckService } from './deck.service';

export interface PublicDeck {
  id: string;
  /** Account des Besitzers - null bei Decks accountloser Spieler. Nur dafür da, dem Besitzer unter seinem eigenen Deck den Löschknopf an fremden Kommentaren zu zeigen (siehe deck-comments). */
  userId: string | null;
  name: string;
  format: string | null;
  updatedAt: string;
  edhrecTag: string | null;
  colorIdentity: string[];
  commanderTypes: string[];
  /** Name + individuell gewähltes Artwork (deck_cards.image_url) jedes markierten Commanders - dieselbe Priorität wie deck-list.ts' commanderImageUrl, damit das Bild hier mit dem in der Deck-Ansicht übereinstimmt. */
  commanders: { name: string; imageUrl: string | null }[];
}

export interface PublicDeckStats {
  games: number;
  wins: number;
  winRate: number;
}

export interface PublicDeckFilters {
  name?: string;
  /** Exakte Farbidentität (wie ScryfallService.searchCommanders()) - sortiert, für den eq()-Vergleich gegen decks.color_identity. */
  colors?: string[];
  /** decks.edhrec_tag, exakt (siehe archetypeOptions()). */
  archetype?: string | null;
  /** Muss in decks.commander_types enthalten sein. */
  creatureType?: string | null;
  sort: 'recent' | 'winRate';
}

/** Obergrenze für die Grundmenge, über die "neu"/"Winrate" sortiert wird - siehe searchPublicDecks(). */
const MAX_RESULTS = 300;

/**
 * Schlanker, eigenständiger Service für den öffentlichen "Decks"-Suchreiter (alle nicht-privaten
 * Decks aller Nutzer, auch ohne Login lesbar - siehe sql/public-deck-browse-2026-08-26.sql für die
 * nötige RLS-Änderung). Bewusst NICHT DeckService erweitert - der ist auf eingeloggte
 * Nutzer/eigene Decks zugeschnitten (Erstellen/Löschen/Umbenennen); hier geht es rein um Lesen
 * über ALLE Nutzer hinweg.
 */
@Injectable({ providedIn: 'root' })
export class PublicDeckService {
  /**
   * Sucht öffentliche Decks über die gegebenen Filter. Begrenzt auf die MAX_RESULTS zuletzt
   * aktualisierten Treffer, bevor sortiert/angezeigt wird - eine "Winrate"-Sortierung über
   * wirklich JEDES öffentliche Deck aller Zeiten bräuchte eine serverseitige Sortier-/
   * Aggregations-Lösung; dieselbe bewusste Grenze (Grundmenge laden, Winrate clientseitig
   * nachsortieren) nutzt bereits deck-list.ts für die eigene Deck-Liste.
   */
  async searchPublicDecks(filters: PublicDeckFilters): Promise<{ decks: PublicDeck[]; stats: Map<string, PublicDeckStats> }> {
    // Gelöschte Decks (Grabsteine, siehe DeckService.deleteDeck()) gehören nicht ins Stöbern: Sie
    // zählen zwar in den Ranglisten weiter, haben aber keine Kartenliste mehr zum Ansehen.
    const abfrage = () => {
      let query = DeckService.nurLebende(
        supabase
          .from('decks')
          .select('id, user_id, name, format, updated_at, edhrec_tag, color_identity, commander_types')
          .eq('is_private', false)
          .order('updated_at', { ascending: false })
          .limit(MAX_RESULTS)
      );

      const name = filters.name?.trim();
      if (name) query = query.ilike('name', `%${name}%`);
      if (filters.colors && filters.colors.length > 0) {
        // .eq() serialisiert ein JS-Array NICHT als Postgres-Array-Literal (nur String(array), also
        // "B,G" ohne geschweifte Klammern) - das scheitert am text[]-Cast der Spalte und lässt die
        // Query mit Fehler fehlschlagen, was searchPublicDecks() dann als leeres Ergebnis behandelt.
        // Deshalb hier selbst das Literal-Format "{B,G}" bauen.
        const sorted = [...filters.colors].sort();
        query = query.eq('color_identity', `{${sorted.join(',')}}`);
      }
      if (filters.archetype) query = query.eq('edhrec_tag', filters.archetype);
      if (filters.creatureType) query = query.contains('commander_types', [filters.creatureType]);
      return query;
    };

    let { data, error } = await abfrage();
    // Steht die Grabstein-Migration noch aus, kennt Postgres deleted_at nicht - dann ohne den
    // Filter erneut, statt die Suche leer zu lassen (dieselbe Mechanik wie in DeckService).
    if (DeckService.fehlendeSpalteAbgeschaltet(error)) ({ data, error } = await abfrage());

    if (error || !data) {
      console.error('Konnte öffentliche Decks nicht laden:', error);
      return { decks: [], stats: new Map() };
    }

    const deckIds = (data as any[]).map((row) => row.id);
    const [commanders, stats] = await Promise.all([
      this.getCommanders(deckIds),
      this.getStats(deckIds),
    ]);

    const decks: PublicDeck[] = (data as any[]).map((row) => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      format: row.format,
      updatedAt: row.updated_at,
      edhrecTag: row.edhrec_tag,
      colorIdentity: row.color_identity ?? [],
      commanderTypes: row.commander_types ?? [],
      commanders: commanders.get(row.id) ?? [],
    }));

    if (filters.sort === 'winRate') {
      decks.sort((a, b) => {
        const sa = stats.get(a.id) ?? { games: 0, wins: 0, winRate: 0 };
        const sb = stats.get(b.id) ?? { games: 0, wins: 0, winRate: 0 };
        return sb.winRate - sa.winRate || sb.games - sa.games;
      });
    }

    return { decks, stats };
  }

  /**
   * Alle markierten Commander pro Deck (nicht nur der erste - wichtig für Partner-Decks), inklusive
   * des individuell gewählten Artworks (deck_cards.image_url). Wird für die Kartenbild-Anzeige
   * gebraucht - ein reiner Namens-Lookup bei Scryfall (frühere Version) liefert das generische/
   * neueste Artwork zum Namen, das vom tatsächlich im Deck hinterlegten Bild abweichen kann (z.B.
   * nach Nutzung des Artwork-Pickers im Deck-Editor).
   */
  private async getCommanders(deckIds: string[]): Promise<Map<string, { name: string; imageUrl: string | null }[]>> {
    const result = new Map<string, { name: string; imageUrl: string | null }[]>();
    if (deckIds.length === 0) return result;

    const { data, error } = await supabase
      .from('deck_cards')
      .select('deck_id, card_name, image_url')
      .eq('is_commander', true)
      .in('deck_id', deckIds);

    if (error || !data) {
      console.error('Konnte Commander nicht laden:', error);
      return result;
    }

    for (const row of data as any[]) {
      const list = result.get(row.deck_id) ?? [];
      list.push({ name: row.card_name, imageUrl: row.image_url });
      result.set(row.deck_id, list);
    }
    return result;
  }

  /** Liest die vorab aggregierten Sieg-/Partienzahlen über die deck_public_stats()-Funktion (SECURITY
   * DEFINER mit fest gesetztem search_path, siehe deck-public-stats-function-2026-08-30.sql - vorher
   * eine View, die der Supabase Security Advisor als "Security Definer View" kritisch einstufte). */
  private async getStats(deckIds: string[]): Promise<Map<string, PublicDeckStats>> {
    const result = new Map<string, PublicDeckStats>();
    if (deckIds.length === 0) return result;

    const { data, error } = await supabase.rpc('deck_public_stats', { p_deck_ids: deckIds });

    if (error || !data) {
      console.error('Konnte Deck-Statistiken nicht laden:', error);
      return result;
    }

    for (const row of data as any[]) {
      const games = row.games ?? 0;
      const wins = row.wins ?? 0;
      result.set(row.deck_id, { games, wins, winRate: games > 0 ? (wins / games) * 100 : 0 });
    }
    return result;
  }

  /** Kartenliste eines einzelnen öffentlichen Decks (Hauptdeck, ohne Maybeboard) - für die Leseansicht. */
  async loadDeckCards(deckId: string): Promise<{ name: string; quantity: number; isCommander: boolean }[]> {
    const { data, error } = await supabase
      .from('deck_cards')
      .select('card_name, quantity, is_commander')
      .eq('deck_id', deckId)
      .eq('is_maybeboard', false)
      .eq('is_token', false);

    if (error || !data) {
      console.error('Konnte Deckliste nicht laden:', error);
      return [];
    }
    return (data as any[]).map((row) => ({ name: row.card_name, quantity: row.quantity, isCommander: row.is_commander }));
  }

  /** Distinkte Archetyp-Werte (decks.edhrec_tag) unter allen öffentlichen Decks - für das Archetyp-Dropdown. */
  async archetypeOptions(): Promise<string[]> {
    const abfrage = () =>
      DeckService.nurLebende(supabase.from('decks').select('edhrec_tag'))
        .eq('is_private', false)
        .not('edhrec_tag', 'is', null);

    let { data, error } = await abfrage();
    if (DeckService.fehlendeSpalteAbgeschaltet(error)) ({ data, error } = await abfrage());

    if (error || !data) return [];
    return [...new Set((data as any[]).map((row) => row.edhrec_tag as string))].sort();
  }
}
