import { Injectable, signal } from '@angular/core';

/**
 * Steuert das Login-Overlay - seit dem App-Umbau ist die normale App-Hülle (Header/Tab-Leiste)
 * immer sichtbar, auch abgemeldet. Login ist deshalb kein Standard-Fallback mehr, sondern ein
 * On-Demand-Overlay, das von überall aus geöffnet werden kann (Header-Button, "Jetzt anmelden" in
 * gesperrten Tabs, ...). Gleiches Muster wie LegalPageService/CardPreviewService.
 */
@Injectable({ providedIn: 'root' })
export class LoginOverlayService {
  readonly active = signal(false);

  open(): void {
    this.active.set(true);
  }

  close(): void {
    this.active.set(false);
  }
}
