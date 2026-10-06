import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { DeckService } from './deck.service';
import {
  BracketAnalysis,
  BracketBenchmark,
  DEFAULT_BRACKET_BENCHMARK,
  PREIS_SCHWELLE_EUR,
  TUNING_BUMP_SCHWELLE,
  POWER_ANTEIL_KARTEN,
  POWER_ANTEIL_BESTAENDIGKEIT,
  AUTO_BRACKET_MAX,
  analyzeBracket,
  powerRange,
  spellbookLift,
} from './bracket';
import { I18nService } from './i18n.service';
import { averageCmc } from './deck-analyse';
import type { BracketMathTopic } from './deck-viewer.service';
import { DeckViewerState } from './deck-viewer-state.service';
import { DeckAnalysisService } from './deck-analysis.service';
import { DeckCheckService } from './deck-check.service';

/**
 * Commander-Bracket der Detailansicht: Einstufung (bracket.ts), manuelle Wahl, Rückschreiben der Automatik und der Rechenweg im Popup.
 */
@Injectable({ providedIn: 'root' })
export class DeckBracketService {
  private readonly deckService = inject(DeckService);
  readonly i18n = inject(I18nService);
  private readonly state = inject(DeckViewerState);
  private readonly analysis = inject(DeckAnalysisService);
  /** Beständigkeit aus dem Deck-Check - Teil des Power-Werts. */
  readonly deckCheck = inject(DeckCheckService);

  /** Brackets gibt es nur im Commander - für Brawl, PDH und den Rest bleibt die Anzeige aus. */
  readonly showsBracket = computed(() => this.state.viewingDeck()?.format === 'Commander');

  /** Gemessene Schwellen aus bracket_benchmark; bis zum Laden und ohne Tabelle die Startwerte. */
  readonly bracketBenchmark = signal<BracketBenchmark>(DEFAULT_BRACKET_BENCHMARK);

  /**
   * Automatische Einstufung. null solange Kartendetails laden - sonst käme verlässlich "Bracket 2"
   * heraus und würde zurückgeschrieben.
   */
  readonly bracketAnalysis = computed<BracketAnalysis | null>(() => {
    if (!this.showsBracket() || this.analysis.analysisBusy()) return null;
    // Die Beständigkeit braucht Wirkungs-Kategorien und Spielweise; ohne sie spränge der Wert
    // (und das gespeicherte Bracket) beim Nachladen.
    if (!this.deckCheck.consistencyReady()) return null;

    const deck = this.state.viewingDeck();
    if (!deck) return null;

    const cards = this.analysis.bracketCards();
    if (cards.length === 0) return null;

    return analyzeBracket({
      cards,
      flags: this.analysis.spellbookCardFlags(),
      combos: this.analysis.spellbookCombos(),
      spellbookTag: this.analysis.bracketEstimate()?.bracketTag ?? null,
      isPrecon: deck.isPrecon,
      averageCmc: this.analysis.averageCmc(),
      untappedLandPercent: this.analysis.untappedLandPercent(),
      tutorCount: this.analysis.tutorCards().reduce((sum, c) => sum + c.quantity, 0),
      winningCombos: this.analysis.winningCombos(),
      totalCards: this.state.viewingTotalCards(),
      totalPrice: this.analysis.totalDeckPrice(),
      benchmark: this.bracketBenchmark(),
      consistency: this.deckCheck.consistency(),
    });
  });

  /**
   * Angezeigte Stufe: manuell schlägt automatisch; während die Rechnung läuft, der zuletzt
   * gespeicherte Wert.
   */
  readonly effectiveBracket = computed<{ level: number; source: 'manual' | 'auto' } | null>(() => {
    const deck = this.state.viewingDeck();
    if (!deck || !this.showsBracket()) return null;
    if (deck.bracket != null) return { level: deck.bracket, source: 'manual' };

    const level = this.bracketAnalysis()?.bracket ?? deck.bracketAuto;
    return level != null ? { level, source: 'auto' } : null;
  });

  readonly bracketSaving = signal(false);

  /** Stufe von Hand setzen (null = automatisch). Speichert sofort, wie setArchetype(). */
  async setBracket(bracket: number | null): Promise<void> {
    const deck = this.state.viewingDeck();
    if (!deck || !this.state.canEditViewingDeck()) return;

    this.bracketSaving.set(true);
    const ok = await this.deckService.setDeckBracket(deck.id, bracket);
    this.bracketSaving.set(false);
    if (ok) this.state.viewingDeck.set({ ...deck, bracket });
  }

  /**
   * Schreibt das Automatik-Ergebnis zurück, damit Listen ein Abzeichen ohne Kartenliste zeigen
   * können. Als effect(), weil die Einstufung an mehreren unabhängig eintreffenden Quellen hängt;
   * der Vergleich mit dem gespeicherten Wert hält es bei einem Schreibvorgang je Öffnung.
   */
  private readonly autoBracketPersist = effect(() => {
    const deck = this.state.viewingDeck();
    const analysis = this.bracketAnalysis();
    if (!deck || !analysis || analysis.bracket === deck.bracketAuto) return;
    if (!this.state.canEditViewingDeck()) return;

    const level = analysis.bracket;
    void this.deckService.saveDeckAutoBracket(deck.id, level).then((ok) => {
      // Lokal nachziehen, sonst liefe der effect() bei der nächsten Änderung erneut an.
      if (ok)
        this.state.viewingDeck.update((d) =>
          d && d.id === deck.id ? { ...d, bracketAuto: level } : d,
        );
    });
  });

  /** Die fünf Stufen für das Auswahlfeld, in Anzeigereihenfolge. */
  readonly bracketOptions: readonly number[] = [1, 2, 3, 4, 5];

  /** Begründung der Einstufung ein-/ausklappen. */
  readonly showBracketWhy = signal(false);

  toggleBracketWhy(): void {
    this.showBracketWhy.update((v) => !v);
  }

  /**
   * Welches Urteil als Rechenweg-Popup offen ist (null = keins). Die Zahlen erklären sich nicht
   * selbst (Skalen, Mittelung, umgekehrte Manawert-Skala), deshalb je Urteil ein ⓘ.
   */
  readonly bracketMathTopic = signal<BracketMathTopic | null>(null);

  openBracketMath(topic: BracketMathTopic): void {
    this.bracketMathTopic.set(topic);
  }

  closeBracketMath(): void {
    this.bracketMathTopic.set(null);
  }

  /** Schwelle, ab der die Feinbewertung anhebt - in Prozent, für die Erklärtexte. */
  readonly tuningBumpPercent = Math.round(TUNING_BUMP_SCHWELLE * 100);
  /** Anteile am gemeinsamen Wert, für die Erklärtexte ("0,6 × … + 0,4 × …"). */
  private readonly anteilText = (wert: number) =>
    wert.toLocaleString(this.i18n.lang() === 'de' ? 'de-DE' : 'en-US');
  readonly cardShare = computed(() => this.anteilText(POWER_ANTEIL_KARTEN));
  readonly consistencyShare = computed(() => this.anteilText(POWER_ANTEIL_BESTAENDIGKEIT));

  /** Kartenwert, ab dem mindestens Bracket 3 gilt - für die Erklärtexte. */
  readonly priceThresholdEur = PREIS_SCHWELLE_EUR;

  /** Fertige Zahlen fürs Rechenweg-Popup: Punktsumme, Teiler, Power-Spanne. */
  readonly bracketMath = computed(() => {
    const analysis = this.bracketAnalysis();
    if (!analysis) return null;
    const teile = analysis.verdicts.tuningParts;
    const [powerVon, powerBis] = powerRange(analysis.bracket);
    return {
      /** z.B. "0.27 × 0.31 + 0.40 × 0.17" - Gewicht × Punkte je Messgröße, in der Reihenfolge der Liste. */
      summands: teile.map((t) => `${t.weight.toFixed(2)} × ${t.score.toFixed(2)}`).join(' + '),
      divisor: teile.reduce((summe, t) => summe + t.weight, 0).toFixed(2),
      powerVon,
      powerBis,
      powerSpanne: Math.round((powerBis - powerVon) * 10) / 10,
      /** true, wenn die Feinbewertung das Bracket tatsächlich um eine Stufe angehoben hat. */
      bumped: analysis.reasons.some((r) => r.key === 'tuning'),
      /** true, wenn eine Anhebung überhaupt möglich war (unter B4, kein Precon). */
      canBump: analysis.bracket < AUTO_BRACKET_MAX && !this.state.viewingDeck()?.isPrecon,
      bumpThreshold: TUNING_BUMP_SCHWELLE,
      /** true, wenn der Kartenwert die Schwelle erreicht und damit mindestens Bracket 3 erzwingt. */
      pricePushed: analysis.reasons.some((r) => r.key === 'price'),
      /**
       * Befunde aus Schritt 1 ohne Tuning-Anhebung und ohne Kartenwert (keine offizielle Regel).
       */
      rulesReasons: analysis.reasons.filter((r) => r.key !== 'tuning' && r.key !== 'price'),
      /** Stufe nach den beiden Urteilen, aber VOR einer möglichen Anhebung durch die Feinbewertung. */
      baseBracket: Math.max(
        analysis.verdicts.rules,
        spellbookLift(analysis.verdicts.spellbook) ?? 0,
      ),
    };
  });

  /** Beschriftung "Automatisch" samt berechneter Stufe. */
  readonly bracketAutoOptionLabel = computed(() => {
    const level = this.bracketAnalysis()?.bracket ?? this.state.viewingDeck()?.bracketAuto;
    return level == null
      ? this.i18n.t('deckView.bracketAutoOptionPending')
      : this.i18n.t('deckView.bracketAutoOption', { level: String(level) });
  });

  /** Info-Klappen zu: beim nächsten Deck stünde sonst sofort eine lange Erklärung über der Liste. */
  reset(): void {
    this.showBracketWhy.set(false);
    this.bracketMathTopic.set(null);
  }
}
