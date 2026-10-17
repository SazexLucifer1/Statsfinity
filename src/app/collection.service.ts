import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { ScryfallService } from './scryfall.service';
import {
  CollectionEntry,
  CollectionPrint,
  DeckUsage,
  collectionKey,
  printImageUrl,
} from './collection-coverage';

/**
 * Kartensammlung (Profil -> Reiter "Sammlung", Scanner, Abgleich in der Deck-Ansicht).
 * Tabelle und Begründung der schlanken Form: sql/sammlung-2026-10-17.sql.
 *
 * Kartendaten (Bild, gedruckter Name, Setname) kommen NICHT aus der Datenbank, sondern bei Bedarf
 * von Scryfall - das Bild lässt sich ohnehin aus der Druck-ID bauen. Fehlt die Migration, schaltet
 * sich alles beim ersten 42P01/PGRST205 still ab (`available`).
 */

/** Was Scryfall je Druck zusätzlich weiß (siehe printInfo()). */
export interface PrintInfo {
  illustrationId: string | null;
  rarity: string | null;
  setName: string | null;
  eur: number | null;
  eurFoil: number | null;
}

const SELECT =
  'scryfall_id, foil, card_name, lang, set_code, collector_number, illustration_id, quantity, added_at';
const API = 'https://api.scryfall.com';

export function toCollectionPrint(c: any): CollectionPrint {
  const face = c.card_faces?.[0];
  return {
    scryfallId: c.id,
    cardName: c.name,
    printedName: c.printed_name ?? face?.printed_name ?? null,
    lang: c.lang ?? 'en',
    setCode: c.set ?? '',
    setName: c.set_name ?? '',
    collectorNumber: c.collector_number ?? '',
    illustrationId: c.illustration_id ?? face?.illustration_id ?? null,
    imageUrl: c.image_uris?.normal ?? face?.image_uris?.normal ?? printImageUrl(c.id),
    finishes: c.finishes ?? ['nonfoil'],
  };
}

function fromRow(row: any): CollectionEntry {
  return {
    scryfallId: row.scryfall_id,
    foil: !!row.foil,
    cardName: row.card_name,
    lang: row.lang,
    setCode: row.set_code ?? '',
    collectorNumber: row.collector_number ?? '',
    illustrationId: row.illustration_id ?? null,
    quantity: row.quantity,
    addedAt: row.added_at,
  };
}

function isMissingMigration(error: { code?: string } | null): boolean {
  return !!error && ['42P01', 'PGRST205', 'PGRST202', '42883'].includes(error.code ?? '');
}

@Injectable({ providedIn: 'root' })
export class CollectionService {
  private readonly auth = inject(AuthService);
  private readonly scryfall = inject(ScryfallService);

  readonly available = signal(true);
  /** Eigene Sammlung; null = noch nicht geladen. */
  readonly entries = signal<CollectionEntry[] | null>(null);
  readonly loading = signal(false);
  /** Karten der eigenen Decks; null = noch nicht geladen. */
  readonly deckUsage = signal<DeckUsage[] | null>(null);

  private loadedFor: string | null = null;

  /**
   * Offene Vollbild-Ansicht der Sammlung (collection-view/): null = zu, `userId` null = die eigene.
   * Wie die Deck-Ansicht eine eigene Seite statt eines Reiters im Profil (Wunsch des Users,
   * 18.10.2026: die Sammlung braucht mehr Platz).
   */
  readonly view = signal<{ userId: string | null; name: string | null } | null>(null);

  openView(userId: string | null = null, name: string | null = null): void {
    this.view.set({ userId, name });
  }

  closeView(): void {
    this.view.set(null);
  }

  /** Besitz je Kartenname (normalisierte Vorderseite). */
  readonly ownedByName = computed(() => {
    const map = new Map<string, CollectionEntry[]>();
    for (const e of this.entries() ?? []) {
      const key = collectionKey(e.cardName);
      const list = map.get(key);
      if (list) list.push(e);
      else map.set(key, [e]);
    }
    return map;
  });

  readonly totalCards = computed(() =>
    (this.entries() ?? []).reduce((sum, e) => sum + e.quantity, 0),
  );

  constructor() {
    // Bei Kontowechsel die fremde Sammlung sofort vergessen.
    effect(() => {
      const uid = this.auth.currentUser()?.id ?? null;
      if (uid !== this.loadedFor) {
        this.entries.set(null);
        this.deckUsage.set(null);
        this.loadedFor = null;
        this.view.set(null);
      }
    });
  }

  /** Lädt die eigene Sammlung einmal je Konto. */
  async ensureLoaded(): Promise<void> {
    const uid = this.auth.currentUser()?.id;
    if (!uid || !this.available() || this.loadedFor === uid || this.loading()) return;
    this.loading.set(true);
    const rows = await this.fetchAll(uid);
    this.loading.set(false);
    if (rows) {
      this.loadedFor = uid;
      this.entries.set(rows);
    }
  }

  /** Sammlung eines Freundes (RLS lässt nur Freunde durch, sonst kommt eine leere Liste). */
  async loadFor(userId: string): Promise<CollectionEntry[]> {
    if (!this.available()) return [];
    return (await this.fetchAll(userId)) ?? [];
  }

  private async fetchAll(userId: string): Promise<CollectionEntry[] | null> {
    const all: CollectionEntry[] = [];
    // In Seiten zu 1000 - so viele liefert PostgREST höchstens auf einmal.
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from('collection_cards')
        .select(SELECT)
        .eq('user_id', userId)
        .order('added_at', { ascending: false })
        .range(from, from + 999);
      if (error) {
        if (isMissingMigration(error)) this.available.set(false);
        else console.error('Konnte Sammlung nicht laden:', error);
        return null;
      }
      all.push(...(data ?? []).map(fromRow));
      if (!data || data.length < 1000) return all;
    }
  }

  quantityOf(scryfallId: string, foil: boolean): number {
    return (
      this.entries()?.find((e) => e.scryfallId === scryfallId && e.foil === foil)?.quantity ?? 0
    );
  }

  /** Ändert die Anzahl eines Drucks um `delta`; bei 0 verschwindet die Zeile. */
  async add(print: CollectionPrint | CollectionEntry, foil: boolean, delta = 1): Promise<boolean> {
    await this.ensureLoaded();
    const uid = this.auth.currentUser()?.id;
    if (!uid || !this.available()) return false;
    const current = this.quantityOf(print.scryfallId, foil);
    return this.setQuantity(print, foil, Math.min(999, current + delta));
  }

  async setQuantity(
    print: CollectionPrint | CollectionEntry,
    foil: boolean,
    quantity: number,
  ): Promise<boolean> {
    const uid = this.auth.currentUser()?.id;
    if (!uid) return false;
    const before = this.entries() ?? [];
    const existing = before.find((e) => e.scryfallId === print.scryfallId && e.foil === foil);

    if (quantity <= 0) {
      this.entries.set(before.filter((e) => e !== existing));
      const { error } = await supabase
        .from('collection_cards')
        .delete()
        .eq('user_id', uid)
        .eq('scryfall_id', print.scryfallId)
        .eq('foil', foil);
      if (error) {
        console.error('Konnte Karte nicht aus der Sammlung nehmen:', error);
        this.entries.set(before);
        return false;
      }
      return true;
    }

    const entry: CollectionEntry = existing
      ? { ...existing, quantity }
      : {
          scryfallId: print.scryfallId,
          foil,
          cardName: print.cardName,
          lang: print.lang,
          setCode: print.setCode,
          collectorNumber: print.collectorNumber,
          illustrationId: print.illustrationId,
          quantity,
          addedAt: new Date().toISOString(),
        };
    // Sofort anzeigen, beim Fehler zurückrollen - beim Scannen soll nichts auf die Datenbank warten.
    this.entries.set(
      existing ? before.map((e) => (e === existing ? entry : e)) : [entry, ...before],
    );
    const { error } = await supabase.from('collection_cards').upsert({
      user_id: uid,
      scryfall_id: entry.scryfallId,
      foil,
      card_name: entry.cardName,
      lang: entry.lang,
      set_code: entry.setCode,
      collector_number: entry.collectorNumber,
      illustration_id: entry.illustrationId,
      quantity,
    });
    if (error) {
      if (isMissingMigration(error)) this.available.set(false);
      console.error('Konnte Sammlung nicht speichern:', error);
      this.entries.set(before);
      return false;
    }
    return true;
  }

  /** Karten aller eigenen Decks (für "brauchst du in mehreren Decks"). */
  async ensureDeckUsage(force = false): Promise<void> {
    if (!this.auth.currentUser() || !this.available()) return;
    if (this.deckUsage() && !force) return;
    const { data, error } = await supabase.rpc('collection_deck_usage');
    if (error) {
      if (isMissingMigration(error)) this.available.set(false);
      else console.error('Konnte Deck-Nutzung nicht laden:', error);
      return;
    }
    this.deckUsage.set(
      ((data as unknown[][] | null) ?? []).map((r) => ({
        deckId: r[0] as string,
        deckName: r[1] as string,
        cardName: r[2] as string,
        quantity: r[3] as number,
        imageUrl: (r[4] as string | null) ?? null,
      })),
    );
  }

  // --- Scryfall --------------------------------------------------------------------------

  /** Namensvorschläge beim Hinzufügen; ohne englischen Treffer auch über gedruckte Namen. */
  async suggestNames(query: string): Promise<string[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const res = await this.scryfall.fetchWithRetry(
      `${API}/cards/autocomplete?q=${encodeURIComponent(q)}`,
      1,
    );
    const names: string[] = res?.ok ? ((await res.json()).data ?? []) : [];
    if (names.length > 0) return names.slice(0, 12);
    const safe = q.replace(/"/g, '');
    const search = await this.scryfall.fetchWithRetry(
      `${API}/cards/search?q=${encodeURIComponent(`lang:any name:"${safe}"`)}&unique=cards&include_multilingual=true`,
      1,
    );
    if (!search?.ok) return [];
    const data = await search.json();
    return [...new Set(((data.data as any[]) ?? []).map((c) => c.name as string))].slice(0, 12);
  }

  /** Alle Papier-Drucke einer Karte in allen Sprachen, neueste zuerst (höchstens 4 Seiten). */
  async printsOf(cardName: string): Promise<CollectionPrint[]> {
    const safe = cardName.replace(/"/g, '');
    let url: string | null =
      `${API}/cards/search?q=${encodeURIComponent(`!"${safe}" -is:digital include:extras`)}` +
      `&unique=prints&include_multilingual=true&order=released&dir=desc`;
    const prints: CollectionPrint[] = [];
    for (let page = 0; url && page < 4; page++) {
      const res = await this.scryfall.fetchWithRetry(url, 1);
      if (!res?.ok) break;
      const data = await res.json();
      prints.push(...((data.data as any[]) ?? []).map(toCollectionPrint));
      url = data.has_more ? data.next_page : null;
    }
    return prints;
  }

  /**
   * Angaben je Druck, die nur Scryfall kennt (Seltenheit, Setname, Preise, illustration_id) -
   * gebündelt zu je 75 über /cards/collection, im Sitzungs-Cache. Bewusst nicht in der Datenbank:
   * Preise ändern sich täglich, und die Sammlungs-Tabelle soll klein bleiben.
   */
  private readonly printInfoCache = new Map<string, PrintInfo | null>();
  async printInfo(
    ids: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, PrintInfo | null>> {
    const open = [...new Set(ids)].filter((id) => !this.printInfoCache.has(id));
    for (let i = 0; i < open.length; i += 75) {
      onProgress?.(i, open.length);
      const chunk = open.slice(i, i + 75);
      const res = await this.scryfall.fetchWithRetry(`${API}/cards/collection`, 1, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: chunk.map((id) => ({ id })) }),
      });
      if (!res?.ok) continue;
      const data = await res.json();
      for (const c of (data.data as any[]) ?? []) {
        const eur = parseFloat(c.prices?.eur);
        const eurFoil = parseFloat(c.prices?.eur_foil);
        this.printInfoCache.set(c.id, {
          illustrationId: c.illustration_id ?? c.card_faces?.[0]?.illustration_id ?? null,
          rarity: c.rarity ?? null,
          setName: c.set_name ?? null,
          eur: Number.isNaN(eur) ? null : eur,
          eurFoil: Number.isNaN(eurFoil) ? null : eurFoil,
        });
      }
      for (const id of chunk) if (!this.printInfoCache.has(id)) this.printInfoCache.set(id, null);
    }
    onProgress?.(open.length, open.length);
    return new Map(ids.map((id) => [id, this.printInfoCache.get(id) ?? null]));
  }

  /** illustration_id je Scryfall-ID (für die strenge Artwork-Prüfung). */
  async illustrationsOf(ids: string[]): Promise<Map<string, string | null>> {
    const info = await this.printInfo(ids);
    return new Map(ids.map((id) => [id, info.get(id)?.illustrationId ?? null]));
  }
}
