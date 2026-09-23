import { Injectable, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { normalizeCardName } from './array-utils';

/** 'banned' = gar nicht erlaubt, 'restricted' = höchstens ein Exemplar (nur Vintage). */
export type BanStatus = 'banned' | 'restricted';

/** Was die Prüfung von einer Karte braucht - DeckCard (eigene Decks) und die Einträge des öffentlichen Stöberns passen beide. */
export interface BanCheckCard {
  cardName: string;
  quantity: number;
  isMaybeboard?: boolean;
  isToken?: boolean;
}

/** Name vor " // ", normalisiert - derselbe Schlüssel wie format_banlist.name_normalized. */
function banKey(cardName: string): string {
  return normalizeCardName(cardName.split(' // ')[0].trim());
}

/**
 * Bannlisten je Spielformat (sql/format-bannliste-2026-09-23.sql, nächtlich aus Scryfall
 * abgeglichen von scripts/sync-scryfall-bulk.js).
 *
 * Zwei Wege, weil die beiden Stellen Unterschiedliches wissen:
 * - Die Deckliste (deck-list) hat nur Decks, keine Kartenlisten. Sie fragt über
 *   deck_banned_cards(ids) eine ganze Seite in EINER Anfrage ab und zeigt ein rotes Ausrufezeichen.
 *   Das öffentliche Stöbern (public-deck-browser) macht es für seine Kacheln genauso.
 * - Die Deck-Ansichten (deck-detail-view, public-deck-browser) haben die Karten schon geladen, und
 *   die eigene muss auch während des Bearbeitens stimmen. Sie laden die Bannliste des Formats (ein
 *   paar Dutzend Namen) und prüfen selbst - eine Serverabfrage kennte nur den gespeicherten Stand.
 *
 * Die Regel steht damit zweimal (hier und in der SQL-Funktion): nicht mitgezählt werden Maybeboard
 * und Marken, eine beschränkte Karte zählt erst ab dem zweiten Exemplar.
 */
@Injectable({ providedIn: 'root' })
export class BanlistService {
  /** Deck-ID → verbotene Karten. Fehlender Eintrag = noch nicht geprüft, leeres Array = sauber. */
  readonly deckViolations = signal<ReadonlyMap<string, string[]>>(new Map());

  /** Format → (normalisierter Name → Status). Einmal je Sitzung geladen. */
  readonly formatLists = signal<ReadonlyMap<string, ReadonlyMap<string, BanStatus>>>(new Map());

  /** Fehlt die Migration noch, verschwindet die Prüfung still - gleiche Haltung wie bei Likes. */
  private verfuegbar = true;
  private readonly laufendeFormate = new Set<string>();

  violationsFor(deckId: string): string[] {
    return this.deckViolations().get(deckId) ?? [];
  }

  /** Prüft die gegebenen Decks serverseitig (eine Anfrage für alle). */
  async loadForDecks(deckIds: string[]): Promise<void> {
    const ids = [...new Set(deckIds)].filter(Boolean);
    if (!this.verfuegbar || ids.length === 0) return;

    const { data, error } = await supabase.rpc('deck_banned_cards', { p_deck_ids: ids });
    if (error) {
      if (!this.istFehlendeMigration(error)) console.error('Konnte Bannliste nicht prüfen:', error);
      return;
    }

    const next = new Map(this.deckViolations());
    for (const id of ids) next.set(id, []);
    for (const row of (data as { deck_id: string; card_name: string }[] | null) ?? []) {
      next.get(row.deck_id)?.push(row.card_name);
    }
    for (const id of ids) next.get(id)?.sort((a, b) => a.localeCompare(b));
    this.deckViolations.set(next);
  }

  /** Lädt die Bannliste eines Formats (einmal je Sitzung). */
  async loadFormat(format: string | null): Promise<void> {
    if (!format || !this.verfuegbar) return;
    if (this.formatLists().has(format) || this.laufendeFormate.has(format)) return;
    this.laufendeFormate.add(format);
    try {
      const { data, error } = await supabase
        .from('format_banlist')
        .select('name_normalized, status')
        .eq('format', format);
      if (error) {
        if (!this.istFehlendeMigration(error))
          console.error('Konnte Bannliste nicht laden:', error);
        return;
      }
      const liste = new Map<string, BanStatus>();
      for (const row of (data as { name_normalized: string; status: BanStatus }[] | null) ?? []) {
        liste.set(row.name_normalized, row.status);
      }
      this.formatLists.set(new Map(this.formatLists()).set(format, liste));
    } finally {
      this.laufendeFormate.delete(format);
    }
  }

  /**
   * Verbotene Karten eines Decks im gegebenen Format: Kartenname → Status. Leer, solange die
   * Bannliste des Formats nicht geladen ist (siehe loadFormat()).
   */
  violationsIn(format: string | null, cards: BanCheckCard[]): Map<string, BanStatus> {
    const result = new Map<string, BanStatus>();
    const liste = format ? this.formatLists().get(format) : undefined;
    if (!liste || liste.size === 0) return result;

    const mengen = new Map<string, { names: string[]; qty: number; status: BanStatus }>();
    for (const card of cards) {
      if (card.isMaybeboard || card.isToken) continue;
      const key = banKey(card.cardName);
      const status = liste.get(key);
      if (!status) continue;
      const eintrag = mengen.get(key) ?? { names: [], qty: 0, status };
      eintrag.names.push(card.cardName);
      eintrag.qty += card.quantity;
      mengen.set(key, eintrag);
    }
    for (const { names, qty, status } of mengen.values()) {
      if (status === 'restricted' && qty <= 1) continue;
      for (const name of names) result.set(name, status);
    }
    return result;
  }

  private istFehlendeMigration(error: { code?: string }): boolean {
    // PGRST202/42883 = Funktion fehlt, PGRST205/42P01 = Tabelle fehlt.
    if (!['PGRST202', '42883', 'PGRST205', '42P01'].includes(error.code ?? '')) return false;
    console.warn(
      'Bannliste fehlt noch - sql/format-bannliste-2026-09-23.sql im Supabase-SQL-Editor ausführen.',
    );
    this.verfuegbar = false;
    return true;
  }
}
