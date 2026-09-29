import { Injectable, effect, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';

export interface CustomBackground {
  id: string;
  url: string;
  ownerId: string;
}

@Injectable({ providedIn: 'root' })
export class BackgroundService {
  private readonly auth = inject(AuthService);

  /** Statische, mit der App ausgelieferte Hintergründe (public/backgrounds/) - für alle sichtbar. */
  readonly list = signal<string[]>([]);
  private loaded = false;

  /** Eigene hochgeladene Hintergründe - nur für den eigenen Account sichtbar/wählbar. */
  readonly myBackgrounds = signal<CustomBackground[]>([]);
  /** Von anderen Accounts gezielt mit mir geteilte Hintergründe. */
  readonly sharedWithMe = signal<CustomBackground[]>([]);

  readonly uploading = signal(false);
  readonly uploadError = signal('');

  constructor() {
    effect(() => {
      const userId = this.auth.currentUser()?.id;
      if (userId) {
        this.loadOwn(userId);
        this.loadSharedWithMe(userId);
      } else {
        this.myBackgrounds.set([]);
        this.sharedWithMe.set([]);
      }
    });
  }

  /** Lädt das Manifest einmalig (lazy) und baut die vollen Pfade zu den Bildern. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const res = await fetch('/backgrounds/manifest.json');
      if (!res.ok) return;
      const data = await res.json();
      const files: string[] = Array.isArray(data.backgrounds) ? data.backgrounds : [];
      this.list.set(files.map((f) => `/backgrounds/${f}`));
    } catch {
      // Kein Manifest gefunden -> App bleibt ohne Hintergrund-Auswahl nutzbar.
    }
  }

  private async loadOwn(userId: string): Promise<void> {
    const { data, error } = await supabase
      .from('backgrounds')
      .select('id, image_url, owner_id')
      .eq('owner_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Konnte eigene Hintergründe nicht laden:', error);
      return;
    }

    this.myBackgrounds.set(
      (data ?? []).map((row) => ({ id: row.id, url: row.image_url, ownerId: row.owner_id }))
    );
  }

  private async loadSharedWithMe(userId: string): Promise<void> {
    const { data, error } = await supabase
      .from('background_shares')
      .select('backgrounds ( id, image_url, owner_id )')
      .eq('shared_with', userId);

    if (error) {
      console.error('Konnte geteilte Hintergründe nicht laden:', error);
      return;
    }

    this.sharedWithMe.set(
      (data as any[])
        .filter((row) => row.backgrounds)
        .map((row) => ({
          id: row.backgrounds.id,
          url: row.backgrounds.image_url,
          ownerId: row.backgrounds.owner_id,
        }))
    );
  }

  async uploadBackground(file: File): Promise<boolean> {
    const userId = this.auth.currentUser()?.id;
    if (!userId) return false;

    if (!file.type.startsWith('image/')) {
      this.uploadError.set('Bitte ein Bild auswählen.');
      return false;
    }
    if (file.size > 10 * 1024 * 1024) {
      this.uploadError.set('Bild ist zu groß (max. 10 MB).');
      return false;
    }

    this.uploading.set(true);
    this.uploadError.set('');

    const ext = file.name.split('.').pop() ?? 'jpg';
    const path = `${userId}/${crypto.randomUUID()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('backgrounds')
      .upload(path, file, { contentType: file.type });

    if (uploadError) {
      console.error('Konnte Hintergrund nicht hochladen:', uploadError);
      this.uploadError.set('Hochladen fehlgeschlagen.');
      this.uploading.set(false);
      return false;
    }

    const { data: publicUrlData } = supabase.storage.from('backgrounds').getPublicUrl(path);

    const { error: insertError } = await supabase
      .from('backgrounds')
      .insert({ owner_id: userId, image_url: publicUrlData.publicUrl });

    this.uploading.set(false);

    if (insertError) {
      console.error('Konnte Hintergrund nicht speichern:', insertError);
      this.uploadError.set('Speichern fehlgeschlagen.');
      return false;
    }

    await this.loadOwn(userId);
    return true;
  }

  async deleteBackground(id: string): Promise<void> {
    const { error } = await supabase.from('backgrounds').delete().eq('id', id);
    if (error) {
      console.error('Konnte Hintergrund nicht löschen:', error);
      return;
    }
    this.myBackgrounds.update((list) => list.filter((b) => b.id !== id));
  }

  /** Gibt einen eigenen Hintergrund für einen anderen Account frei (erneutes Teilen ist ein No-op). */
  async shareBackground(backgroundId: string, targetUserId: string): Promise<boolean> {
    const { error } = await supabase
      .from('background_shares')
      .upsert(
        { background_id: backgroundId, shared_with: targetUserId },
        { onConflict: 'background_id,shared_with' }
      );

    if (error) {
      console.error('Konnte Hintergrund nicht teilen:', error);
      return false;
    }
    return true;
  }
}
