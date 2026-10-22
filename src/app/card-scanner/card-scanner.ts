import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../i18n.service';
import { CollectionService } from '../collection.service';
import { CardScanService, ScanHit } from '../card-scan.service';
import { ArtLanguageService } from '../art-language.service';
import { ART_LANGUAGES } from '../art-languages';
import { Icon } from '../ui/icon/icon';

interface RecentScan extends ScanHit {
  key: number;
}

function canToggleFoil(item: ScanHit): boolean {
  const finishes = item.print.finishes;
  return finishes.includes('nonfoil') && finishes.some((f) => f !== 'nonfoil');
}

/**
 * Mittlere Helligkeitsänderung je Pixel (0-255) zum vorigen Bild, über der gerade eine Karte
 * gewechselt wird. Eine Hand, die das Handy hält, zittert immer: gemessen 5-15 zwischen zwei
 * Bildern. Die erste Fassung wartete auf unter 5 in zwei Bildern hintereinander - das kam in der
 * Hand praktisch nie vor, und der Scanner löste auf dem iPhone überhaupt nicht aus.
 */
const MOTION = 22;
/** Abstand zum Bild des letzten Treffers, ab dem eine andere Karte (oder keine) im Rahmen liegt. */
const CHANGED = 25;
/** Suchbereich um den Rahmen herum, je Seite in Anteilen der Rahmengröße. */
const SEARCH_MARGIN = 0.15;
/** Frühestens so oft ein neuer Versuch, solange die Karte nicht erkannt wird. */
const RETRY_MS = 600;
/** Unter dieser Streuung liegt keine Karte im Rahmen, nur Tisch. */
const MIN_CONTRAST = 14;
const LANG_KEY = 'statsfinity.scanLang';

/**
 * Kartenscanner der Sammlung: Kamera an, Karte in den Rahmen, sie wird erkannt und sofort
 * gespeichert - ohne Knopf zwischen zwei Karten (Wunsch des Users, 17.10.2026). Ausgelöst wird
 * ein Scan, sobald eine Karte im Rahmen liegt und nicht gerade bewegt wird; ohne Treffer wird es
 * laufend wieder versucht. Nach einem Treffer muss sich das Bild im Rahmen erst deutlich von
 * diesem Treffer unterscheiden, damit dieselbe Karte nicht doppelt zählt (vier gleiche Länder
 * hintereinander gehen trotzdem: Karte weg, nächste hin).
 * Die Erkennung selbst steht in card-scan.service.ts.
 */
@Component({
  selector: 'app-card-scanner',
  imports: [FormsModule, Icon],
  templateUrl: './card-scanner.html',
  styleUrl: './card-scanner.scss',
})
export class CardScanner implements OnInit, OnDestroy {
  readonly i18n = inject(I18nService);
  readonly scan = inject(CardScanService);
  private readonly collection = inject(CollectionService);
  private readonly artLanguage = inject(ArtLanguageService);

  readonly closed = output<void>();
  readonly languages = ART_LANGUAGES;

  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private readonly guide = viewChild.required<ElementRef<HTMLDivElement>>('guide');

  readonly status = signal<
    'starting' | 'ready' | 'reading' | 'notFound' | 'glare' | 'saved' | 'error'
  >('starting');
  readonly error = signal<string | null>(null);
  readonly recent = signal<RecentScan[]>([]);
  readonly flash = signal(false);
  readonly fallbackLang = signal<string>(this.readLang());
  /**
   * Foil-Stapel: jede erkannte Karte zählt als Foil, sofern es sie als Foil gibt. Den Stern in der
   * Sammlerzeile liest die Kamera auf dem iPhone kaum je (gut 1 mm, und bei Foil spiegelt er), und
   * am Bild allein ist Foil nicht sicher zu erkennen - wer einen Stapel Foils scannt, sagt es
   * deshalb einmal vorher (Wunsch des Users, 20.10.2026).
   */
  readonly foilMode = signal(false);

  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private previous: Float32Array | null = null;
  /** Kleines Bild des letzten Treffers; solange der Rahmen ihm gleicht, wird nicht gescannt. */
  private lastHit: Float32Array | null = null;
  private lastAttempt = 0;
  /**
   * Gegen Doppelzählung bei starkem Zittern: derselbe Druck zählt kurz nach dem letzten Treffer
   * nur, wenn der Rahmen dazwischen leer war (Karte weggenommen).
   */
  private lastHitKey: string | null = null;
  private lastHitAt = 0;
  private sawEmpty = false;
  private readonly small = document.createElement('canvas');
  /** Der Ausschnitt in voller Kameraauflösung, für die Nahaufnahme der Ecke - wiederverwendet,
   *  Safari begrenzt den Speicher aller Canvas zusammen. */
  private readonly detail = document.createElement('canvas');
  private scanCounter = 0;

  async ngOnInit(): Promise<void> {
    void this.collection.ensureLoaded();
    const prepared = this.scan.prepare();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          // So hoch wie die Kamera kann: Die Sammlerzeile ist auf der Karte gut 1 mm hoch, und
          // bei 1080p blieben davon auf dem iPhone kaum lesbare Pixel übrig. "ideal" scheitert
          // nicht, wenn die Kamera weniger kann - sie liefert dann ihr Bestes.
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
        audio: false,
      });
    } catch (e) {
      console.warn('Kamera nicht verfügbar:', e);
      this.status.set('error');
      this.error.set(this.i18n.t('collection.scanner.noCamera'));
      return;
    }
    const video = this.video().nativeElement;
    video.srcObject = this.stream;
    await video.play().catch(() => undefined);
    await prepared;
    this.status.set('ready');
    this.timer = setInterval(() => void this.tick(), 250);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
  }

  close(): void {
    this.closed.emit();
  }

  setFallbackLang(lang: string): void {
    this.fallbackLang.set(lang);
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      // privater Modus - gilt dann nur für diese Sitzung
    }
  }

  /** Foil/nicht Foil nachträglich umstellen - nur bei Drucken, die es in beiden Fassungen gibt. */
  async toggleFoil(item: RecentScan): Promise<void> {
    if (!canToggleFoil(item)) return;
    const ok = await this.collection.add(item.print, !item.foil, 1);
    if (!ok) return;
    await this.collection.add(item.print, item.foil, -1);
    this.recent.update((list) =>
      list.map((r) => (r.key === item.key ? { ...r, foil: !r.foil } : r)),
    );
  }

  canToggleFoil(item: RecentScan): boolean {
    return canToggleFoil(item);
  }

  async undo(item: RecentScan): Promise<void> {
    await this.collection.add(item.print, item.foil, -1);
    this.recent.update((list) => list.filter((r) => r !== item));
  }

  langLabel(code: string): string {
    return code.toUpperCase();
  }

  private readLang(): string {
    try {
      return localStorage.getItem(LANG_KEY) ?? this.artLanguage.lang();
    } catch {
      return this.artLanguage.lang();
    }
  }

  /** Rahmen (Bildschirm) -> Ausschnitt im Videobild, unter object-fit: cover. */
  private cropRect(): { x: number; y: number; w: number; h: number } | null {
    const video = this.video().nativeElement;
    if (!video.videoWidth) return null;
    const v = video.getBoundingClientRect();
    const g = this.guide().nativeElement.getBoundingClientRect();
    const scale = Math.max(v.width / video.videoWidth, v.height / video.videoHeight);
    const offX = (v.width - video.videoWidth * scale) / 2;
    const offY = (v.height - video.videoHeight * scale) / 2;
    return {
      x: (g.left - v.left - offX) / scale,
      y: (g.top - v.top - offY) / scale,
      w: g.width / scale,
      h: g.height / scale,
    };
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    const rect = this.cropRect();
    if (!rect) return;
    const video = this.video().nativeElement;

    this.small.width = 24;
    this.small.height = 32;
    const sctx = this.small.getContext('2d', { willReadFrequently: true });
    if (!sctx) return;
    sctx.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, 24, 32);
    const px = sctx.getImageData(0, 0, 24, 32).data;
    const gray = new Float32Array(24 * 32);
    let mean = 0;
    for (let i = 0; i < gray.length; i++) {
      gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
      mean += gray[i];
    }
    mean /= gray.length;
    let spread = 0;
    let diff = 0;
    let sinceHit = 0;
    for (let i = 0; i < gray.length; i++) {
      spread += Math.abs(gray[i] - mean);
      if (this.previous) diff += Math.abs(gray[i] - this.previous[i]);
      if (this.lastHit) sinceHit += Math.abs(gray[i] - this.lastHit[i]);
    }
    spread /= gray.length;
    diff = this.previous ? diff / gray.length : 255;
    sinceHit = this.lastHit ? sinceHit / gray.length : 255;
    this.previous = gray;

    // Karte weg oder eine andere im Rahmen: der letzte Treffer sperrt nicht mehr.
    if (spread < MIN_CONTRAST) this.sawEmpty = true;
    if (this.lastHit && (sinceHit > CHANGED || spread < MIN_CONTRAST)) this.lastHit = null;
    if (this.lastHit || spread < MIN_CONTRAST || diff > MOTION) return;
    if (Date.now() - this.lastAttempt < RETRY_MS) return;

    this.busy = true;
    this.lastAttempt = Date.now();
    this.status.set('reading');
    try {
      // Gesucht wird nicht nur im Rahmen, sondern mit einem Rand ringsum: Die Karte muss nur
      // ungefähr drinliegen und darf überstehen (Wunsch des Users, 18.10.2026). Wo genau sie
      // liegt, findet card-bounds.ts.
      const mx = rect.w * SEARCH_MARGIN;
      const my = rect.h * SEARCH_MARGIN;
      const x0 = Math.max(0, rect.x - mx);
      const y0 = Math.max(0, rect.y - my);
      const x1 = Math.min(video.videoWidth, rect.x + rect.w + mx);
      const y1 = Math.min(video.videoHeight, rect.y + rect.h + my);
      const frame = document.createElement('canvas');
      frame.width = Math.round(Math.min(x1 - x0, 1800));
      frame.height = Math.round((frame.width * (y1 - y0)) / (x1 - x0));
      frame
        .getContext('2d')
        ?.drawImage(video, x0, y0, x1 - x0, y1 - y0, 0, 0, frame.width, frame.height);
      const guide = [
        (rect.x - x0) / (x1 - x0),
        (rect.y - y0) / (y1 - y0),
        (rect.x + rect.w - x0) / (x1 - x0),
        (rect.y + rect.h - y0) / (y1 - y0),
      ] as const;
      // Die Sammlerzeile ist gut 1 mm hoch: Für sie zählt jedes Kamerapixel, `frame` ist dafür
      // verkleinert (Artwork und Kantensuche brauchen die Auflösung nicht).
      let detail: HTMLCanvasElement | undefined;
      if (x1 - x0 > frame.width) {
        detail = this.detail;
        detail.width = Math.round(x1 - x0);
        detail.height = Math.round(y1 - y0);
        detail
          .getContext('2d')
          ?.drawImage(video, x0, y0, x1 - x0, y1 - y0, 0, 0, detail.width, detail.height);
      }
      const found = await this.scan.identify(frame, guide, this.fallbackLang(), detail);
      if (!found) {
        this.status.set(this.scan.glare() ? 'glare' : 'notFound');
        return;
      }
      const hit =
        this.foilMode() && found.print.finishes.some((f) => f !== 'nonfoil')
          ? { ...found, foil: true }
          : found;
      const key = `${hit.print.scryfallId}|${hit.foil}`;
      if (key === this.lastHitKey && !this.sawEmpty && Date.now() - this.lastHitAt < 4000) {
        this.lastHit = gray;
        this.status.set('saved');
        return;
      }
      const ok = await this.collection.add(hit.print, hit.foil, 1);
      if (!ok) {
        this.status.set('error');
        this.error.set(this.i18n.t('collection.saveFailed'));
        return;
      }
      this.lastHit = gray;
      this.lastHitKey = key;
      this.lastHitAt = Date.now();
      this.sawEmpty = false;
      this.recent.update((list) => [{ ...hit, key: ++this.scanCounter }, ...list].slice(0, 8));
      this.status.set('saved');
      this.flash.set(true);
      setTimeout(() => this.flash.set(false), 600);
      navigator.vibrate?.(60);
    } finally {
      this.busy = false;
    }
  }
}
