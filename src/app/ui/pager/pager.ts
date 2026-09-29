import { Component, computed, inject, input, output } from '@angular/core';
import { I18nService } from '../../i18n.service';

/**
 * Seitenblätterer "◀ 1-10 von 42 ▶".
 *
 * Dieselben zwölf Zeilen standen vorher siebenmal in der App (viermal allein im Statistik-Tab,
 * dazu in deck-list, commander-stat-list, public-card-search und
 * public-deck-browser), jedes Mal mit eigenen prev/next/effectivePage-Methoden daneben.
 */
@Component({
  selector: 'app-pager',
  templateUrl: './pager.html',
  styleUrl: './pager.scss',
})
export class Pager {
  readonly i18n = inject(I18nService);

  /** Aktuelle Seite, nullbasiert. */
  readonly page = input.required<number>();
  readonly totalItems = input.required<number>();
  readonly pageSize = input(10);

  readonly pageChange = output<number>();

  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.totalItems() / this.pageSize())));
  /** Gegen eine Seitenzahl, die nach dem Filtern hinter dem Ende liegt. */
  readonly effectivePage = computed(() => Math.min(this.page(), this.totalPages() - 1));
  readonly rangeStart = computed(() => this.effectivePage() * this.pageSize() + 1);
  readonly rangeEnd = computed(() =>
    Math.min(this.totalItems(), (this.effectivePage() + 1) * this.pageSize()),
  );

  prev(): void {
    if (this.effectivePage() > 0) this.pageChange.emit(this.effectivePage() - 1);
  }

  next(): void {
    if (this.effectivePage() < this.totalPages() - 1) this.pageChange.emit(this.effectivePage() + 1);
  }
}
