import { Injectable, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { ProfileService } from './profile.service';

export interface DeckComment {
  id: string;
  /** Null = Kommentar erster Ebene. Sonst die id des Kommentars, auf den geantwortet wurde. */
  parentId: string | null;
  userId: string;
  /** Anzeigename aus profiles - beim Lesen nachgeschlagen, nicht beim Schreiben eingefroren. Null, wenn das Profil nicht (mehr) existiert. */
  displayName: string | null;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
  /** Antworten auf diesen Kommentar, ältester zuerst. Bei einer Antwort immer leer - es gibt genau eine Ebene. */
  replies: DeckComment[];
}

/** Gleiche Obergrenze wie der CHECK in sql/deck-kommentare-2026-09-22.sql - der Client soll den Fehler vorher abfangen. */
export const DECK_COMMENT_MAX_LENGTH = 2000;

/**
 * Kommentare unter einem Deck, eine Antwort-Ebene tief (siehe
 * sql/deck-kommentare-2026-09-22.sql). Der Zustand hängt bewusst am Service und nicht an der
 * Komponente: dieselbe Kommentarliste wird an zwei voneinander unabhängigen Stellen gezeigt
 * (deck-detail-view über DeckViewerService und public-deck-browser mit eigenem, lokalem Zustand),
 * und beide sollen sich nicht gegenseitig Ladezustände überschreiben, wenn nacheinander
 * verschiedene Decks geöffnet werden - deshalb merkt sich der Service, zu WELCHEM Deck die
 * geladene Liste gehört (siehe loadedDeckId).
 *
 * Gelesen wird über die Funktion deck_comments_for_deck() statt direkt über die Tabelle: nur so
 * kommen Anzeigename und Avatar auch für nicht eingeloggte Besucher mit (siehe Kommentar §4 der
 * Migration). Geschrieben und gelöscht wird dagegen ganz normal über die Tabelle - dort ist RLS
 * die Schranke.
 */
@Injectable({ providedIn: 'root' })
export class DeckCommentService {
  private readonly auth = inject(AuthService);
  private readonly profileService = inject(ProfileService);

  readonly comments = signal<DeckComment[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);
  /** Gesetzt, wenn Laden/Senden/Löschen fehlgeschlagen ist - i18n-Key, kein fertiger Text. */
  readonly errorKey = signal<string | null>(null);

  /** Deck, zu dem comments() gehört - gegen überholende Antworten bei schnellem Deck-Wechsel. */
  private loadedDeckId: string | null = null;

  /**
   * Steht die Migration noch aus, kennt Postgres deck_comments_for_deck() nicht. Dann verschwindet
   * der ganze Abschnitt still, statt unter jedem Deck eine Fehlermeldung zu zeigen - gleiche
   * Haltung wie bei den Bracket-/Grabstein-Spalten in DeckService, nur dass es hier nichts gibt,
   * das man ohne die Migration noch sinnvoll anzeigen könnte.
   */
  readonly verfuegbar = signal(true);

  /** Wie viele Kommentare insgesamt unter dem Deck stehen, Antworten mitgezählt - für die Überschrift. */
  count(): number {
    return this.comments().reduce((sum, c) => sum + 1 + c.replies.length, 0);
  }

  async load(deckId: string): Promise<void> {
    if (!this.verfuegbar()) return;

    this.loadedDeckId = deckId;
    this.comments.set([]);
    this.errorKey.set(null);
    this.loading.set(true);

    const { data, error } = await supabase.rpc('deck_comments_for_deck', { p_deck_id: deckId });

    // Ein zwischenzeitlich geöffnetes anderes Deck hat die Anzeige längst übernommen - diese
    // Antwort gehört nicht mehr dorthin.
    if (this.loadedDeckId !== deckId) return;

    this.loading.set(false);

    if (error) {
      if (this.istFehlendeMigration(error)) return;
      console.error('Konnte Deck-Kommentare nicht laden:', error);
      this.errorKey.set('deckComment.loadFailed');
      return;
    }

    this.comments.set(this.baueBaum((data as CommentRow[] | null) ?? []));
  }

  /** Verwirft die Anzeige, wenn die Deck-Ansicht geschlossen wird - sonst blitzt beim nächsten Deck kurz die alte Liste auf. */
  clear(): void {
    this.loadedDeckId = null;
    this.comments.set([]);
    this.errorKey.set(null);
    this.loading.set(false);
  }

  /** Ob der eingeloggte Nutzer diesen Kommentar löschen darf: als Verfasser, als Deck-Besitzer oder als Developer. Die eigentliche Schranke ist die DELETE-Policy, das hier steuert nur die Anzeige des Knopfes. */
  canDelete(comment: DeckComment, deckOwnerUserId: string | null): boolean {
    const uid = this.auth.currentUser()?.id;
    if (!uid) return false;
    if (comment.userId === uid) return true;
    if (deckOwnerUserId && deckOwnerUserId === uid) return true;
    return this.profileService.profile()?.isDeveloper === true;
  }

  /**
   * Schreibt einen Kommentar (parentId gesetzt = Antwort) und lädt die Liste danach neu, statt den
   * neuen Eintrag lokal anzuhängen: die id und der Zeitstempel kommen vom Server, und nebenbei
   * erscheinen so auch Kommentare, die in der Zwischenzeit jemand anders geschrieben hat.
   * Gibt true zurück, wenn gespeichert wurde - die Komponente leert ihr Eingabefeld nur dann.
   */
  async add(deckId: string, body: string, parentId: string | null = null): Promise<boolean> {
    const text = body.trim();
    const user = this.auth.currentUser();
    if (!text || !user || this.busy()) return false;

    this.busy.set(true);
    this.errorKey.set(null);

    const { error } = await supabase.from('deck_comments').insert({
      deck_id: deckId,
      parent_id: parentId,
      user_id: user.id,
      body: text.slice(0, DECK_COMMENT_MAX_LENGTH),
    });

    this.busy.set(false);

    if (error) {
      console.error('Konnte Kommentar nicht speichern:', error);
      this.errorKey.set('deckComment.saveFailed');
      return false;
    }

    await this.load(deckId);
    return true;
  }

  async remove(deckId: string, commentId: string): Promise<void> {
    if (this.busy()) return;

    this.busy.set(true);
    this.errorKey.set(null);

    const { error } = await supabase.from('deck_comments').delete().eq('id', commentId);

    this.busy.set(false);

    if (error) {
      console.error('Konnte Kommentar nicht löschen:', error);
      this.errorKey.set('deckComment.deleteFailed');
      return;
    }

    await this.load(deckId);
  }

  /**
   * Flache Zeilen (die Funktion liefert Kommentare und Antworten in einer nach Zeit sortierten
   * Liste) zu Kommentar + Antworten zusammensetzen. Eine Antwort, deren Elternkommentar fehlt,
   * wird wie ein eigenständiger Kommentar einsortiert statt verworfen - passieren kann das nicht,
   * solange das Kaskaden-Löschen greift, aber eine stumm verschluckte Zeile wäre der schlechtere
   * Ausgang.
   */
  private baueBaum(rows: CommentRow[]): DeckComment[] {
    const alle = new Map<string, DeckComment>();
    for (const row of rows) {
      alle.set(row.id, {
        id: row.id,
        parentId: row.parent_id,
        userId: row.user_id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        body: row.body,
        createdAt: row.created_at,
        replies: [],
      });
    }

    const wurzeln: DeckComment[] = [];
    for (const row of rows) {
      const comment = alle.get(row.id)!;
      const parent = row.parent_id ? alle.get(row.parent_id) : undefined;
      if (parent) parent.replies.push(comment);
      else wurzeln.push(comment);
    }
    return wurzeln;
  }

  /** true = die Migration fehlt noch; der Abschnitt bleibt für den Rest der Sitzung ausgeblendet. */
  private istFehlendeMigration(error: { code?: string; message?: string }): boolean {
    // PGRST202 = PostgREST kennt die Funktion nicht (Schema-Cache), 42883 = Postgres kennt sie nicht.
    if (error.code !== 'PGRST202' && error.code !== '42883') return false;
    console.warn(
      'Funktion deck_comments_for_deck() fehlt noch - sql/deck-kommentare-2026-09-22.sql im Supabase-SQL-Editor ausführen. Bis dahin gibt es keine Deck-Kommentare.',
    );
    this.verfuegbar.set(false);
    return true;
  }
}

/** Rohform einer Zeile aus deck_comments_for_deck(). */
interface CommentRow {
  id: string;
  parent_id: string | null;
  user_id: string;
  body: string;
  created_at: string;
  display_name: string | null;
  avatar_url: string | null;
}
