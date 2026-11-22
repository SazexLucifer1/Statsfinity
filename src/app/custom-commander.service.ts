import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { normalizeCardName } from './array-utils';
import { CustomCommander } from './models';
import type { ScryfallCard } from './scryfall.service';
import { supabase } from './supabase.client';

/** Reihenfolge der Farbknöpfe im Dialog und der gespeicherten Farbidentität. */
export const CUSTOM_COMMANDER_COLORS = ['W', 'U', 'B', 'R', 'G'] as const;

/**
 * Selbst erstellte Commander (sql/eigene-commander-2026-11-22.sql) - Karten, die es bei Scryfall
 * nicht gibt. Partien speichern den Commander ohnehin nur als Namen, Statistiken rechnen damit; es
 * fehlte nur, was die App sonst bei Scryfall nachschlägt. Deshalb hängt dieser Service an genau
 * zwei Stellen ein, statt in jeder Liste eine Sonderregel zu brauchen:
 *
 * - Vorschläge beim Tippen: ScryfallService.autocomplete()/autocompleteSecondCommander() stellen
 *   passende eigene Commander voran (Match-Tab, Deck anlegen, Commander-Ideen).
 * - Kartendaten nach Namen: CardDataService.findCard()/findCardsBulk() liefern für einen eigenen
 *   Commander eine Karte aus Name, Farben und Bild - damit stimmen Kartenbild (card-thumb,
 *   Statistik, Match-Verlauf), Farbidentität eines Decks und canBeCommander() ohne weitere Änderung.
 *
 * Die Liste ist klein und wird einmal je Sitzung ganz geladen.
 */
@Injectable({ providedIn: 'root' })
export class CustomCommanderService {
  private readonly auth = inject(AuthService);

  /** false, sobald die Tabelle fehlt (Migration noch nicht gelaufen) - dann verschwindet alles still. */
  readonly available = signal(true);
  readonly all = signal<CustomCommander[]>([]);
  private loading: Promise<void> | null = null;

  // --- Dialog "Eigenen Commander anlegen" (custom-commander-dialog/) ---
  readonly dialogOpen = signal(false);
  readonly draftName = signal('');
  readonly draftColors = signal<ReadonlySet<string>>(new Set());
  readonly draftFile = signal<File | null>(null);
  readonly draftPreview = signal<string | null>(null);
  readonly busy = signal(false);
  readonly errorKey = signal<string | null>(null);
  private onCreated: ((name: string) => void) | null = null;

  private static readonly BUCKET = 'custom-commander-images';
  private static readonly MAX_BILD_BYTES = 5 * 1024 * 1024;

  ensureLoaded(): Promise<void> {
    if (!this.available()) return Promise.resolve();
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    const { data, error } = await supabase
      .from('custom_commanders')
      .select('id, name, color_identity, image_url, created_by')
      .order('name');
    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205') {
        console.warn(
          'Tabelle custom_commanders fehlt - sql/eigene-commander-2026-11-22.sql ausführen.',
        );
        this.available.set(false);
      } else {
        console.error('Konnte eigene Commander nicht laden:', error);
        // Beim nächsten Aufruf erneut versuchen.
        this.loading = null;
      }
      return;
    }
    this.all.set(
      ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        id: row['id'] as string,
        name: row['name'] as string,
        colorIdentity: (row['color_identity'] as string[] | null) ?? [],
        imageUrl: (row['image_url'] as string | null) ?? null,
        createdBy: row['created_by'] as string,
      })),
    );
  }

  private static key(name: string): string {
    return normalizeCardName(name.split(' // ')[0].trim());
  }

  /** Eigene Commander, deren Name die Eingabe enthält - Treffer am Wortanfang zuerst. */
  async search(query: string): Promise<string[]> {
    const q = CustomCommanderService.key(query);
    if (q.length < 2) return [];
    await this.ensureLoaded();
    return this.all()
      .map((c) => c.name)
      .filter((name) => CustomCommanderService.key(name).includes(q))
      .sort((a, b) => {
        const aStart = CustomCommanderService.key(a).startsWith(q) ? 0 : 1;
        const bStart = CustomCommanderService.key(b).startsWith(q) ? 0 : 1;
        return aStart - bStart || a.localeCompare(b);
      });
  }

  /** Ist der Name ein eigener Commander? Nur nach ensureLoaded() verlässlich. */
  isCustom(name: string | null | undefined): boolean {
    if (!name) return false;
    const key = CustomCommanderService.key(name);
    return this.all().some((c) => CustomCommanderService.key(c.name) === key);
  }

  /**
   * Kartendaten für eigene Commander unter den Namen; Schlüssel wie bei findCardsBulk() der
   * kleingeschriebene Name. Die Typzeile lautet "Legendary Creature", damit canBeCommander() und
   * alle Stellen, die nach Kreaturen zählen, den Commander als Commander behandeln.
   */
  async cardsFor(names: string[]): Promise<Map<string, ScryfallCard>> {
    const result = new Map<string, ScryfallCard>();
    if (names.length === 0) return result;
    await this.ensureLoaded();
    const byKey = new Map(this.all().map((c) => [CustomCommanderService.key(c.name), c]));
    for (const name of names) {
      const custom = byKey.get(CustomCommanderService.key(name));
      if (!custom) continue;
      result.set(name.trim().toLowerCase(), {
        name: custom.name,
        imageUrl: custom.imageUrl ?? undefined,
        typeLine: 'Legendary Creature',
        cmc: 0,
        colorIdentity: [...custom.colorIdentity],
      });
    }
    return result;
  }

  // --- Anlegen ---

  /** Öffnet den Dialog; `onCreated` bekommt den gespeicherten Namen (z. B. um ihn gleich auszuwählen). */
  openCreate(prefillName: string, onCreated: (name: string) => void): void {
    this.draftName.set(prefillName.trim());
    this.draftColors.set(new Set());
    this.setFile(null);
    this.errorKey.set(null);
    this.onCreated = onCreated;
    this.dialogOpen.set(true);
    void this.ensureLoaded();
  }

  close(): void {
    this.dialogOpen.set(false);
    this.setFile(null);
    this.onCreated = null;
  }

  toggleColor(color: string): void {
    this.draftColors.update((set) => {
      const next = new Set(set);
      if (next.has(color)) next.delete(color);
      else next.add(color);
      return next;
    });
  }

  setFile(file: File | null): void {
    const old = this.draftPreview();
    if (old) URL.revokeObjectURL(old);
    if (file && !file.type.startsWith('image/')) {
      this.errorKey.set('match.customCommander.notAnImage');
      file = null;
    } else if (file && file.size > CustomCommanderService.MAX_BILD_BYTES) {
      this.errorKey.set('match.customCommander.imageTooBig');
      file = null;
    } else if (file) {
      this.errorKey.set(null);
    }
    this.draftFile.set(file);
    this.draftPreview.set(file ? URL.createObjectURL(file) : null);
  }

  async save(): Promise<void> {
    const name = this.draftName().trim().replace(/\s+/g, ' ');
    const uid = this.auth.currentUser()?.id;
    if (!name || !uid || this.busy()) return;

    this.busy.set(true);
    this.errorKey.set(null);
    try {
      await this.ensureLoaded();
      if (this.isCustom(name)) {
        this.errorKey.set('match.customCommander.exists');
        return;
      }
      // Ein Name, den es als echte Karte gibt, würde in Statistik und Kartenbild mit dieser
      // vermischt - die echte Karte gewinnt beim Nachschlagen, der eigene Commander wäre unsichtbar.
      const { data: real } = await supabase
        .from('scryfall_cards')
        .select('name')
        .eq('front_name_normalized', CustomCommanderService.key(name))
        .limit(1);
      if (real && real.length > 0) {
        this.errorKey.set('match.customCommander.realCard');
        return;
      }

      let imageUrl: string | null = null;
      const file = this.draftFile();
      if (file) {
        const ext =
          (file.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
        const path = `${uid}/${crypto.randomUUID()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from(CustomCommanderService.BUCKET)
          .upload(path, file, { contentType: file.type });
        if (uploadError) {
          console.error('Konnte Commander-Bild nicht hochladen:', uploadError);
          this.errorKey.set('match.customCommander.uploadFailed');
          return;
        }
        imageUrl = supabase.storage.from(CustomCommanderService.BUCKET).getPublicUrl(path)
          .data.publicUrl;
      }

      const colors = CUSTOM_COMMANDER_COLORS.filter((c) => this.draftColors().has(c));
      const { data, error } = await supabase
        .from('custom_commanders')
        .insert({ name, color_identity: colors, image_url: imageUrl, created_by: uid })
        .select('id, name, color_identity, image_url, created_by')
        .single();
      if (error || !data) {
        console.error('Konnte eigenen Commander nicht speichern:', error);
        this.errorKey.set(
          error?.code === '23505'
            ? 'match.customCommander.exists'
            : 'match.customCommander.saveFailed',
        );
        return;
      }
      const created: CustomCommander = {
        id: data.id,
        name: data.name,
        colorIdentity: data.color_identity ?? [],
        imageUrl: data.image_url ?? null,
        createdBy: data.created_by,
      };
      this.all.update((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
      const callback = this.onCreated;
      this.close();
      callback?.(created.name);
    } finally {
      this.busy.set(false);
    }
  }
}
