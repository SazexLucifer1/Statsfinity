import {
  ApplicationRef,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  computed,
  inject,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { CdkPortal, DomPortalOutlet } from '@angular/cdk/portal';
import { I18nService } from '../../i18n.service';

/**
 * Auswahlfeld für MEHRERE Werte: sieht aus wie eine Auswahlliste, klappt aber ein Sheet mit
 * Häkchen auf, in dem beliebig viele Einträge gleichzeitig angehakt sein können.
 *
 * Ein natives <select multiple> ist auf dem iPhone praktisch unbedienbar (Safari zeigt es als
 * mehrzeilige Liste ohne Mehrfachauswahl-Geste), und eine Chip-Reihe wird bei mehr als einer
 * Handvoll Einträgen zu einer langen Kachelwand - genau deshalb gibt es diesen Baustein.
 *
 * Bewusst NICHT über OverflowMenu gelöst, obwohl das Sheet-Muster dort schon steckt: dessen Sheet
 * schließt sich bei JEDEM Klick im Inhalt (overflow-menu.html), was beim Anhaken mehrerer Einträge
 * genau das Falsche ist, und sein Auslöser ist fest das "⋮"-Symbol. Die beiden bewährten Mechaniken
 * von dort sind hier übernommen - die ausführliche Begründung steht in overflow-menu.ts:
 *   - Das Sheet wandert per Portal in einen eigenen Container am <body>, weil ein Vorfahre mit
 *     backdrop-filter (.glass-card) sonst zum Bezugsrahmen für position:fixed wird und das Sheet in
 *     der Karte gefangen bliebe.
 *   - Escape schließt, der Fokus bleibt im Sheet gefangen (cdkTrapFocus).
 */
@Component({
  selector: 'app-multi-select',
  imports: [A11yModule, CdkPortal],
  templateUrl: './multi-select.html',
  styleUrl: './multi-select.scss',
})
export class MultiSelect implements OnDestroy {
  readonly i18n = inject(I18nService);
  private readonly appRef = inject(ApplicationRef);
  private readonly injector = inject(Injector);

  /** Aktuell angehakte Werte. */
  readonly value = model.required<Set<string>>();
  /** Alle wählbaren Werte, in Anzeigereihenfolge. */
  readonly options = input.required<readonly string[]>();
  /** Werte, die nicht angehakt werden dürfen (z.B. für diesen Account gesperrte Spielmodi). */
  readonly disabledOptions = input<readonly string[]>([]);
  /** Zeichen vor gesperrten Einträgen, z.B. "*". Leer = keine Markierung. */
  readonly disabledMarker = input('');
  /** Beschriftung des "alles auswählen"-Eintrags, z.B. "Alle Modi". */
  readonly allLabel = input('');
  /** Vorgelesener Name des Auslösers, z.B. "Spielmodi". */
  readonly label = input('');

  readonly open = signal(false);

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly portal = viewChild.required(CdkPortal);

  /** Erst beim ersten Öffnen angelegt - ein nie geöffnetes Menü hängt nichts in den <body>. */
  private outlet: DomPortalOutlet | null = null;
  private host: HTMLElement | null = null;

  /** Auswählbare (also nicht gesperrte) Optionen - Grundlage für "alle ausgewählt". */
  private readonly selectableOptions = computed(() =>
    this.options().filter((o) => !this.isDisabled(o))
  );

  readonly allSelected = computed(() => {
    const selectable = this.selectableOptions();
    return selectable.length > 0 && selectable.every((o) => this.value().has(o));
  });

  /**
   * Beschriftung des Auslösers: bei vollständiger Auswahl die "Alle"-Beschriftung, bei genau einem
   * Wert dieser Wert, sonst die Anzahl - ausgeschriebene Listen würden den Knopf sprengen.
   */
  readonly summary = computed<string>(() => {
    const selected = [...this.value()];
    if (this.allSelected()) return this.allLabel() || this.i18n.t('common.multiSelectAll');
    if (selected.length === 0) return this.i18n.t('common.multiSelectNone');
    if (selected.length === 1) return selected[0];
    return this.i18n.t('common.multiSelectCount', { count: selected.length });
  });

  isSelected(option: string): boolean {
    return this.value().has(option);
  }

  isDisabled(option: string): boolean {
    return this.disabledOptions().includes(option);
  }

  toggle(option: string): void {
    if (this.isDisabled(option)) return;
    const next = new Set(this.value());
    if (next.has(option)) next.delete(option);
    else next.add(option);
    this.value.set(next);
  }

  /** Hakt alle nicht gesperrten Optionen an - gesperrte bleiben außen vor, sonst wäre "Alle" nie aktiv. */
  selectAll(): void {
    this.value.set(new Set(this.selectableOptions()));
  }

  toggleOpen(): void {
    if (this.open()) this.close();
    else this.openMenu();
  }

  close(): void {
    if (!this.open()) return;
    this.open.set(false);
    this.outlet?.detach();
    // Fokus zurück auf den Auslöser, sonst landet er nach dem Schließen am Seitenanfang.
    this.trigger()?.nativeElement.focus();
  }

  ngOnDestroy(): void {
    // Siehe overflow-menu.ts: dispose() entfernt auch das Outlet-Element selbst, deshalb bekommt
    // das Portal einen eigenen Container statt direkt auf dem <body> zu sitzen.
    this.outlet?.dispose();
    this.outlet = null;
    this.host = null;
  }

  private openMenu(): void {
    if (!this.outlet) {
      this.host = document.createElement('div');
      this.host.classList.add('multi-select-portal');
      document.body.appendChild(this.host);
      this.outlet = new DomPortalOutlet(this.host, this.appRef, this.injector);
    }
    if (!this.outlet.hasAttached()) this.outlet.attach(this.portal());
    this.open.set(true);
  }
}
