import { Injectable, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { normalizeCardName } from './array-utils';
import { I18nService } from './i18n.service';
import {
  KartenzahlFehler,
  eigeneKopienGrenze,
  kartenzahlFehler,
  regelFuer,
  zuVieleKopien,
} from './deck-regeln';

/** 'banned' = gar nicht erlaubt, 'restricted' = höchstens ein Exemplar (nur Vintage). */
export type BanStatus = 'banned' | 'restricted';

/** Was die Prüfung von einer Karte braucht - DeckCard (eigene Decks) und die Einträge des öffentlichen Stöberns passen beide. */
export interface BanCheckCard {
  cardName: string;
  quantity: number;
  isMaybeboard?: boolean;
  isToken?: boolean;
  /** Für die Kopien-Regel: Standardländer dürfen beliebig oft. */
  typeLine?: string | null;
  /** Für die Kopien-Regel: „A deck can have any number of cards named …". */
  oracleText?: string | null;
}

/** Ergebnis der Prüfung einer geladenen Kartenliste (Deck-Ansichten). */
export interface DeckPruefung {
  /** Kartennamen, die rot markiert werden: gebannt oder zu oft im Deck. */
  markiert: ReadonlySet<string>;
  /** Hinweiszeilen über der Kartenliste, leer = alles in Ordnung. */
  texte: string[];
}

/** Was deck_rule_facts() je Deck liefert (sql/deck-regeln-2026-09-23.sql). */
interface RegelFakten {
  anzahl: number;
  kopien: { name: string; qty: number; grenze: number | null | undefined }[];
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
 *
 * Dazu die Bauregeln des Formats (deck-regeln.ts): Kartenzahl und Kopien. Für Listen liefert
 * deck_rule_facts() nur Fakten, die Grenzen selbst stehen ausschließlich in FORMAT_REGELN.
 */
@Injectable({ providedIn: 'root' })
export class BanlistService {
  /** Deck-ID → verbotene Karten. Fehlender Eintrag = noch nicht geprüft, leeres Array = sauber. */
  readonly deckViolations = signal<ReadonlyMap<string, string[]>>(new Map());

  /** Format → (normalisierter Name → Status). Einmal je Sitzung geladen. */
  readonly formatLists = signal<ReadonlyMap<string, ReadonlyMap<string, BanStatus>>>(new Map());

  /** Deck-ID → Kartenzahl und mehrfach vorhandene Karten (deck_rule_facts). */
  private readonly regelFakten = signal<ReadonlyMap<string, RegelFakten>>(new Map());

  private readonly i18n = inject(I18nService);

  /** Fehlt die Migration noch, verschwindet die Prüfung still - gleiche Haltung wie bei Likes. */
  private verfuegbar = true;
  /** Dasselbe für deck_rule_facts() - eine eigene Migration, die fehlen kann, während die Bannliste schon läuft. */
  private regelnVerfuegbar = true;
  private readonly laufendeFormate = new Set<string>();

  violationsFor(deckId: string): string[] {
    return this.deckViolations().get(deckId) ?? [];
  }

  /**
   * Alle Probleme eines Decks als Hinweiszeilen für Listen (Deckliste, Kacheln im Stöbern): gebannte
   * Karten, falsche Kartenzahl, zu viele Kopien. Leer = nichts gefunden oder noch nicht geprüft.
   */
  problemsFor(deckId: string, format: string | null): string[] {
    const texte: string[] = [];
    const gebannt = this.violationsFor(deckId);
    if (gebannt.length > 0) {
      texte.push(
        this.i18n.t('deck.bannedBadge', { format: format ?? '', cards: gebannt.join(', ') }),
      );
    }
    const fakten = this.regelFakten().get(deckId);
    if (fakten && regelFuer(format)) {
      const zahl = kartenzahlFehler(format, fakten.anzahl);
      if (zahl) texte.push(this.kartenzahlText(format, zahl));
      const kopien = fakten.kopien.filter((k) => zuVieleKopien(format, k.qty, k.grenze));
      if (kopien.length > 0) texte.push(this.kopienText(format, kopien));
    }
    return texte;
  }

  /** Lädt Bannliste UND Bauregel-Fakten für die gegebenen Decks (je eine Anfrage für alle). */
  async loadForDecks(deckIds: string[]): Promise<void> {
    await Promise.all([this.loadBanned(deckIds), this.loadRegelFakten(deckIds)]);
  }

  private async loadRegelFakten(deckIds: string[]): Promise<void> {
    const ids = [...new Set(deckIds)].filter(Boolean);
    if (!this.regelnVerfuegbar || ids.length === 0) return;

    const { data, error } = await supabase.rpc('deck_rule_facts', { p_deck_ids: ids });
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') {
        console.warn(
          'Bauregeln fehlen noch - sql/deck-regeln-2026-09-23.sql im Supabase-SQL-Editor ausführen.',
        );
        this.regelnVerfuegbar = false;
      } else {
        console.error('Konnte Bauregeln nicht prüfen:', error);
      }
      return;
    }

    type Zeile = {
      deck_id: string;
      card_count: number;
      copies: { name: string; qty: number; limit: number | null }[] | null;
    };
    const next = new Map(this.regelFakten());
    for (const row of (data as Zeile[] | null) ?? []) {
      next.set(row.deck_id, {
        anzahl: Number(row.card_count) || 0,
        // -1 = beliebig viele erlaubt, null = Grenze des Formats (siehe die SQL-Datei).
        kopien: (row.copies ?? []).map((k) => ({
          name: k.name,
          qty: k.qty,
          grenze: k.limit === -1 ? null : (k.limit ?? undefined),
        })),
      });
    }
    this.regelFakten.set(next);
  }

  private async loadBanned(deckIds: string[]): Promise<void> {
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

  /**
   * Prüft eine geladene Kartenliste (Deck-Ansichten) gegen Bannliste und Bauregeln des Formats.
   * Die Bannliste muss vorher über loadFormat() geladen sein, die Bauregeln brauchen nichts.
   */
  pruefe(format: string | null, cards: BanCheckCard[]): DeckPruefung {
    const markiert = new Set<string>();
    const texte: string[] = [];

    const gebannt = this.violationsIn(format, cards);
    if (gebannt.size > 0) {
      for (const name of gebannt.keys()) markiert.add(name);
      const liste = [...gebannt]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, status]) =>
          status === 'restricted' ? `${name} ${this.i18n.t('deckView.restrictedSuffix')}` : name,
        )
        .join(', ');
      texte.push(this.i18n.t('deckView.bannedNotice', { format: format ?? '', cards: liste }));
    }

    if (!regelFuer(format)) return { markiert, texte };

    const haupt = cards.filter((c) => !c.isMaybeboard && !c.isToken);
    const zahl = kartenzahlFehler(
      format,
      haupt.reduce((sum, c) => sum + c.quantity, 0),
    );
    if (zahl) texte.push(this.kartenzahlText(format, zahl));

    // Gleichnamige Karten (auch verschiedene Drucke) zusammen zählen, wie die SQL-Funktion.
    const gruppen = new Map<
      string,
      { names: string[]; qty: number; grenze: number | null | undefined }
    >();
    for (const c of haupt) {
      const key = banKey(c.cardName);
      const g = gruppen.get(key) ?? { names: [], qty: 0, grenze: undefined };
      g.names.push(c.cardName);
      g.qty += c.quantity;
      const eigene = eigeneKopienGrenze(c.typeLine, c.oracleText);
      if (eigene !== undefined) g.grenze = eigene;
      gruppen.set(key, g);
    }
    const kopien: { name: string; qty: number }[] = [];
    for (const g of gruppen.values()) {
      if (!zuVieleKopien(format, g.qty, g.grenze)) continue;
      for (const name of g.names) markiert.add(name);
      kopien.push({ name: g.names[0], qty: g.qty });
    }
    if (kopien.length > 0) {
      texte.push(
        this.kopienText(
          format,
          kopien.sort((a, b) => a.name.localeCompare(b.name)),
        ),
      );
    }

    return { markiert, texte };
  }

  private kartenzahlText(format: string | null, f: KartenzahlFehler): string {
    const key = {
      genau: 'deck.ruleCountExact',
      min: 'deck.ruleCountMin',
      max: 'deck.ruleCountMax',
    }[f.art];
    return this.i18n.t(key, { format: format ?? '', ist: String(f.ist), soll: String(f.soll) });
  }

  private kopienText(format: string | null, kopien: { name: string; qty: number }[]): string {
    return this.i18n.t('deck.ruleCopies', {
      format: format ?? '',
      cards: kopien.map((k) => `${k.name} (${k.qty}×)`).join(', '),
    });
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
