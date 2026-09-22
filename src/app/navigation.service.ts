import { Injectable, signal } from '@angular/core';

export type AppTab = 'match' | 'search' | 'stats' | 'group' | 'profile';

/** Erkennt eine Deck-ID in der Adresse - alles andere wird ignoriert, statt es zu öffnen. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Steuert, welcher der vier Haupt-Tabs aktiv ist - liegt in einem Service statt direkt in App,
 * damit auch andere Komponenten (z.B. "Profil ansehen" aus dem Gruppen-Tab) dorthin wechseln können. */
@Injectable({ providedIn: 'root' })
export class NavigationService {
  readonly activeTab = signal<AppTab>('match');

  /**
   * Deck, das gleich beim Start geöffnet werden soll, weil jemand einen Deck-Link aufgerufen hat
   * (z.B. den QR-Code eines Steckbriefs abgescannt). Der öffentliche Deck-Browser greift es auf,
   * öffnet das Deck und setzt es zurück.
   */
  readonly pendingPublicDeckId = signal<string | null>(null);

  constructor() {
    this.deckLinkLesen();
  }

  goToTab(tab: AppTab): void {
    this.activeTab.set(tab);
  }

  /**
   * Baut den Link auf ein Deck - die Adresse, die im QR-Code des Steckbriefs steckt.
   *
   * Bewusst die aktuelle Herkunft statt einer fest eingetragenen Domain: Im Repo steht heute
   * nirgends eine, es ist öffentlich, und der vorhandene "App teilen"-QR im Profil macht es
   * genauso. Preis dafür: Ein Steckbrief, der auf einer Cloudflare-Preview erzeugt wird, trägt
   * einen QR auf genau diese Preview. Wer ein Bild zum Teilen macht, macht es aus der Live-App.
   */
  deckLink(deckId: string): string {
    return `${window.location.origin}/?deck=${deckId}`;
  }

  /**
   * Der EINZIGE Ort, an dem diese App eine Adresse auswertet.
   *
   * Die Navigation läuft sonst komplett über activeTab - kein Router, keine Routen, keine
   * URL-Parameter (siehe CLAUDE.md). Diese eine Ausnahme gibt es, weil ein QR-Code ohne Adresse
   * nicht geht: Er muss auf etwas zeigen. Bewusst KEIN Router dafür - eine Routing-Tabelle für
   * einen einzigen Parameter wäre ein Gerüst um eine Schraube herum.
   *
   * Geöffnet wird immer die öffentliche Deck-Ansicht: Wer einen QR-Code scannt, ist im Zweifel
   * gar nicht eingeloggt, und nicht-private Decks darf auch ein Fremder sehen.
   */
  private deckLinkLesen(): void {
    let deckId: string | null = null;
    try {
      deckId = new URLSearchParams(window.location.search).get('deck');
    } catch {
      return;
    }
    if (!deckId || !UUID.test(deckId)) return;

    this.pendingPublicDeckId.set(deckId);
    this.activeTab.set('search');

    // Den Parameter wieder aus der Adresse nehmen: Sonst landet man nach jedem Neuladen und über
    // jeden Zurück-Schritt wieder in diesem Deck, auch wenn man längst woanders war.
    try {
      history.replaceState(history.state, '', window.location.pathname);
    } catch {
      // Zur Not bleibt der Parameter stehen - das Deck öffnet sich dann eben erneut.
    }
  }
}
