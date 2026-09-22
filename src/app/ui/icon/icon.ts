import { Component, computed, input } from '@angular/core';

/**
 * Ein einzelnes Strich-Piktogramm.
 *
 * Ersetzt die Emojis, die vorher überall in der Oberfläche standen. Emojis sehen auf jedem Gerät
 * anders aus (Apple, Google und Windows zeichnen dasselbe Zeichen verschieden), sind bunt und
 * lassen sich weder einfärben noch in der Strichstärke an die Umgebung angleichen - eine Leiste
 * aus fünf fremden Bilderchen wirkt dadurch zusammengewürfelt. Diese Piktogramme sind ein
 * einheitlicher Satz: gleiches 24er-Raster, gleiche Strichstärke, Farbe immer `currentColor`,
 * also automatisch die Textfarbe der Umgebung.
 *
 * Verwendung: `<app-icon name="trash" />` rein dekorativ (Screenreader überspringen es, weil
 * daneben Text oder ein aria-label steht) oder `<app-icon name="trophy" [label]="..." />`, wenn
 * das Zeichen die einzige Information ist.
 *
 * Die Größe kommt aus der Umgebung (`font-size`), nicht aus einem Attribut: so wächst ein Icon
 * in einer Überschrift automatisch mit, genau wie ein Emoji es getan hat.
 *
 * **Ein `<button>` um ein Icon herum muss eine eigene `color` setzen.** Ein Emoji bringt seine
 * Farbe selbst mit, ein Piktogramm zeichnet in `currentColor` - und ein Knopf erbt die Textfarbe
 * NICHT vom Elternteil, sondern nimmt die dunkle Browser-Standardfarbe. Auf den runden Knöpfen
 * über dem Kartenbild war davon genau nichts mehr zu sehen; bei `<span>` tritt das nicht auf,
 * weil Spans die Farbe erben.
 */
@Component({
  selector: 'app-icon',
  templateUrl: './icon.html',
  styleUrl: './icon.scss',
  host: { '[attr.data-icon]': 'name()' },
})
export class Icon {
  readonly name = input.required<IconName>();

  /**
   * Gesetzt = das Piktogramm wird vorgelesen, weil es allein steht. Leer = dekorativ, weil der
   * Sinn schon als Text oder als aria-label des umgebenden Knopfes danebensteht.
   */
  readonly label = input<string | null>(null);

  readonly decorative = computed(() => !this.label());
}

/** Alle vorhandenen Piktogramme. Neue Namen hier UND in icon.html eintragen. */
export type IconName =
  | 'archive'
  | 'brush'
  | 'bug'
  | 'card'
  | 'chart'
  | 'check'
  | 'comment'
  | 'copy'
  | 'crown'
  | 'deck'
  | 'dice'
  | 'download'
  | 'exchange'
  | 'exile'
  | 'graveyard'
  | 'help'
  | 'image'
  | 'inbox'
  | 'layers'
  | 'link'
  | 'lock'
  | 'mail'
  | 'outbox'
  | 'package'
  | 'palette'
  | 'pencil'
  | 'play'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'share'
  | 'shuffle'
  | 'skull'
  | 'swords'
  | 'tag'
  | 'trash'
  | 'trophy'
  | 'unlock'
  | 'user'
  | 'users'
  | 'warning'
  | 'wrench';
