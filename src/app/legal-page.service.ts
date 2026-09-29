import { Injectable, signal } from '@angular/core';

export type LegalPage = 'impressum' | 'datenschutz' | 'nutzungsbedingungen';

/**
 * Steuert das Rechtsseiten-Overlay (Impressum/Datenschutz/Nutzungsbedingungen). Bewusst kein
 * Angular-Router - die App hat aktuell keinen (Tab-Navigation läuft über NavigationService/
 * @switch, siehe app.html), ein vollständiger Router-Umbau nur für drei statische Textseiten wäre
 * ein unnötig großer, riskanter Eingriff. Stattdessen dasselbe Overlay-Muster wie
 * DeckViewerService/app-deck-detail-view: ein Signal steuert Sichtbarkeit, root-level in app.html
 * und login.html eingebunden, damit die Seiten von überall (auch abgemeldet) erreichbar sind.
 */
@Injectable({ providedIn: 'root' })
export class LegalPageService {
  readonly activePage = signal<LegalPage | null>(null);

  open(page: LegalPage): void {
    this.activePage.set(page);
  }

  close(): void {
    this.activePage.set(null);
  }
}
