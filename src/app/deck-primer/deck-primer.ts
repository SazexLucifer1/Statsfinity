import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DeckPrimerService } from '../deck-primer.service';
import {
  PRIMER_MAX_TEXT_LENGTH,
  bereinigePrimerHtml,
  primerAlsBearbeitbaresHtml,
  primerKartenNamen,
  primerText,
} from '../primer-html';
import { PRIMER_CARD_CLASS } from '../primer-html';
import { DialogService } from '../dialog.service';
import { I18nService } from '../i18n.service';
import { CardPreviewService } from '../card-preview.service';
import { CardSuggestion, ScryfallCard, ScryfallService } from '../scryfall.service';
import { Icon } from '../ui/icon/icon';
import { ManaSymbol } from '../ui/mana-symbol/mana-symbol';

/** Welches Zusatzfeld unter dem Werkzeugkasten gerade offen steht - immer höchstens eines. */
type PrimerFeld = 'mana' | 'karte' | 'link';

/** Blockformate, die der Werkzeugkasten anbietet. Entspricht den Tags, die der Primer erlaubt. */
type PrimerBlock = 'p' | 'h2' | 'h3' | 'blockquote';

/**
 * Der Primer eines Decks: gelesen als formatierter Text, geschrieben in einem contenteditable-Feld
 * mit Werkzeugkasten (Vorbild Moxfield). Eingehängt an beiden Stellen, an denen man sich ein Deck
 * ansieht - deck-detail-view (dort auch änderbar) und public-deck-browser (nur lesen).
 *
 * Die Komponente hält bewusst nur die Oberfläche; Laden, Bereinigen und Speichern stehen im
 * DeckPrimerService bzw. in primer-html.ts.
 *
 * Warum contenteditable und kein Editor-Paket: Die App bringt für den Primer sonst nichts mit,
 * was ein zusätzliches Bündel rechtfertigen würde - und jedes Editor-Paket liefert am Ende
 * genauso HTML, das trotzdem bereinigt werden müsste. document.execCommand() ist zwar als
 * veraltet markiert, funktioniert aber in allen Browsern einschließlich iOS-Safari, auf den diese
 * App zuerst zielt.
 */
@Component({
  selector: 'app-deck-primer',
  imports: [FormsModule, Icon, ManaSymbol],
  templateUrl: './deck-primer.html',
  styleUrl: './deck-primer.scss',
})
export class DeckPrimer implements OnDestroy {
  readonly primerService = inject(DeckPrimerService);
  readonly i18n = inject(I18nService);
  private readonly dialog = inject(DialogService);
  private readonly scryfall = inject(ScryfallService);
  private readonly cardPreview = inject(CardPreviewService);

  readonly deckId = input.required<string>();
  /** Nur der Besitzer des Decks darf den Primer ändern - im öffentlichen Stöbern ist er immer nur lesbar. */
  readonly canEdit = input(false);

  private readonly editorRef = viewChild<ElementRef<HTMLElement>>('editor');
  private readonly bildFeldRef = viewChild<ElementRef<HTMLInputElement>>('bildFeld');

  readonly bearbeitet = signal(false);

  /** Offenes Zusatzfeld (Mana-Auswahl, Karte einfügen, Link einfügen) - höchstens eines. */
  readonly offenesFeld = signal<PrimerFeld | null>(null);

  readonly linkUrl = signal('');
  readonly kartenName = signal('');
  readonly kartenVorschlaege = signal<CardSuggestion[]>([]);
  readonly kartenBildLaedt = signal(false);

  readonly textLaenge = signal(0);
  readonly maxLaenge = PRIMER_MAX_TEXT_LENGTH;
  readonly zuLang = computed(() => this.textLaenge() > this.maxLaenge);

  /**
   * Was an der Schreibmarke gerade gilt - damit die Knöpfe zeigen, ob fett/kursiv/Liste AN ist,
   * statt nur auszulösen. Ohne das rät man beim Schreiben, in welchem Zustand man steckt.
   */
  readonly aktivFett = signal(false);
  readonly aktivKursiv = signal(false);
  readonly aktivListe = signal(false);
  readonly aktivNummern = signal(false);
  /** Blockformat an der Schreibmarke - füllt gleichzeitig die Auswahlliste, die damit den Zustand ANZEIGT. */
  readonly aktuellerBlock = signal<PrimerBlock>('p');

  /** Angebotene Manasymbole: Farben, farblos, die üblichen Beträge, X und das Tap-Symbol. */
  readonly manaSymbole = [
    'W',
    'U',
    'B',
    'R',
    'G',
    'C',
    'X',
    'T',
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
  ];

  /** Kartenname (klein) -> Scryfall-Karte, für die Vorschau beim Klick auf einen Kartennamen. */
  private readonly kartenBilder = signal<Map<string, ScryfallCard>>(new Map());

  /**
   * Die Markierung im Eingabefeld, bevor ein Zusatzfeld den Fokus übernimmt. Ohne sie wäre beim
   * Einfügen nichts mehr markiert und das Eingefügte landete am Anfang des Textes.
   */
  private gemerkteAuswahl: Range | null = null;

  private kartenSucheTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Das Feld bekommt seinen Inhalt EINMAL beim Öffnen - danach gehört es dem Browser. Würde der
    // Text bei jeder Änderung neu hineingeschrieben, spränge der Cursor bei jedem Tastendruck an
    // den Anfang. viewChild ist ein Signal, der Effekt läuft also genau dann, wenn das Feld
    // tatsächlich im DOM steht.
    effect(() => {
      const el = this.editorRef()?.nativeElement;
      if (!this.bearbeitet() || !el) return;
      untracked(() => {
        // Mit Kürzeln statt fertigem Markup: Ein Manasymbol ist ein Element ohne Text - im
        // Schreibfeld ließe sich daran nichts markieren und die Rücktaste träfe es nur zufällig.
        el.innerHTML = primerAlsBearbeitbaresHtml(this.primerService.primer());
        this.textLaenge.set(primerText(el.innerHTML).length);
        el.focus();
        this.zustandAktualisieren();
      });
    });

    // Deck gewechselt, während der Bearbeiten-Modus offen stand: Das Feld zeigte sonst weiter den
    // Text des vorigen Decks und ein Speichern schriebe ihn unter das neue.
    effect(() => {
      this.deckId();
      untracked(() => this.bearbeitenBeenden());
    });

    // Kartenbilder für alle [[Kartennamen]] im Primer einmal gebündelt nachladen - beim ersten
    // Klick stünde man sonst spürbar vor einem leeren Vorschaufenster.
    effect(() => {
      const namen = primerKartenNamen(this.primerService.primer());
      if (namen.length === 0) {
        untracked(() => this.kartenBilder.set(new Map()));
        return;
      }
      untracked(async () => this.kartenBilder.set(await this.scryfall.findCardsBulk(namen)));
    });

    document.addEventListener('selectionchange', this.aufAuswahlWechsel);
  }

  ngOnDestroy(): void {
    document.removeEventListener('selectionchange', this.aufAuswahlWechsel);
    if (this.kartenSucheTimer) clearTimeout(this.kartenSucheTimer);
  }

  // ---------------------------------------------------------------------------------------------
  // Lesen
  // ---------------------------------------------------------------------------------------------

  /**
   * Klick auf einen Kartennamen im gelesenen Primer öffnet dieselbe Kartenvorschau wie überall
   * sonst in der App. Ein Ereignis für den ganzen Text statt eines Zuhörers je Name: Der Inhalt
   * kommt über [innerHTML] herein, einzelne Angular-Bindungen gibt es darin nicht.
   */
  async aufPrimerKlick(event: Event): Promise<void> {
    const ziel = (event.target as HTMLElement | null)?.closest?.(`a.${PRIMER_CARD_CLASS}`);
    if (!ziel) return;
    event.preventDefault();
    const name = (ziel.textContent ?? '').trim();
    if (!name) return;
    const karte =
      this.kartenBilder().get(name.toLowerCase()) ?? (await this.scryfall.findCard(name));
    if (karte?.imageUrl) this.cardPreview.open(karte.imageUrl, karte.backImageUrl, karte.name);
  }

  // ---------------------------------------------------------------------------------------------
  // Schreiben
  // ---------------------------------------------------------------------------------------------

  bearbeiten(): void {
    if (!this.canEdit()) return;
    // Absätze statt <div> beim Zeilenumbruch - das gespeicherte Markup sieht damit in allen
    // Browsern gleich aus.
    try {
      document.execCommand('defaultParagraphSeparator', false, 'p');
    } catch {
      // Kennt der Browser den Befehl nicht, bleibt es bei seiner eigenen Schreibweise - die
      // Bereinigung macht daraus ohnehin Absätze.
    }
    this.bearbeitet.set(true);
  }

  /** Fett/kursiv/Listen/Formatierung entfernen - alles, was ohne weitere Eingabe auskommt. */
  format(befehl: string, wert?: string): void {
    const el = this.editorRef()?.nativeElement;
    if (!el) return;
    el.focus();
    document.execCommand(befehl, false, wert);
    this.laengeAktualisieren();
    this.zustandAktualisieren();
  }

  /** Absatz/Überschrift/Zitat aus der Auswahlliste, die gleichzeitig den aktuellen Zustand zeigt. */
  setzeBlock(event: Event): void {
    const wert = (event.target as HTMLSelectElement).value as PrimerBlock;
    this.format('formatBlock', `<${wert}>`);
  }

  /** Öffnet ein Zusatzfeld und merkt sich vorher, was im Text markiert war. */
  feldOeffnen(feld: PrimerFeld): void {
    const auswahl = window.getSelection();
    this.gemerkteAuswahl =
      auswahl && auswahl.rangeCount > 0 ? auswahl.getRangeAt(0).cloneRange() : null;
    if (feld === 'link') this.linkUrl.set('');
    if (feld === 'karte') {
      this.kartenName.set('');
      this.kartenVorschlaege.set([]);
    }
    this.offenesFeld.set(this.offenesFeld() === feld ? null : feld);
  }

  feldSchliessen(): void {
    this.offenesFeld.set(null);
    this.gemerkteAuswahl = null;
  }

  /**
   * Eingefügt wird das Kürzel, nicht das fertige Symbol - im Schreibfeld steht damit durchgehend
   * dasselbe, egal ob getippt oder geklickt, und alles bleibt löschbar. Zum Symbol wird es beim
   * Speichern.
   */
  manaEinfuegen(symbol: string): void {
    this.einfuegenText(`{${symbol}} `);
  }

  linkEinfuegen(): void {
    const eingabe = this.linkUrl().trim();
    if (!eingabe) return;
    // "edhrec.com" ist als Adresse gemeint, aber ohne Schema kein Link - die Bereinigung würde ihn
    // sonst als relativen Pfad verwerfen.
    const url = /^(https?:\/\/|mailto:)/i.test(eingabe) ? eingabe : `https://${eingabe}`;

    const el = this.editorRef()?.nativeElement;
    if (!el) return;
    el.focus();
    this.auswahlWiederherstellen();

    const auswahl = window.getSelection();
    if (!auswahl || auswahl.isCollapsed) {
      // Nichts markiert: Die Adresse wird selbst zum Linktext. createLink hätte hier nichts, was
      // es verlinken könnte, und würde stillschweigend gar nichts tun.
      const text = url.replace(/^https?:\/\//i, '');
      document.execCommand('insertHTML', false, `<a href="${maskiere(url)}">${maskiere(text)}</a>`);
    } else {
      document.execCommand('createLink', false, url);
    }
    this.nachDemEinfuegen();
  }

  /** Tippen im Kartenfeld - fragt Scryfall erst, wenn kurz nichts mehr getippt wurde. */
  kartenNameGeaendert(wert: string): void {
    this.kartenName.set(wert);
    if (this.kartenSucheTimer) clearTimeout(this.kartenSucheTimer);
    if (wert.trim().length < 2) {
      this.kartenVorschlaege.set([]);
      return;
    }
    this.kartenSucheTimer = setTimeout(async () => {
      const treffer = await this.scryfall.autocompleteAnyCard(wert);
      if (this.kartenName() === wert) this.kartenVorschlaege.set(treffer.slice(0, 6));
    }, 300);
  }

  vorschlagUebernehmen(vorschlag: CardSuggestion): void {
    this.kartenName.set(vorschlag.name);
    this.kartenVorschlaege.set([]);
  }

  /**
   * Kartenname als Kürzel [[Sol Ring]] - aus demselben Grund wie beim Mana: Im Schreibfeld steht
   * das, was man auch tippen würde, beim Speichern wird daraus der anklickbare Name.
   */
  karteAlsLinkEinfuegen(): void {
    const name = this.kartenName().trim();
    if (!name) return;
    this.einfuegenText(`[[${name}]] `);
  }

  /** Dasselbe als Kartenbild mitten im Text - die Adresse kommt von Scryfall. */
  async karteAlsBildEinfuegen(): Promise<void> {
    const name = this.kartenName().trim();
    if (!name) return;
    this.kartenBildLaedt.set(true);
    const karte = await this.scryfall.findCard(name);
    this.kartenBildLaedt.set(false);
    if (!karte?.imageUrl) {
      this.primerService.errorKey.set('deckPrimer.cardNotFound');
      return;
    }
    this.einfuegen(
      `<img class="primer-image" src="${maskiere(karte.imageUrl)}" alt="${maskiere(karte.name)}">`,
    );
  }

  /** Öffnet die Dateiauswahl für ein eigenes Bild. */
  eigenesBildWaehlen(): void {
    const auswahl = window.getSelection();
    this.gemerkteAuswahl =
      auswahl && auswahl.rangeCount > 0 ? auswahl.getRangeAt(0).cloneRange() : null;
    this.bildFeldRef()?.nativeElement.click();
  }

  async eigenesBildGewaehlt(event: Event): Promise<void> {
    const feld = event.target as HTMLInputElement;
    const datei = feld.files?.[0];
    feld.value = '';
    if (!datei) return;
    const url = await this.primerService.bildHochladen(datei);
    if (!url) return;
    this.einfuegen(`<img class="primer-image" src="${maskiere(url)}" alt="">`);
  }

  laengeAktualisieren(): void {
    const el = this.editorRef()?.nativeElement;
    if (el) this.textLaenge.set(primerText(el.innerHTML).length);
  }

  /** Liest am Schreibpunkt ab, was gerade gilt, und füttert damit die Knopf-Zustände. */
  zustandAktualisieren(): void {
    const el = this.editorRef()?.nativeElement;
    if (!el) return;
    const auswahl = document.getSelection();
    // Steht die Markierung woanders (z.B. im Kommentarfeld darunter), sagt queryCommandState
    // etwas über FREMDEN Text aus - die Knöpfe zeigten dann einen Zustand, der hier nicht gilt.
    if (!auswahl?.anchorNode || !el.contains(auswahl.anchorNode)) return;

    this.aktivFett.set(document.queryCommandState('bold'));
    this.aktivKursiv.set(document.queryCommandState('italic'));
    this.aktivListe.set(document.queryCommandState('insertUnorderedList'));
    this.aktivNummern.set(document.queryCommandState('insertOrderedList'));

    const block = (document.queryCommandValue('formatBlock') || '').toLowerCase();
    this.aktuellerBlock.set(
      block === 'h2' || block === 'h3' || block === 'blockquote' ? block : 'p',
    );
  }

  async speichern(): Promise<void> {
    const el = this.editorRef()?.nativeElement;
    if (!el || this.zuLang() || this.primerService.saving()) return;
    if (await this.primerService.save(this.deckId(), el.innerHTML)) this.bearbeitenBeenden();
  }

  async abbrechen(): Promise<void> {
    const el = this.editorRef()?.nativeElement;
    const jetzt = bereinigePrimerHtml(el?.innerHTML ?? '');
    const gespeichert = this.primerService.primer() ?? '';
    // Nur nachfragen, wenn wirklich etwas verloren ginge - eine Rückfrage auf eine ungeänderte
    // Ansicht ist nur im Weg.
    if (
      jetzt !== gespeichert &&
      !(await this.dialog.confirm(this.i18n.t('deckPrimer.discardConfirm')))
    )
      return;
    this.bearbeitenBeenden();
  }

  /**
   * Reiner Text an der Schreibmarke - für die Kürzel. Nicht insertHTML: Kartennamen wie "R&D's
   * Secret Lair" enthalten Zeichen, die als Markup gelesen würden.
   */
  private einfuegenText(text: string): void {
    const el = this.editorRef()?.nativeElement;
    if (!el) return;
    el.focus();
    this.auswahlWiederherstellen();
    document.execCommand('insertText', false, text);
    this.nachDemEinfuegen();
  }

  private einfuegen(html: string): void {
    const el = this.editorRef()?.nativeElement;
    if (!el) return;
    el.focus();
    this.auswahlWiederherstellen();
    document.execCommand('insertHTML', false, html);
    this.nachDemEinfuegen();
  }

  private auswahlWiederherstellen(): void {
    if (!this.gemerkteAuswahl) return;
    const auswahl = window.getSelection();
    auswahl?.removeAllRanges();
    auswahl?.addRange(this.gemerkteAuswahl);
  }

  private nachDemEinfuegen(): void {
    this.offenesFeld.set(null);
    this.gemerkteAuswahl = null;
    this.laengeAktualisieren();
    this.zustandAktualisieren();
  }

  private bearbeitenBeenden(): void {
    this.bearbeitet.set(false);
    this.offenesFeld.set(null);
    this.linkUrl.set('');
    this.kartenName.set('');
    this.kartenVorschlaege.set([]);
    this.gemerkteAuswahl = null;
  }

  /** Bei jeder Bewegung der Schreibmarke die Knopf-Zustände nachziehen. */
  private readonly aufAuswahlWechsel = (): void => {
    if (this.bearbeitet()) this.zustandAktualisieren();
  };
}

/** Für selbst zusammengesetztes Markup: Sonderzeichen dürfen es nicht aufbrechen. */
function maskiere(wert: string): string {
  return wert
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
