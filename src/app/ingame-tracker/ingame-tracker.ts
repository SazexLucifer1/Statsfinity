import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  QueryList,
  ViewChildren,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { COUNTER_ICONS, COUNTER_KINDS, GameSessionService, IngameUnit, UndoEntry } from '../game-session.service';
import { MtgService } from '../mtg.service';
import { BackgroundService } from '../background.service';
import { TournamentService } from '../tournament.service';
import { DialogService } from '../dialog.service';
import { I18nService } from '../i18n.service';
import { TutorialService } from '../tutorial.service';
import { AuthService } from '../auth.service';
import { Icon } from '../ui/icon/icon';
import { WIN_CONDITIONS } from '../models';
import { LifeChart } from '../ui/life-chart/life-chart';

const FIVE_MINUTES_MS = 5 * 60_000;

@Component({
  selector: 'app-ingame-tracker',
  imports: [CommonModule, Icon, LifeChart],
  templateUrl: './ingame-tracker.html',
  styleUrls: ['./ingame-tracker.scss', './ingame-tracker.overlays.scss'],
})
export class IngameTracker implements AfterViewInit, OnDestroy {
  readonly session = inject(GameSessionService);
  readonly mtg = inject(MtgService);
  readonly backgrounds = inject(BackgroundService);
  readonly tournament = inject(TournamentService);
  private readonly dialog = inject(DialogService);
  readonly i18n = inject(I18nService);
  readonly auth = inject(AuthService);
  private readonly tutorial = inject(TutorialService);

  // --- Turnier-Rundenzeit (nur sichtbar, wenn dieses Spiel Teil eines Turnier-Tisches ist) ---
  private readonly now = signal(Date.now());

  readonly tournamentDeadline = computed<string | null>(() => {
    const matchId = this.session.activeTournamentMatchId();
    if (!matchId) return null;
    const match = this.tournament.matches().find((m) => m.id === matchId);
    return match ? this.tournament.matchDeadlineAt(match) : null;
  });

  readonly tournamentRemainingMs = computed<number | null>(() => {
    const deadline = this.tournamentDeadline();
    return deadline ? new Date(deadline).getTime() - this.now() : null;
  });

  readonly tournamentRemainingLabel = computed(() => {
    const remaining = this.tournamentRemainingMs();
    if (remaining === null) return '';
    const clamped = Math.max(0, remaining);
    const totalSeconds = Math.floor(clamped / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  });

  readonly tournamentFiveMinuteWarning = computed(() => {
    const r = this.tournamentRemainingMs();
    return r !== null && r > 0 && r <= FIVE_MINUTES_MS;
  });

  readonly tournamentTimeIsUp = computed(() => {
    const r = this.tournamentRemainingMs();
    return r !== null && r <= 0;
  });

  /** Laufender BO3-Spielstand des aktuellen Turnier-Tisches (nur bei 1v1) - bleibt sichtbar, solange die BO3 noch nicht entschieden ist (siehe TournamentService.handleGameFinished, das dann automatisch das nächste Spiel hier startet). */
  readonly tournamentBo3Score = computed<{ p1: string; s1: number; p2: string; s2: number } | null>(() => {
    const matchId = this.session.activeTournamentMatchId();
    if (!matchId) return null;
    const match = this.tournament.matches().find((m) => m.id === matchId);
    if (!match || match.participants.length !== 2) return null;
    const [a, b] = match.participants;
    return { p1: a.playerName, s1: a.gamesWon, p2: b.playerName, s2: b.gamesWon };
  });

  constructor() {
    effect((onCleanup) => {
      if (!this.session.activeTournamentMatchId()) return;
      const id = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(id));
    });

    // Verhindert, dass sich das Handy während einer laufenden Partie selbst sperrt - eine
    // Commander-Runde dauert oft 60-90 Minuten mit langen Phasen ohne Interaktion (fremder Zug),
    // und das Gerät liegt am Tisch, damit reihum draufgetippt werden kann. Ohne Wake Lock müsste
    // sonst irgendwann jemand das gesperrte Handy erst wieder entsperren, bevor er Leben abziehen
    // kann - das würde das ganze "Handy liegt am Tisch"-Konzept unterlaufen.
    effect((onCleanup) => {
      const isActive = this.session.phase() === 'ingame' && !this.session.minimized();
      if (!isActive) return;

      let cancelled = false;
      this.acquireWakeLock().then((sentinel) => {
        if (cancelled) sentinel?.release();
      });

      const reacquireOnVisible = (): void => {
        if (document.visibilityState === 'visible') this.acquireWakeLock();
      };
      document.addEventListener('visibilitychange', reacquireOnVisible);

      onCleanup(() => {
        cancelled = true;
        document.removeEventListener('visibilitychange', reacquireOnVisible);
        this.releaseWakeLock();
      });
    });
  }

  // --- Wake Lock: hält den Bildschirm während einer laufenden Partie wach (siehe Effect oben).
  // Der Browser gibt ein Wake Lock automatisch frei, sobald der Tab in den Hintergrund wechselt
  // (App-Wechsel, Bildschirm manuell gesperrt) - deshalb wird es bei "wieder sichtbar" erneut
  // angefordert, statt nur einmalig beim Spielstart. ---

  private wakeLockSentinel: WakeLockSentinel | null = null;

  private async acquireWakeLock(): Promise<WakeLockSentinel | null> {
    if (!('wakeLock' in navigator)) return null;
    try {
      this.wakeLockSentinel = await navigator.wakeLock.request('screen');
      return this.wakeLockSentinel;
    } catch (err) {
      // Kann z.B. bei niedrigem Akkustand oder fehlender Nutzer-Geste abgelehnt werden - dann bleibt
      // der Tracker einfach ohne Wake Lock nutzbar, kein Grund für eine Fehlermeldung an den User.
      console.warn('Wake Lock konnte nicht angefordert werden:', err);
      return null;
    }
  }

  private releaseWakeLock(): void {
    this.wakeLockSentinel?.release();
    this.wakeLockSentinel = null;
  }

  /** Kurzer Vibrations-Tick als taktile Rückmeldung fürs Tippen - Leben/Gift/Commander-Schaden
   * werden erst nach 700ms verrechnet (siehe GameSessionService.bufferChange), die große Zahl
   * rührt sich also kurz nicht. Ohne Vibration ist der einzige Hinweis "hat's registriert?" eine
   * kleine, blasse "+1"-Einblendung - auf dem Handy unter Tischtrubel leicht zu übersehen. */
  private vibrateTick(): void {
    navigator.vibrate?.(10);
  }

  readonly backgroundPickerFor = signal<string | null>(null);

  openBackgroundPicker(player: string): void {
    this.backgroundPickerFor.set(player);
    this.backgrounds.ensureLoaded();
  }

  closeBackgroundPicker(): void {
    this.backgroundPickerFor.set(null);
  }

  selectBackground(player: string, url: string | null): void {
    this.mtg.setPlayerBackground(player, url);
    this.closeBackgroundPicker();
  }

  toggleDead(key: string): void {
    this.vibrateTick();
    const dying = !this.session.isDead(key);
    this.session.toggleDead(key);
    if (dying && this.session.tracksEliminations()) this.eliminationSheetFor.set(key);
  }

  // --- Rauswurf: beim Totenkopf fragen, wer den Spieler rausgeworfen hat ---

  /** Panel-Key des gerade rausgeworfenen Spielers, solange das Sheet offen ist. */
  readonly eliminationSheetFor = signal<string | null>(null);

  /** Wer als Werfer infrage kommt: alle anderen, die noch leben. */
  readonly eliminationCandidates = computed(() => {
    const victim = this.eliminationSheetFor();
    return this.session.ingameUnits().filter((u) => u.key !== victim && !this.session.isDead(u.key));
  });

  pickEliminatedBy(killer: string | null): void {
    const victim = this.eliminationSheetFor();
    if (victim) this.session.setEliminatedBy(victim, killer);
    this.eliminationSheetFor.set(null);
  }

  /** Zeile im Totenkopf-Feld: wer es war, oder die Aufforderung, es nachzutragen. */
  eliminationLabel(key: string): string {
    const killer = this.session.eliminations()[key];
    if (!killer) return this.i18n.t('ingame.eliminationAsk');
    if (killer === key) return this.i18n.t('ingame.eliminationSelfShort');
    const label = this.session.ingameUnits().find((u) => u.key === killer)?.label ?? killer;
    return this.i18n.t('ingame.eliminatedByShort', { name: label });
  }

  readonly brokenBackgrounds = signal<Set<string>>(new Set());

  markBackgroundBroken(url: string): void {
    this.brokenBackgrounds.update((set) => {
      const next = new Set(set);
      next.add(url);
      return next;
    });
    console.warn(`Hintergrundbild nicht gefunden (404?): ${url}`);
  }

  async onBackgroundFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    await this.backgrounds.uploadBackground(file);
  }

  async deleteOwnBackground(event: Event, id: string): Promise<void> {
    event.stopPropagation();
    if (await this.dialog.confirm(this.i18n.t('ingame.msg.confirmDeleteBackground'))) {
      await this.backgrounds.deleteBackground(id);
    }
  }

  // --- Zentrales Options-Menü: ersetzt den alten Minimieren-Button (oben) und
  // den Spiel-beenden-Button (unten) durch einen einzigen Button in der Mitte. ---

  readonly showOptionsMenu = signal(false);

  openOptionsMenu(): void {
    this.lastUndone.set(null);
    this.showOptionsMenu.set(true);
  }

  closeOptionsMenu(): void {
    this.showOptionsMenu.set(false);
  }

  chooseMinimize(): void {
    this.showOptionsMenu.set(false);
    this.session.minimizeGame();
  }

  chooseHelp(): void {
    this.showOptionsMenu.set(false);
    this.tutorial.start('ingame');
  }

  chooseEndGame(): void {
    this.showOptionsMenu.set(false);
    this.session.showWinnerPanel.set(true);
  }

  // --- Rückgängig: bleibt im Menü, damit sich mehrere Schritte nacheinander zurücknehmen
  // lassen; die Zeile darunter sagt, was zuletzt zurückgenommen wurde. ---

  readonly lastUndone = signal<string | null>(null);
  /** Siegarten im Sieger-Dialog (optional, sql/partie-ergebnis-deck-version-2026-10-06.sql). */
  readonly winConditions = WIN_CONDITIONS;
  readonly counterKinds = COUNTER_KINDS;
  readonly counterIcons = COUNTER_ICONS;

  // --- Monarch/Initiative per Ziehen weitergeben: Marke antippen und gedrückt auf ein anderes
  // Feld ziehen. Die Felder sind gedreht, deshalb zählt nur die Bildschirmposition beim Loslassen
  // (elementFromPoint), nicht eine Richtung im Feld. ---

  readonly markerDrag = signal<{ kind: 'monarch' | 'initiative'; x: number; y: number; moved: boolean } | null>(null);

  startMarkerDrag(event: PointerEvent, kind: 'monarch' | 'initiative'): void {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    this.markerDrag.set({ kind, x: startX, y: startY, moved: false });

    const move = (e: PointerEvent): void => {
      const moved = Math.hypot(e.clientX - startX, e.clientY - startY) > 8;
      this.markerDrag.update((d) => (d ? { ...d, x: e.clientX, y: e.clientY, moved: d.moved || moved } : d));
    };
    const end = (e: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      const drag = this.markerDrag();
      this.markerDrag.set(null);
      if (!drag?.moved || e.type === 'pointercancel') return;
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-unit-key]');
      const key = target?.getAttribute('data-unit-key');
      if (!key) return;
      if (kind === 'monarch') this.session.monarchKey.set(key);
      else this.session.initiativeKey.set(key);
      this.vibrateTick();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  /** Panel-Key -> Anzeigename (bei 2HG "Anna & Ben" statt des Team-Schlüssels). */
  readonly unitLabels = computed(() =>
    Object.fromEntries(this.session.ingameUnits().map((u) => [u.key, u.label])),
  );

  undoLast(): void {
    const entry = this.session.undoLast();
    this.lastUndone.set(entry ? this.describeUndo(entry) : null);
  }

  private describeUndo(entry: UndoEntry): string {
    const name = this.session.ingameUnits().find((u) => u.key === entry.key)?.label ?? entry.key;
    const what =
      entry.kind === 'life'
        ? 'ingame.undoWhatLife'
        : entry.kind === 'poison'
          ? 'ingame.undoWhatPoison'
          : 'ingame.undoWhatCommanderDamage';
    const delta = `${entry.delta > 0 ? '+' : ''}${entry.delta}`;
    return this.i18n.t('ingame.undone', { name, delta, what: this.i18n.t(what) });
  }

  // --- Startspieler von Hand festlegen (ausgewürfelt statt ausgelost) ---

  readonly starterPickerOpen = signal(false);

  openStarterPicker(): void {
    this.showOptionsMenu.set(false);
    this.starterPickerOpen.set(true);
  }

  pickStarter(key: string | null): void {
    this.session.startingPlayerKey.set(key);
    this.starterPickerOpen.set(false);
  }

  // --- Eingabe-Sheet je Spieler: Leben eintippen oder in größeren Schritten ändern, Monarch und
  // Initiative vergeben. Ein eigenes Sheet statt weiterer Tippzonen - das Feld selbst ist schon
  // voll mit +/- und gehört dem schnellen Tippen. ---

  readonly playerSheetFor = signal<IngameUnit | null>(null);
  readonly lifeDraft = signal('');

  openPlayerSheet(unit: IngameUnit): void {
    this.playerSheetFor.set(unit);
    this.lifeDraft.set(String(this.session.lifeTotals()[unit.key] ?? ''));
  }

  closePlayerSheet(): void {
    this.playerSheetFor.set(null);
  }

  changeLifeBy(key: string, delta: number): void {
    this.vibrateTick();
    this.session.changeLifeNow(key, delta);
    this.lifeDraft.set(String(this.session.lifeTotals()[key] ?? ''));
  }

  applyLifeDraft(key: string): void {
    const value = Number.parseInt(this.lifeDraft(), 10);
    if (Number.isNaN(value)) return;
    this.session.setLife(key, value);
    this.closePlayerSheet();
  }

  // --- Spieler neu anordnen: Tippen-zum-Tauschen-Modus ---

  readonly reorderMode = signal(false);
  readonly reorderFirstKey = signal<string | null>(null);

  openReorderMode(): void {
    this.showOptionsMenu.set(false);
    this.reorderMode.set(true);
    this.reorderFirstKey.set(null);
  }

  closeReorderMode(): void {
    this.reorderMode.set(false);
    this.reorderFirstKey.set(null);
  }

  selectForReorder(key: string): void {
    const first = this.reorderFirstKey();
    if (!first) {
      this.reorderFirstKey.set(key);
      return;
    }
    if (first === key) {
      this.reorderFirstKey.set(null);
      return;
    }
    this.session.swapUnits(first, key);
    this.reorderFirstKey.set(null);
  }

  // --- Longpress auf einen Panel-Namen: Menü zum freien Anheften des
  // Sonderslots unten (quer liegend bei ungerader Panel-Anzahl). ---

  readonly pinMenuFor = signal<string | null>(null);
  private pinLongPressTimer: ReturnType<typeof setTimeout> | null = null;

  startPinLongPress(key: string): void {
    this.cancelPinLongPress();
    this.pinLongPressTimer = setTimeout(() => {
      this.pinMenuFor.set(key);
      this.pinLongPressTimer = null;
    }, 550);
  }

  cancelPinLongPress(): void {
    if (this.pinLongPressTimer) {
      clearTimeout(this.pinLongPressTimer);
      this.pinLongPressTimer = null;
    }
  }

  closePinMenu(): void {
    this.pinMenuFor.set(null);
  }

  pinToBottom(key: string): void {
    this.session.setPinnedBottomKey(key);
    this.closePinMenu();
  }

  resetPinnedBottom(): void {
    this.session.setPinnedBottomKey(null);
    this.closePinMenu();
  }

  /** Ist dieser Index gerade der Sonderslot unten (volle Breite, quer)? */
  isBottomSpecialSlot(index: number): boolean {
    return this.session.hasOddBottomSlot() && index === this.session.ingameUnits().length - 1;
  }

  // --- Startspieler-Roulette: durchläuft alle Panel-Einheiten mehrfach
  // (schnell, wird zum Ende hin langsamer) und landet zufällig auf einer. ---

  readonly showRouletteOverlay = signal(false);
  readonly rouletteHighlightKey = signal<string | null>(null);
  readonly rouletteResultUnit = signal<IngameUnit | null>(null);
  private rouletteTimeout: ReturnType<typeof setTimeout> | null = null;

  startPlayerRoulette(): void {
    this.showOptionsMenu.set(false);
    const units = this.session.ingameUnits();
    if (units.length === 0) return;

    this.rouletteResultUnit.set(null);
    this.showRouletteOverlay.set(true);

    const finalIndex = Math.floor(Math.random() * units.length);
    // totalSteps so gewählt, dass der LETZTE Loop-Durchlauf (step = totalSteps - 1)
    // bereits exakt bei finalIndex landet – kein Nachkorrigieren am Ende nötig,
    // das Ergebnis entspricht immer genau der zuletzt angezeigten Ecke.
    const rounds = 3; // Mindestanzahl voller Umdrehungen vor dem Stopp
    const totalSteps = units.length * rounds + finalIndex + 1;
    let step = 0;

    const tick = (): void => {
      const currentIndex = step % units.length;
      this.rouletteHighlightKey.set(units[currentIndex].key);
      step++;

      if (step >= totalSteps) {
        this.rouletteResultUnit.set(units[currentIndex]);
        // Fürs Speichern merken (Zugreihenfolge) - im Sieger-Dialog lässt es sich noch ändern.
        this.session.startingPlayerKey.set(units[currentIndex].key);
        return;
      }

      const progress = step / totalSteps;
      const delay = 60 + Math.pow(progress, 3) * 340; // startet bei ~60ms, endet bei ~400ms
      this.rouletteTimeout = setTimeout(tick, delay);
    };

    tick();
  }

  closeRouletteOverlay(): void {
    if (this.rouletteTimeout) clearTimeout(this.rouletteTimeout);
    this.rouletteTimeout = null;
    this.showRouletteOverlay.set(false);
    this.rouletteHighlightKey.set(null);
    this.rouletteResultUnit.set(null);
  }

  @ViewChildren('panelRef') private panelRefs!: QueryList<ElementRef<HTMLDivElement>>;
  private resizeObserver: ResizeObserver | null = null;
  private panelRefsSub: Subscription | null = null;

  /** Tatsächliche Pixelgröße jeder Panel-Zelle, live gemessen – passt sich jeder Bildschirmgröße automatisch an. */
  readonly panelSizes = signal<Record<number, { width: number; height: number }>>({});

  ngAfterViewInit(): void {
    this.resizeObserver = new ResizeObserver((entries) => {
      this.panelSizes.update((sizes) => {
        const next = { ...sizes };
        for (const entry of entries) {
          const indexAttr = (entry.target as HTMLElement).dataset['panelIndex'];
          if (indexAttr === undefined) continue;
          next[Number(indexAttr)] = { width: entry.contentRect.width, height: entry.contentRect.height };
        }
        return next;
      });
    });

    this.observeCurrentPanels();
    this.panelRefsSub = this.panelRefs.changes.subscribe(() => this.observeCurrentPanels());
  }

  iconPairCorner(index: number): string {
    const cols = this.session.ingameColumns();
    const row = Math.floor(index / cols);
    const col = index % cols;
    const isTopRight = (row + col) % 2 !== 0;
    return isTopRight ? 'corner-tr' : 'corner-tl';
  }

  iconPairDirection(_index: number): string {
    return 'column';
  }

  private observeCurrentPanels(): void {
    if (!this.resizeObserver) return;
    this.resizeObserver.disconnect();
    this.panelRefs.forEach((ref) => this.resizeObserver!.observe(ref.nativeElement));
  }

  /**
   * Ist dieses Panel (nach der Rotation) breiter als hoch? Dann liegen mehrere
   * Commander-Quellen im Schadens-Fokus NEBENEINANDER statt untereinander -
   * gestapelt bräuchte jede Quelle (Label + 64px Tap-Fläche + Padding) rund
   * 100px, was bei den quer liegenden Panels eines 4-Spieler-Spiels (~180px
   * Inhaltshöhe auf dem iPhone) nicht für zwei Quellen reicht: die zweite wurde
   * von .player-panel {overflow:hidden} abgeschnitten.
   */
  isWidePanel(index: number): boolean {
    const size = this.panelSizes()[index];
    if (!size) return false;
    const rotated = Math.abs(this.session.panelRotation(index)) === 90;
    const width = rotated ? size.height : size.width;
    const height = rotated ? size.width : size.height;
    return width > height;
  }

  panelInnerWidth(index: number): string {
    const size = this.panelSizes()[index];
    if (!size) return '100%';
    const rotated = Math.abs(this.session.panelRotation(index)) === 90;
    return `${rotated ? size.height : size.width}px`;
  }

  panelInnerHeight(index: number): string {
    const size = this.panelSizes()[index];
    if (!size) return '100%';
    const rotated = Math.abs(this.session.panelRotation(index)) === 90;
    return `${rotated ? size.width : size.height}px`;
  }

  // --- Press-and-Hold: sofort 1 Schritt, nach 400ms Wiederholung, ab 2s Schrittgröße 10 ---

  private readonly activeHolds = new Map<string, { timeout?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval>; startedAt: number }>();

  private startHold(key: string, action: (step: number) => void): void {
    if (this.activeHolds.has(key)) return;
    this.vibrateTick();
    action(1);

    const state: { timeout?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval>; startedAt: number } = {
      startedAt: Date.now(),
    };
    state.timeout = setTimeout(() => {
      state.interval = setInterval(() => {
        const heldFor = Date.now() - state.startedAt;
        action(heldFor > 2000 ? 10 : 1);
      }, 150);
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
    for (const key of [...this.activeHolds.keys()]) {
      this.stopHold(key);
    }
  }

  startLifeHold(player: string, sign: 1 | -1): void {
    this.startHold(`life-${player}-${sign}`, (step) => this.session.bufferLifeChange(player, sign * step));
  }
  stopLifeHold(player: string, sign: 1 | -1): void {
    this.stopHold(`life-${player}-${sign}`);
  }

  startCommanderDamageHold(target: string, sourceKey: string, sign: 1 | -1): void {
    this.startHold(`cd-${target}-${sourceKey}-${sign}`, (step) => this.session.bufferCommanderDamageChange(target, sourceKey, sign * step));
  }
  stopCommanderDamageHold(target: string, sourceKey: string, sign: 1 | -1): void {
    this.stopHold(`cd-${target}-${sourceKey}-${sign}`);
  }

  startPoisonHold(player: string, sign: 1 | -1): void {
    this.startHold(`poison-${player}-${sign}`, (step) => this.session.bufferPoisonChange(player, sign * step));
  }
  stopPoisonHold(player: string, sign: 1 | -1): void {
    this.stopHold(`poison-${player}-${sign}`);
  }

  ngOnDestroy(): void {
    this.stopAllHolds();
    this.cancelPinLongPress();
    if (this.rouletteTimeout) clearTimeout(this.rouletteTimeout);
    this.resizeObserver?.disconnect();
    this.panelRefsSub?.unsubscribe();
  }

  /** Menschenlesbarer Text für den aktuell gewählten Sieger - für die Bestätigungsabfrage vor dem Speichern. */
  private winnerLabel(): string {
    const winner = this.session.winner();
    if (!winner) return '';
    if (winner === this.session.DRAW) return this.i18n.t('ingame.draw');
    if (winner === this.session.OTHERS) return this.i18n.t('ingame.allOthers');
    return winner;
  }

  async finishGame(): Promise<void> {
    if (!this.session.canSave()) return;
    const confirmKey = this.auth.currentUser() ? 'ingame.confirmSaveWinner' : 'ingame.confirmEndGuestGame';
    if (!(await this.dialog.confirm(this.i18n.t(confirmKey, { winner: this.winnerLabel() })))) return;
    this.stopAllHolds();
    this.session.saveAndReset();
  }

  async discardGame(): Promise<void> {
    const confirmed = await this.dialog.confirm(this.i18n.t('ingame.msg.confirmDiscardGame'));
    if (!confirmed) return;

    this.stopAllHolds();
    this.session.discardAndReset();
  }
}