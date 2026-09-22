import { Injectable, computed, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { bereinigePrimerHtml, primerIstLeer } from './primer-html';

/**
 * Der Primer eines Decks - die selbst geschriebene Beschreibung ("was will das Deck, wie gewinnt
 * es, worauf muss man achten"), gespeichert in decks.primer (siehe
 * sql/deck-primer-2026-09-22.sql).
 *
 * Der Zustand hängt aus demselben Grund am Service wie bei den Kommentaren: Derselbe Primer wird
 * an zwei voneinander unabhängigen Stellen gezeigt (deck-detail-view über DeckViewerService und
 * public-deck-browser mit eigenem, lokalem Zustand). Deshalb merkt sich der Service, zu WELCHEM
 * Deck der geladene Text gehört - sonst überschreibt bei schnellem Deck-Wechsel eine überholende
 * Antwort die Anzeige.
 *
 * Geladen wird beim Öffnen eines Decks, NICHT erst beim Umschalten auf den Reiter: Ob es den
 * Reiter für Fremde überhaupt gibt, hängt daran, ob ein Primer existiert (siehe hatPrimer()).
 */
@Injectable({ providedIn: 'root' })
export class DeckPrimerService {
  private readonly auth = inject(AuthService);

  /** Bereinigtes HTML des geladenen Decks, null = kein Primer geschrieben. */
  readonly primer = signal<string | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  /** Gesetzt, wenn Laden oder Speichern fehlgeschlagen ist - i18n-Key, kein fertiger Text. */
  readonly errorKey = signal<string | null>(null);

  readonly hatPrimer = computed(() => this.primer() !== null);

  /**
   * Steht die Migration noch aus, kennt Postgres die Spalte nicht (42703 beim Lesen, PGRST204
   * beim Schreiben über den Schema-Cache von PostgREST). Dann verschwindet der Reiter still,
   * statt an jedem Deck eine Fehlermeldung zu zeigen - gleiche Mechanik wie bei den
   * Bracket-Spalten in DeckService und beim Kommentar-Abschnitt.
   */
  readonly verfuegbar = signal(true);

  /** Deck, zu dem primer() gehört - gegen überholende Antworten bei schnellem Deck-Wechsel. */
  private loadedDeckId: string | null = null;

  async load(deckId: string): Promise<void> {
    this.loadedDeckId = deckId;
    this.primer.set(null);
    this.errorKey.set(null);
    if (!this.verfuegbar()) return;

    this.loading.set(true);
    const { data, error } = await supabase
      .from('decks')
      .select('primer')
      .eq('id', deckId)
      .maybeSingle();
    // Inzwischen wurde ein anderes Deck geöffnet - diese Antwort gehört nicht mehr zur Anzeige.
    if (this.loadedDeckId !== deckId) return;
    this.loading.set(false);

    if (error) {
      if (this.spalteFehlt(error)) return;
      console.error('Konnte Primer nicht laden:', error);
      this.errorKey.set('deckPrimer.loadFailed');
      return;
    }

    // Auch beim LESEN bereinigen: Was in der Spalte steht, hat zwar den Weg über
    // bereinigePrimerHtml() genommen, aber die Positivliste kann enger werden, und ein direkter
    // API-Aufruf am Client vorbei ist jederzeit möglich.
    const html = bereinigePrimerHtml((data as { primer?: string | null } | null)?.primer ?? '');
    this.primer.set(html || null);
  }

  /**
   * Speichert den Primer des Decks. Nimmt das rohe HTML aus dem Eingabefeld entgegen und
   * bereinigt es hier - nicht erst in der Komponente, damit kein zweiter Aufrufer die Bereinigung
   * vergessen kann. Ein Primer ohne sichtbaren Text wird zu NULL: ein Feld, in das jemand getippt
   * und alles wieder gelöscht hat, ist kein Primer.
   */
  async save(deckId: string, rohesHtml: string): Promise<boolean> {
    if (!this.verfuegbar()) return false;

    const html = bereinigePrimerHtml(rohesHtml);
    const wert = primerIstLeer(html) ? null : html;

    this.saving.set(true);
    this.errorKey.set(null);
    // updated_at bleibt bewusst unangetastet: Die Deck-Listen sortieren danach, und ein Primer
    // sagt etwas ÜBER das Deck, ohne das Deck selbst zu ändern - ein Tippfehler in der
    // Beschreibung soll kein Deck an die Spitze der Liste heben.
    const { error } = await supabase.from('decks').update({ primer: wert }).eq('id', deckId);
    this.saving.set(false);

    if (error) {
      if (this.spalteFehlt(error)) return false;
      console.error('Konnte Primer nicht speichern:', error);
      this.errorKey.set('deckPrimer.saveFailed');
      return false;
    }

    if (this.loadedDeckId === deckId) this.primer.set(wert);
    return true;
  }

  /** Läuft, während ein eigenes Bild in den Bucket hochgeladen wird. */
  readonly bildUpload = signal(false);

  /**
   * Fehlt der Bucket noch (sql/primer-bilder-bucket-2026-09-22.sql läuft nicht automatisch mit dem
   * Deployment), verschwindet der Knopf für eigene Bilder nach dem ersten Versuch - dieselbe
   * Mechanik wie beim Reiter selbst. Kartenbilder von Scryfall bleiben davon unberührt, die
   * brauchen keinen Bucket.
   */
  readonly eigeneBilderVerfuegbar = signal(true);

  /**
   * Lädt ein eigenes Bild in den Bucket "primer-images" und liefert die öffentliche Adresse
   * (siehe sql/primer-bilder-bucket-2026-09-22.sql). Eigener Bucket statt "deck-art": Dort liegen
   * Kartenbilder, die ein Deck ersetzt anzeigt - ein Primer-Bild ist etwas anderes, und beim
   * Aufräumen ("welche Bilder hängen woran?") will man die beiden nicht auseinanderklauben müssen.
   *
   * Der Pfad beginnt mit der eigenen Benutzer-ID, weil genau darauf die Schreibrechte des Buckets
   * prüfen - niemand soll in den Ordner eines anderen hochladen können.
   */
  async bildHochladen(file: File): Promise<string | null> {
    const uid = this.auth.currentUser()?.id;
    if (!uid) return null;
    if (!file.type.startsWith('image/')) {
      this.errorKey.set('deckPrimer.imageNotAnImage');
      return null;
    }
    if (file.size > DeckPrimerService.MAX_BILD_BYTES) {
      this.errorKey.set('deckPrimer.imageTooBig');
      return null;
    }

    this.bildUpload.set(true);
    this.errorKey.set(null);
    const endung = (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const pfad = `${uid}/${crypto.randomUUID()}.${endung || 'jpg'}`;
    const { error } = await supabase.storage
      .from('primer-images')
      .upload(pfad, file, { contentType: file.type });
    this.bildUpload.set(false);

    if (error) {
      // "Bucket not found" heißt nicht "Upload kaputt", sondern "Migration steht noch aus" - und
      // das ist etwas, das nur der Betreiber beheben kann, nicht der Schreiber.
      if ((error.message ?? '').toLowerCase().includes('bucket not found')) {
        console.warn(
          'Bucket primer-images fehlt noch - sql/primer-bilder-bucket-2026-09-22.sql im Supabase-SQL-Editor ausführen. Bis dahin gibt es im Primer nur Kartenbilder.',
        );
        this.eigeneBilderVerfuegbar.set(false);
        this.errorKey.set('deckPrimer.imageBucketMissing');
        return null;
      }
      console.error('Konnte Primer-Bild nicht hochladen:', error);
      this.errorKey.set('deckPrimer.imageUploadFailed');
      return null;
    }
    return supabase.storage.from('primer-images').getPublicUrl(pfad).data.publicUrl;
  }

  /** 5 MB: Ein Primer-Bild wird im Text auf Handybreite angezeigt - mehr ist nur Ladezeit. */
  private static readonly MAX_BILD_BYTES = 5 * 1024 * 1024;

  /** Beim Schließen der Deck-Ansicht aufräumen, damit der nächste Aufruf nicht kurz den alten Text zeigt. */
  zuruecksetzen(): void {
    this.loadedDeckId = null;
    this.primer.set(null);
    this.errorKey.set(null);
    this.loading.set(false);
  }

  /**
   * true = die Spalte fehlt noch, der Primer ist für diese Sitzung abgeschaltet. 42703 meldet
   * Postgres beim Lesen, PGRST204 meldet PostgREST beim Schreiben (die Spalte fehlt in seinem
   * Schema-Cache). Die Meldung wird mitgeprüft, damit nicht irgendeine andere fehlende Migration
   * ausgerechnet den Primer abschaltet.
   */
  private spalteFehlt(error: { code?: string; message?: string }): boolean {
    const code = error.code ?? '';
    if (code !== '42703' && code !== 'PGRST204') return false;
    if (!(error.message ?? '').includes('primer')) return false;
    console.warn(
      'Spalte decks.primer fehlt noch - sql/deck-primer-2026-09-22.sql im Supabase-SQL-Editor ausführen. Bis dahin gibt es keinen Primer.',
    );
    this.verfuegbar.set(false);
    this.primer.set(null);
    return true;
  }
}
