import { Injectable, computed, signal } from '@angular/core';
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
/** Womit die Liste gerade eingegrenzt ist. Leere Bracket-Liste heißt "keine Stufe gewählt". */
export interface PoolFilter {
  search: string;
  brackets: number[];
}

/**
 * Wie viele Treffer eine Abfrage höchstens zurückgibt.
 *
 * Nicht mehr, weil niemand 10.000 Kacheln durchscrollt - und weil Supabase eine Antwort ohne
 * limit ohnehin bei 1.000 Zeilen abschneidet, ohne das zu sagen. Genau daran hat die Ansicht
 * vorher stillschweigend nur die ersten 1.000 von 10.005 Decks gezeigt. Wer mehr sehen will,
 * grenzt weiter ein; die Gesamtzahl der Treffer steht in `total` daneben.
 */
const MAX_TREFFER = 200;

/**
 * Bereitet einen Suchbegriff für den like-Filter auf.
 *
 * Zwei Dinge müssen raus, sonst tut der Filter etwas anderes als der Benutzer meint: die
 * like-Platzhalter % und _ (ein getipptes "%" würde sonst auf alles passen) und das Komma, das
 * PostgREST in der Filtersyntax selbst als Trennzeichen benutzt.
 */
function suchbegriffAufbereiten(begriff: string): string {
  return begriff
    .trim()
    .toLowerCase()
    .replace(/[\\%_,]/g, ' ')
    .trim();
}

@Injectable({ providedIn: 'root' })
export class ArchidektPoolService {
  /** Steuert, ob die Vorrats-Seite statt der Tabs angezeigt wird (ausgewertet in app.html). */
  readonly isOpen = signal(false);

  readonly decks = signal<PoolDeck[]>([]);
  /** Treffer insgesamt laut Datenbank - kann weit über den geladenen MAX_TREFFER liegen. */
  readonly total = signal(0);
  readonly loading = signal(false);
  /** Gesetzt, wenn das Laden fehlschlug - die Ansicht unterscheidet das von "nichts importiert". */
  readonly failed = signal(false);

  /** Ob die Anzeige gerade beschnitten ist, es also mehr Treffer gibt als geladene Decks. */
  readonly begrenzt = computed(() => this.total() > this.decks().length);

  /**
   * Öffnet die Seite. Geladen wird NICHT hier, sondern von der Komponente beim Erzeugen: Sie kennt
   * den aktuellen Filter, und weil app.html sie nur bei isOpen() einhängt, entsteht bei jedem
   * Öffnen eine frische Instanz - die Liste ist damit nie veraltet.
   */
  open(): void {
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }

  /**
   * Lädt die Deckköpfe - ohne Kartenlisten. Die Karten eines Decks kommen erst beim Öffnen dazu
   * (loadCards), weil sonst bei 100 Karten je Deck schon für eine Übersichtsliste zehntausende
   * Zeilen über die Leitung gingen.
   *
   * Suche und Bracket-Filter laufen in der DATENBANK, nicht im Browser. Bei den ersten fünf Decks
   * war das andersherum richtig; ab dem ersten großen Import wäre es das Gegenteil - alles zu
   * laden hieße bei 10.000 Decks rund 2 MB übers Handynetz zu ziehen, nur um daraus eine Handvoll
   * Treffer zu filtern. Die Suchspalte und ihr Index stehen in
   * sql/archidekt-pool-search-2026-09-15.sql.
   */
  async loadDecks(filter: PoolFilter): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);

    let query = supabase
      .from('archidekt_deck_pool')
      .select(
        'id, archidekt_id, name, commander_names, creator_bracket, card_count, owner_username, view_count, imported_at',
        { count: 'exact' },
      )
      .order('creator_bracket', { ascending: true })
      .order('name', { ascending: true })
      .limit(MAX_TREFFER);

    if (filter.brackets.length > 0) query = query.in('creator_bracket', filter.brackets);

    // like statt ilike: search_text ist bereits klein geschrieben, der Begriff wird es auch. Das
    // trifft denselben Trigramm-Index, spart aber das Kleinschreiben jeder Zeile zur Laufzeit.
    const begriff = suchbegriffAufbereiten(filter.search);
    if (begriff) query = query.like('search_text', `%${begriff}%`);

    const { data, error, count } = await query;

    this.loading.set(false);

    if (error || !data) {
      console.error('Konnte den Archidekt-Deckvorrat nicht laden:', error);
      this.failed.set(true);
      this.decks.set([]);
      this.total.set(0);
      return;
    }

    this.total.set(count ?? data.length);

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
