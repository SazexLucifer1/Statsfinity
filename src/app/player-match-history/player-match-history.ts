import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { MtgService } from '../mtg.service';
import { I18nService } from '../i18n.service';
import { LIVE_TRACKING_START_DATE, Match } from '../models';
import { DRAW, gameModeLabel, isPlayerWinner } from '../match-utils';
import { PlayerAvatar } from '../player-avatar/player-avatar';
import { CardImage } from '../card-image/card-image';
import { Pager } from '../ui/pager/pager';
import { ScryfallCard, ScryfallService } from '../scryfall.service';
import { DeckService } from '../deck.service';
import { DeckViewerService } from '../deck-viewer.service';
import { Icon } from '../ui/icon/icon';

/** Ein Teilnehmer eines Spiels, so wie ihn die Historie als Kachel zeigt. */
export interface PlayerMatchEntry {
  name: string;
  /** Die Person, deren Profil gerade offen ist - steht bewusst mit in der Liste, nicht daneben. */
  isSelf: boolean;
  isWinner: boolean;
  commander: string | null;
  partnerCommander: string | null;
  /** Nur gesetzt, wenn wirklich ein importiertes Deck hinterlegt ist - nur dann ist die Kachel anklickbar. */
  deckId: string | null;
  deckName: string | null;
}

/** Ein Spiel aus Sicht EINER Person - alles, was die Profil-Historie je Zeile anzeigt, vorberechnet. */
export interface PlayerMatchRow {
  match: Match;
  result: 'win' | 'loss' | 'draw';
  placement: number | null;
  /** ALLE Teilnehmer inklusive der eigenen Person, in der Reihenfolge des Matches. */
  participants: PlayerMatchEntry[];
}

/**
 * Match-Verlauf EINER Person, zum Ansehen - die Ergänzung zum Verlauf im Match-Tab, der alle
 * Spiele der Gruppe zeigt. Steht im Profil (eigenes, fremdes und NPC-Profil) und listet nur die
 * Spiele, an denen die jeweils angezeigte Person selbst teilgenommen hat.
 *
 * Bewusst ohne Bearbeiten/Löschen: das Korrigieren eines Ergebnisses samt Platzierung, Commander
 * und Cube hängt am Match-Tab und bleibt dort an einer Stelle, statt in zwei Ansichten zu leben.
 */
@Component({
  selector: 'app-player-match-history',
  imports: [DatePipe, NgTemplateOutlet, PlayerAvatar, CardImage, Pager, Icon],
  templateUrl: './player-match-history.html',
  styleUrl: './player-match-history.scss',
})
export class PlayerMatchHistory {
  readonly mtg = inject(MtgService);
  readonly i18n = inject(I18nService);
  private readonly scryfall = inject(ScryfallService);
  private readonly deckService = inject(DeckService);
  private readonly deckViewer = inject(DeckViewerService);

  /** Spielername, dessen Partien gezeigt werden - null, solange das Profil noch keinen kennt. */
  readonly playerName = input.required<string | null>();
  /** Jahresfilter des eigenen Profils; 'Alle' (Vorgabe) zeigt alle Jahre. */
  readonly year = input<number | 'Alle'>('Alle');
  /**
   * Gesetzt = statt der Matches der aktiven Gruppe (mtg.history()) genau diese zeigen, samt dem
   * Namen, unter dem die Person im jeweiligen Match gespielt hat. Für ein fremdes Profil, dessen
   * Besitzer nicht in der Gruppe des Betrachters spielt (MtgService.loadPublicMatchesForUser()).
   */
  readonly externalMatches = input<{ match: Match; selfName: string }[] | null>(null);

  readonly page = signal(0);
  readonly pageSize = 10;

  readonly rows = computed<PlayerMatchRow[]>(() => {
    const name = this.playerName();
    const extern = this.externalMatches();
    if (!name && !extern) return [];
    const year = this.year();

    // Beide Quellen kommen bereits nach Datum absteigend sortiert.
    const quelle = extern ?? this.mtg.history().map((match) => ({ match, selfName: name! }));

    const rows: PlayerMatchRow[] = [];
    for (const { match, selfName: name } of quelle) {
      // Dieselbe Grenze wie im Match-Tab: alte Excel-Importe bleiben in der Statistik, aber aus
      // dem sichtbaren Verlauf raus (siehe LIVE_TRACKING_START_DATE in models.ts).
      if (new Date(match.date) < LIVE_TRACKING_START_DATE) continue;
      if (year !== 'Alle' && new Date(match.date).getFullYear() !== year) continue;

      const me = match.players.find((p) => p.name === name);
      if (!me) continue;

      const isDraw = match.winner === DRAW;
      rows.push({
        match,
        result: isDraw
          ? 'draw'
          : isPlayerWinner(match.mode, match.winner, me.name, me.team, me.isArchenemy)
            ? 'win'
            : 'loss',
        placement: me.placement ?? null,
        participants: match.players.map((p) => ({
          name: p.name,
          isSelf: p.name === name,
          // Über isPlayerWinner, damit auch ein Sieg über das Team (Two-Headed Giant) oder über
          // "alle außer dem Archenemy" bei allen Beteiligten die Krone zeigt.
          isWinner:
            !isDraw && isPlayerWinner(match.mode, match.winner, p.name, p.team, p.isArchenemy),
          commander: p.commander ?? null,
          partnerCommander: p.partnerCommander ?? null,
          deckId: p.deckId ?? null,
          deckName: p.deckName ?? null,
        })),
      });
    }
    return rows;
  });

  readonly wins = computed(() => this.rows().filter((r) => r.result === 'win').length);

  readonly winRate = computed(() => {
    const total = this.rows().length;
    return total === 0 ? 0 : Math.round((this.wins() / total) * 100);
  });

  /** Gegen eine Seitenzahl, die nach einem Profil- oder Jahreswechsel hinter dem Ende liegt. */
  readonly effectivePage = computed(() =>
    Math.min(this.page(), Math.max(0, Math.ceil(this.rows().length / this.pageSize) - 1)),
  );

  readonly pagedRows = computed(() => {
    const start = this.effectivePage() * this.pageSize;
    return this.rows().slice(start, start + this.pageSize);
  });

  // --- Commander-Vorschaubilder ---
  //
  // Zwei Quellen, dieselbe Rangfolge wie in der Deck-Liste und im Statistik-Tab: das im Deck selbst
  // hinterlegte Artwork (deck_cards.image_url) hat Vorrang, damit das Bild hier mit dem in der
  // Deck-Ansicht übereinstimmt; erst danach die Namenssuche bei Scryfall, die auch Commander ohne
  // hinterlegtes Deck abdeckt. Geladen wird nur, was auf der gerade sichtbaren Seite steht.

  private readonly commanderCards = signal<Record<string, ScryfallCard | null>>({});
  private readonly storedCommanders = signal<
    Map<string, { name: string; imageUrl: string | null }>
  >(new Map());
  /** Bereits abgefragte Deck-IDs - ein Deck ohne hinterlegten Commander steht in keiner Antwort und würde sonst bei jedem Lauf erneut abgefragt. */
  private readonly requestedDeckIds = new Set<string>();

  constructor() {
    effect(() => {
      const names = new Set<string>();
      for (const row of this.pagedRows()) {
        for (const p of row.participants) {
          if (p.commander) names.add(p.commander);
          if (p.partnerCommander) names.add(p.partnerCommander);
        }
      }
      const cache = this.commanderCards();
      const missing = [...names].filter((n) => !(n.toLowerCase() in cache));
      if (missing.length === 0) return;

      void this.scryfall.findCardsBulk(missing).then((found) => {
        this.commanderCards.update((current) => {
          const next = { ...current };
          for (const name of missing) {
            next[name.toLowerCase()] = found.get(name.toLowerCase()) ?? null;
          }
          return next;
        });
      });
    });

    effect(() => {
      const missing: string[] = [];
      for (const row of this.pagedRows()) {
        for (const p of row.participants) {
          if (p.deckId && !this.requestedDeckIds.has(p.deckId)) missing.push(p.deckId);
        }
      }
      if (missing.length === 0) return;
      for (const id of missing) this.requestedDeckIds.add(id);

      void this.deckService.getStoredCommanders(missing).then((found) => {
        if (found.size === 0) return;
        this.storedCommanders.update((current) => new Map([...current, ...found]));
      });
    });
  }

  /** Vorderseite des Commander-Bilds einer Kachel, oder null, solange (oder falls) es keines gibt. */
  thumbUrl(entry: PlayerMatchEntry): string | null {
    const stored = entry.deckId ? this.storedCommanders().get(entry.deckId) : undefined;
    if (stored?.imageUrl) return stored.imageUrl;
    if (!entry.commander) return null;
    return this.commanderCards()[entry.commander.toLowerCase()]?.imageUrl ?? null;
  }

  /** Rückseite bei Doppelkarten - immer aus der Namenssuche, ein im Deck hinterlegtes Bild kennt nie eine Rückseite. */
  thumbBackUrl(entry: PlayerMatchEntry): string | null {
    if (!entry.commander) return null;
    return this.commanderCards()[entry.commander.toLowerCase()]?.backImageUrl ?? null;
  }

  commanderLabel(entry: PlayerMatchEntry): string | null {
    if (!entry.commander) return null;
    return entry.partnerCommander
      ? `${entry.commander} + ${entry.partnerCommander}`
      : entry.commander;
  }

  /**
   * Klick auf eine Kachel mit hinterlegtem Deck: öffnet die Deck-Detailansicht wie aus der
   * Deck-Liste heraus (root-level Overlay, funktioniert aus jedem Tab). Fremde Decks schaltet die
   * Detailansicht selbst schreibgeschützt (DeckViewerService.canEditViewingDeck).
   */
  async openDeck(deckId: string): Promise<void> {
    const deck = await this.deckService.getDeckById(deckId);
    if (deck) await this.deckViewer.open(deck);
  }

  modeLabel(match: Match): string {
    return gameModeLabel(match.mode, match.format);
  }

  resultLabel(result: PlayerMatchRow['result']): string {
    return this.i18n.t(
      result === 'win'
        ? 'profile.matchHistoryWin'
        : result === 'draw'
          ? 'profile.matchHistoryDraw'
          : 'profile.matchHistoryLoss',
    );
  }
}
