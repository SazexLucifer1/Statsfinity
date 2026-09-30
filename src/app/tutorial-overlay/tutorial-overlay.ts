import { Component, OnDestroy, effect, inject, signal } from '@angular/core';
import { TutorialService } from '../tutorial.service';
import { I18nService } from '../i18n.service';

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface TooltipPosition {
  /** null = zentriert (kein Spotlight-Ziel für diesen Schritt). */
  top: number | null;
  left: number | null;
}

@Component({
  selector: 'app-tutorial-overlay',
  imports: [],
  templateUrl: './tutorial-overlay.html',
  styleUrl: './tutorial-overlay.scss',
})
export class TutorialOverlay implements OnDestroy {
  readonly tutorial = inject(TutorialService);
  readonly i18n = inject(I18nService);

  readonly targetRect = signal<SpotlightRect | null>(null);
  readonly tooltipPosition = signal<TooltipPosition>({ top: null, left: null });

  private resizeHandler = () => this.measure();

  constructor() {
    effect(() => {
      // Liest Signale, damit der Effect bei jedem Schrittwechsel neu misst.
      this.tutorial.activeTutorialId();
      this.tutorial.stepIndex();
      // Zwei rAF-Ticks abwarten: der Tab-Wechsel (navigation.goToTab) löst erst Change Detection
      // aus, das Ziel-Element existiert im DOM also frühestens im übernächsten Frame.
      requestAnimationFrame(() => requestAnimationFrame(() => this.measure()));
    });

    window.addEventListener('resize', this.resizeHandler);
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.resizeHandler);
  }

  private static readonly TOOLTIP_HEIGHT_ESTIMATE = 220;
  private static readonly TOOLTIP_WIDTH = 320;
  private static readonly MARGIN = 16;

  private measure(): void {
    const step = this.tutorial.currentStep();
    if (!this.tutorial.activeTutorialId() || !step) {
      this.targetRect.set(null);
      return;
    }
    const target = step.target;
    const el = target ? document.querySelector(`[data-tutorial="${target}"]`) : null;

    // Ein vorhandenes, aber leeres Element (z.B. ein Postfach ohne Inhalt) wie ein fehlendes behandeln.
    const initial = el ? TutorialOverlay.visibleRect(el) : null;
    if (!el || !initial || initial.width === 0 || initial.height === 0) {
      this.targetRect.set(null);
      this.tooltipPosition.set({ top: null, left: null });
      return;
    }

    // Ziel-Element kann außerhalb des sichtbaren Bereichs liegen (z.B. weiter unten auf der Seite) -
    // ohne dieses Scrollen würde die Tour dort optisch "verschwinden" (Tooltip mit den Weiter/
    // Zurück-Buttons liegt dann unerreichbar außerhalb des Viewports, obwohl die abgedunkelte
    // Overlay-Fläche weiter sichtbar bleibt).
    const scrollTarget =
      getComputedStyle(el).display === 'inline' ? (el.firstElementChild ?? el) : el;
    scrollTarget.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });

    const rect = TutorialOverlay.visibleRect(el);
    this.targetRect.set({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });

    const margin = TutorialOverlay.MARGIN;
    const tooltipWidth = TutorialOverlay.TOOLTIP_WIDTH;
    const tooltipHeightEstimate = TutorialOverlay.TOOLTIP_HEIGHT_ESTIMATE;
    const fitsBelow = rect.bottom + margin + tooltipHeightEstimate <= window.innerHeight;

    let top = fitsBelow
      ? rect.bottom + margin
      : Math.max(margin, rect.top - margin - tooltipHeightEstimate);
    // Sicherheitsnetz: Tooltip in JEDEM Fall innerhalb des Viewports halten, selbst wenn das
    // Ziel-Element (z.B. bei sehr kurzem Viewport) nicht vollständig mittig gescrollt werden konnte.
    top = Math.min(top, window.innerHeight - margin - 120);

    let left = rect.left + rect.width / 2 - tooltipWidth / 2;
    left = Math.min(Math.max(margin, left), window.innerWidth - tooltipWidth - margin);

    this.tooltipPosition.set({ top, left });
  }

  /**
   * Komponenten-Hosts (etwa `<app-deck-social data-tutorial="…">`) sind ohne eigene Stilregel
   * `display: inline` - ihr eigenes Rechteck ist dann flach oder leer, obwohl der Inhalt darin
   * blockweise steht. In dem Fall zählt die Fläche, die die Kinder zusammen einnehmen.
   */
  private static visibleRect(el: Element): {
    top: number;
    left: number;
    bottom: number;
    width: number;
    height: number;
  } {
    const own = el.getBoundingClientRect();
    const children = Array.from(el.children)
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    if (getComputedStyle(el).display !== 'inline' || children.length === 0) return own;
    const top = Math.min(...children.map((r) => r.top));
    const left = Math.min(...children.map((r) => r.left));
    const bottom = Math.max(...children.map((r) => r.bottom));
    const right = Math.max(...children.map((r) => r.right));
    return { top, left, bottom, width: right - left, height: bottom - top };
  }

  skip(): void {
    this.tutorial.finish();
  }
}
