import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DeckSteckbriefService } from '../deck-steckbrief.service';
import { I18nService } from '../i18n.service';
import { Icon } from '../ui/icon/icon';
import {
  STECKBRIEF_MAX_LAENGE,
  SteckbriefDaten,
  SteckbriefKachel,
  steckbriefAlsBlob,
  zeichneSteckbrief,
} from '../steckbrief-canvas';

/** Was der Steckbrief über das Deck selbst wissen muss. Stellt die einbettende Ansicht zusammen. */
export interface SteckbriefDeckinfo {
  id: string;
  name: string;
  /** Anzeigename des Formats, z.B. "Commander" - oder null, wenn keines hinterlegt ist. */
  formatLabel: string | null;
  /** Selbst gewählter Kreaturtyp eines Typal-Decks, z.B. "Elf". */
  kreaturtyp: string | null;
  /** Farbidentität als W/U/B/R/G. */
  farben: string[];
  bracket: number | null;
  bracketQuelle: 'manual' | 'auto';
  commander: { name: string; imageUrl: string | null }[];
}

/**
 * Die Kennzahlen für das untere Band. Alle fertig gerechnet von der einbettenden Ansicht - die
 * zeigt dieselben Zahlen bereits an anderer Stelle an, und ein zweites Mal hier ausgerechnet
 * stünde im Steckbrief irgendwann etwas anderes als eine Bildschirmhöhe darüber.
 *
 * null = diese Zahl gibt es für dieses Deck nicht; die Kachel fällt dann weg statt "–" zu zeigen.
 */
export interface SteckbriefZahlen {
  karten: number;
  schnittMv: number | null;
  laender: number;
  kreaturen: number | null;
  partien: number | null;
  /** Siegquote in Prozent (0-100). */
  siegquote: number | null;
}

/**
 * Der Steckbrief eines Decks: die Kurzvorstellung zum Herzeigen und Teilen (Vorbild
 * deckpassport.com), als dritter Reiter neben Deckliste und Primer. Eingehängt an beiden Stellen,
 * an denen man sich ein Deck ansieht - deck-detail-view (dort auch änderbar) und
 * public-deck-browser (nur lesen).
 *
 * Was man sieht, IST das Bild: Der Reiter zeigt das Canvas aus steckbrief-canvas.ts, und der
 * Download-Knopf speichert genau dieses Canvas als PNG. Eine zweite, in HTML nachgebaute Vorschau
 * gibt es bewusst nicht - sonst lädt jemand am Ende etwas anderes herunter, als er angesehen hat.
 *
 * Die Komponente hält nur die Oberfläche: Gezeichnet wird in steckbrief-canvas.ts, die zwei
 * selbst geschriebenen Sätze lädt und speichert der DeckSteckbriefService.
 */
@Component({
  selector: 'app-deck-steckbrief',
  imports: [FormsModule, Icon],
  templateUrl: './deck-steckbrief.html',
  styleUrl: './deck-steckbrief.scss',
})
export class DeckSteckbrief {
  readonly steckbrief = inject(DeckSteckbriefService);
  readonly i18n = inject(I18nService);

  readonly deck = input.required<SteckbriefDeckinfo>();
  readonly zahlen = input.required<SteckbriefZahlen>();
  /** Nur der Besitzer darf die zwei Sätze schreiben - im öffentlichen Stöbern ist alles nur lesbar. */
  readonly canEdit = input(false);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  readonly maxLaenge = STECKBRIEF_MAX_LAENGE;
  readonly bearbeitet = signal(false);
  readonly entwurfKurz = signal('');
  readonly entwurfSieg = signal('');
  /** Läuft, solange das Bild gezeichnet wird - die Commander-Bilder müssen dafür erst geladen werden. */
  readonly zeichnet = signal(false);

  /** Zählt jeden Zeichenauftrag mit, damit ein überholter Lauf das Canvas nicht nachträglich überschreibt. */
  private lauf = 0;

  constructor() {
    effect(() => {
      const canvas = this.canvasRef()?.nativeElement;
      const daten = this.daten();
      if (!canvas) return;
      untracked(() => void this.neuZeichnen(canvas, daten));
    });
  }

  /** Alles, was ins Bild kommt - fertig übersetzt, damit steckbrief-canvas.ts keine Sprache kennen muss. */
  private readonly daten = computed<SteckbriefDaten>(() => {
    const deck = this.deck();
    const zahlen = this.zahlen();

    const untertitel = [deck.formatLabel, deck.kreaturtyp].filter(Boolean).join(' · ');
    const textbloecke = [
      { titel: this.i18n.t('deckSteckbrief.aboutTitle'), text: this.steckbrief.kurz() ?? '' },
      { titel: this.i18n.t('deckSteckbrief.winTitle'), text: this.steckbrief.sieg() ?? '' },
    ].filter((b) => b.text.length > 0);

    return {
      deckName: deck.name,
      commanderNamen: deck.commander.map((c) => c.name),
      commanderBildUrls: deck.commander.map((c) => c.imageUrl).filter((u): u is string => !!u),
      farben: deck.farben,
      untertitel: untertitel || null,
      bracketText: deck.bracket
        ? `B${deck.bracket} · ${this.i18n.t(`deck.bracket.name${deck.bracket}`)}`
        : null,
      bracketGeschaetzt: deck.bracketQuelle === 'auto',
      textbloecke,
      kacheln: this.kacheln(zahlen),
      fusszeile: this.i18n.t('deckSteckbrief.footer', {
        date: new Date().toLocaleDateString(this.i18n.lang() === 'de' ? 'de-DE' : 'en-GB'),
      }),
    };
  });

  private kacheln(zahlen: SteckbriefZahlen): SteckbriefKachel[] {
    const liste: SteckbriefKachel[] = [
      { wert: String(zahlen.karten), label: this.i18n.t('deckSteckbrief.tileCards') },
    ];
    if (zahlen.schnittMv !== null) {
      liste.push({
        wert: zahlen.schnittMv.toFixed(2).replace('.', this.i18n.lang() === 'de' ? ',' : '.'),
        label: this.i18n.t('deckSteckbrief.tileAvgMv'),
      });
    }
    liste.push({ wert: String(zahlen.laender), label: this.i18n.t('deckSteckbrief.tileLands') });
    if (zahlen.kreaturen !== null) {
      liste.push({
        wert: String(zahlen.kreaturen),
        label: this.i18n.t('deckSteckbrief.tileCreatures'),
      });
    }
    if (zahlen.partien !== null && zahlen.partien > 0) {
      liste.push({
        wert: String(zahlen.partien),
        label: this.i18n.t('deckSteckbrief.tileGames'),
      });
      if (zahlen.siegquote !== null) {
        liste.push({
          wert: `${Math.round(zahlen.siegquote)}%`,
          label: this.i18n.t('deckSteckbrief.tileWinRate'),
        });
      }
    }
    return liste;
  }

  private async neuZeichnen(canvas: HTMLCanvasElement, daten: SteckbriefDaten): Promise<void> {
    const lauf = ++this.lauf;
    this.zeichnet.set(true);
    await zeichneSteckbrief(canvas, daten);
    if (lauf !== this.lauf) return;
    this.zeichnet.set(false);
  }

  bearbeitenStarten(): void {
    this.entwurfKurz.set(this.steckbrief.kurz() ?? '');
    this.entwurfSieg.set(this.steckbrief.sieg() ?? '');
    this.bearbeitet.set(true);
  }

  abbrechen(): void {
    this.bearbeitet.set(false);
  }

  async speichern(): Promise<void> {
    const ok = await this.steckbrief.save(this.deck().id, this.entwurfKurz(), this.entwurfSieg());
    if (ok) this.bearbeitet.set(false);
  }

  readonly zuLang = computed(
    () =>
      this.entwurfKurz().length > STECKBRIEF_MAX_LAENGE ||
      this.entwurfSieg().length > STECKBRIEF_MAX_LAENGE,
  );

  /**
   * Speichert das gezeichnete Canvas als PNG. Über einen blob:-Link statt über eine data:-URL:
   * Ein 1080er PNG als data:-URL ist eine Zeichenkette von gut einem Megabyte, und daran verschluckt
   * sich iOS-Safari beim Download.
   */
  async herunterladen(): Promise<void> {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    const blob = await steckbriefAlsBlob(canvas);
    if (!blob) return;

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${dateiName(this.deck().name)}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Nicht sofort freigeben: Safari braucht die Adresse noch, während der Download anläuft.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** Decknamen zu einem Dateinamen entschärfen - Umlaute bleiben, Schrägstriche und Co. fliegen raus. */
function dateiName(name: string): string {
  const sauber = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-');
  return sauber.slice(0, 60) || 'steckbrief';
}
