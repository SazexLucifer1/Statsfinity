import {
  isAppBlank,
  isModuleLoadError,
  shouldAutoReload,
  MIN_RELOAD_DISTANCE_MS,
} from './app-recovery';

/**
 * Die Bausteine der Weißer-Bildschirm-Rettung sind bewusst frei von Angular-Abhängigkeiten, damit
 * sie auch dann noch greifen, wenn Angular nichts mehr rendert - und damit genau hier testbar sind.
 */
describe('app-recovery', () => {
  describe('shouldAutoReload', () => {
    it('lädt beim ersten Mal neu', () => {
      expect(shouldAutoReload(null, 1_000_000)).toBe(true);
    });

    it('bremst einen sofort folgenden zweiten Reload aus (sonst Endlosschleife)', () => {
      const now = 1_000_000;
      expect(shouldAutoReload(now - 1_000, now)).toBe(false);
    });

    it('erlaubt einen erneuten Reload nach Ablauf des Mindestabstands', () => {
      const now = 1_000_000;
      expect(shouldAutoReload(now - MIN_RELOAD_DISTANCE_MS, now)).toBe(true);
    });
  });

  describe('isModuleLoadError', () => {
    it('erkennt die Meldungen der Browser für einen fehlenden Code-Chunk', () => {
      expect(
        isModuleLoadError(
          new TypeError('Failed to fetch dynamically imported module: /chunk-A1B2.js'),
        ),
      ).toBe(true);
      expect(isModuleLoadError(new Error('error loading dynamically imported module'))).toBe(true);
      expect(isModuleLoadError(new Error('Importing a module script failed.'))).toBe(true);
    });

    it('hält gewöhnliche Fehler nicht dafür', () => {
      expect(isModuleLoadError(new Error('Konnte Gruppen nicht laden'))).toBe(false);
      expect(isModuleLoadError(null)).toBe(false);
    });
  });

  describe('isAppBlank', () => {
    afterEach(() => {
      document.querySelector('app-root')?.remove();
    });

    it('meldet eine leere Seite, wenn es gar kein app-root gibt', () => {
      expect(isAppBlank()).toBe(true);
    });

    it('meldet eine leere Seite, wenn unter app-root nichts steht', () => {
      document.body.appendChild(document.createElement('app-root'));
      expect(isAppBlank()).toBe(true);
    });

    it('meldet keine leere Seite, sobald etwas gerendert wurde', () => {
      const root = document.createElement('app-root');
      root.appendChild(document.createElement('header'));
      document.body.appendChild(root);
      expect(isAppBlank()).toBe(false);
    });
  });
});
