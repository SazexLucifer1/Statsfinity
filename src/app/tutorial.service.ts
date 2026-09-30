import { Injectable, inject, signal } from '@angular/core';
import { ProfileService } from './profile.service';
import { NavigationService } from './navigation.service';
import { DeckViewerService } from './deck-viewer.service';
import { AuthService } from './auth.service';
import { TournamentService } from './tournament.service';

export type TutorialId =
  | 'match'
  | 'search'
  | 'stats'
  | 'globalStats'
  | 'group'
  | 'profile'
  | 'profileView'
  | 'deckDetail'
  | 'deckBuild'
  | 'ingame'
  | 'tournament';

export interface TutorialStep {
  /** `data-tutorial`-Attributwert des hervorzuhebenden Elements, oder null für einen zentrierten Schritt ohne Spotlight. Fehlt das Element gerade im DOM (z.B. weil es erst nach einer Nutzeraktion erscheint), wird der Schritt ebenfalls zentriert gezeigt. */
  target: string | null;
  titleKey: string;
  textKey: string;
  /** Schritt erklärt eine EDHREC-Funktion und entfällt ohne Alpha-Zugang (siehe ProfileService.isAlphaTester). */
  alphaOnly?: boolean;
  /** Ersatztexte ohne EDHREC-Erwähnung für Nutzer ohne Alpha-Zugang. */
  plainTitleKey?: string;
  plainTextKey?: string;
}

interface TutorialDef {
  id: TutorialId;
  steps: TutorialStep[];
}

/** Kurzform für einen Schritt: `key` ist der gemeinsame Präfix von `.title` und `.text`. */
function step(target: string | null, key: string, extra: Partial<TutorialStep> = {}): TutorialStep {
  return { target, titleKey: `tutorial.${key}.title`, textKey: `tutorial.${key}.text`, ...extra };
}

const TUTORIALS: TutorialDef[] = [
  {
    id: 'match',
    steps: [
      step(null, 'match.intro'),
      step('header-actions', 'match.header'),
      step('tab-bar', 'match.navBar'),
      step('match-mode', 'match.mode'),
      step('match-ranked', 'match.ranked'),
      step('match-tournament', 'match.tournament'),
      step('match-players-heading', 'match.players'),
      step(null, 'match.commanders'),
      step(null, 'match.extras'),
      step('match-start', 'match.start'),
      step('match-history', 'match.history'),
    ],
  },
  {
    id: 'search',
    steps: [
      step(null, 'search.intro'),
      step('search-subtabs', 'search.subtabs'),
      step(null, 'search.cards'),
      step(null, 'search.precons'),
      step(null, 'search.decks'),
      step(null, 'search.deckTile'),
    ],
  },
  {
    id: 'stats',
    steps: [
      step(null, 'stats.intro'),
      step('stats-filters', 'stats.filters'),
      step('stats-player-details', 'stats.playerDetails'),
      step('stats-overview', 'stats.overview'),
      step('stats-ranking', 'stats.ranking'),
      step('stats-elo', 'stats.elo'),
      step('stats-h2h', 'stats.h2h'),
      step('stats-decks-commanders', 'stats.decksCommanders'),
      step(null, 'stats.colors'),
      step(null, 'stats.admin'),
    ],
  },
  {
    id: 'globalStats',
    steps: [
      step(null, 'globalStats.intro'),
      step('stats-global-filters', 'globalStats.filters'),
      step('stats-global-overview', 'globalStats.overview'),
      step('stats-global-decks', 'globalStats.decks'),
      step('stats-global-commanders', 'globalStats.commanders'),
    ],
  },
  {
    id: 'group',
    steps: [
      step(null, 'group.intro'),
      step('group-create-join', 'group.createJoin'),
      step('group-list-section', 'group.list'),
      step(null, 'group.leader'),
      step('group-players', 'group.players'),
      step(null, 'group.merge'),
    ],
  },
  {
    id: 'profile',
    steps: [
      step(null, 'profile.intro'),
      step('profile-inbox', 'profile.inbox'),
      step('profile-header', 'profile.header'),
      step('profile-rank', 'profile.rank'),
      step('profile-favorites', 'profile.favorites'),
      step('profile-icons', 'profile.icons'),
      step('profile-view-toggle', 'profile.viewToggle'),
      step('deck-import-buttons', 'profile.deckImport'),
      step(null, 'profile.deckActions'),
      step(null, 'profile.unassigned'),
      step(null, 'profile.danger'),
    ],
  },
  {
    id: 'profileView',
    steps: [
      step(null, 'profileView.intro'),
      step('profile-favorites', 'profileView.favorites'),
      step(null, 'profileView.content'),
    ],
  },
  {
    id: 'deckDetail',
    steps: [
      step(null, 'deckDetail.intro'),
      step('deck-detail-header', 'deckDetail.header', {
        plainTitleKey: 'tutorial.deckDetail.header.plainTitle',
        plainTextKey: 'tutorial.deckDetail.header.plainText',
      }),
      step('deck-social', 'deckDetail.social'),
      step('deck-bracket', 'deckDetail.bracket'),
      step('deck-tab-switch', 'deckDetail.tabs'),
      step('deck-view-toggles', 'deckDetail.toggles'),
      step(null, 'deckDetail.rules'),
      step('deck-analysis-toggle', 'deckDetail.analysis'),
      step('deck-sort-toggle', 'deckDetail.sort'),
      step('deck-search-filter', 'deckDetail.search'),
      step('deck-comments', 'deckDetail.comments'),
    ],
  },
  {
    id: 'deckBuild',
    steps: [
      step(null, 'deckBuild.intro'),
      step('deck-edit-topbar', 'deckBuild.topbar'),
      step('deck-add-card-mode', 'deckBuild.addMode', {
        plainTitleKey: 'tutorial.deckBuild.addMode.plainTitle',
        plainTextKey: 'tutorial.deckBuild.addMode.plainText',
      }),
      step('deck-add-card-destination', 'deckBuild.destination'),
      step('deck-add-card-filters', 'deckBuild.filters'),
      step(null, 'deckBuild.edhrec', { alphaOnly: true }),
      step('deck-card-edit-controls', 'deckBuild.cardControls'),
      step(null, 'deckBuild.pending'),
    ],
  },
  {
    id: 'ingame',
    steps: [
      step(null, 'ingame.intro'),
      step('ingame-life-area', 'ingame.life'),
      step('ingame-panel-icons', 'ingame.panelIcons'),
      step('ingame-mode-toggle', 'ingame.modeToggle'),
      step(null, 'ingame.pin'),
      step('ingame-menu-button', 'ingame.menuButton'),
      step(null, 'ingame.winner'),
    ],
  },
  {
    id: 'tournament',
    steps: [
      step(null, 'tournament.intro'),
      step(null, 'tournament.create'),
      step(null, 'tournament.join'),
      step(null, 'tournament.rounds'),
      step(null, 'tournament.standings'),
    ],
  },
];

/**
 * Hält die Erklär-Touren (ein Spotlight-Overlay über die echte Oberfläche) - nur Zustand und
 * Schritt-Definitionen, gezeichnet wird in TutorialOverlay. Touren starten NICHT mehr von selbst:
 * Der Fragezeichen-Knopf in der Kopfzeile (app.html) erklärt den gerade sichtbaren Bildschirm
 * (`startForCurrentScreen()`), im Live-Tracker steht derselbe Eintrag im ⋮-Menü.
 */
@Injectable({ providedIn: 'root' })
export class TutorialService {
  private readonly profileService = inject(ProfileService);
  private readonly navigation = inject(NavigationService);
  private readonly deckViewer = inject(DeckViewerService);
  private readonly auth = inject(AuthService);
  private readonly tournament = inject(TournamentService);

  readonly activeTutorialId = signal<TutorialId | null>(null);
  readonly stepIndex = signal(0);

  private currentDef(): TutorialDef | null {
    const id = this.activeTutorialId();
    return id ? (TUTORIALS.find((t) => t.id === id) ?? null) : null;
  }

  currentSteps(): TutorialStep[] {
    const steps = this.currentDef()?.steps ?? [];
    if (this.profileService.isAlphaTester()) return steps;
    return steps
      .filter((s) => !s.alphaOnly)
      .map((s) => ({
        ...s,
        titleKey: s.plainTitleKey ?? s.titleKey,
        textKey: s.plainTextKey ?? s.textKey,
      }));
  }

  currentStep(): TutorialStep | null {
    return this.currentSteps()[this.stepIndex()] ?? null;
  }

  /** Welche Tour zum gerade sichtbaren Inhaltsbereich gehört - dieselbe Reihenfolge wie das @if in app.html. */
  currentScreenTutorial(): TutorialId {
    if (this.deckViewer.state.viewingDeck()) {
      return this.deckViewer.state.editMode() ? 'deckBuild' : 'deckDetail';
    }
    if (this.tournament.panelExpanded()) return 'tournament';
    const tab = this.navigation.activeTab();
    if (tab === 'stats' && !this.auth.currentUser()) return 'globalStats';
    if (
      tab === 'profile' &&
      (this.profileService.viewingUserId() || this.profileService.viewingPlayerId())
    ) {
      return 'profileView';
    }
    return tab;
  }

  startForCurrentScreen(): void {
    this.start(this.currentScreenTutorial());
  }

  start(id: TutorialId): void {
    this.activeTutorialId.set(id);
    this.stepIndex.set(0);
  }

  next(): void {
    if (this.stepIndex() >= this.currentSteps().length - 1) {
      this.finish();
      return;
    }
    this.stepIndex.update((i) => i + 1);
  }

  prev(): void {
    if (this.stepIndex() === 0) return;
    this.stepIndex.update((i) => i - 1);
  }

  finish(): void {
    this.activeTutorialId.set(null);
  }
}
