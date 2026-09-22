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
import { DeckPrimerService } from '../deck-primer.service';
import { PRIMER_MAX_TEXT_LENGTH, bereinigePrimerHtml, primerText } from '../primer-html';
import { DialogService } from '../dialog.service';
import { I18nService } from '../i18n.service';
import { Icon } from '../ui/icon/icon';

/**
 * Der Primer eines Decks: gelesen als formatierter Text, geschrieben in einem contenteditable-Feld
 * mit kleiner Werkzeugleiste (Vorbild Moxfield). Eingehängt an beiden Stellen, an denen man sich
 * ein Deck ansieht - deck-detail-view (dort auch änderbar) und public-deck-browser (nur lesen).
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
  imports: [FormsModule, Icon],
  templateUrl: './deck-primer.html',
  styleUrl: './deck-primer.scss',
})
export class DeckPrimer {
  readonly primerService = inject(DeckPrimerService);
  readonly i18n = inject(I18nService);
  private readonly dialog = inject(DialogService);

  readonly deckId = input.required<string>();
  /** Nur der Besitzer des Decks darf den Primer ändern - im öffentlichen Stöbern ist er immer nur lesbar. */
  readonly canEdit = input(false);

  private readonly editorRef = viewChild<ElementRef<HTMLElement>>('editor');

  readonly bearbeitet = signal(false);
  readonly linkFeldOffen = signal(false);
  readonly linkUrl = signal('');

  readonly textLaenge = signal(0);
  readonly maxLaenge = PRIMER_MAX_TEXT_LENGTH;
  readonly zuLang = computed(() => this.textLaenge() > this.maxLaenge);

  /**
   * Die Markierung im Eingabefeld, bevor das Link-Feld den Fokus übernimmt. Ohne sie wäre beim
   * Einfügen des Links nichts mehr markiert und createLink hätte nichts, woran es sich hängen
   * könnte.
   */
  private gemerkteAuswahl: Range | null = null;

  constructor() {
    // Das Feld bekommt seinen Inhalt EINMAL beim Öffnen - danach gehört es dem Browser. Würde der
    // Text bei jeder Änderung neu hineingeschrieben, spränge der Cursor bei jedem Tastendruck an
    // den Anfang. viewChild ist ein Signal, der Effekt läuft also genau dann, wenn das Feld
    // tatsächlich im DOM steht.
    effect(() => {
      const el = this.editorRef()?.nativeElement;
      if (!this.bearbeitet() || !el) return;
      untracked(() => {
        el.innerHTML = this.primerService.primer() ?? '';
        this.textLaenge.set(primerText(el.innerHTML).length);
        el.focus();
      });
    });

    // Deck gewechselt, während der Bearbeiten-Modus offen stand: Das Feld zeigte sonst weiter den
    // Text des vorigen Decks und ein Speichern schriebe ihn unter das neue.
    effect(() => {
      this.deckId();
      untracked(() => this.bearbeitenBeenden());
    });
  }

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
  }

  /** Absatz/Überschrift/Zitat. Das Auswahlfeld springt danach zurück - es zeigt keinen Zustand an, es führt aus. */
  setzeBlock(event: Event): void {
    const feld = event.target as HTMLSelectElement;
    const wert = feld.value;
    feld.value = '';
    if (!wert) return;
    this.format('formatBlock', `<${wert}>`);
  }

  linkFeldOeffnen(): void {
    const auswahl = window.getSelection();
    this.gemerkteAuswahl =
      auswahl && auswahl.rangeCount > 0 ? auswahl.getRangeAt(0).cloneRange() : null;
    this.linkUrl.set('');
    this.linkFeldOffen.set(true);
  }

  linkEinfuegen(): void {
    const el = this.editorRef()?.nativeElement;
    const eingabe = this.linkUrl().trim();
    if (!el || !eingabe) return;
    // "edhrec.com" ist als Eingabe gemeint, aber ohne Schema kein Link - die Bereinigung würde ihn
    // sonst als relativen Pfad verwerfen.
    const url = /^(https?:\/\/|mailto:)/i.test(eingabe) ? eingabe : `https://${eingabe}`;

    el.focus();
    if (this.gemerkteAuswahl) {
      const auswahl = window.getSelection();
      auswahl?.removeAllRanges();
      auswahl?.addRange(this.gemerkteAuswahl);
    }

    const auswahl = window.getSelection();
    if (!auswahl || auswahl.isCollapsed) {
      // Nichts markiert: Die Adresse wird selbst zum Linktext. createLink hätte hier nichts, was
      // es verlinken könnte, und würde stillschweigend gar nichts tun.
      const text = url.replace(/^https?:\/\//i, '');
      document.execCommand('insertHTML', false, `<a href="${maskiere(url)}">${maskiere(text)}</a>`);
    } else {
      document.execCommand('createLink', false, url);
    }

    this.linkFeldOffen.set(false);
    this.gemerkteAuswahl = null;
    this.laengeAktualisieren();
  }

  linkAbbrechen(): void {
    this.linkFeldOffen.set(false);
    this.gemerkteAuswahl = null;
  }

  laengeAktualisieren(): void {
    const el = this.editorRef()?.nativeElement;
    if (el) this.textLaenge.set(primerText(el.innerHTML).length);
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

  private bearbeitenBeenden(): void {
    this.bearbeitet.set(false);
    this.linkFeldOffen.set(false);
    this.linkUrl.set('');
    this.gemerkteAuswahl = null;
  }
}

/** Für den selbst zusammengesetzten Link: Sonderzeichen in Adresse und Text dürfen das Markup nicht aufbrechen. */
function maskiere(wert: string): string {
  return wert
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
