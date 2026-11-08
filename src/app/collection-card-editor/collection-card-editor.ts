import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../i18n.service';
import { CollectionService } from '../collection.service';
import {
  CardCondition,
  CollectionEntry,
  CollectionPrint,
  printImageUrl,
} from '../collection-coverage';
import { CardPreviewService } from '../card-preview.service';
import { ART_LANGUAGES } from '../art-languages';

/**
 * Bearbeiten-Blatt einer Karte in der Sammlung (Wunsch des Users, 06.11.2026: „beim Scannen oder
 * Eintragen falsch gemacht“): Anzahl, Foil, Sprache und Druck nachträglich ändern - für alle
 * Exemplare des Eintrags oder nur einige. Wie im Scanner ist jede Sprache wählbar, auch wenn
 * Scryfall den Druck darin nicht führt; dann bleibt Scryfalls Druck für Bild und Preis.
 */
@Component({
  selector: 'app-collection-card-editor',
  imports: [FormsModule],
  templateUrl: './collection-card-editor.html',
  styleUrl: './collection-card-editor.scss',
})
export class CollectionCardEditor {
  readonly i18n = inject(I18nService);
  readonly collection = inject(CollectionService);
  private readonly preview = inject(CardPreviewService);

  readonly entry = input.required<CollectionEntry>();
  readonly closed = output<void>();

  readonly languages = ART_LANGUAGES;

  /** Alle Drucke der Karte in allen Sprachen; null = lädt noch. */
  readonly prints = signal<CollectionPrint[] | null>(null);
  readonly variantKey = signal('');
  readonly lang = signal('en');
  readonly foil = signal(false);
  /** Zustand - nur hier von Hand, der Scanner trägt immer Near Mint ein. */
  readonly condition = signal<CardCondition>('nm');
  readonly count = signal(1);
  readonly busy = signal(false);
  readonly failed = signal(false);

  /** Aktueller Stand des Eintrags in der Sammlung - ändert sich mit −/+. */
  readonly current = computed(() => {
    const e = this.entry();
    return (
      this.collection
        .entries()
        ?.find(
          (x) =>
            x.scryfallId === e.scryfallId &&
            x.foil === e.foil &&
            x.lang === e.lang &&
            (x.condition ?? 'nm') === (e.condition ?? 'nm'),
        ) ?? null
    );
  });

  /** Ein Eintrag je Set und Nummer, beschriftet mit dem englischen Druck, wenn es ihn gibt. */
  readonly variants = computed(() => {
    const byKey = new Map<string, CollectionPrint>();
    for (const p of this.prints() ?? [this.fromEntry()]) {
      const key = keyOf(p);
      const had = byKey.get(key);
      if (!had || (had.lang !== 'en' && p.lang === 'en')) byKey.set(key, p);
    }
    if (!byKey.has(keyOf(this.fromEntry()))) byKey.set(keyOf(this.fromEntry()), this.fromEntry());
    return [...byKey.entries()].map(([key, p]) => ({
      key,
      label: `${p.setCode.toUpperCase()} #${p.collectorNumber}${p.setName ? ' · ' + p.setName : ''}`,
    }));
  });

  /** Der Druck, auf den umgestellt würde. */
  readonly target = computed<CollectionPrint>(() => {
    const key = this.variantKey();
    const lang = this.lang();
    const list = this.prints() ?? [];
    const exact = list.find((p) => keyOf(p) === key && p.lang === lang);
    if (exact) return exact;
    const base =
      list.find((p) => keyOf(p) === key && p.lang === 'en') ??
      list.find((p) => keyOf(p) === key) ??
      this.fromEntry();
    return { ...base, lang, printLang: base.printLang ?? base.lang };
  });
  readonly unlisted = computed(() => {
    const t = this.target();
    return !!t.printLang && t.printLang !== t.lang;
  });
  readonly canFoil = computed(() => this.target().finishes.some((f) => f !== 'nonfoil'));
  readonly canNonfoil = computed(() => this.target().finishes.includes('nonfoil'));
  readonly changed = computed(() => {
    const e = this.entry();
    const t = this.target();
    return (
      t.scryfallId !== e.scryfallId ||
      t.lang !== e.lang ||
      this.foil() !== e.foil ||
      this.condition() !== (e.condition ?? 'nm')
    );
  });
  readonly counts = computed(() =>
    Array.from({ length: this.current()?.quantity ?? 0 }, (_, i) => i + 1),
  );

  constructor() {
    effect(() => {
      const e = this.entry();
      this.variantKey.set(`${e.setCode}|${e.collectorNumber}`.toLowerCase());
      this.lang.set(e.lang);
      this.foil.set(e.foil);
      this.condition.set(e.condition ?? 'nm');
      this.count.set(e.quantity);
      this.prints.set(null);
      void this.collection.printsOf(e.cardName).then((list) => {
        if (this.entry() === e) this.prints.set(list);
      });
    });
    // Gibt es den Druck nur in einer Fassung, steht Foil fest.
    effect(() => {
      if (this.foil() && !this.canFoil()) this.foil.set(false);
      else if (!this.foil() && !this.canNonfoil() && this.canFoil()) this.foil.set(true);
    });
  }

  image(): string {
    return this.target().imageUrl || printImageUrl(this.target().scryfallId);
  }

  openPreview(): void {
    this.preview.open(this.image(), null, this.entry().cardName);
  }

  async changeQuantity(delta: number): Promise<void> {
    const c = this.current();
    if (!c) return;
    await this.collection.setQuantity(c, c.foil, c.quantity + delta);
    if (!this.current()) this.closed.emit();
    else this.count.set(Math.min(this.count(), this.current()!.quantity));
  }

  async apply(): Promise<void> {
    const c = this.current();
    if (!c || !this.changed()) return;
    this.busy.set(true);
    this.failed.set(false);
    const ok = await this.collection.moveCopies(
      c,
      this.target(),
      this.foil(),
      this.count(),
      this.condition(),
    );
    this.busy.set(false);
    if (ok) this.closed.emit();
    else this.failed.set(true);
  }

  async remove(): Promise<void> {
    const c = this.current();
    if (!c) return;
    await this.collection.setQuantity(c, c.foil, 0);
    this.closed.emit();
  }

  private fromEntry(): CollectionPrint {
    const e = this.entry();
    return {
      scryfallId: e.scryfallId,
      cardName: e.cardName,
      printedName: null,
      lang: e.lang,
      setCode: e.setCode,
      setName: '',
      collectorNumber: e.collectorNumber,
      illustrationId: e.illustrationId,
      imageUrl: printImageUrl(e.scryfallId),
      finishes: ['nonfoil', 'foil'],
    };
  }
}

function keyOf(p: { setCode: string; collectorNumber: string }): string {
  return `${p.setCode}|${p.collectorNumber}`.toLowerCase();
}
