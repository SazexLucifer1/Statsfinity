import { Component, computed, inject, input } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { I18nService } from '../i18n.service';
import { CollectionItem } from '../collection-filter';
import { CardRank, CountBucket, PRICE_TIERS, collectionStats } from '../collection-stats';
import { printImageUrl } from '../collection-coverage';
import { translateSectionLabel } from '../deck-analyse';
import { BarChart, BarChartDatum } from '../ui/bar-chart/bar-chart';
import { CardThumb } from '../ui/card-thumb/card-thumb';
import { InfoToggle } from '../ui/info-toggle/info-toggle';
import { Meter } from '../ui/meter/meter';

/** Wie viele Sets im Diagramm stehen - der Rest ist eine lange Liste, die niemand liest. */
const TOP_SETS = 8;

/**
 * Reiter „Statistik“ der Sammlung (Wunsch des Users, 06.11.2026): Kennzahlen, wie viel davon in
 * eigenen Decks steckt, Verteilungen und Toplisten. Gerechnet in collection-stats.ts über die
 * Einträge, die gerade durch die Filter der Sammlung kommen.
 */
@Component({
  selector: 'app-collection-stats',
  imports: [DecimalPipe, BarChart, CardThumb, InfoToggle, Meter],
  templateUrl: './collection-stats.html',
  styleUrl: './collection-stats.scss',
})
export class CollectionStats {
  readonly i18n = inject(I18nService);

  readonly items = input.required<readonly CollectionItem[]>();
  /** Nur bei der eigenen Sammlung weiß die App, was in Decks steckt. */
  readonly usageKnown = input(false);
  readonly setLabel = input<(code: string) => string>((c) => c.toUpperCase());

  readonly stats = computed(() => collectionStats(this.items()));

  readonly playedDistinctPercent = computed(() =>
    percent(this.stats().usage.distinctPlayed, this.stats().distinct),
  );
  readonly playedCopiesPercent = computed(() =>
    percent(this.stats().usage.copiesPlayed, this.stats().copies),
  );
  readonly playedValuePercent = computed(() =>
    percent(this.stats().usage.valuePlayed, this.stats().value),
  );
  readonly foilPercent = computed(() => percent(this.stats().foilCopies, this.stats().copies));

  readonly colorChart = computed<BarChartDatum[]>(() =>
    this.stats().colors.map((b) => ({
      label:
        b.key === 'M' ? this.i18n.t('collection.stats.multicolor') : this.i18n.t(`pip.${b.key}`),
      value: b.copies,
      // Mehrfarbig ohne eigene Farbe: der Akzentton der Diagramme.
      color: b.key === 'M' ? undefined : `var(--pip-${b.key.toLowerCase()})`,
      symbol: b.key === 'M' ? undefined : b.key,
      detail: this.money(b.value),
    })),
  );
  /** Farben stehen als Manasymbol; nur „Mehrfarbig“ braucht Platz für ein Wort. */
  readonly colorLabelWidth = computed(() =>
    this.stats().colors.some((b) => b.key === 'M') ? '6rem' : '22px',
  );
  readonly curveChart = computed<BarChartDatum[]>(() =>
    this.stats().curve.map((b) => ({ label: b.key === '7' ? '7+' : b.key, value: b.copies })),
  );
  readonly typeChart = computed<BarChartDatum[]>(() =>
    this.stats().types.map((b) => ({
      label: translateSectionLabel(this.i18n, b.key),
      value: b.copies,
      detail: this.money(b.value),
    })),
  );
  readonly rarityChart = computed<BarChartDatum[]>(() =>
    this.stats().rarities.map((b) => ({
      label: b.key ? this.i18n.t(`collection.rarity.${b.key}`) : this.i18n.t('collection.unknown'),
      value: b.copies,
      detail: this.money(b.value),
    })),
  );
  readonly priceChart = computed<BarChartDatum[]>(() =>
    this.stats().priceTiers.map((b) => ({
      label: tierLabel(Number(b.key)),
      value: b.copies,
      detail: this.money(b.value),
    })),
  );
  readonly setChart = computed<BarChartDatum[]>(() =>
    this.stats()
      .setList.slice(0, TOP_SETS)
      .map((b) => ({
        label: this.setLabel()(b.key),
        value: b.copies,
        detail: this.money(b.value),
      })),
  );
  readonly langChart = computed<BarChartDatum[]>(() =>
    this.stats().langs.map((b: CountBucket) => ({ label: b.key.toUpperCase(), value: b.copies })),
  );

  image(rank: CardRank): string {
    return printImageUrl(rank.item.entry.scryfallId, 'small');
  }

  private money(value: number): string {
    return value > 0 ? `${value.toFixed(2)} €` : '';
  }
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function tierLabel(i: number): string {
  const euro = (v: number) => `${v.toFixed(v < 1 ? 2 : 0)} €`;
  if (i === 0) return `< ${euro(PRICE_TIERS[0])}`;
  if (i >= PRICE_TIERS.length) return `≥ ${euro(PRICE_TIERS[PRICE_TIERS.length - 1])}`;
  return `${euro(PRICE_TIERS[i - 1])} – ${euro(PRICE_TIERS[i])}`;
}
