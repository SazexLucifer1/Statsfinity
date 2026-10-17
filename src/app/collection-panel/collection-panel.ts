import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../i18n.service';
import { CollectionService } from '../collection.service';
import { CollectionEntry, CollectionPrint, printImageUrl } from '../collection-coverage';
import { CardPreviewService } from '../card-preview.service';
import { ART_LANGUAGES } from '../art-languages';
import { Pager } from '../ui/pager/pager';
import { Icon } from '../ui/icon/icon';
import { CardScanner } from '../card-scanner/card-scanner';

type SortMode = 'added' | 'name' | 'set';

/**
 * Sammlung im Profil: eigene (bearbeitbar, mit Hinzufügen und Scanner) oder die eines Freundes
 * (nur lesen - RLS liefert sie nur Freunden, sql/sammlung-2026-10-17.sql). Eine Zeile je Druck
 * und Foil; Sprachen lassen sich einzeln ein- und ausblenden.
 */
@Component({
  selector: 'app-collection-panel',
  imports: [FormsModule, Pager, Icon, CardScanner],
  templateUrl: './collection-panel.html',
  styleUrl: './collection-panel.scss',
})
export class CollectionPanel {
  readonly i18n = inject(I18nService);
  readonly collection = inject(CollectionService);
  private readonly preview = inject(CardPreviewService);

  /** null = eigene Sammlung. */
  readonly userId = input<string | null>(null);

  readonly PAGE_SIZE = 25;
  private readonly friendEntries = signal<CollectionEntry[] | null>(null);
  readonly entries = computed(
    () => (this.userId() ? this.friendEntries() : this.collection.entries()) ?? [],
  );
  readonly loaded = computed(
    () => (this.userId() ? this.friendEntries() : this.collection.entries()) !== null,
  );
  readonly editable = computed(() => !this.userId());

  readonly langFilter = signal<ReadonlySet<string>>(new Set());
  readonly search = signal('');
  readonly sort = signal<SortMode>('added');
  readonly page = signal(0);

  readonly scannerOpen = signal(false);

  // Hinzufügen per Suche
  readonly addOpen = signal(false);
  readonly addQuery = signal('');
  readonly suggestions = signal<string[]>([]);
  readonly addCardName = signal<string | null>(null);
  readonly prints = signal<CollectionPrint[]>([]);
  readonly printsBusy = signal(false);
  readonly addFoil = signal(false);
  readonly addLangFilter = signal<string | null>(null);
  private suggestTimer: ReturnType<typeof setTimeout> | null = null;

  /** Sprachen, die in der Sammlung vorkommen, mit Kartenzahl - Reihenfolge wie im Profil. */
  readonly languages = computed(() => {
    const counts = new Map<string, number>();
    for (const e of this.entries()) counts.set(e.lang, (counts.get(e.lang) ?? 0) + e.quantity);
    const order = ART_LANGUAGES.map((l) => l.code as string);
    return [...counts.entries()]
      .sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99))
      .map(([code, count]) => ({ code, count }));
  });

  readonly totalCards = computed(() => this.entries().reduce((sum, e) => sum + e.quantity, 0));
  readonly distinctCards = computed(() => new Set(this.entries().map((e) => e.cardName)).size);

  readonly filtered = computed(() => {
    const langs = this.langFilter();
    const q = this.search().trim().toLowerCase();
    const list = this.entries().filter(
      (e) =>
        (langs.size === 0 || langs.has(e.lang)) && (!q || e.cardName.toLowerCase().includes(q)),
    );
    const sort = this.sort();
    return [...list].sort((a, b) =>
      sort === 'name'
        ? a.cardName.localeCompare(b.cardName)
        : sort === 'set'
          ? a.setCode.localeCompare(b.setCode) || collectorOrder(a) - collectorOrder(b)
          : b.addedAt.localeCompare(a.addedAt),
    );
  });

  readonly visible = computed(() => {
    const start = this.page() * this.PAGE_SIZE;
    return this.filtered().slice(start, start + this.PAGE_SIZE);
  });

  readonly shownPrints = computed(() => {
    const lang = this.addLangFilter();
    return lang ? this.prints().filter((p) => p.lang === lang) : this.prints();
  });
  readonly printLanguages = computed(() => [...new Set(this.prints().map((p) => p.lang))]);

  constructor() {
    effect(() => {
      const uid = this.userId();
      this.page.set(0);
      if (!uid) {
        void this.collection.ensureLoaded();
        return;
      }
      this.friendEntries.set(null);
      void this.collection.loadFor(uid).then((rows) => {
        if (this.userId() === uid) this.friendEntries.set(rows);
      });
    });
  }

  image(entry: CollectionEntry): string {
    return printImageUrl(entry.scryfallId, 'small');
  }

  openPreview(entry: CollectionEntry): void {
    this.preview.open(printImageUrl(entry.scryfallId), null, entry.cardName);
  }

  toggleLang(code: string): void {
    this.langFilter.update((set) => {
      const next = new Set(set);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
    this.page.set(0);
  }

  clearLangs(): void {
    this.langFilter.set(new Set());
    this.page.set(0);
  }

  setSearch(value: string): void {
    this.search.set(value);
    this.page.set(0);
  }

  change(entry: CollectionEntry, delta: number): void {
    void this.collection.setQuantity(entry, entry.foil, entry.quantity + delta);
  }

  // --- Hinzufügen -------------------------------------------------------------------------

  openAdd(): void {
    this.addOpen.set(true);
    this.addQuery.set('');
    this.suggestions.set([]);
    this.addCardName.set(null);
    this.prints.set([]);
  }

  closeAdd(): void {
    this.addOpen.set(false);
  }

  onAddQuery(value: string): void {
    this.addQuery.set(value);
    if (this.suggestTimer) clearTimeout(this.suggestTimer);
    this.suggestTimer = setTimeout(async () => {
      const names = await this.collection.suggestNames(value);
      if (this.addQuery() === value) this.suggestions.set(names);
    }, 300);
  }

  async pickCard(name: string): Promise<void> {
    this.addCardName.set(name);
    this.addLangFilter.set(null);
    this.prints.set([]);
    this.printsBusy.set(true);
    const prints = await this.collection.printsOf(name);
    if (this.addCardName() !== name) return;
    this.prints.set(prints);
    this.printsBusy.set(false);
  }

  backToSearch(): void {
    this.addCardName.set(null);
    this.prints.set([]);
  }

  ownedOf(print: CollectionPrint): number {
    return this.collection.quantityOf(print.scryfallId, this.addFoil());
  }

  canFoil(print: CollectionPrint): boolean {
    return this.addFoil()
      ? print.finishes.some((f) => f !== 'nonfoil')
      : print.finishes.includes('nonfoil');
  }

  addPrint(print: CollectionPrint, delta: number): void {
    void this.collection.add(print, this.addFoil(), delta);
  }
}

function collectorOrder(entry: CollectionEntry): number {
  return parseInt(entry.collectorNumber, 10) || 0;
}
