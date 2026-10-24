import { Injectable, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { DeckService } from './deck.service';
import { VariantCard } from './deck-variants';

export interface DeckVariantInfo {
  id: string;
  name: string;
  isPrivate: boolean;
}

interface DeckCardRow {
  card_name: string;
  quantity: number;
  image_url: string | null;
  type_line: string | null;
  cmc: number | null;
  is_commander: boolean;
  is_maybeboard: boolean | null;
  is_token: boolean | null;
}

/**
 * Deck-Varianten (decks.variant_group, sql/deck-varianten-2026-10-24.sql): mehrere Fassungen
 * desselben Decks, z. B. Bracket 4 und Bracket 2/3 mit demselben Commander. Verglichen wird in
 * deck-variants.ts, angezeigt von deck-variants/ in beiden Deck-Ansichten.
 *
 * Wie beim Primer merkt sich der Service, zu WELCHEM Deck der Zustand gehört - beide Ansichten
 * teilen ihn, und bei schnellem Deck-Wechsel darf keine überholende Antwort die Anzeige
 * überschreiben. Die Kartenlisten lädt er selbst aus deck_cards, damit der Vergleich in der
 * Deck-Ansicht und im öffentlichen Stöbern derselbe ist (gespeicherter Stand, nicht der
 * ungespeicherte Bearbeiten-Entwurf).
 */
@Injectable({ providedIn: 'root' })
export class DeckVariantService {
  private readonly auth = inject(AuthService);

  /** Fehlt die Migration, verschwindet der Abschnitt beim ersten 42703 still. */
  readonly available = signal(true);
  readonly loading = signal(false);
  readonly busy = signal(false);
  /** Gesetzt, wenn Verknüpfen/Lösen fehlgeschlagen ist - i18n-Key. */
  readonly errorKey = signal<string | null>(null);

  readonly variants = signal<DeckVariantInfo[]>([]);
  /** Eigene Decks mit demselben Commander, die sich noch verknüpfen lassen (nur für den Besitzer). */
  readonly candidates = signal<DeckVariantInfo[]>([]);
  readonly thisCards = signal<VariantCard[]>([]);
  /** Kartenlisten der Varianten, je Deck-ID - einmal geladen, dann gemerkt. */
  readonly otherCards = signal<ReadonlyMap<string, VariantCard[]>>(new Map());

  private loadedDeckId: string | null = null;
  private group: string | null = null;

  async load(deckId: string, ownerUserId: string | null): Promise<void> {
    this.loadedDeckId = deckId;
    this.group = null;
    this.variants.set([]);
    this.candidates.set([]);
    this.thisCards.set([]);
    this.otherCards.set(new Map());
    this.errorKey.set(null);
    if (!this.available()) return;

    this.loading.set(true);
    const { data, error } = await supabase
      .from('decks')
      .select('variant_group')
      .eq('id', deckId)
      .maybeSingle();
    if (this.loadedDeckId !== deckId) return;
    if (error) {
      this.loading.set(false);
      if (error.code === '42703') this.available.set(false);
      else console.error('Konnte Deck-Varianten nicht laden:', error);
      return;
    }
    this.group = (data as { variant_group: string | null } | null)?.variant_group ?? null;

    const isOwner = !!ownerUserId && this.auth.currentUser()?.id === ownerUserId;
    const [variants, cards, candidates] = await Promise.all([
      this.loadVariants(deckId, this.group),
      this.loadCards(deckId),
      isOwner ? this.loadCandidates(deckId, ownerUserId!, this.group) : Promise.resolve([]),
    ]);
    if (this.loadedDeckId !== deckId) return;
    this.variants.set(variants);
    this.thisCards.set(cards);
    this.candidates.set(candidates);
    this.loading.set(false);
  }

  async ensureOtherCards(otherId: string): Promise<void> {
    if (this.otherCards().has(otherId)) return;
    const deckId = this.loadedDeckId;
    const cards = await this.loadCards(otherId);
    if (this.loadedDeckId !== deckId) return;
    this.otherCards.update((m) => new Map(m).set(otherId, cards));
  }

  /**
   * Verknüpft das andere Deck mit diesem. Hat eines schon eine Gruppe, kommt das andere dazu;
   * haben beide eine, wandert die ganze Gruppe des anderen herüber - Varianten von Varianten sind
   * Varianten.
   */
  async link(deckId: string, otherId: string, ownerUserId: string): Promise<void> {
    this.busy.set(true);
    this.errorKey.set(null);
    try {
      const { data, error } = await supabase
        .from('decks')
        .select('id, variant_group')
        .in('id', [deckId, otherId]);
      if (error) throw error;
      const groupOf = (id: string) =>
        (data as { id: string; variant_group: string | null }[]).find((d) => d.id === id)
          ?.variant_group ?? null;
      const mine = groupOf(deckId);
      const theirs = groupOf(otherId);
      const target = mine ?? theirs ?? crypto.randomUUID();

      if (theirs && theirs !== target) {
        await this.setGroup(
          supabase.from('decks').update({ variant_group: target }).eq('variant_group', theirs),
        );
      }
      await this.setGroup(
        supabase.from('decks').update({ variant_group: target }).in('id', [deckId, otherId]),
      );
      await this.load(deckId, ownerUserId);
    } catch (e) {
      console.error('Konnte Decks nicht als Varianten verknüpfen:', e);
      this.errorKey.set('deckView.variants.linkFailed');
    } finally {
      this.busy.set(false);
    }
  }

  /** Nimmt dieses Deck aus seiner Gruppe. Bleibt danach nur ein Deck übrig, ist auch das keine Variante mehr. */
  async unlink(deckId: string, ownerUserId: string): Promise<void> {
    const group = this.group;
    if (!group) return;
    this.busy.set(true);
    this.errorKey.set(null);
    try {
      await this.setGroup(supabase.from('decks').update({ variant_group: null }).eq('id', deckId));
      const { data } = await supabase.from('decks').select('id').eq('variant_group', group);
      if (data && data.length === 1) {
        await this.setGroup(
          supabase.from('decks').update({ variant_group: null }).eq('id', data[0].id),
        );
      }
      await this.load(deckId, ownerUserId);
    } catch (e) {
      console.error('Konnte Variante nicht lösen:', e);
      this.errorKey.set('deckView.variants.linkFailed');
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Ohne Schreibrecht meldet Postgres keinen Fehler, sondern ändert einfach keine Zeile - deshalb
   * mit .select() prüfen, ob wirklich etwas geschrieben wurde (wie MtgService.linkCube()).
   */
  private async setGroup(
    query: PromiseLike<unknown> & {
      select(cols: string): PromiseLike<{ data: unknown[] | null; error: unknown }>;
    },
  ): Promise<void> {
    const { data, error } = await query.select('id');
    if (error) throw error;
    if (!data || data.length === 0)
      throw new Error('Keine Zeile geändert (fehlendes Schreibrecht?)');
  }

  private async loadVariants(deckId: string, group: string | null): Promise<DeckVariantInfo[]> {
    if (!group) return [];
    const { data, error } = await DeckService.nurLebende(
      supabase
        .from('decks')
        .select('id, name, is_private')
        .eq('variant_group', group)
        .neq('id', deckId),
    ).order('name');
    if (error) {
      console.error('Konnte Deck-Varianten nicht laden:', error);
      return [];
    }
    return (data as { id: string; name: string; is_private: boolean | null }[]).map((d) => ({
      id: d.id,
      name: d.name,
      isPrivate: !!d.is_private,
    }));
  }

  /** Eigene Decks mit genau denselben Commandern, die nicht schon in dieser Gruppe sind. */
  private async loadCandidates(
    deckId: string,
    ownerUserId: string,
    group: string | null,
  ): Promise<DeckVariantInfo[]> {
    const { data, error } = await supabase
      .from('deck_cards')
      .select('deck_id, card_name, decks!inner ( id, name, user_id, is_private, variant_group )')
      .eq('is_commander', true)
      .eq('decks.user_id', ownerUserId);
    if (error) {
      console.error('Konnte mögliche Deck-Varianten nicht laden:', error);
      return [];
    }
    type Row = {
      deck_id: string;
      card_name: string;
      decks: { id: string; name: string; is_private: boolean | null; variant_group: string | null };
    };
    const commanders = new Map<string, Set<string>>();
    const decks = new Map<string, Row['decks']>();
    for (const row of data as unknown as Row[]) {
      if (!commanders.has(row.deck_id)) commanders.set(row.deck_id, new Set());
      commanders.get(row.deck_id)!.add(row.card_name.toLowerCase());
      decks.set(row.deck_id, row.decks);
    }
    const mine = commanders.get(deckId);
    if (!mine || mine.size === 0) return [];
    const sameCommanders = (other: Set<string>) =>
      other.size === mine.size && [...other].every((n) => mine.has(n));

    return [...commanders.entries()]
      .filter(
        ([id, set]) =>
          id !== deckId &&
          sameCommanders(set) &&
          (!group || decks.get(id)!.variant_group !== group),
      )
      .map(([id]) => ({ id, name: decks.get(id)!.name, isPrivate: !!decks.get(id)!.is_private }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async loadCards(deckId: string): Promise<VariantCard[]> {
    const { data, error } = await supabase
      .from('deck_cards')
      .select(
        'card_name, quantity, image_url, type_line, cmc, is_commander, is_maybeboard, is_token',
      )
      .eq('deck_id', deckId);
    if (error) {
      console.error('Konnte Kartenliste der Variante nicht laden:', error);
      return [];
    }
    return (data as DeckCardRow[]).map((r) => ({
      cardName: r.card_name,
      quantity: r.quantity,
      imageUrl: r.image_url,
      typeLine: r.type_line,
      cmc: r.cmc ?? 0,
      isCommander: r.is_commander,
      isMaybeboard: !!r.is_maybeboard,
      isToken: !!r.is_token,
    }));
  }
}
