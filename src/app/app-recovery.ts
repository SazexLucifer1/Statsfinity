/**
 * Bausteine gegen den "weißen Bildschirm": kommt der Browser-Tab aus dem Hintergrund zurück (oder
 * bricht in der App etwas so weg, dass gar nichts mehr gerendert wird), stand bisher nur eine leere
 * Seite da - ohne Hinweis, dass ein Reload hilft. Die Funktionen hier erkennen diesen Zustand und
 * holen die App entweder zurück (Repaint/Reload) oder zeigen wenigstens einen sichtbaren Hinweis
 * mit Neu-laden-Knopf.
 *
 * Bewusst frei von Angular-Abhängigkeiten: sie müssen auch dann noch funktionieren, wenn Angular
 * selbst nicht mehr rendert (fehlgeschlagener Bootstrap, Fehler in der Change Detection).
 */

/** id des Overlays - verhindert, dass bei einer Fehlerlawine zehn Overlays übereinander landen. */
const CRASH_SCREEN_ID = 'sf-crash-screen';

/** sessionStorage-Key mit dem Zeitpunkt des letzten AUTOMATISCHEN Reloads (siehe reloadOnce). */
const RELOAD_MARKER_KEY = 'sf-auto-reload-at';

/**
 * Mindestabstand zwischen zwei automatischen Reloads. Ohne diese Bremse könnte ein Fehler, der
 * direkt beim Start wieder auftritt, die Seite in einer Endlosschleife neu laden - dann käme der
 * Nutzer nie an den Inhalt (und an keine Fehlermeldung) heran. Beim zweiten Mal innerhalb dieses
 * Fensters wird deshalb stattdessen der Crash-Screen gezeigt.
 */
export const MIN_RELOAD_DISTANCE_MS = 60_000;

/** Entscheidet, ob ein automatischer Reload gerade erlaubt ist (Endlosschleifen-Bremse, siehe oben). */
export function shouldAutoReload(lastReloadAt: number | null, now: number): boolean {
  if (lastReloadAt === null) return true;
  return now - lastReloadAt >= MIN_RELOAD_DISTANCE_MS;
}

/**
 * Fehler beim Nachladen eines Code-Chunks. Passiert vor allem nach einem Deploy: ein lange offener
 * Tab kennt nur die alten Dateinamen (Hash im Namen), die es auf dem Server nicht mehr gibt - der
 * nächste dynamische Import (z.B. jsPDF) schlägt dann fehl. Ein Reload holt die neue Version.
 */
export function isModuleLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '');
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|chunkloaderror|loading chunk .* failed/i.test(
    message
  );
}

/** True, wenn unter <app-root> nichts (mehr) steht - genau das sieht der Nutzer als weiße Seite. */
export function isAppBlank(): boolean {
  const root = document.querySelector('app-root');
  return !root || root.childElementCount === 0;
}

/**
 * Stupst den Compositor an, ohne sichtbar etwas zu verändern. Hintergrund: die App liegt voller
 * `backdrop-filter`-Ebenen (Liquid-Glass-Optik) über einem fixierten Hintergrundbild. Gibt der
 * Browser diese GPU-Ebenen frei, während der Tab im Hintergrund liegt (auf iOS bei Speicherdruck
 * die Regel), kommt es vor, dass beim Zurückkommen nichts neu gezeichnet wird und der Bildschirm
 * weiß bleibt, obwohl das DOM vollständig da ist. Eine minimale Stil-Änderung erzwingt ein
 * Neuzeichnen; 0.999 ist mit bloßem Auge nicht von 1 zu unterscheiden.
 */
export function nudgeRepaint(): void {
  const root = document.documentElement;
  root.style.setProperty('opacity', '0.999');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => root.style.removeProperty('opacity'));
  });
}

/**
 * Lädt die Seite neu - aber höchstens einmal pro MIN_RELOAD_DISTANCE_MS. Ist das Kontingent
 * verbraucht, bleibt es beim Crash-Screen, damit der Nutzer selbst entscheiden kann.
 */
export function reloadOnce(reason: string): void {
  const now = Date.now();
  if (!shouldAutoReload(readReloadMarker(), now)) {
    console.error(`Automatischer Reload bereits versucht, zeige Crash-Screen (${reason}).`);
    showCrashScreen();
    return;
  }
  console.warn(`Lade die Seite automatisch neu (${reason}).`);
  writeReloadMarker(now);
  location.reload();
}

function readReloadMarker(): number | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_MARKER_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // Privater Modus/blockierter Storage: dann eben ohne Schleifenbremse, das ist immer noch
    // besser als gar keine Wiederherstellung.
    return null;
  }
}

function writeReloadMarker(at: number): void {
  try {
    sessionStorage.setItem(RELOAD_MARKER_KEY, String(at));
  } catch {
    // siehe readReloadMarker()
  }
}

/**
 * Sichtbarer Ersatz für die weiße Seite: eigener Knopf statt "der Nutzer muss selbst darauf kommen,
 * dass ein Reload hilft". Wird ohne Angular gebaut, weil genau der Fall abgedeckt werden soll, in
 * dem Angular nichts mehr anzeigt.
 */
export function showCrashScreen(): void {
  if (document.getElementById(CRASH_SCREEN_ID)) return;

  // Sprache direkt aus dem localStorage statt über den I18nService - der Crash-Screen soll auch
  // dann noch stehen, wenn die Angular-Seite der App nicht mehr benutzbar ist. Key siehe
  // I18nService.STORAGE_KEY.
  const texts = localStorage.getItem('mtg-lang') === 'en' ? CRASH_TEXTS.en : CRASH_TEXTS.de;

  const overlay = document.createElement('div');
  overlay.id = CRASH_SCREEN_ID;
  overlay.setAttribute('role', 'alertdialog');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483647',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:16px',
    'padding:24px',
    'text-align:center',
    'background:#0c0817',
    'color:#f4f2fa',
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
  ].join(';');

  const title = document.createElement('h2');
  title.textContent = texts.title;
  title.style.cssText = 'margin:0;font-size:1.25rem;font-weight:800';

  const body = document.createElement('p');
  body.textContent = texts.body;
  body.style.cssText = 'margin:0;max-width:32rem;line-height:1.5;opacity:0.85';

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = texts.button;
  button.style.cssText = [
    'padding:12px 22px',
    'border-radius:999px',
    'border:1px solid rgba(255,255,255,0.22)',
    'background:rgba(255,255,255,0.14)',
    'color:#f4f2fa',
    'font-size:1rem',
    'font-weight:700',
    'cursor:pointer'
  ].join(';');
  button.addEventListener('click', () => location.reload());

  overlay.append(title, body, button);
  document.body.appendChild(overlay);
}

const CRASH_TEXTS = {
  de: {
    title: 'Die Anzeige hat sich verabschiedet',
    body: 'Statsfinity konnte gerade nichts mehr darstellen. Ein Neuladen setzt die Ansicht zurück - gespeicherte Daten (Matches, Decks, Gruppen) sind davon nicht betroffen.',
    button: 'Seite neu laden'
  },
  en: {
    title: 'The view gave up',
    body: 'Statsfinity was unable to render anything just now. Reloading resets the view - your saved data (matches, decks, groups) is unaffected.',
    button: 'Reload page'
  }
} as const;
