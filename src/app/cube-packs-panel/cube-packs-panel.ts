import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../i18n.service';
import { CubeService } from '../cube.service';
import { CardPreviewService } from '../card-preview.service';
import { DialogService } from '../dialog.service';
import { CUBE_COLUMNS, CubeCardData } from '../cube-layout';
import {
  DEFAULT_PACK_SETTINGS,
  PACK_RULE_TYPES,
  PackRule,
  PackSettings,
  PackShortfall,
  buildPack,
  normalizePackSettings,
  packShortfalls,
  splitIntoPacks,
} from '../cube-packs';
import { Icon } from '../ui/icon/icon';

/** Eine Karte, wie sie die Booster brauchen: Kartendaten plus Bild. */
export interface PackCard extends CubeCardData {
  image: string | null;
  backImage: string | null;
}

/** Gespeicherte Aufteilung: nur Namen (sql/cube-packs-2026-10-19.sql). */
interface StoredSplit {
  at: string;
  packs: string[][];
  leftover: string[];
}

/**
 * Reiter "Booster" im Cube (Wunsch des Users, 19.10.2026): Packgröße und Mindestanteile je Pack
 * einstellen, Probe-Booster ziehen und den ganzen Cube in Packs aufteilen, um sie so vorzubereiten.
 * Einstellungen und Aufteilung hängen am Cube (cube_lists.pack_settings/pack_split), gerechnet
 * wird in cube-packs.ts.
 */
@Component({
  selector: 'app-cube-packs-panel',
  imports: [FormsModule, Icon],
  templateUrl: './cube-packs-panel.html',
  styleUrl: './cube-packs-panel.scss',
})
export class CubePacksPanel {
  readonly i18n = inject(I18nService);
  readonly cubes = inject(CubeService);
  private readonly preview = inject(CardPreviewService);
  private readonly dialog = inject(DialogService);

  readonly cubeId = input.required<string>();
  readonly items = input.required<readonly PackCard[]>();
  readonly editable = input(true);

  readonly settings = signal<PackSettings>(DEFAULT_PACK_SETTINGS);
  readonly sample = signal<{ pack: PackCard[]; shortfalls: PackShortfall[] } | null>(null);
  private readonly stored = signal<StoredSplit | null>(null);
  readonly copied = signal(false);
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Auswahl für eine Regel: Spalten, Typen, legendär - als "art:schlüssel". */
  readonly ruleOptions = [
    ...CUBE_COLUMNS.map((c) => ({ value: `column:${c}`, label: `cube.column.${c}` })),
    ...PACK_RULE_TYPES.map((t) => ({ value: `type:${t}`, label: `cube.ruleType.${t}` })),
    { value: 'legendary:', label: 'cube.ruleLegendary' },
  ];

  /** Gespeicherte Aufteilung wieder mit Karten verknüpft (Karten, die es nicht mehr gibt, fehlen). */
  readonly split = computed(() => {
    const stored = this.stored();
    if (!stored) return null;
    const byName = new Map(this.items().map((i) => [i.name.toLowerCase(), i]));
    const resolve = (names: string[]) =>
      names.map((n) => byName.get(n.toLowerCase())).filter((c): c is PackCard => !!c);
    const settings = this.settings();
    return {
      at: stored.at,
      packs: stored.packs.map((names) => {
        const cards = resolve(names);
        return { cards, shortfalls: packShortfalls(cards, settings.rules) };
      }),
      leftover: resolve(stored.leftover),
    };
  });

  readonly totalCards = computed(() => this.items().reduce((s, i) => s + i.quantity, 0));
  readonly possiblePacks = computed(() =>
    Math.floor(this.totalCards() / Math.max(1, this.settings().size)),
  );
  readonly minSum = computed(() => this.settings().rules.reduce((s, r) => s + r.min, 0));

  constructor() {
    effect(() => {
      const id = this.cubeId();
      untracked(() => {
        this.sample.set(null);
        this.stored.set(null);
        this.settings.set(DEFAULT_PACK_SETTINGS);
      });
      void this.cubes.loadPackData(id).then((data) => {
        if (!data || this.cubeId() !== id) return;
        this.settings.set(normalizePackSettings(data.settings));
        const split = data.split as StoredSplit | null;
        if (split && Array.isArray(split.packs)) this.stored.set(split);
      });
    });
  }

  // --- Einstellungen ----------------------------------------------------------------------

  setSize(value: number): void {
    const size = Math.max(1, Math.min(60, Math.round(Number(value)) || 1));
    this.update({ ...this.settings(), size });
  }

  addRule(): void {
    this.update({
      ...this.settings(),
      rules: [...this.settings().rules, { kind: 'column', key: 'W', min: 1 }],
    });
  }

  /** "Je Farbe": eine Regel für jede der fünf Farben, sofern es sie noch nicht gibt. */
  addColorRules(): void {
    const rules = [...this.settings().rules];
    for (const c of ['W', 'U', 'B', 'R', 'G']) {
      if (!rules.some((r) => r.kind === 'column' && r.key === c))
        rules.push({ kind: 'column', key: c, min: 1 });
    }
    this.update({ ...this.settings(), rules });
  }

  ruleValue(rule: PackRule): string {
    return `${rule.kind}:${rule.key}`;
  }

  setRuleTarget(index: number, value: string): void {
    const [kind, key] = value.split(':') as [PackRule['kind'], string];
    this.patchRule(index, { kind, key: key ?? '' });
  }

  setRuleMin(index: number, value: number): void {
    this.patchRule(index, { min: Math.max(0, Math.min(60, Math.round(Number(value)) || 0)) });
  }

  removeRule(index: number): void {
    this.update({
      ...this.settings(),
      rules: this.settings().rules.filter((_, i) => i !== index),
    });
  }

  private patchRule(index: number, patch: Partial<PackRule>): void {
    this.update({
      ...this.settings(),
      rules: this.settings().rules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    });
  }

  private update(settings: PackSettings): void {
    this.settings.set(settings);
    if (!this.editable()) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const id = this.cubeId();
    this.saveTimer = setTimeout(() => void this.cubes.savePackData(id, { settings }), 600);
  }

  ruleLabel(rule: PackRule): string {
    return this.i18n.t(this.ruleOptions.find((o) => o.value === this.ruleValue(rule))?.label ?? '');
  }

  // --- Booster ----------------------------------------------------------------------------

  newSample(): void {
    this.sample.set(buildPack(this.items(), this.settings()));
  }

  async splitCube(): Promise<void> {
    if (this.stored() && !(await this.dialog.confirm(this.i18n.t('cube.packSplitReplace')))) return;
    const result = splitIntoPacks(this.items(), this.settings());
    const stored: StoredSplit = {
      at: new Date().toISOString(),
      packs: result.packs.map((p) => p.map((c) => c.name)),
      leftover: result.leftover.map((c) => c.name),
    };
    this.stored.set(stored);
    if (this.editable()) await this.cubes.savePackData(this.cubeId(), { split: stored });
  }

  /** Aufteilung als Text ("Pack 1" und darunter die Karten) zum Ausdrucken oder Abhaken. */
  async copySplit(): Promise<void> {
    const split = this.split();
    if (!split) return;
    const lines: string[] = [];
    split.packs.forEach((p, i) => {
      lines.push(this.i18n.t('cube.packTitle', { n: i + 1 }));
      lines.push(...p.cards.map((c) => `  ${c.name}`), '');
    });
    if (split.leftover.length) {
      lines.push(this.i18n.t('cube.packLeftover', { count: split.leftover.length }));
      lines.push(...split.leftover.map((c) => `  ${c.name}`));
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      /* Zwischenablage gesperrt - dann eben nicht. */
    }
  }

  shortfallText(shortfalls: PackShortfall[]): string {
    return shortfalls.map((s) => `${this.ruleLabel(s.rule)} ${s.have}/${s.rule.min}`).join(', ');
  }

  openPreview(card: PackCard): void {
    if (card.image) this.preview.open(card.image, card.backImage, card.name);
  }
}
