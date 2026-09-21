import { Component, inject } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CdkDropList, CdkDrag, CdkDragDrop } from '@angular/cdk/drag-drop';
import { GoldfishService, GoldfishCardInstance, GoldfishZone, activeTypeLine, isEphemeralSpell, isAttachable } from '../goldfish.service';
import { I18nService } from '../i18n.service';
import { Icon } from '../ui/icon/icon';

@Component({
  selector: 'app-goldfish-tracker',
  imports: [FormsModule, NgTemplateOutlet, CdkDropList, CdkDrag, Icon],
  templateUrl: './goldfish-tracker.html',
  styleUrl: './goldfish-tracker.scss',
})
export class GoldfishTracker {
  readonly goldfish = inject(GoldfishService);
  readonly i18n = inject(I18nService);

  zoneLabel(zone: GoldfishZone): string {
    return this.i18n.t(`goldfish.zone.${zone}`);
  }

  moveMenuCard(): GoldfishCardInstance | null {
    const id = this.goldfish.moveMenuFor();
    if (!id) return null;
    return this.goldfish.cards().find((c) => c.instanceId === id) ?? null;
  }

  /**
   * Sinnvolle Zielzonen fürs Verschiebe-Menü - Kommandozone nur als Ziel, wenn die Karte tatsächlich
   * ein Commander ist; "Spielfeld" wird bei Instant/Sorcery gar nicht erst angeboten, da das im
   * Service ohnehin automatisch in den Friedhof umgeleitet würde (wäre als Button-Label irreführend).
   */
  moveMenuTargets(): GoldfishZone[] {
    const card = this.moveMenuCard();
    if (!card) return [];
    const zones: GoldfishZone[] = isEphemeralSpell(activeTypeLine(card))
      ? ['hand', 'library', 'graveyard', 'exile']
      : ['battlefield', 'hand', 'library', 'graveyard', 'exile'];
    if (card.isCommander) zones.push('command');
    return zones.filter((z) => z !== card.zone);
  }

  /** Ausrüstung/Verzauberung, die man an eine Kreatur anlegen kann - nur relevant, während sie auf dem Spielfeld liegt. */
  moveMenuCardIsAttachable(): boolean {
    const card = this.moveMenuCard();
    return !!card && card.zone === 'battlefield' && isAttachable(activeTypeLine(card));
  }

  attachTargetsFor(instanceId: string): GoldfishCardInstance[] {
    return this.goldfish.attachTargets(instanceId);
  }

  /**
   * Generischer Drop-Handler für alle Ablageziele (Spielfeld/Bibliothek/Friedhof/Exil) - welche Zone
   * gemeint ist, kommt direkt aus dem Template statt aus der Container-ID, damit jede neue Ablage-
   * Liste nur eine zusätzliche Bindung braucht. Beim Spielfeld ergibt sich die tatsächliche Zeile
   * (Kreatur/Rest/Land) automatisch aus der Type-Line, unabhängig davon, wo genau abgelegt wurde.
   */
  onZoneDropped(event: CdkDragDrop<unknown>, zone: GoldfishZone): void {
    const card = event.item.data as GoldfishCardInstance;
    this.goldfish.moveCard(card.instanceId, zone);
  }

  // --- Spielfeld: Tap = tappen/enttappen, Long-Press = Verschiebe-Menü (Muster wie startPinLongPress in ingame-tracker.ts) ---

  private battlefieldPressTimer: ReturnType<typeof setTimeout> | null = null;
  private battlefieldLongPressFired = false;

  startBattlefieldPress(instanceId: string): void {
    this.cancelBattlefieldPress();
    this.battlefieldLongPressFired = false;
    this.battlefieldPressTimer = setTimeout(() => {
      this.battlefieldLongPressFired = true;
      this.goldfish.openMoveMenu(instanceId);
      this.battlefieldPressTimer = null;
    }, 550);
  }

  endBattlefieldPress(instanceId: string): void {
    const longPressFired = this.battlefieldLongPressFired;
    this.cancelBattlefieldPress();
    if (!longPressFired) this.goldfish.toggleTapped(instanceId);
  }

  cancelBattlefieldPress(): void {
    if (this.battlefieldPressTimer) {
      clearTimeout(this.battlefieldPressTimer);
      this.battlefieldPressTimer = null;
    }
  }

  // --- Press-and-Hold fürs Ziehen (Muster wie startHold/stopHold in ingame-tracker.ts, hier lokal nachgebaut) ---

  private readonly activeHolds = new Map<
    string,
    { timeout?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval>; startedAt: number }
  >();

  private startHold(key: string, action: () => void): void {
    if (this.activeHolds.has(key)) return;
    action();

    const state: { timeout?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval>; startedAt: number } = {
      startedAt: Date.now(),
    };
    state.timeout = setTimeout(() => {
      state.interval = setInterval(action, 150);
    }, 400);

    this.activeHolds.set(key, state);
  }

  private stopHold(key: string): void {
    const state = this.activeHolds.get(key);
    if (!state) return;
    if (state.timeout) clearTimeout(state.timeout);
    if (state.interval) clearInterval(state.interval);
    this.activeHolds.delete(key);
  }

  private stopAllHolds(): void {
    for (const key of [...this.activeHolds.keys()]) this.stopHold(key);
  }

  startDrawHold(): void {
    this.startHold('draw', () => this.goldfish.draw(1));
  }
  stopDrawHold(): void {
    this.stopHold('draw');
  }

  ngOnDestroy(): void {
    this.stopAllHolds();
    this.cancelBattlefieldPress();
  }
}
