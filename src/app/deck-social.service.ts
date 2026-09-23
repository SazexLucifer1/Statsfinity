import { Injectable, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';

/** Aufrufe und Likes eines Decks, wie deck_social_stats() sie liefert. */
export interface DeckSocialStats {
  /** Wie oft andere Leute das Deck geöffnet haben - der Besitzer zählt nicht mit. */
  views: number;
  likes: number;
  /** Ob der eingeloggte Nutzer selbst geliket hat. Ohne Login immer false. */
  likedByMe: boolean;
  /** Anzeigename des Besitzers (Account oder Spieler ohne Login) - null, wenn keiner hinterlegt ist. */
  ownerName: string | null;
}

/**
 * Aufrufe und Likes unter einem Deck (sql/deck-aufrufe-likes-2026-09-22.sql). Gezeigt an drei
 * Stellen: in der Deck-Ansicht (deck-detail-view), im öffentlichen Stöbern (public-deck-browser)
 * und kompakt in der Deckliste (deck-list, u. a. „Meine Decks" im Profil). Die Zahlen liegen
 * deshalb hier in EINER Tabelle je Deck-ID und nicht in den Komponenten: ein Like in der
 * Deck-Ansicht soll beim Zurückgehen auch in der Liste schon stimmen.
 *
 * Gelesen wird gebündelt über deck_social_stats(ids) - die Deckliste fragt eine Seite Decks mit
 * einer einzigen Anfrage ab statt einmal je Zeile.
 */
@Injectable({ providedIn: 'root' })
export class DeckSocialService {
  private readonly auth = inject(AuthService);

  /** Deck-ID → Zahlen. Ein fehlender Eintrag heißt „noch nicht geladen", nicht „0". */
  readonly stats = signal<ReadonlyMap<string, DeckSocialStats>>(new Map());

  /** Decks, für die gerade ein Like/Unlike unterwegs ist - gegen Doppeltippen. */
  readonly busy = signal<ReadonlySet<string>>(new Set());

  /**
   * Fehlt die Migration noch, verschwinden Aufrufe und Likes still, statt unter jedem Deck eine
   * Fehlermeldung zu zeigen - gleiche Haltung wie bei den Deck-Kommentaren.
   */
  readonly verfuegbar = signal(true);

  /**
   * In dieser Sitzung schon gezählte Decks. Wer ein Deck öffnet, zurückgeht und es wieder öffnet,
   * hat es einmal angesehen, nicht zweimal. Bewusst nur im Speicher: nach einem Neuladen zählt
   * derselbe Besuch neu - eine Schranke gegen absichtliches Hochtreiben ist das ohnehin nicht.
   */
  private readonly gezaehlt = new Set<string>();

  statsFor(deckId: string): DeckSocialStats | null {
    return this.stats().get(deckId) ?? null;
  }

  /** Lädt die Zahlen für die gegebenen Decks nach (bereits geladene werden aufgefrischt). */
  async load(deckIds: string[]): Promise<void> {
    const ids = [...new Set(deckIds)].filter(Boolean);
    if (!this.verfuegbar() || ids.length === 0) return;

    const { data, error } = await supabase.rpc('deck_social_stats', { p_deck_ids: ids });
    if (error) {
      if (this.istFehlendeMigration(error)) return;
      console.error('Konnte Aufrufe/Likes nicht laden:', error);
      return;
    }

    const next = new Map(this.stats());
    for (const row of (data as SocialRow[] | null) ?? []) {
      next.set(row.deck_id, {
        views: Number(row.views) || 0,
        likes: Number(row.likes) || 0,
        likedByMe: row.liked_by_me === true,
        ownerName: row.owner_name?.trim() || null,
      });
    }
    this.stats.set(next);
  }

  /**
   * Zählt einen Aufruf - aber nur, wenn jemand anders als der Besitzer schaut und das Deck nicht
   * privat ist (die Funktion prüft dasselbe serverseitig noch einmal). Lädt danach die Zahlen,
   * damit die Anzeige den eigenen Aufruf schon enthält.
   */
  async registerView(deck: {
    id: string;
    userId: string | null;
    isPrivate?: boolean;
  }): Promise<void> {
    if (!this.verfuegbar()) return;
    const uid = this.auth.currentUser()?.id ?? null;
    const istBesitzer = !!uid && deck.userId === uid;

    if (!istBesitzer && !deck.isPrivate && !this.gezaehlt.has(deck.id)) {
      this.gezaehlt.add(deck.id);
      const { error } = await supabase.rpc('deck_register_view', { p_deck_id: deck.id });
      if (error && !this.istFehlendeMigration(error)) {
        console.error('Konnte Aufruf nicht zählen:', error);
      }
    }
    await this.load([deck.id]);
  }

  /** Ob der eingeloggte Nutzer dieses Deck liken darf: eingeloggt und nicht der Besitzer. */
  canLike(deckOwnerUserId: string | null): boolean {
    const uid = this.auth.currentUser()?.id;
    return !!uid && deckOwnerUserId !== uid;
  }

  /**
   * Like setzen oder zurücknehmen. Die Anzeige springt sofort um und wird bei einem Fehler
   * zurückgedreht - auf dem Handy wirkt ein Herz, das erst nach einer Netzrunde reagiert, kaputt.
   */
  async toggleLike(deckId: string): Promise<void> {
    const user = this.auth.currentUser();
    const vorher = this.statsFor(deckId);
    if (!user || !vorher || this.busy().has(deckId)) return;

    const liken = !vorher.likedByMe;
    this.setzeBusy(deckId, true);
    this.setzeStats(deckId, {
      ...vorher,
      likedByMe: liken,
      likes: Math.max(0, vorher.likes + (liken ? 1 : -1)),
    });

    const { error } = liken
      ? await supabase.from('deck_likes').insert({ deck_id: deckId, user_id: user.id })
      : await supabase.from('deck_likes').delete().eq('deck_id', deckId).eq('user_id', user.id);

    this.setzeBusy(deckId, false);

    // 23505 = das Like existiert schon (z. B. in einem zweiten Tab gesetzt) - Ziel erreicht.
    if (error && error.code !== '23505') {
      console.error('Konnte Like nicht speichern:', error);
      this.setzeStats(deckId, vorher);
      return;
    }
    await this.load([deckId]);
  }

  private setzeStats(deckId: string, s: DeckSocialStats): void {
    const next = new Map(this.stats());
    next.set(deckId, s);
    this.stats.set(next);
  }

  private setzeBusy(deckId: string, on: boolean): void {
    const next = new Set(this.busy());
    if (on) next.add(deckId);
    else next.delete(deckId);
    this.busy.set(next);
  }

  /** true = die Migration fehlt noch; Aufrufe und Likes bleiben für den Rest der Sitzung ausgeblendet. */
  private istFehlendeMigration(error: { code?: string }): boolean {
    // PGRST202 = PostgREST kennt die Funktion nicht (Schema-Cache), 42883 = Postgres kennt sie nicht.
    if (error.code !== 'PGRST202' && error.code !== '42883') return false;
    console.warn(
      'Funktionen für Aufrufe/Likes fehlen noch - sql/deck-aufrufe-likes-2026-09-22.sql im Supabase-SQL-Editor ausführen.',
    );
    this.verfuegbar.set(false);
    return true;
  }
}

/** Rohform einer Zeile aus deck_social_stats(). bigint kommt je nach Größe als Zahl oder Text. */
interface SocialRow {
  deck_id: string;
  views: number | string;
  likes: number | string;
  liked_by_me: boolean;
  owner_name: string | null;
}
