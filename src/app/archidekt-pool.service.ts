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
  /**
   * Sind alle Karten im Commander spielbar? null heisst NOCH NICHT GEPRÜFT und ist ausdrücklich
   * nicht dasselbe wie "illegal" - siehe sql/deck-pool-legality-2026-09-16.sql.
   */
  legal: boolean | null;
}

/** Eine Karte eines solchen Decks - aus archidekt_deck_pool_cardlists zusammengesetzt. */
export interface PoolCard {
  /** Name wie auf Archidekt, inklusive " // " bei doppelseitigen Karten. */
  name: string;
  quantity: number;
  isCommander: boolean;
}

/**
 * Womit die Liste gerade eingegrenzt ist.
 *
 * GENAU EINE Stufe, nicht mehrere: Der Vorrat ist dazu da, Stufen gegeneinander zu halten, und
 * dafür will man immer eine sehen. Vorher stand hier eine Mehrfachauswahl - die startete mit allen
 * fünf Stufen angehakt, sodass ein Tipp auf "2" die Stufe ABWÄHLTE statt sie auszuwählen. Genau
 * so gemeldet: "ich wähle B2 und sehe trotzdem B1".
 */
export interface PoolFilter {
  search: string;
  bracket: number;
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
  /** Treffer insgesamt laut Datenbank - kann weit über den geladenen MAX_TREFFER liegen. */
  readonly total = signal(0);
  /**
   * Wie viele der Treffer geprüft UND legal sind. null, solange die Zahl nicht vorliegt (etwa weil
   * die Migration noch nicht gelaufen ist) - dann zeigt die Ansicht gar nichts an, statt eine Null
   * zu behaupten.
   */
  readonly legalCount = signal<number | null>(null);
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
        'id, archidekt_id, name, commander_names, creator_bracket, card_count, owner_username, view_count, imported_at, legal',
        { count: 'exact' },
      )
      .order('name', { ascending: true })
      .limit(MAX_TREFFER);

    query = query.eq('creator_bracket', filter.bracket);

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
      this.legalCount.set(null);
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
        legal: row.legal ?? null,
      })),
    );

    await this.ladeLegalZahl(filter);
  }

  /**
   * Wie viele Decks dieser Auswahl sind geprüft und legal?
   *
   * Eine eigene Abfrage, weil sich das aus den geladenen Zeilen nicht ablesen lässt: Die Liste
   * zeigt höchstens MAX_TREFFER Decks, die Frage gilt aber allen Treffern. head + count holt nur
   * die Zahl, keine einzige Zeile.
   *
   * Schlägt sie fehl (etwa weil die Spalte noch nicht existiert), bleibt die Zahl null und die
   * Ansicht schweigt dazu - das ist ehrlicher als eine Null, die wie "keins legal" aussieht.
   */
  private async ladeLegalZahl(filter: PoolFilter): Promise<void> {
    let query = supabase
      .from('archidekt_deck_pool')
      .select('id', { count: 'exact', head: true })
      .eq('creator_bracket', filter.bracket)
      .eq('legal', true);

    const begriff = suchbegriffAufbereiten(filter.search);
    if (begriff) query = query.like('search_text', `%${begriff}%`);

    const { count, error } = await query;
    if (error) {
      console.error('Konnte die Zahl der legalen Decks nicht laden:', error);
      this.legalCount.set(null);
      return;
    }
    this.legalCount.set(count ?? 0);
  }

  /**
   * Die Kartenliste eines Decks. Commander zuerst, danach alphabetisch - wie in der lesbaren View.
   *
   * Zwei Abfragen statt einer, weil die Kartenliste als Zahlen-Array abgelegt ist und nicht als
   * Tabelle mit Fremdschlüssel: PostgREST kann nur über echte Beziehungen einbetten, ein int[]
   * ist keine. Also erst die Liste, dann die Namen zu den darin enthaltenen Zahlen. Bei rund 100
   * Karten je Deck sind das zwei kleine Anfragen - der Grund für das Array-Format steht in
   * sql/archidekt-pool-card-arrays-2026-09-15.sql: eine Zeile je Karte hat den Vorrat auf das
   * Siebzehnfache aufgebläht und die Datenbank an ihre Grenze gebracht.
   */
  async loadCards(deckId: string): Promise<PoolCard[] | null> {
    const { data: liste, error } = await supabase
      .from('archidekt_deck_pool_cardlists')
      .select('card_ids, quantities, commander_ids')
      .eq('deck_id', deckId)
      .maybeSingle();

    if (error) {
      console.error('Konnte die Kartenliste nicht laden:', error);
      return null;
    }
    if (!liste) return [];

    const kartenIds: number[] = liste.card_ids ?? [];
    const mengen: number[] = liste.quantities ?? [];
    const commander = new Set<number>(liste.commander_ids ?? []);

    const { data: namen, error: namenFehler } = await supabase
      .from('archidekt_pool_card_names')
      .select('id, name')
      .in('id', kartenIds);

    if (namenFehler || !namen) {
      console.error('Konnte die Kartennamen nicht laden:', namenFehler);
      return null;
    }

    const nameZuId = new Map<number, string>(namen.map((n) => [n.id, n.name]));

    return kartenIds
      .map((id, i) => ({
        name: nameZuId.get(id) ?? `#${id}`,
        quantity: mengen[i] ?? 1,
        isCommander: commander.has(id),
      }))
      .sort(
        (a, b) => Number(b.isCommander) - Number(a.isCommander) || a.name.localeCompare(b.name),
      );
  }
}
