import { Injectable, effect, inject, signal } from '@angular/core';
import { ProfileService } from './profile.service';
import { NavigationService, AppTab } from './navigation.service';
import { DeckViewerService } from './deck-viewer.service';
import { GameSessionService } from './game-session.service';

export type TutorialId =
  | 'intro'
  | 'match'
  | 'stats'
  | 'group'
  | 'profile'
  | 'deckDetail'
  | 'deckBuild'
  | 'ingame';

export interface TutorialStep {
  /** Falls gesetzt, wechselt die Tour vor Anzeige dieses Schritts automatisch auf diesen Haupt-Tab. */
  tab?: AppTab;
  /** `data-tutorial`-Attributwert des hervorzuhebenden Elements, oder null für einen zentrierten Schritt ohne Spotlight (z.B. weil die Funktion erst nach einer Nutzeraktion im DOM auftaucht). */
  target: string | null;
  titleKey: string;
  textKey: string;
}

export interface TutorialDef {
  id: TutorialId;
  labelKey: string;
  steps: TutorialStep[];
}

const TUTORIALS: TutorialDef[] = [
  {
    id: 'intro',
    labelKey: 'tutorial.def.intro',
    steps: [
      { target: null, titleKey: 'tutorial.welcome.title', textKey: 'tutorial.welcome.text' },
      { target: 'lang-toggle', titleKey: 'tutorial.lang.title', textKey: 'tutorial.lang.text' },
      { target: 'tab-bar', titleKey: 'tutorial.navBar.title', textKey: 'tutorial.navBar.text' },
      { target: null, titleKey: 'tutorial.done.title', textKey: 'tutorial.done.text' },
    ],
  },
  {
    id: 'match',
    labelKey: 'tutorial.def.match',
    steps: [
      { tab: 'match', target: null, titleKey: 'tutorial.match.intro.title', textKey: 'tutorial.match.intro.text' },
      { tab: 'match', target: 'match-mode', titleKey: 'tutorial.match.mode.title', textKey: 'tutorial.match.mode.text' },
      { tab: 'match', target: 'match-players-heading', titleKey: 'tutorial.match.players.title', textKey: 'tutorial.match.players.text' },
      { tab: 'match', target: null, titleKey: 'tutorial.match.commanders.title', textKey: 'tutorial.match.commanders.text' },
      { tab: 'match', target: null, titleKey: 'tutorial.match.extras.title', textKey: 'tutorial.match.extras.text' },
      { tab: 'match', target: 'match-start', titleKey: 'tutorial.match.start.title', textKey: 'tutorial.match.start.text' },
      { tab: 'match', target: 'match-history', titleKey: 'tutorial.match.history.title', textKey: 'tutorial.match.history.text' },
    ],
  },
  {
    id: 'stats',
    labelKey: 'tutorial.def.stats',
    steps: [
      { tab: 'stats', target: null, titleKey: 'tutorial.stats.intro.title', textKey: 'tutorial.stats.intro.text' },
      { tab: 'stats', target: 'stats-filters', titleKey: 'tutorial.stats.filters.title', textKey: 'tutorial.stats.filters.text' },
      { tab: 'stats', target: 'stats-player-details', titleKey: 'tutorial.stats.playerDetails.title', textKey: 'tutorial.stats.playerDetails.text' },
      { tab: 'stats', target: 'stats-overview', titleKey: 'tutorial.stats.overview.title', textKey: 'tutorial.stats.overview.text' },
      { tab: 'stats', target: 'stats-ranking', titleKey: 'tutorial.stats.ranking.title', textKey: 'tutorial.stats.ranking.text' },
      { tab: 'stats', target: 'stats-decks-commanders', titleKey: 'tutorial.stats.decksCommanders.title', textKey: 'tutorial.stats.decksCommanders.text' },
      { tab: 'stats', target: null, titleKey: 'tutorial.stats.admin.title', textKey: 'tutorial.stats.admin.text' },
    ],
  },
  {
    id: 'group',
    labelKey: 'tutorial.def.group',
    steps: [
      { tab: 'group', target: null, titleKey: 'tutorial.group.intro.title', textKey: 'tutorial.group.intro.text' },
      { tab: 'group', target: 'group-create-join', titleKey: 'tutorial.group.createJoin.title', textKey: 'tutorial.group.createJoin.text' },
      { tab: 'group', target: 'group-list-section', titleKey: 'tutorial.group.list.title', textKey: 'tutorial.group.list.text' },
      { tab: 'group', target: 'group-players', titleKey: 'tutorial.group.players.title', textKey: 'tutorial.group.players.text' },
      { tab: 'group', target: null, titleKey: 'tutorial.group.merge.title', textKey: 'tutorial.group.merge.text' },
      { tab: 'group', target: null, titleKey: 'tutorial.group.admin.title', textKey: 'tutorial.group.admin.text' },
    ],
  },
  {
    id: 'profile',
    labelKey: 'tutorial.def.profile',
    steps: [
      { tab: 'profile', target: null, titleKey: 'tutorial.profile.intro.title', textKey: 'tutorial.profile.intro.text' },
      { tab: 'profile', target: 'profile-header', titleKey: 'tutorial.profile.header.title', textKey: 'tutorial.profile.header.text' },
      { tab: 'profile', target: 'profile-favorites', titleKey: 'tutorial.profile.favorites.title', textKey: 'tutorial.profile.favorites.text' },
      { tab: 'profile', target: 'profile-icons', titleKey: 'tutorial.profile.icons.title', textKey: 'tutorial.profile.icons.text' },
      { tab: 'profile', target: 'deck-import-buttons', titleKey: 'tutorial.profile.deckImport.title', textKey: 'tutorial.profile.deckImport.text' },
      { tab: 'profile', target: null, titleKey: 'tutorial.profile.deckActions.title', textKey: 'tutorial.profile.deckActions.text' },
      { tab: 'profile', target: null, titleKey: 'tutorial.profile.unassigned.title', textKey: 'tutorial.profile.unassigned.text' },
      { tab: 'profile', target: null, titleKey: 'tutorial.profile.danger.title', textKey: 'tutorial.profile.danger.text' },
    ],
  },
  {
    id: 'deckDetail',
    labelKey: 'tutorial.def.deckDetail',
    steps: [
      { target: null, titleKey: 'tutorial.deckDetail.intro.title', textKey: 'tutorial.deckDetail.intro.text' },
      { target: 'deck-detail-header', titleKey: 'tutorial.deckDetail.header.title', textKey: 'tutorial.deckDetail.header.text' },
      { target: 'deck-view-toggles', titleKey: 'tutorial.deckDetail.toggles.title', textKey: 'tutorial.deckDetail.toggles.text' },
      { target: null, titleKey: 'tutorial.deckDetail.editMode.title', textKey: 'tutorial.deckDetail.editMode.text' },
      { target: null, titleKey: 'tutorial.deckDetail.edhrec.title', textKey: 'tutorial.deckDetail.edhrec.text' },
      { target: 'deck-analysis-toggle', titleKey: 'tutorial.deckDetail.analysis.title', textKey: 'tutorial.deckDetail.analysis.text' },
      { target: 'deck-sort-toggle', titleKey: 'tutorial.deckDetail.sort.title', textKey: 'tutorial.deckDetail.sort.text' },
      { target: 'deck-search-filter', titleKey: 'tutorial.deckDetail.search.title', textKey: 'tutorial.deckDetail.search.text' },
    ],
  },
  {
    id: 'deckBuild',
    labelKey: 'tutorial.def.deckBuild',
    steps: [
      { target: null, titleKey: 'tutorial.deckBuild.intro.title', textKey: 'tutorial.deckBuild.intro.text' },
      { target: 'deck-edit-topbar', titleKey: 'tutorial.deckBuild.topbar.title', textKey: 'tutorial.deckBuild.topbar.text' },
      { target: 'deck-add-card-mode', titleKey: 'tutorial.deckBuild.addMode.title', textKey: 'tutorial.deckBuild.addMode.text' },
      { target: 'deck-add-card-filters', titleKey: 'tutorial.deckBuild.filters.title', textKey: 'tutorial.deckBuild.filters.text' },
      { target: null, titleKey: 'tutorial.deckBuild.edhrec.title', textKey: 'tutorial.deckBuild.edhrec.text' },
      { target: 'deck-card-edit-controls', titleKey: 'tutorial.deckBuild.cardControls.title', textKey: 'tutorial.deckBuild.cardControls.text' },
      { target: null, titleKey: 'tutorial.deckBuild.pending.title', textKey: 'tutorial.deckBuild.pending.text' },
    ],
  },
  {
    id: 'ingame',
    labelKey: 'tutorial.def.ingame',
    steps: [
      { target: null, titleKey: 'tutorial.ingame.intro.title', textKey: 'tutorial.ingame.intro.text' },
      { target: 'ingame-life-area', titleKey: 'tutorial.ingame.life.title', textKey: 'tutorial.ingame.life.text' },
      { target: 'ingame-panel-icons', titleKey: 'tutorial.ingame.panelIcons.title', textKey: 'tutorial.ingame.panelIcons.text' },
      { target: 'ingame-mode-toggle', titleKey: 'tutorial.ingame.modeToggle.title', textKey: 'tutorial.ingame.modeToggle.text' },
      { target: 'ingame-menu-button', titleKey: 'tutorial.ingame.menuButton.title', textKey: 'tutorial.ingame.menuButton.text' },
      { target: null, titleKey: 'tutorial.ingame.options.title', textKey: 'tutorial.ingame.options.text' },
      { target: null, titleKey: 'tutorial.ingame.winner.title', textKey: 'tutorial.ingame.winner.text' },
    ],
  },
];

/**
 * Steuert alle Einführungs-Touren (ein Spotlight-Overlay über die echte Oberfläche pro Bereich) -
 * hält nur Zustand und Schritt-Definitionen, das eigentliche Rendern/Hervorheben übernimmt
 * TutorialOverlay (root-level Komponente analog IngameTracker/DeckDetailView). "intro" erklärt nur
 * die App-weite Grundstruktur (Sprache, Tab-Leiste); jeder Haupt-Tab sowie Deck-Detailansicht und
 * Ingame-Tracker haben je eine eigene, ausführliche Tour, die beim jeweils ERSTEN Besuch automatisch
 * startet (erst nachdem "intro" gesehen wurde) - und über den Hilfe-Knopf im Profil jederzeit erneut
 * wählbar ist.
 */
@Injectable({ providedIn: 'root' })
export class TutorialService {
  private readonly profileService = inject(ProfileService);
  private readonly navigation = inject(NavigationService);
  private readonly deckViewer = inject(DeckViewerService);
  private readonly session = inject(GameSessionService);

  readonly tutorials = TUTORIALS;

  readonly activeTutorialId = signal<TutorialId | null>(null);
  readonly stepIndex = signal(0);
  readonly showPicker = signal(false);

  private currentDef(): TutorialDef | null {
    const id = this.activeTutorialId();
    return id ? TUTORIALS.find((t) => t.id === id) ?? null : null;
  }

  currentSteps(): TutorialStep[] {
    return this.currentDef()?.steps ?? [];
  }

  currentStep(): TutorialStep | null {
    return this.currentSteps()[this.stepIndex()] ?? null;
  }

  isSeen(id: TutorialId): boolean {
    return this.profileService.profile()?.tutorialsSeen.includes(id) ?? false;
  }

  private introTriggered = false;

  constructor() {
    // "intro" startet einmalig automatisch, sobald das eigene Profil zum ersten Mal geladen ist.
    effect(() => {
      const profile = this.profileService.profile();
      if (!profile || this.introTriggered) return;
      if (!profile.tutorialsSeen.includes('intro')) {
        this.introTriggered = true;
        this.start('intro');
      }
    });

    // Pro Haupt-Tab: startet automatisch beim ersten Besuch (erst nachdem "intro" gesehen wurde).
    effect(() => {
      const tab = this.navigation.activeTab();
      const profile = this.profileService.profile();
      if (!profile || this.activeTutorialId() !== null) return;
      if (!profile.tutorialsSeen.includes('intro')) return;
      if (profile.tutorialsSeen.includes(tab)) return;
      this.start(tab as TutorialId);
    });

    // Deck-Detailansicht: startet beim ersten Öffnen eines Decks.
    effect(() => {
      const deck = this.deckViewer.viewingDeck();
      const profile = this.profileService.profile();
      if (!deck || !profile || this.activeTutorialId() !== null) return;
      if (!profile.tutorialsSeen.includes('intro')) return;
      if (profile.tutorialsSeen.includes('deckDetail')) return;
      this.start('deckDetail');
    });

    // Deck bauen (Bearbeiten-Modus): startet beim ersten Aktivieren von "Bearbeiten" in der
    // Deck-Detailansicht - unabhängig von "deckDetail" oben, da es eine eigene, tiefere Tour ist.
    effect(() => {
      const editing = this.deckViewer.editMode();
      const profile = this.profileService.profile();
      if (!editing || !profile || this.activeTutorialId() !== null) return;
      if (!profile.tutorialsSeen.includes('intro')) return;
      if (profile.tutorialsSeen.includes('deckBuild')) return;
      this.start('deckBuild');
    });

    // Ingame-Tracker: startet beim ersten Start einer Partie.
    effect(() => {
      const phase = this.session.phase();
      const profile = this.profileService.profile();
      if (phase !== 'ingame' || !profile || this.activeTutorialId() !== null) return;
      if (!profile.tutorialsSeen.includes('intro')) return;
      if (profile.tutorialsSeen.includes('ingame')) return;
      this.start('ingame');
    });
  }

  openPicker(): void {
    this.showPicker.set(true);
  }

  closePicker(): void {
    this.showPicker.set(false);
  }

  start(id: TutorialId): void {
    this.showPicker.set(false);
    this.activeTutorialId.set(id);
    this.stepIndex.set(0);
    this.applyCurrentTab();
  }

  private applyCurrentTab(): void {
    const tab = this.currentStep()?.tab;
    if (tab) this.navigation.goToTab(tab);
  }

  next(): void {
    if (this.stepIndex() >= this.currentSteps().length - 1) {
      this.finish();
      return;
    }
    this.stepIndex.update((i) => i + 1);
    this.applyCurrentTab();
  }

  prev(): void {
    if (this.stepIndex() === 0) return;
    this.stepIndex.update((i) => i - 1);
    this.applyCurrentTab();
  }

  async finish(): Promise<void> {
    const id = this.activeTutorialId();
    // Wichtig: erst NACH dem (asynchronen) Speichern von "gesehen" auf null setzen - sonst sieht
    // der Auto-Start-Effect für den aktuellen Tab kurzzeitig "keine Tour aktiv" UND "Tab noch nicht
    // gesehen" gleichzeitig und startet dieselbe Tour direkt noch einmal.
    if (id) await this.profileService.markTutorialSeen(id);
    this.activeTutorialId.set(null);
  }
}
