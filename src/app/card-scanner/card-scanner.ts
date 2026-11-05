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
import { ScanSampleService } from '../scan-sample.service';
import { CollectionPrint } from '../collection-coverage';
import { ArtLanguageService } from '../art-language.service';
import { ART_LANGUAGES } from '../art-languages';
import { Icon } from '../ui/icon/icon';

interface RecentScan extends ScanHit {
  key: number;
  /** Derselbe Druck in allen Sprachen, zum Umstellen (lädt nach dem Treffer). */
  languages?: CollectionPrint[];
  /** Drucke mit demselben Artwork, je Set einer - zum Umstellen eines falsch erkannten Sets. */
  sets?: CollectionPrint[];
  /** Gespeicherte Scan-Probe zu diesem Treffer, für Korrekturen (scan-sample.service.ts). */
  sampleId?: string;
}

/**
 * Derselbe Druck in einer anderen Sprache, die Scryfall dafür nicht führt: Druck-ID, Bild und Preis
 * bleiben, nur `lang` wechselt. `printLang` hält fest, in welcher Sprache der Druck bei Scryfall
 * steht.
 */
function withLang(print: CollectionPrint, lang: string): CollectionPrint {
  return { ...print, lang, printLang: print.printLang ?? print.lang };
}

function isUnlisted(print: CollectionPrint): boolean {
  return !!print.printLang && print.printLang !== print.lang;
}

/** Nach so vielen Fehlversuchen in Folge bei liegender Karte kommt einmal der Achtungston. */
const MISS_ALERT = 3;
const SOUND_KEY = 'scannerSound';

function readSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === '1';
  } catch {
    return false;
  }
}

/** Ohne Treffer höchstens alle so viele ms eine Scan-Probe - der Scanner versucht es alle 0,6 s. */
const MISS_SAMPLE_MS = 5000;

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
/**
 * Helligkeit, bei der die Schwellen oben gelten; dunklere Bilder werden darauf hochgerechnet.
 * Nicht weiter als bis `MIN_LIGHT` - fast schwarz ist kein Bild mehr, nur Rauschen.
 */
const NORMAL_LIGHT = 128;
const MIN_LIGHT = 20;
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
  readonly samples = inject(ScanSampleService);
  private lastMissSample = 0;
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
  /** Töne an (gemerkt im localStorage): hell = sicher erkannt, zwei tiefe = bitte hinsehen. */
  readonly sound = signal(readSound());
  private audio: AudioContext | null = null;
  /** Fehlversuche in Folge bei liegender Karte; ab MISS_ALERT einmal der Achtungston. */
  private missStreak = 0;
  private missAlerted = false;

  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private previous: Float32Array | null = null;
  /** Kleines Bild des letzten Treffers; solange der Rahmen ihm gleicht, wird nicht gescannt. */
  private lastHit: Float32Array | null = null;
  private lastAttempt = 0;
  /**
   * Gegen Doppelzählung: derselbe Druck zählt nach dem letzten Treffer nur, wenn der Rahmen
   * dazwischen leer war oder deutlich bewegt wurde (Karte weggenommen bzw. getauscht). Langsames
   * Verrutschen zählt nicht - das hat am 05.11.2026 17 von 22 gelöschten Treffern verdoppelt.
   */
  private lastHitKey: string | null = null;
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
    void this.samples.correct(item.sampleId, { foil: !item.foil });
  }

  canToggleFoil(item: RecentScan): boolean {
    return canToggleFoil(item);
  }

  /**
   * Andere Sprache für einen Treffer: tauscht den Druck in der Sammlung um. Jede Sprache ist
   * wählbar, auch wenn Scryfall den Druck darin nicht kennt (Wunsch des Users, 05.11.2026: das
   * stimmt oft nicht) - dann bleibt Scryfalls Druck für Bild und Preis, nur die Sprache wechselt
   * (bevorzugt der englische Druck desselben Sets).
   */
  async changeLanguage(item: RecentScan, lang: string): Promise<void> {
    const known = item.languages ?? [item.print];
    const target =
      known.find((p) => p.lang === lang) ??
      withLang(
        known.find((p) => p.lang === 'en') ??
          known.find((p) => p.scryfallId === item.print.scryfallId) ??
          item.print,
        lang,
      );
    await this.swapPrint(item, target);
  }

  /** Alle Sprachen zur Auswahl - nicht nur die, die Scryfall für diesen Druck kennt. */
  readonly allLanguages = ART_LANGUAGES.map((l) => l.code);

  /** Steht der Treffer in einer Sprache, in der Scryfall diesen Druck nicht führt? */
  unlistedLang(item: RecentScan): boolean {
    return isUnlisted(item.print);
  }

  /** Anderes Set (anderer Druck mit demselben Artwork), möglichst in derselben Sprache. */
  async changeSet(item: RecentScan, scryfallId: string): Promise<void> {
    const chosen = item.sets?.find((p) => p.scryfallId === scryfallId);
    if (!chosen) return;
    const languages = await this.scan.languagesOfPrint(chosen);
    // Die gewählte Sprache bleibt, auch wenn Scryfall das neue Set darin nicht kennt.
    const target =
      languages.find((p) => p.lang === item.print.lang) ??
      withLang(languages.find((p) => p.lang === 'en') ?? chosen, item.print.lang);
    await this.swapPrint(item, target);
    this.recent.update((list) => list.map((r) => (r.key === item.key ? { ...r, languages } : r)));
  }

  /** Tauscht den Druck eines Treffers in der Sammlung um (neuer +1, alter −1). */
  private async swapPrint(item: RecentScan, target: CollectionPrint): Promise<void> {
    if (target.scryfallId === item.print.scryfallId && target.lang === item.print.lang) return;
    const foil = item.foil && target.finishes.some((f) => f !== 'nonfoil');
    const ok = await this.collection.add(target, foil, 1);
    if (!ok) return;
    await this.collection.add(item.print, item.foil, -1);
    this.recent.update((list) =>
      list.map((r) => (r.key === item.key ? { ...r, print: target, foil } : r)),
    );
    void this.samples.correct(item.sampleId, {
      scryfall_id: target.scryfallId,
      set: target.setCode,
      number: target.collectorNumber,
      lang: target.lang,
      foil,
      // Sprache, die Scryfall für diesen Druck nicht führt: Bild und ID sind dann die eines anderen.
      lang_unlisted: isUnlisted(target) || undefined,
    });
  }

  private async loadLanguages(key: number, print: CollectionPrint): Promise<void> {
    const [languages, sets] = await Promise.all([
      this.scan.languagesOfPrint(print),
      this.scan.printsOfSameArt(print),
    ]);
    this.recent.update((list) =>
      list.map((r) =>
        r.key === key
          ? {
              ...r,
              languages,
              sets: sets.length > 1 ? sets : undefined,
            }
          : r,
      ),
    );
  }

  async undo(item: RecentScan): Promise<void> {
    await this.collection.add(item.print, item.foil, -1);
    this.recent.update((list) => list.filter((r) => r !== item));
    void this.samples.correct(item.sampleId, { removed: true });
  }

  langLabel(code: string): string {
    return code.toUpperCase();
  }

  /** Töne an/aus. Der Klick ist zugleich die Nutzergeste, die Safari zum Abspielen verlangt. */
  toggleSound(): void {
    const on = !this.sound();
    this.sound.set(on);
    try {
      localStorage.setItem(SOUND_KEY, on ? '1' : '0');
    } catch {
      // privater Modus - gilt dann nur für diese Sitzung
    }
    if (on) this.beep('ok');
  }

  /**
   * Zwei klar verschiedene Töne aus dem Browser selbst (Web Audio, keine Datei): `ok` hell und
   * aufsteigend, `check` zwei tiefe, kantigere Töne - "hinsehen". Auf dem iPhone stumm, solange
   * der Stummschalter an der Seite aktiv ist.
   */
  private beep(kind: 'ok' | 'check'): void {
    if (!this.sound()) return;
    try {
      this.audio ??= new AudioContext();
      void this.audio.resume();
      const ctx = this.audio;
      const notes =
        kind === 'ok'
          ? [
              { f: 880, t: 0, d: 0.09 },
              { f: 1320, t: 0.1, d: 0.12 },
            ]
          : [
              { f: 330, t: 0, d: 0.16 },
              { f: 330, t: 0.24, d: 0.16 },
            ];
      for (const n of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === 'ok' ? 'sine' : 'square';
        osc.frequency.value = n.f;
        const start = ctx.currentTime + n.t;
        const peak = kind === 'ok' ? 0.25 : 0.12;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(peak, start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + n.d);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + n.d + 0.02);
      }
    } catch {
      // ohne Web Audio eben ohne Ton
    }
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
    // Die Schwellen unten sind bei normalem Licht gemessen (mittlere Helligkeit um 128). Bei wenig
    // Licht schrumpfen alle Helligkeitsabstände mit dem Bild - eine Karte sah dann aus wie leerer
    // Tisch, und der Scanner löste gar nicht erst aus. Deshalb relativ zur Helligkeit, aber nur
    // nach oben: Bei hellem Licht bleibt alles, wie es auf dem iPhone eingestellt wurde.
    const light = Math.max(1, NORMAL_LIGHT / Math.max(mean, MIN_LIGHT));
    spread = (spread / gray.length) * light;
    diff = this.previous ? (diff / gray.length) * light : 255;
    sinceHit = this.lastHit ? (sinceHit / gray.length) * light : 255;
    this.previous = gray;

    // Karte weg oder bewegt: Der Achtungston für "wird nicht erkannt" darf wieder kommen.
    if (spread < MIN_CONTRAST || diff > MOTION) {
      this.missStreak = 0;
      this.missAlerted = false;
    }
    // Rahmen leer oder deutliche Bewegung seit dem Treffer (Karte weggenommen, Hand im Bild): Eine
    // gleiche Karte danach ist eine neue. In einer Box mit Wänden wird der Rahmen nie "leer", die
    // zweite gleiche Karte wurde deshalb verschluckt (04.11.2026). Bloßes Verrutschen der liegenden
    // Karte reicht dagegen nicht: Das zählte sie ein zweites Mal - 17 der 22 gelöschten Treffer
    // der nächsten Testrunde waren solche Doppelten, meist 2-3 s nach dem ersten (05.11.2026).
    if (spread < MIN_CONTRAST || diff > MOTION) this.sawEmpty = true;
    // Karte weg oder eine andere im Rahmen: der letzte Treffer sperrt nicht mehr.
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
        // Liegt die Karte und wird mehrmals hintereinander nicht erkannt: einmal Bescheid geben,
        // erst nach Bewegung oder leerem Rahmen wieder.
        if (++this.missStreak >= MISS_ALERT && !this.missAlerted) {
          this.missAlerted = true;
          this.beep('check');
        }
        if (this.samples.enabled() && Date.now() - this.lastMissSample > MISS_SAMPLE_MS) {
          this.lastMissSample = Date.now();
          void this.samples.save(frame, guide, this.scan.lastCorner, null, this.scan.lastScan);
        }
        return;
      }
      const hit =
        this.foilMode() && found.print.finishes.some((f) => f !== 'nonfoil')
          ? { ...found, foil: true }
          : found;
      // Nur der Druck, nicht Foil: Schwankt die Foil-Erkennung zwischen zwei Versuchen, ist es
      // trotzdem dieselbe Karte. Und ohne Zeitgrenze - eine liegende Karte bleibt dieselbe.
      const key = hit.print.scryfallId;
      if (key === this.lastHitKey && !this.sawEmpty) {
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
      this.sawEmpty = false;
      this.missStreak = 0;
      this.missAlerted = false;
      // Hell = Ecke gelesen und Foil eindeutig; tief = nur über das Bild erkannt oder Foil unklar,
      // in der Liste prüfen. Im Foil-Stapel entscheidet der Schalter, nicht die Erkennung.
      this.beep(hit.sure && (this.foilMode() || hit.foilSure) ? 'ok' : 'check');
      const entry = ++this.scanCounter;
      this.recent.update((list) => [{ ...hit, key: entry }, ...list].slice(0, 8));
      void this.loadLanguages(entry, hit.print);
      if (this.samples.enabled()) {
        void this.samples
          .save(frame, guide, this.scan.lastCorner, hit, this.scan.lastScan)
          .then((sampleId) => {
            if (!sampleId) return;
            this.recent.update((list) =>
              list.map((r) => (r.key === entry ? { ...r, sampleId } : r)),
            );
          });
      }
      this.status.set('saved');
      this.flash.set(true);
      setTimeout(() => this.flash.set(false), 600);
      navigator.vibrate?.(60);
    } finally {
      this.busy = false;
    }
  }
}
