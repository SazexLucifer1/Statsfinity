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
import {
  ALL_EFFECT_FILTERS,
  CardEffectFilter,
  EFFECT_GROUPS,
  EffectGroup,
  EffectSelection,
} from '../../card-effect-filters';

/**
 * Effekt-Filter (Wunsch eines Spielers, 05.11.2026): ein Knopf, der ein Popup mit allen
 * Effekt-Tags öffnet - gruppiert, durchsuchbar, beliebig viele anhakbar, verknüpft mit "alle
 * müssen zutreffen" oder "mindestens einer". Ersetzt das frühere Auswahlfeld mit einem Wert.
 *
 * Angewendet wird erst beim Schließen ("Fertig", Hintergrund, Escape): Jede Änderung startet in
 * den Live-Suchen eine Scryfall-Abfrage, beim Anhaken von drei Tags wären es sonst drei.
 *
 * Portal an den <body> wie in ui/multi-select (Begründung dort und in overflow-menu.ts).
 */
@Component({
  selector: 'app-effect-filter',
  imports: [A11yModule, CdkPortal],
  templateUrl: './effect-filter.html',
  styleUrl: './effect-filter.scss',
})
export class EffectFilter implements OnDestroy {
  readonly i18n = inject(I18nService);
  private readonly appRef = inject(ApplicationRef);
  private readonly injector = inject(Injector);

  readonly value = model.required<EffectSelection>();
  /**
   * Anzubietende Kategorien. Live-Suchen bei Scryfall geben nur die mit Abfrage herein
   * (CARD_EFFECT_FILTERS), lokal filternde Stellen alle (ALL_EFFECT_FILTERS).
   */
  readonly options = input<readonly CardEffectFilter[]>(ALL_EFFECT_FILTERS);

  readonly open = signal(false);
  /** Entwurf im offenen Popup - übernommen erst beim Schließen. */
  readonly draft = signal<EffectSelection>({ keys: new Set(), mode: 'all' });
  readonly search = signal('');

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly portal = viewChild.required(CdkPortal);
  private outlet: DomPortalOutlet | null = null;

  label(key: string): string {
    return this.i18n.t(`effectFilter.${key}`);
  }

  /** Gruppen mit ihren (nach Suchbegriff gefilterten) Einträgen, leere Gruppen fallen weg. */
  readonly groups = computed<{ group: EffectGroup; items: CardEffectFilter[] }[]>(() => {
    const term = this.search().trim().toLowerCase();
    // Sprachwechsel soll die Liste neu filtern - i18n.t() liest das Sprach-Signal.
    const matches = (f: CardEffectFilter) =>
      !term ||
      this.label(f.value).toLowerCase().includes(term) ||
      f.query.toLowerCase().includes(term);
    return EFFECT_GROUPS.map((group) => ({
      group,
      items: this.options().filter((f) => f.group === group && matches(f)),
    })).filter((g) => g.items.length > 0);
  });

  /** Beschriftung des Knopfes: "Alle Effekte", ein Name oder "3 Effekte · alle". */
  readonly summary = computed(() => {
    const keys = [...this.value().keys];
    if (keys.length === 0) return this.i18n.t('deckView.effectAll');
    if (keys.length === 1) return this.label(keys[0]);
    return this.i18n.t(
      this.value().mode === 'all' ? 'effectFilter.summaryAll' : 'effectFilter.summaryAny',
      { count: keys.length },
    );
  });

  isChecked(key: string): boolean {
    return this.draft().keys.has(key);
  }

  toggle(key: string): void {
    const keys = new Set(this.draft().keys);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    this.draft.update((d) => ({ ...d, keys }));
  }

  setMode(mode: 'all' | 'any'): void {
    this.draft.update((d) => ({ ...d, mode }));
  }

  clear(): void {
    this.draft.update((d) => ({ ...d, keys: new Set() }));
  }

  openMenu(): void {
    this.draft.set({ keys: new Set(this.value().keys), mode: this.value().mode });
    this.search.set('');
    if (!this.outlet) {
      const host = document.createElement('div');
      host.classList.add('effect-filter-portal');
      document.body.appendChild(host);
      this.outlet = new DomPortalOutlet(host, this.appRef, this.injector);
    }
    if (!this.outlet.hasAttached()) this.outlet.attach(this.portal());
    this.open.set(true);
  }

  /** Schließt und übernimmt den Entwurf - nur wenn sich etwas geändert hat (sonst unnötige Suche). */
  close(): void {
    if (!this.open()) return;
    this.open.set(false);
    this.outlet?.detach();
    const before = this.value();
    const after = this.draft();
    const sameKeys =
      before.keys.size === after.keys.size && [...after.keys].every((k) => before.keys.has(k));
    // Der Modus zählt nur, wenn er bei mehr als einem Tag etwas ändert.
    const sameMode = before.mode === after.mode || after.keys.size < 2;
    if (!sameKeys || !sameMode) this.value.set(after);
    this.trigger()?.nativeElement.focus();
  }

  ngOnDestroy(): void {
    this.outlet?.dispose();
    this.outlet = null;
  }
}
