import { Injectable, signal } from '@angular/core';
import { supabase } from './supabase.client';

/**
 * Ein Deck aus dem Archidekt-Auswertungsvorrat (Tabelle archidekt_deck_pool, angelegt in
 * sql/archidekt-deck-pool-2026-09-15.sql, gefüllt von scripts/import-archidekt-decks.js).
 *
 * Bewusst hier im Service und nicht in models.ts: Das sind keine Domänenmodelle der App, sondern
 * die Form einer einzelnen Tabelle - gleiche Einordnung wie PreconSummary in precon.service.ts.
 */
export interface PoolDeck {
  id: string;
  archidektId: number;
  name: string;
  commanderNames: string[];
  /** Bracket 1-5, wie der Ersteller es auf Archidekt SELBST angegeben hat. */
  creatorBracket: number;
  cardCount: number;
  ownerUsername: string | null;
  viewCount: number | null;
  importedAt: string;
}

/** Eine Karte eines solchen Decks (Tabelle archidekt_deck_pool_cards). */
export interface PoolCard {
  /** Name wie auf Archidekt, inklusive " // " bei doppelseitigen Karten. */
  name: string;
  quantity: number;
  isCommander: boolean;
}

/**
 * Der Archidekt-Deckvorrat für die Developer-Ansicht.
 *
 * Hält zwei Dinge zusammen, weil beide nur von dieser einen Ansicht gebraucht werden: den
 * Auf/Zu-Zustand der Seite (gleiches Muster wie LegalPageService und DeckViewerService - ein
 * Signal, das app.html auswertet; die App hat bewusst keinen Router) und das Laden der Daten.
 *
 * SICHTBARKEIT: Die Tabellen sind per RLS nur für Developer lesbar (profiles.is_developer). Für
 * alle anderen Konten kommt hier schlicht eine leere Liste zurück - die Datenbank filtert, nicht
 * die App. Die Prüfung auf isDeveloper im Profil-Tab blendet den Knopf aus; sie ist Bequemlichkeit,
 * nicht die Absicherung.
 */
@Injectable({ providedIn: 'root' })
export class ArchidektPoolService {
  /** Steuert, ob die Vorrats-Seite statt der Tabs angezeigt wird (ausgewertet in app.html). */
  readonly isOpen = signal(false);

  readonly decks = signal<PoolDeck[]>([]);
  readonly loading = signal(false);
  /** Gesetzt, wenn das Laden fehlschlug - die Ansicht unterscheidet das von "nichts importiert". */
  readonly failed = signal(false);

  open(): void {
    this.isOpen.set(true);
    if (this.decks().length === 0) void this.loadDecks();
  }

  close(): void {
    this.isOpen.set(false);
  }

  /**
   * Lädt die Deckköpfe - ohne Kartenlisten. Die Karten eines Decks kommen erst beim Öffnen dazu
   * (loadCards), weil sonst bei 100 Karten je Deck schon für eine Übersichtsliste zehntausende
   * Zeilen über die Leitung gingen.
   */
  async loadDecks(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);

    const { data, error } = await supabase
      .from('archidekt_deck_pool')
      .select(
        'id, archidekt_id, name, commander_names, creator_bracket, card_count, owner_username, view_count, imported_at',
      )
      .order('creator_bracket', { ascending: true })
      .order('name', { ascending: true });

    this.loading.set(false);

    if (error || !data) {
      console.error('Konnte den Archidekt-Deckvorrat nicht laden:', error);
      this.failed.set(true);
      return;
    }

    this.decks.set(
      data.map((row) => ({
        id: row.id,
        archidektId: Number(row.archidekt_id),
        name: row.name,
        commanderNames: row.commander_names ?? [],
        creatorBracket: row.creator_bracket,
        cardCount: row.card_count,
        ownerUsername: row.owner_username,
        viewCount: row.view_count,
        importedAt: row.imported_at,
      })),
    );
  }

  /** Die Kartenliste eines Decks. Commander zuerst, danach alphabetisch - wie in der lesbaren View. */
  async loadCards(deckId: string): Promise<PoolCard[] | null> {
    const { data, error } = await supabase
      .from('archidekt_deck_pool_cards')
      .select('name, quantity, is_commander')
      .eq('deck_id', deckId)
      .order('is_commander', { ascending: false })
      .order('name', { ascending: true });

    if (error || !data) {
      console.error('Konnte die Kartenliste nicht laden:', error);
      return null;
    }

    return data.map((row) => ({
      name: row.name,
      quantity: row.quantity,
      isCommander: row.is_commander,
    }));
  }
}
