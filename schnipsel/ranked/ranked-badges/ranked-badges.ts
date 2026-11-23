import { Component, effect, inject, input, signal } from '@angular/core';
import { I18nService } from '../i18n.service';
import { RankedBadge, RankedBadgeService } from '../ranked-badge.service';
import { divisionLabel, rankFromLp } from '../elo';
import { RankBadge } from '../ui/rank-badge/rank-badge';
import { InfoToggle } from '../ui/info-toggle/info-toggle';

/**
 * Saison-Abzeichen im Profil (sql/ranked-saison-2026-10-06.sql): Endrang und LP je beendeter
 * Saison und Wertung. Für alle sichtbar, auch ohne Login (Entscheidung des Users, 06.10.2026).
 * Ohne Abzeichen erscheint der Abschnitt gar nicht.
 */
@Component({
  selector: 'app-ranked-badges',
  imports: [RankBadge, InfoToggle],
  templateUrl: './ranked-badges.html',
  styleUrl: './ranked-badges.scss',
})
export class RankedBadges {
  readonly i18n = inject(I18nService);
  private readonly service = inject(RankedBadgeService);

  readonly userId = input.required<string>();
  readonly badges = signal<RankedBadge[]>([]);

  constructor() {
    effect(() => {
      const id = this.userId();
      this.badges.set([]);
      this.service.badgesFor(id).then((list) => {
        if (this.userId() === id) this.badges.set(list);
      });
    });
  }

  rank(b: RankedBadge) {
    return rankFromLp(b.lp);
  }

  rankName(b: RankedBadge): string {
    const r = rankFromLp(b.lp);
    const tier = this.i18n.t('profile.rank.tier.' + r.tier);
    return r.division ? `${tier} ${divisionLabel(r.division)}` : tier;
  }

  /** "Normal · Commander · 2026" - Modus nur, wenn er nicht Normal ist. */
  ranking(b: RankedBadge): string {
    const parts = [b.mode === 'Normal' ? null : b.mode, b.format, b.seasonEndedAt.slice(0, 4)];
    return parts.filter(Boolean).join(' · ');
  }
}
