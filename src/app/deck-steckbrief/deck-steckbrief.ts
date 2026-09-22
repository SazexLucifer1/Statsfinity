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
import { CardDataService } from '../card-data.service';
import { I18nService } from '../i18n.service';
import { normalizeCardName } from '../array-utils';
import { CARD_EFFECT_FILTERS } from '../card-effect-filters';
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

/** Eine Deck-Karte, soweit der Steckbrief sie braucht: Name und Anzahl, mehr zählt er nicht. */
export interface SteckbriefKarte {
  name: string;
  quantity: number;
}

/**
 * Die vier Wirkungs-Kacheln des Steckbriefs.
 *
 * Die Schlüssel sind die `category`-Werte aus `scryfall_card_effects`, gefüllt vom nächtlichen
 * Scryfall-Abgleich; damit hier keine erfundenen Schlüssel stehen, kommen sie aus
 * CARD_EFFECT_FILTERS - derselben Liste, aus der sich auch Kartensuche und Deck-Analyse bedienen.
 * Die Beschriftungen sind bewusst dieselben i18n-Keys wie in der Deck-Analyse: Dieselbe Zahl soll
 * nicht zwei Namen haben.
 */
const STECKBRIEF_KATEGORIEN: { key: string; labelKey: string }[] = [
  { key: 'removal', labelKey: 'deckView.removalTile' },
  { key: 'ramp', labelKey: 'deckView.rampTile' },
  { key: 'draw', labelKey: 'deckView.drawTile' },
  { key: 'boardwipe', labelKey: 'deckView.boardwipeTile' },
].filter((k) => CARD_EFFECT_FILTERS.some((f) => f.value === k.key));

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
  private readonly cardData = inject(CardDataService);

  readonly deck = input.required<SteckbriefDeckinfo>();
  /** Die Karten des Decks (ohne Maybeboard/Marken) - Grundlage der vier Wirkungs-Kacheln. */
  readonly karten = input.required<SteckbriefKarte[]>();
  /**
   * Durchschnittlicher Manawert ohne Länder. Kommt als Eingabe herein, weil beide Ansichten ihn
   * bereits über der Kartenliste anzeigen - hier neu gerechnet stünde im Bild irgendwann etwas
   * anderes als eine Bildschirmhöhe darüber.
   */
  readonly schnittMv = input.required<number | null>();
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

  /**
   * Anzahl je Wirkungs-Kategorie (Schlüssel wie in STECKBRIEF_KATEGORIEN), null = noch nicht
   * geladen. Solange null, zeigt das Bild nur den Manawert - eine Kachel mit einer 0, die
   * gleich zu einer 7 wird, ist irreführender als eine, die noch nicht da ist.
   */
  private readonly kategorieZahlen = signal<Map<string, number> | null>(null);

  /** Kartenliste, zu der kategorieZahlen gehört - gegen überholende Antworten bei Deck-Wechsel. */
  private kategorieFuer = '';

  constructor() {
    // Die Kategorien laden, sobald die Kartenliste steht. Getrennt vom Zeichnen-Effekt, damit das
    // Ergebnis dieses Ladens nicht sofort ein neues Laden auslöst.
    effect(() => {
      const karten = this.karten();
      untracked(() => void this.kategorienLaden(karten));
    });

    effect(() => {
      const canvas = this.canvasRef()?.nativeElement;
      const daten = this.daten();
      if (!canvas) return;
      untracked(() => void this.neuZeichnen(canvas, daten));
    });
  }

  /**
   * Zählt, wie viele Karten des Decks als Entfernung, Rampe, Kartenziehen bzw. Bretträumung
   * gelten - aus dem eigenen Kartenbestand (scryfall_card_effects, gefüllt vom nächtlichen
   * Abgleich), eine Abfrage für alle vier.
   *
   * Bewusst OHNE den Rückfall auf eine Live-Suche bei Scryfall, den die Deck-Analyse hat: Der
   * kostet bei kaltem Cache ein Dutzend Anfragen mit Zwangspausen dazwischen, und der Steckbrief
   * wird geöffnet, um ein Bild zu sehen. Karten, die der Abgleich noch nicht kennt (frische
   * Spoiler), zählen hier also nicht mit - das sind einzelne, und die Zahl daneben ist ohnehin
   * eine Einordnung, keine Buchführung.
   */
  private async kategorienLaden(karten: SteckbriefKarte[]): Promise<void> {
    const kennung = karten.map((k) => `${k.name}x${k.quantity}`).join('|');
    if (kennung === this.kategorieFuer) return;
    this.kategorieFuer = kennung;
    this.kategorieZahlen.set(null);
    if (!karten.length) return;

    const treffer = await this.cardData.effectCategories(karten.map((k) => k.name));
    // Inzwischen wurde ein anderes Deck geöffnet - diese Antwort gehört nicht mehr zur Anzeige.
    if (kennung !== this.kategorieFuer) return;

    const zahlen = new Map<string, number>();
    for (const { key } of STECKBRIEF_KATEGORIEN) {
      const namen = treffer.get(key) ?? new Set<string>();
      // Vorderseiten-Name wie beim Abgleich: Eine Doppelkarte steht dort unter "A", im Deck als
      // "A // B" - ohne das Kürzen findet sich keine einzige davon wieder.
      const anzahl = karten
        .filter((k) => namen.has(normalizeCardName(k.name.split(' // ')[0].trim())))
        .reduce((summe, k) => summe + k.quantity, 0);
      zahlen.set(key, anzahl);
    }
    this.kategorieZahlen.set(zahlen);
  }

  /** Alles, was ins Bild kommt - fertig übersetzt, damit steckbrief-canvas.ts keine Sprache kennen muss. */
  private readonly daten = computed<SteckbriefDaten>(() => {
    const deck = this.deck();

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
      kacheln: this.kacheln(),
      fusszeile: this.i18n.t('deckSteckbrief.footer', {
        date: new Date().toLocaleDateString(this.i18n.lang() === 'de' ? 'de-DE' : 'en-GB'),
      }),
    };
  });

  /**
   * Das Kachelband: der durchschnittliche Manawert und die vier Wirkungs-Kategorien.
   *
   * Bewusst keine Kartenzahl, keine Länder, keine Kreaturen und keine Bilanz - das steht entweder
   * ohnehin über der Kartenliste oder sagt über ein Deck nichts, was man nicht schon am Commander
   * sieht. Interessant ist, WIE ein Deck gebaut ist.
   */
  private kacheln(): SteckbriefKachel[] {
    const liste: SteckbriefKachel[] = [];
    const schnittMv = this.schnittMv();
    if (schnittMv !== null) {
      liste.push({
        wert: schnittMv.toFixed(2).replace('.', this.i18n.lang() === 'de' ? ',' : '.'),
        label: this.i18n.t('deckView.avgCmcTile'),
      });
    }

    const zahlen = this.kategorieZahlen();
    if (zahlen) {
      for (const { key, labelKey } of STECKBRIEF_KATEGORIEN) {
        liste.push({ wert: String(zahlen.get(key) ?? 0), label: this.i18n.t(labelKey) });
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
