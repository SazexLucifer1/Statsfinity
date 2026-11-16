import { Injectable, computed, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { ProfileService } from './profile.service';
import type { ArtBox } from './art-hash';
import type { ScanDiagnostics, ScanHit } from './card-scan.service';

/**
 * Scan-Proben: Der Scanner speichert auf Wunsch jedes Kamerabild samt Ergebnis, Zwischenwerten und
 * späterer Korrektur (Wunsch des Users, 04.11.2026) - damit sich jede Änderung am Scanner gegen
 * echte Fälle nachmessen lässt statt gegen ein paar Screenshots. Screenshots taugen dafür schlecht:
 * Sie enthalten den Rahmen und die Abdunklung, die die App über das Kamerabild legt.
 *
 * Nur für Developer und nur mit dem Schalter im Scanner (gemerkt im localStorage). Bilder im
 * Bucket `scan-samples` (über die Adresse lesbar, nicht auflistbar), Verzeichnis in der Tabelle
 * `scan_samples` (sql/scan-proben-2026-11-04.sql). Die Korrektur in der Trefferliste (andere
 * Sprache, Foil, gelöscht) ist die richtige Antwort zum Bild - ohne sie wüsste man bei einem
 * Treffer nicht, ob er stimmte.
 *
 * Fehlt die Migration, verschwindet der Schalter beim ersten Fehler still (`available`).
 */
@Injectable({ providedIn: 'root' })
export class ScanSampleService {
  private readonly auth = inject(AuthService);
  private readonly profiles = inject(ProfileService);

  /** false, sobald Bucket oder Tabelle fehlen. */
  readonly available = signal(true);
  readonly enabled = signal(readEnabled());
  /** Den Schalter sehen nur Developer. */
  readonly canUse = computed(
    () => this.available() && this.profiles.profile()?.isDeveloper === true,
  );
  /** Gespeicherte Proben in dieser Sitzung - zur Anzeige am Schalter. */
  readonly savedCount = signal(0);

  setEnabled(on: boolean): void {
    this.enabled.set(on);
    try {
      localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      // privater Modus - gilt dann nur für diese Sitzung
    }
  }

  /** Speichert eine Probe; gibt die Zeilen-ID zurück (für spätere Korrekturen) oder null. */
  async save(
    frame: HTMLCanvasElement,
    guide: ArtBox,
    corner: HTMLCanvasElement | null,
    hit: ScanHit | null,
    diagnostics: ScanDiagnostics,
  ): Promise<string | null> {
    if (!this.enabled() || !this.canUse()) return null;
    const uid = this.auth.currentUser()?.id;
    if (!uid) return null;
    const id = crypto.randomUUID();
    const imagePath = `${uid}/${id}.jpg`;
    const cornerPath = corner ? `${uid}/${id}-corner.jpg` : null;
    try {
      const image = await toJpeg(frame, 0.85);
      if (!image || !(await this.upload(imagePath, image))) return null;
      if (corner && cornerPath) {
        const cornerJpeg = await toJpeg(corner, 0.92);
        if (cornerJpeg) await this.upload(cornerPath, cornerJpeg);
      }
      const { error } = await supabase.from('scan_samples').insert({
        id,
        image_path: imagePath,
        corner_path: cornerPath,
        guide,
        result: hit && {
          scryfall_id: hit.print.scryfallId,
          name: hit.print.cardName,
          set: hit.print.setCode,
          number: hit.print.collectorNumber,
          lang: hit.print.lang,
          foil: hit.foil,
          via: hit.via,
        },
        diagnostics,
      });
      if (error) {
        this.fail(error);
        return null;
      }
      this.savedCount.update((n) => n + 1);
      return id;
    } catch (e) {
      console.warn('Scan-Probe nicht gespeichert:', e);
      return null;
    }
  }

  /** Eigene Proben von vor `OLD_SAMPLES_BEFORE` - null, solange nicht gezählt. */
  readonly oldCount = signal<number | null>(null);
  readonly deleting = signal(false);

  async countOld(): Promise<void> {
    const uid = this.auth.currentUser()?.id;
    if (!uid || !this.available()) return;
    const { count, error } = await supabase
      .from('scan_samples')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', uid)
      .lt('created_at', OLD_SAMPLES_BEFORE);
    if (!error) this.oldCount.set(count ?? 0);
  }

  /**
   * Löscht die eigenen Proben von vor `OLD_SAMPLES_BEFORE`: erst die Bilder im Bucket, dann die
   * Zeilen - nur die, deren Bilder wirklich weg sind, sonst lägen Bilder ohne Verzeichnis im Bucket.
   * Nur Proben: Die Sammlung (collection_cards) hat damit nichts zu tun. Gibt die Zahl gelöschter
   * Proben zurück, -1 wenn der Bucket nichts löschen ließ (Migration
   * sql/scan-proben-loeschen-2026-11-15.sql fehlt).
   */
  async deleteOld(): Promise<number> {
    const uid = this.auth.currentUser()?.id;
    if (!uid || this.deleting()) return 0;
    this.deleting.set(true);
    let deleted = 0;
    try {
      for (;;) {
        const { data, error } = await supabase
          .from('scan_samples')
          .select('id, image_path, corner_path')
          .eq('user_id', uid)
          .lt('created_at', OLD_SAMPLES_BEFORE)
          .order('created_at')
          .limit(100);
        if (error || !data?.length) break;
        const paths = data.flatMap((r) =>
          [r.image_path, r.corner_path].filter((p): p is string => !!p),
        );
        const removed = await supabase.storage.from(BUCKET).remove(paths);
        if (removed.error) break;
        const gone = new Set((removed.data ?? []).map((o) => o.name));
        // Ohne Lese-Recht auf die Bilder löscht Supabase still nichts.
        if (gone.size === 0) return deleted > 0 ? deleted : -1;
        const ids = data.filter((r) => gone.has(r.image_path)).map((r) => r.id);
        const { error: rowError } = await supabase.from('scan_samples').delete().in('id', ids);
        if (rowError || ids.length === 0) break;
        deleted += ids.length;
        this.oldCount.update((n) => (n == null ? n : Math.max(0, n - ids.length)));
      }
      return deleted;
    } finally {
      this.deleting.set(false);
      void this.countOld();
    }
  }

  /** Korrektur aus der Trefferliste nachtragen (wird mit vorhandenen Angaben zusammengeführt). */
  async correct(id: string | undefined, patch: Record<string, unknown>): Promise<void> {
    if (!id || !this.available()) return;
    const { data } = await supabase
      .from('scan_samples')
      .select('correction')
      .eq('id', id)
      .maybeSingle();
    const correction = { ...((data?.correction as object | null) ?? {}), ...patch };
    const { error } = await supabase.from('scan_samples').update({ correction }).eq('id', id);
    if (error) console.warn('Korrektur der Scan-Probe nicht gespeichert:', error);
  }

  private async upload(path: string, blob: Blob): Promise<boolean> {
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, blob, { contentType: 'image/jpeg' });
    if (error) {
      this.fail(error);
      return false;
    }
    return true;
  }

  /** Fehlt die Migration, Schalter still ausblenden statt bei jedem Scan zu scheitern. */
  private fail(error: { message?: string; code?: string }): void {
    const message = (error.message ?? '').toLowerCase();
    if (
      message.includes('bucket not found') ||
      ['42P01', 'PGRST205', 'PGRST204'].includes(error.code ?? '')
    ) {
      console.warn(
        'Scan-Proben fehlen noch - sql/scan-proben-2026-11-04.sql im Supabase-SQL-Editor ausführen.',
      );
      this.available.set(false);
      return;
    }
    console.warn('Scan-Probe nicht gespeichert:', error);
  }
}

const STORAGE_KEY = 'scanSamplesEnabled';
const BUCKET = 'scan-samples';
/**
 * Proben davor gehören zu älteren Fassungen des Scanners und lassen sich löschen (Wunsch des
 * Users, 15.11.2026, ~1,2 MB je Probe): Live-Gang des Scanner-Updates aus PR #403.
 */
export const OLD_SAMPLES_BEFORE = '2026-11-08T14:42:51Z';

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}
