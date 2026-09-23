import { Component, inject, input, model, output } from '@angular/core';
import { ScryfallCard } from '../scryfall.service';
import { CardImage } from '../card-image/card-image';
import { I18nService } from '../i18n.service';
import { Icon } from '../ui/icon/icon';

/**
 * Zeigt 1 Commander normal, bei einem Partner-Paar (2 Commander, siehe
 * ScryfallService.searchCommanderPairs()) BEIDE Karten als versetzter Stapel - vordere Karte fast
 * kartengroß und dominant, hintere Karte in echter Kartengröße direkt dahinter, sodass oben nur ein
 * schmaler Streifen mit Name/Manakosten herausschaut. Dadurch nimmt eine Partner-Kachel exakt
 * dieselbe Fläche ein wie eine Solo-Commander-Kachel (siehe partner-card-image.scss). Ein kleiner
 * Button oben links tauscht die beiden (um den hinteren Commander zu lesen), ebenso ein Klick auf
 * den sichtbaren Streifen der hinteren Karte selbst.
 *
 * WICHTIG: der Klick auf die vordere/einzelne Karte selbst löst NUR imageClick aus und stoppt die
 * Ereignis-Weiterleitung NICHT - diese Komponente wird oft in eine anklickbare Kachel eingebettet
 * (z.B. `<div class="card-pick-tile" (click)="openDeck(deck)">`), die beim Klick auf den Commander
 * genauso reagieren soll wie beim Klick auf den Rest der Kachel (Deck/Commander öffnen). Nur der
 * Umschalt-Button (und ein Klick auf die kleine hintere Karte) stoppen die Weiterleitung bewusst,
 * damit sie nicht zusätzlich die Kachel auslösen.
 */
@Component({
  selector: 'app-partner-card-image',
  imports: [CardImage, Icon],
  templateUrl: './partner-card-image.html',
  styleUrl: './partner-card-image.scss',
  host: {
    '[class.compact]': 'compact()',
  },
})
export class PartnerCardImage {
  readonly i18n = inject(I18nService);

  readonly cards = input.required<ScryfallCard[]>();
  readonly compact = input(false);

  readonly imageClick = output<ScryfallCard>();

  /**
   * Welche der beiden Karten vorne liegt. Als model(), damit eine umgebende Ansicht den Wechsel
   * auch von außen auslösen kann - das öffentliche Stöbern setzt seinen Umschaltknopf in die
   * Leiste unter dem Bild statt auf die Karte (siehe showSwapButton).
   */
  readonly frontIndex = model(0);

  /** false = der runde Umschaltknopf auf der Karte entfällt, weil die Ansicht einen eigenen hat. */
  readonly showSwapButton = input(true);

  /** false = auch der Umdreh-Knopf doppelseitiger Karten entfällt (siehe CardImage.showFlipButton). */
  readonly showFlipButton = input(true);

  /**
   * Ob die VORDERE Karte gerade ihre Rückseite zeigt. Als model(), damit die Ansicht ihren eigenen
   * Umdreh-Knopf bedienen kann. Beim Tausch der beiden Karten zurück auf die Vorderseite - sonst
   * läge der neu nach vorne geholte Commander gleich umgedreht da.
   */
  readonly frontShowingBack = model(false);

  get frontCard(): ScryfallCard {
    return this.cards()[this.frontIndex()] ?? this.cards()[0];
  }

  get backCard(): ScryfallCard {
    return this.cards()[1 - this.frontIndex()] ?? this.cards()[0];
  }

  onFrontClick(): void {
    this.imageClick.emit(this.frontCard);
  }

  swapToFront(event: Event): void {
    // Bringt die hintere Karte nach vorne - bewusst stopPropagation, damit weder der Umschalt-
    // Button noch ein Klick auf die kleine hintere Karte zusätzlich eine umschließende anklickbare
    // Kachel (Deck/Commander öffnen) mit-auslöst.
    event.stopPropagation();
    this.frontIndex.update((i) => 1 - i);
    this.frontShowingBack.set(false);
  }
}
