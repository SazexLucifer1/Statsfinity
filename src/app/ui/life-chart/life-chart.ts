import { Component, computed, input, signal } from '@angular/core';
import { LifeLog } from '../../models';

/**
 * Lebenspunkte-Verlauf einer Partie als Stufenlinie je Spieler (matches.life_log,
 * sql/partie-verlauf-2026-10-04.sql). Eine Achse (Leben), Zeit nach rechts.
 *
 * Farben: die acht Kategorie-Farben der dunklen Fläche in fester Reihenfolge, geprüft mit dem
 * Palette-Validator gegen --surface-sheet (#14102a): Helligkeitsband, Sättigung, Abstand für
 * Farbfehlsichtige (schlechtestes Nachbarpaar ΔE 8,4) und Kontrast ≥ 3:1. Die Identität trägt
 * trotzdem nie die Farbe allein - die Legende steht immer darunter, bis vier Spieler auch der Name
 * am Linienende. Beim Antippen/Überfahren zeigt eine senkrechte Linie die Werte aller Spieler zu
 * diesem Zeitpunkt.
 */
export const LIFE_CHART_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

const W = 320;
const H = 170;
const PAD = { top: 10, right: 56, bottom: 22, left: 30 };

interface Series {
  label: string;
  color: string;
  /** Stufen: [Sekunde, Leben] - der Wert gilt ab dieser Sekunde. */
  steps: [number, number][];
  final: number;
}

@Component({
  selector: 'app-life-chart',
  templateUrl: './life-chart.html',
  styleUrl: './life-chart.scss',
})
export class LifeChart {
  readonly log = input.required<LifeLog>();
  /** Anzeigenamen je Einheit (Schlüssel aus log.units), z. B. "Anna & Ben" statt "Team 1". */
  readonly labels = input<Record<string, string>>({});
  readonly ariaLabel = input('');

  readonly W = W;
  readonly H = H;
  readonly PAD = PAD;

  readonly series = computed<Series[]>(() => {
    const log = this.log();
    const names = this.labels();
    return log.units.map((unit, i) => {
      let life = log.start;
      const steps: [number, number][] = [[0, life]];
      for (const e of log.events) {
        if (e[1] !== i || e[3] === 1) continue;
        life += e[2];
        steps.push([e[0], life]);
      }
      return { label: names[unit] ?? unit, color: LIFE_CHART_COLORS[i % LIFE_CHART_COLORS.length], steps, final: life };
    });
  });

  readonly duration = computed(() => {
    const last = Math.max(0, ...this.log().events.map((e) => e[0]));
    return Math.max(60, last);
  });

  private readonly yRange = computed(() => {
    const values = this.series().flatMap((s) => s.steps.map(([, v]) => v));
    const min = Math.min(0, ...values);
    const max = Math.max(this.log().start, ...values);
    return { min, max: max === min ? min + 1 : max };
  });

  x(sec: number): number {
    return PAD.left + (sec / this.duration()) * (W - PAD.left - PAD.right);
  }

  y(v: number): number {
    const { min, max } = this.yRange();
    return PAD.top + (1 - (v - min) / (max - min)) * (H - PAD.top - PAD.bottom);
  }

  path(s: Series): string {
    let d = '';
    s.steps.forEach(([t, v], i) => {
      d += i === 0 ? `M${this.x(t)},${this.y(v)}` : `H${this.x(t)}V${this.y(v)}`;
    });
    return d + `H${this.x(this.duration())}`;
  }

  readonly yTicks = computed(() => {
    const { min, max } = this.yRange();
    const step = max - min > 60 ? 20 : 10;
    const ticks: number[] = [];
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
    return ticks;
  });

  readonly xTicks = computed(() => {
    const d = this.duration();
    const minutes = d / 60;
    const step = minutes > 90 ? 30 : minutes > 40 ? 15 : minutes > 15 ? 5 : 1;
    const ticks: number[] = [];
    for (let m = 0; m <= minutes; m += step) ticks.push(m * 60);
    return ticks;
  });

  /** Direkte Beschriftung am Linienende nur bis vier Spieler, sonst wird es ein Knäuel. */
  readonly directLabels = computed(() => this.series().length <= 4);

  // --- Hover/Tippen: senkrechte Linie mit den Werten zu diesem Zeitpunkt ---
  readonly hoverSec = signal<number | null>(null);

  onPointer(event: PointerEvent, svg: Element): void {
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const sec = ((px - PAD.left) / (W - PAD.left - PAD.right)) * this.duration();
    this.hoverSec.set(Math.max(0, Math.min(this.duration(), sec)));
  }

  valueAt(s: Series, sec: number): number {
    let v = s.steps[0][1];
    for (const [t, val] of s.steps) {
      if (t > sec) break;
      v = val;
    }
    return v;
  }

  minuteLabel(sec: number): string {
    return `${Math.round(sec / 60)}′`;
  }
}
