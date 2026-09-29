import { Component, computed, inject, input, output, signal } from '@angular/core';
import { DeckFormat, GameMode } from '../models';
import {
  DIVISION_LP,
  ELO_PROVISIONAL_GAMES,
  EloEntry,
  Rank,
  RANK_TIERS,
  divisionLabel,
  rankFromLp,
} from '../elo';
import { I18nService } from '../i18n.service';
import { RankBadge, rankStyle } from '../ui/rank-badge/rank-badge';
import { Meter } from '../ui/meter/meter';
import { Icon } from '../ui/icon/icon';

/**
 * Elo-Rang im Profil-Kopf: Abzeichen, Rang mit Division, LP und Balken bis zur nächsten Division.
 * Gerechnet wird im Profil-Tab (derselbe Wert färbt dort auch Rahmen und Profilbild), diese
 * Komponente zeigt nur an. Im eigenen Profil (`editable`) lässt sich der Modus umstellen.
 */
@Component({
  selector: 'app-profile-rank',
  imports: [RankBadge, Meter, Icon],
  templateUrl: './profile-rank.html',
  styleUrl: './profile-rank.scss',
  host: { '[style]': 'hostStyle()' },
})
export class ProfileRank {
  readonly i18n = inject(I18nService);

  /** null = in diesem Modus noch keine gewertete Partie. */
  readonly entry = input<EloEntry | null>(null);
  readonly mode = input.required<GameMode>();
  /** Format des Rangs; null = Modus ohne Format (Spezialevent). */
  readonly format = input<DeckFormat | null>(null);
  /** Zur Auswahl stehende Modi und Formate; nur im eigenen Profil angeboten. */
  readonly modes = input<GameMode[]>([]);
  readonly formats = input<DeckFormat[]>([]);
  readonly editable = input(false);
  readonly modeChange = output<GameMode>();
  readonly formatChange = output<DeckFormat>();

  /** "Normal · Commander" - welcher Rang gerade zu sehen ist. */
  readonly choiceLabel = computed(() => {
    const format = this.format();
    return format ? `${this.mode()} · ${format}` : this.mode();
  });

  readonly showInfo = signal(false);

  readonly rank = computed<Rank | null>(() => {
    const e = this.entry();
    return e ? rankFromLp(e.lp) : null;
  });
  readonly hostStyle = computed(() => rankStyle(this.rank()?.tier ?? null));

  readonly rankName = computed(() => this.nameOf(this.rank()));
  readonly peakName = computed(() => {
    const e = this.entry();
    return e ? this.nameOf(rankFromLp(e.peak)) : '';
  });

  /** Nächste Stufe (Division oder Rang) und wie viele LP fehlen; null bei Infinity. */
  readonly next = computed(() => {
    const r = this.rank();
    if (!r || r.division == null) return null;
    const lp = DIVISION_LP - r.lp;
    if (r.division > 1) return { lp, name: this.nameOf({ ...r, division: r.division - 1, lp: 0 }) };
    const tier = RANK_TIERS[RANK_TIERS.indexOf(r.tier) + 1];
    return { lp, name: this.nameOf({ tier, division: tier === 'infinity' ? null : 5, lp: 0 }) };
  });

  readonly placementTotal = ELO_PROVISIONAL_GAMES;

  private nameOf(r: Rank | null): string {
    if (!r) return this.i18n.t('profile.rank.unranked');
    const tier = this.i18n.t('profile.rank.tier.' + r.tier);
    return r.division == null ? tier : `${tier} ${divisionLabel(r.division)}`;
  }
}
