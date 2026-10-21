import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../i18n.service';
import { CubeService, CubeSummary } from '../cube.service';
import { Icon } from '../ui/icon/icon';

const PAGE = 30;

/**
 * Öffentliche Cubes zum Ansehen (Wunsch des Users, 21.10.2026): im Suche-Tab alle (mit
 * Namenssuche), im fremden Profil nur die des Besitzers (`userId`). Ein Tipp öffnet die
 * Cube-Seite - fremde Cubes nur lesend, eigene wie gewohnt. Daten: public_cubes() in
 * sql/cubes-oeffentlich-2026-10-21.sql; fehlt die Migration, steht hier ein Hinweis.
 */
@Component({
  selector: 'app-public-cube-browser',
  imports: [FormsModule, Icon],
  templateUrl: './public-cube-browser.html',
  styleUrl: './public-cube-browser.scss',
})
export class PublicCubeBrowser {
  readonly i18n = inject(I18nService);
  readonly cubes = inject(CubeService);

  /** Nur die Cubes dieser Person (fremdes Profil); ohne = alle öffentlichen. */
  readonly userId = input<string | null>(null);

  readonly query = signal('');
  readonly list = signal<CubeSummary[]>([]);
  readonly loading = signal(false);
  readonly hasMore = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private request = 0;

  constructor() {
    // Neu laden bei anderer Person oder Suche - die Suche erst nach einer kurzen Tipp-Pause.
    effect(() => {
      const userId = this.userId();
      const query = this.query();
      untracked(() => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.load(userId, query, false), query ? 300 : 0);
      });
    });
  }

  async load(userId: string | null, query: string, more: boolean): Promise<void> {
    const request = ++this.request;
    this.loading.set(true);
    const offset = more ? this.list().length : 0;
    const page = await this.cubes.publicCubes({
      userId: userId ?? undefined,
      query: query.trim() || undefined,
      offset,
      limit: PAGE,
    });
    if (request !== this.request) return;
    this.list.set(more ? [...this.list(), ...page] : page);
    this.hasMore.set(page.length === PAGE);
    this.loading.set(false);
  }

  loadMore(): void {
    void this.load(this.userId(), this.query(), true);
  }

  open(cube: CubeSummary): void {
    void this.cubes.openAny(cube.id, cube);
  }
}
