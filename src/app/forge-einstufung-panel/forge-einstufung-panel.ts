import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { I18nService } from '../i18n.service';
import { ProfileService } from '../profile.service';
import { ForgeAuftrag, ForgeEinstufungService, ForgeErgebnis } from '../forge-einstufung.service';
import { FAIRER_ANTEIL, SCHWELLE } from '../forge-einstufung';
import { BarChart, BarChartDatum } from '../ui/bar-chart/bar-chart';
import { BracketBadge } from '../ui/bracket-badge/bracket-badge';

/**
 * Bracket-Einstufung aus der Forge-Simulation (echte 4er-Pods gegen die Test-Decks je Stufe) in der
 * Deck-Ansicht: letztes Ergebnis mit einem Balken je Stufe, Status des Auftrags, Knopf zum Anfordern.
 *
 * NUR FÜR DEVELOPER, solange die Simulation im Aufbau ist (Entscheidung des Users, 28.09.2026) -
 * für alle anderen rendert die Komponente gar nichts. Die RLS erzwingt dasselbe für die Aufträge;
 * die Prüfung hier ist Bequemlichkeit, nicht Sicherheit.
 *
 * Kein Polling: Ein Lauf dauert Stunden. Aufgefrischt wird beim Öffnen des Decks und über den
 * Knopf "Aktualisieren".
 */
@Component({
  selector: 'app-forge-einstufung-panel',
  imports: [BarChart, BracketBadge, DatePipe],
  templateUrl: './forge-einstufung-panel.html',
  styleUrl: './forge-einstufung-panel.scss',
})
export class ForgeEinstufungPanel {
  readonly i18n = inject(I18nService);
  private readonly service = inject(ForgeEinstufungService);
  private readonly profile = inject(ProfileService);

  readonly deckId = input.required<string>();

  readonly sichtbar = computed(
    () => this.profile.profile()?.isDeveloper === true && this.service.verfuegbar(),
  );
  readonly ergebnis = signal<ForgeErgebnis | null>(null);
  readonly auftrag = signal<ForgeAuftrag | null>(null);
  readonly laedt = signal(false);
  readonly sendet = signal(false);
  readonly fehlerKey = signal<string | null>(null);

  readonly fairerAnteil = Math.round(FAIRER_ANTEIL * 100);
  readonly schwelle = Math.round(SCHWELLE * 100);

  /** Ein Auftrag steht offen - dann gibt es keinen zweiten (auch die Datenbank verhindert das). */
  readonly offen = computed(() => {
    const s = this.auftrag()?.status;
    return s === 'wartet' || s === 'laeuft';
  });

  readonly spieleGesamt = computed(
    () => this.ergebnis()?.stufen.reduce((summe, s) => summe + s.spiele, 0) ?? 0,
  );

  readonly balken = computed<BarChartDatum[]>(() =>
    (this.ergebnis()?.stufen ?? []).map((s) => {
      const winrate = s.spiele ? Math.round((100 * s.siege) / s.spiele) : 0;
      return {
        label: this.i18n.t('deckView.forgeGegenStufe', { stufe: s.stufe }),
        value: winrate,
        // Combo-Siege gibt es erst seit dem Combo-Pilot - ältere Läufe haben das Feld nicht.
        detail: s.comboSiege
          ? this.i18n.t('deckView.forgeSiegeVonCombo', {
              siege: s.siege,
              spiele: s.spiele,
              combo: s.comboSiege,
            })
          : this.i18n.t('deckView.forgeSiegeVon', { siege: s.siege, spiele: s.spiele }),
        // Unter der Schwelle gedämpft: dort hält das Deck nicht mit.
        color: winrate >= this.schwelle ? undefined : 'var(--series-neutral)',
      };
    }),
  );

  constructor() {
    effect(() => {
      const id = this.deckId();
      if (!this.sichtbar()) return;
      untracked(() => void this.laden(id));
    });
  }

  async laden(id = this.deckId()): Promise<void> {
    this.laedt.set(true);
    this.fehlerKey.set(null);
    try {
      const { ergebnis, auftrag } = await this.service.laden(id);
      // Inzwischen ein anderes Deck geöffnet - diese Antwort gehört nicht mehr hierher.
      if (id !== this.deckId()) return;
      this.ergebnis.set(ergebnis);
      this.auftrag.set(auftrag);
    } catch (e) {
      console.error('Forge-Einstufung konnte nicht geladen werden:', e);
      this.fehlerKey.set('deckView.forgeLadeFehler');
    } finally {
      this.laedt.set(false);
    }
  }

  async anfordern(): Promise<void> {
    if (this.offen() || this.sendet()) return;
    this.sendet.set(true);
    this.fehlerKey.set(null);
    try {
      await this.service.anfordern(this.deckId());
      await this.laden();
    } catch (e) {
      console.error('Forge-Auftrag konnte nicht angelegt werden:', e);
      this.fehlerKey.set('deckView.forgeAnfordernFehler');
    } finally {
      this.sendet.set(false);
    }
  }
}
