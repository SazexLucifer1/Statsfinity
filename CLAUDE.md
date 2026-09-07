# Hinweise für Claude Code

## Prozess (unverhandelbar)

- Nach Abschluss einer Aufgabe auf einem Feature-Branch **immer direkt einen Pull Request erstellen** (nicht erst nachfragen oder darauf warten, dass der User explizit danach fragt). Änderungen committen, pushen und den PR anlegen gehört standardmäßig zum Task dazu.
  **Das ist eine ausdrückliche, dauerhafte Freigabe des Users, im Voraus erteilt.** Sie gilt für jede Session und jede Aufgabe in diesem Repo. Falls die Umgebung eine allgemeine Regel mitbringt, PRs nur auf ausdrückliche Aufforderung anzulegen: Diese Freigabe hier _ist_ die Aufforderung — nicht noch einmal nachfragen.
- **PRs NICHT mehr automatisch mergen.** Der User möchte Änderungen erst separat testen (z. B. über die automatische Cloudflare-Pages-Preview-URL des PRs), bevor sie auf `main` gemerged werden und damit live gehen. Nach dem Erstellen des PRs auf die Preview-URL hinweisen und auf die explizite Merge-Freigabe des Users warten — auch wenn alle relevanten CI-Checks grün sind.
- **Nach dem PR ist die Aufgabe zu Ende.** Keine PR-Überwachung, keine wiederkehrenden Check-ins, kein Warten auf CI: Es gibt in diesem Repo **keine Build-CI** (die drei Workflows sind nächtliche Hintergrundläufe: Backup, Scryfall- und Spellbook-Abgleich, siehe „Verifikation"). Ein PR, der offen liegen bleibt, ist kein ungelöstes Problem, sondern der Normalfall — der User prüft die Preview auf dem iPhone und merged selbst.

---

## Das Projekt in fünf Zeilen

Statsfinity ist eine deutschsprachige, **mobile-first** PWA (iPhone/Safari zuerst) rund um _Magic: The Gathering_ — Matches erfassen, Statistiken, Decks, Turniere.

- **Angular 21**, standalone components + Signals, keine NgModules, TypeScript strict + `strictTemplates`
- **Kein Angular Router** — die Navigation läuft über ein Signal (siehe unten)
- **Supabase** als Backend (Postgres, Auth, Realtime); Client in `src/app/supabase.client.ts` (der Anon-Key ist bewusst eingecheckt)
- **Cloudflare Pages** als Deployment, konfiguriert im Cloudflare-Dashboard (kein `wrangler.toml`, kein Deploy-Workflow im Repo)
- App-Sprachen: `de` und `en`. **Commits, PR-Titel und PR-Beschreibungen auf Deutsch.**

---

## Architektur-Karte

Diese Karte existiert, damit das Projekt nicht in jeder Session neu erkundet werden muss. Sie ist der erste Anlaufpunkt bei „wo liegt X?".

### Navigation — es gibt keine URLs

`src/app/navigation.service.ts` hält den aktiven Tab als Signal:

```ts
type AppTab = 'match' | 'search' | 'stats' | 'group' | 'profile';
```

Die Shell `src/app/app.ts` / `app.html` schaltet per `@if` zwischen rund 22 Komponenten um. **Es gibt keine Routen, keine URL-Parameter, keinen `RouterOutlet`.** Wer nach Routing sucht, sucht vergeblich.

### Komponenten

| Bereich            | Ort                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs               | `src/app/{match,search,stats,group,profile}-tab/`                                                                                                                                                                                                                                     |
| Vollbild-Overlays  | `ingame-tracker/`, `goldfish-tracker/`, `deck-detail-view/`, `tournament-panel/`, `login/`, `legal-page-view/`, `reset-password/`                                                                                                                                                     |
| Dialoge            | `dialog/`, `card-preview-dialog/`, `deck-import-dialogs/`, `deck-pdf-dialog/`, `feedback-dialog/`, `placement-dialog/`, `manual-deck-link-dialog/`, `tutorial-overlay/`                                                                                                               |
| Sonstige Bausteine | `card-image/`, `partner-card-image/`, `deck-list/`, `commander-stat-list/`, `commander-recommendations/`, `favorite-commander-editor/`, `player-avatar/`, `precon-browser/`, `public-card-search/`, `public-deck-browser/`, `tournament-history/`, `legal-footer/`, `login-required/`, `global-stats/` |

Jede Komponente ist ein Trio `name/name.ts` + `name.html` + `name.scss`. Einzige Ausnahme:
`deck-detail-view` hat ein zweites Stylesheet `deck-detail-view.bracket.scss` (alles zum Bracket),
weil die Hauptdatei sonst über das harte Style-Budget von 12 kB liefe.

### Wiederverwendbare UI-Bausteine — hier zuerst nachsehen

`src/app/ui/` enthält: `bar-chart`, `radar-chart`, `meter`, `split-bar`, `pager`, `podium`, `overflow-menu`, `multi-select`, `color-filter`, `cmc-filter`, `mana-symbol`, `bracket-badge` sowie `chart-scale.ts`.

**Regel: bevor ein Diagramm, ein Filter, ein Menü oder eine Blätterfunktion neu gebaut wird, prüfen, ob es das hier schon gibt.**

### Services (alle flach in `src/app/`)

| Domäne                | Dateien                                                                                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decks                 | `deck.service.ts`, `deck-viewer.service.ts`, `deck-import.service.ts`, `deck-pdf.service.ts`, `public-deck.service.ts`, `manual-deck-link.service.ts`, `excel-import.service.ts`                                                                    |
| Karten & externe APIs | `scryfall.service.ts`, `card-data.service.ts`, `edhrec.service.ts`, `commander-spellbook.service.ts`, `mtg.service.ts`, `precon.service.ts`, `card-preview.service.ts`                                                                             |
| Spiel & Turnier       | `game-session.service.ts`, `goldfish.service.ts`, `tournament.service.ts`                                                                                                                                                                           |
| Konto & Gruppe        | `auth.service.ts`, `profile.service.ts`, `group.service.ts`, `group-permissions.ts`, `login-overlay.service.ts`                                                                                                                                     |
| Infrastruktur         | `navigation.service.ts`, `dialog.service.ts`, `i18n.service.ts`, `app-recovery.service.ts`, `global-error-handler.ts`, `page-visibility.service.ts`, `background.service.ts`, `feedback.service.ts`, `legal-page.service.ts`, `tutorial.service.ts` |
| Hilfsfunktionen       | `array-utils.ts`, `match-utils.ts`, `color-filter-match.ts`, `color-combo-names.ts`, `card-effect-filters.ts`, `commander-archetype-filters.ts`, `rank-sort.ts`, `bracket.ts`                                                                       |

### Weitere Orte

- **Typen:** `src/app/models.ts`, `src/app/tournament.models.ts`
- **Übersetzungen:** `src/app/i18n/` — 13 Module (`auth`, `common`, `deck`, `deck-view`, `feedback`, `group`, `ingame`, `match`, `profile`, `search`, `stats`, `tournament`, `tutorial`), je Datei beide Sprachen. Siehe die Arbeitsregel weiter unten.
- **Styles:** Design-Tokens (`--sp-*` Abstände, `--r-*` Rundungen, Flächen, Diagrammfarben) global in `src/styles.scss`; Partials in `src/styles/` (`_breakpoints.scss`, `_mana.scss`). Style-Budget: **6 kB Warnung / 12 kB Fehler pro Komponenten-Style** — große `.scss`-Dateien nicht unbegrenzt wachsen lassen.
- **Cloudflare Functions:** `functions/api/proxy-image.ts` (CORS-Proxy für Scryfall-Bilder im PDF-Export), `functions/api/estimate-bracket.ts`
- **CSP und Cache-Header:** `public/_headers` — wer eine neue externe API anbindet, muss sie hier freischalten, sonst blockt der Browser sie stillschweigend.
- **Supabase-Migrationen:** `sql/` (datierte Skripte). **Diese Dateien laufen nicht automatisch** — sie müssen von Hand im Supabase-SQL-Editor ausgeführt werden, ein Merge allein ändert an der Datenbank nichts. Wer einem Fehler nachgeht, der nach „die App speichert nicht“ aussieht, prüft deshalb zuerst die Browser-Konsole: Rechte-Fehler kommen als HTTP 500 mit Postgres-Codes wie `42P17` an, nicht als Code-Fehler (siehe `sql/fix-tournament-rls-recursion-2026-09-03.sql`).
- **Nächtliche Abgleiche (GitHub Actions):** `scripts/sync-scryfall-bulk.js` (Workflow `scryfall-sync.yml`, füllt `scryfall_cards`/`scryfall_card_effects`, Tabellen in `sql/scryfall-cache-2026-09-06.sql`) und `scripts/sync-spellbook-bracket.js` (Workflow `spellbook-sync.yml`, füllt `spellbook_card_flags`/`spellbook_two_card_combos`, Tabellen in `sql/spellbook-cache-2026-09-06.sql`). Beide brauchen das Repo-Secret `SUPABASE_SERVICE_ROLE_KEY` und sind über „Actions“ von Hand auslösbar. Sie holen öffentliche Kartendaten einmal pro Nacht von einem Server, statt sie bei jedem Deck-Öffnen aus jedem Browser nachzufragen.
- **Generiert, niemals von Hand anfassen:** `src/app/version.ts` (erzeugt von `scripts/generate-version.js` bei jedem `start`/`build`, gitignored)

---

## Arbeitsregeln

Diese Regeln sparen Kontext und damit Zeit und Kosten. Sie sind nicht optional.

### UI-Texte: erst die richtige Datei bestimmen, dann greppen

Alle sichtbaren Texte liegen in `src/app/i18n/` — **je Bereich eine Datei, beide Sprachen darin nebeneinander.** `i18n.service.ts` selbst ist nur noch die Klasse plus das Zusammensetzen der Module (~110 Zeilen) und enthält **keine** Texte mehr.

```ts
// src/app/i18n/match.ts
export const match = {
  de: { 'match.newMatch': 'Neues Match', … },
  en: { 'match.newMatch': 'New match', … },
};
```

Das **Key-Präfix sagt, in welcher Datei der Key steht** (Schema `bereich.beschreibung`):

| Präfix                                                                                                                                                     | Datei           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `match`, `game`, `placement`                                                                                                                               | `match.ts`      |
| `stats`                                                                                                                                                    | `stats.ts`      |
| `group`, `permission`                                                                                                                                      | `group.ts`      |
| `profile`                                                                                                                                                  | `profile.ts`    |
| `deck`, `deckViewer`, `importDialog`, `pdfDialog`                                                                                                          | `deck.ts`       |
| `deckView`                                                                                                                                                 | `deck-view.ts`  |
| `tournament`, `tournamentHistory`                                                                                                                          | `tournament.ts` |
| `ingame`, `goldfish`                                                                                                                                       | `ingame.ts`     |
| `archetypeFilter`, `effectFilter`, `keywordFilter`, `commanderRec`, `precons`, `publicDecks`, `publicSearch`, `search`, `colorFilter`, `colorCombo`, `pip` | `search.ts`     |
| `login`, `loginRequired`, `resetPassword`                                                                                                                  | `auth.ts`       |
| `feedback`                                                                                                                                                 | `feedback.ts`   |
| `tutorial`                                                                                                                                                 | `tutorial.ts`   |
| `dialog`, `common`, `nav`, `header`, `sort`, `legal`, `cardImage`, `partnerCardImage`                                                                      | `common.ts`     |

Vorgehen bei einer Textänderung:

1. Ist der Bereich schon klar, direkt in der passenden Datei greppen. Sonst über den sichtbaren Text suchen: `grep -rn "Neues Match" src/app/i18n/`
2. Nur die gefundenen Zeilen editieren — die Module sind klein (größte: `tutorial.ts` 409, `deck-view.ts` 404 Zeilen), ein ganzes Modul zu lesen ist vertretbar.
3. **Immer beide Sprachen anpassen** — `de` _und_ `en` stehen in derselben Datei direkt untereinander. Ein Key, den es nur in einer Sprache gibt, ist ein Bug; `src/app/i18n/i18n-keys.spec.ts` prüft das.
4. Ein **neuer** Key gehört in das Modul seines Präfixes. Ein neues Präfix muss zusätzlich in die Tabelle in `i18n-keys.spec.ts` **und** in die Präfix-Tabelle oben eingetragen werden, sonst schlägt der Test fehl.

### Die Karte mitpflegen

Die Architektur-Karte oben ist nur so lange etwas wert, wie sie stimmt. **Eine falsche Karte ist schlimmer als gar keine** — sie schickt die nächste Session gezielt an den falschen Ort. Das ist schon passiert: Die Karte entstand in PR #164 und war vier Commits später falsch, weil die i18n-Aufteilung sie nicht mitzog; die Korrektur brauchte einen eigenen PR (#167).

**Wer eine Datei anlegt, löscht oder umbenennt, die in die Karte gehört, aktualisiert die Karte im selben PR.** Das betrifft:

| Was du änderst                        | Was in der Karte nachgezogen wird                    |
| ------------------------------------- | ---------------------------------------------------- |
| Komponente unter `src/app/`           | Komponenten-Tabelle                                  |
| Service/Helper flach in `src/app/`    | Services-Tabelle                                     |
| Baustein in `src/app/ui/`             | Abschnitt „Wiederverwendbare UI-Bausteine"           |
| Modul in `src/app/i18n/`              | i18n-Abschnitt inkl. Modulanzahl und Präfix-Tabelle  |
| Eine Datei wächst über 1000 Zeilen    | Tabelle „Große Dateien"                              |

Ein PR, der die Struktur ändert und die Karte stehen lässt, ist unvollständig — genauso wie ein i18n-Key, den es nur auf Deutsch gibt.

`npm run check:map` sagt dir, was fehlt. Der Check läuft in einer Sekunde und prüft in **beide** Richtungen: ob alles Vorhandene in der Karte steht, und ob alles in der Karte Genannte noch existiert (fängt Umbenennungen ab, die sonst still ins Leere zeigen). Er ist bewusst **nicht** an `npm run build` gekoppelt — Cloudflare Pages baut mit genau diesem Kommando, eine veraltete Karte darf das Deployment nicht blockieren.

### Große Dateien: erst suchen, dann gezielt lesen

Bei diesen Dateien grundsätzlich `grep`/`Glob` vor `Read`; wenn doch gelesen werden muss, mit `offset`/`limit` nur den relevanten Abschnitt:

| Zeilen | Datei                                            |
| ------ | ------------------------------------------------ |
| 3104   | `src/app/deck-viewer.service.ts`                 |
| 1770   | `src/app/tournament.service.ts`                  |
| 2016   | `src/app/deck.service.ts`                        |
| 1492   | `src/app/mtg.service.ts`                         |
| 1386   | `src/app/stats-tab/stats-tab.ts`                 |
| 1111   | `src/app/game-session.service.ts`                |
| 1021   | `src/app/profile-tab/profile-tab.ts`             |
| 1538   | `src/app/deck-detail-view/deck-detail-view.html` |

`src/app/excel-import.service.ts` wird von grep als binär erkannt (eingebettete Daten) — nicht am Stück lesen.

### Reihenfolge beim Suchen

1. Diese Karte und die Vokabular-Tabelle in `PROMPTING.md`
2. `grep` mit einem konkreten Begriff aus der Aufgabe
3. Erst dann breite Erkundung

**Keine Sub-Agenten für Aufgaben, deren Bereich schon feststeht.** Ein Sub-Agent, der eine bekannte Datei nachschlägt, kostet ein Vielfaches eines gezielten `grep`.

### Umfang

Nur das ändern, wonach gefragt wurde. Keine ungefragten Refactorings, keine „Verbesserungen" nebenbei — der User testet jeden PR einzeln über die Preview-URL, und ein PR mit drei unabhängigen Änderungen ist nicht prüfbar.

---

## Verifikation

| Befehl                         | Was es prüft                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `npm run typecheck`            | Dev-Build inkl. `strictTemplates` — die schnellste echte Prüfung, erste Wahl |
| `npm run build`                | Prod-Build inkl. Budgets — vor jedem PR                                      |
| `npm run check:map`            | Ob die Architektur-Karte oben noch zum Repo passt — nach Strukturänderungen |
| `npx prettier --check <datei>` | Prettier auf den **selbst geänderten** Dateien                               |
| `npm run format:check`         | Prettier projektweit — schlägt derzeit an ~104 Altdateien an, siehe unten    |
| `npm test`                     | Vitest                                                                       |

Wichtig zur Einordnung:

- `npm run format:check` meldet aktuell **~104 vorbestehende** Dateien: Prettier ist konfiguriert, wurde aber nie projektweit ausgeführt. Ein roter `format:check` ist deshalb **kein** Hinweis darauf, dass die eigene Änderung falsch formatiert ist. Prüfe gezielt die eigenen Dateien (`npx prettier --check <datei>`) und formatiere auch nur diese. **Nicht** `npm run format` über das ganze Projekt laufen lassen — das erzeugt einen themenfremden Riesen-Diff, den der User nicht prüfen kann.
- Es gibt **kein Lint** und **keine Build-CI auf GitHub**. Die drei Workflows sind alle nächtliche Hintergrundläufe und sagen über einen PR nichts aus: das Supabase-Backup sowie der Scryfall- und der Commander-Spellbook-Abgleich (siehe „Weitere Orte“). Ein grüner PR bedeutet also nicht, dass gebaut wurde — deshalb lokal bauen, bevor gepusht wird.
- Es gibt nur **8 Spec-Dateien** (`scryfall.service`, `public-deck.service`, `color-filter-match`, `color-combo-names`, `app-recovery`, `bracket`, `ui/radar-chart/radar-geometry`, `i18n/i18n-keys`). Die Tests sind **kein Sicherheitsnetz** — grüne Tests sagen fast nichts.
- Der echte Test ist die **Cloudflare-Pages-Preview des PRs** auf dem iPhone.

---

## Konventionen

- **Commit-Messages auf Deutsch**, knapp und beschreibend, im Stil der bestehenden History — keine Conventional-Commits-Präfixe. Beispiele: `Farbfilter mit Mehrfachauswahl, Farbnamen aus den Suchfiltern raus`, `Profil-Tab: Umschalter kompakt, keine leeren Riesenkaesten mehr`, `Footer ans Seitenende statt direkt unter den Inhalt`.
- Neue Komponenten bekommen **keine** Spec-Datei (`skipTests: true` in `angular.json`).
- Mobile-first: Layouts zuerst für iPhone/Safari denken, Desktop danach.
- Neue externe Domains gehören in die CSP in `public/_headers`.

---

## Test-Accounts: die App selbst anschauen und Änderungen validieren

Es gibt vier Testkonten auf der **Produktiv**-Supabase, die zusammen in der Gruppe
„Claude Testgruppe" spielen. Damit kann jede Session die laufende App selbst bedienen —
einloggen, durchklicken, Screenshots machen — statt Änderungen nur im Code zu prüfen.

> ⚠️ **Die Passwörter stehen bewusst nicht hier.** Dieses Repo ist öffentlich; eingecheckte
> Zugangsdaten wären für jeden lesbar. Der User gibt sie auf Nachfrage im Chat heraus.
> Notfalls kommt man auch ohne sie weiter: Die Registrierung ist offen und
> `mailer_autoconfirm` ist aktiv, ein frisches Konto ist also in Sekunden einsatzbereit —
> es sieht dann nur die Gruppendaten nicht, solange es nicht eingeladen wurde.

| Konto     | E-Mail                                | Rolle            |
| --------- | ------------------------------------- | ---------------- |
| Admin     | `claude.qa.1788426226171@example.com` | Admin der Gruppe |
| Spieler 2 | `claude.qa.1788420220051@example.com` | Mitglied         |
| Spieler 3 | `claude.qa.1788420433192@example.com` | Mitglied         |
| Spieler 4 | `claude.qa.1788420636039@example.com` | Mitglied         |

Bestand: 8 importierte Precon-Decks (2 pro Konto), 15 gespielte Matches, dadurch gefüllte
Spieler-, Deck- und Commander-Ranglisten. **Diese Daten nicht löschen** — ohne sie sind alle
Statistik-Ansichten leer und damit nicht prüfbar.

### Erwartung an neue Sessions

Wer die UI ändert, prüft die Änderung **in der laufenden App** und belegt sie mit einem
Screenshot — nicht nur mit `npm run typecheck`. Das Projekt hat kein Lint, keine Build-CI und
praktisch keine Tests; der Screenshot ist der einzige echte Nachweis.

### So geht es

`npm start` (Dev-Server auf `localhost:4200`, spricht mit der Produktiv-Supabase), dann
Playwright 1.56 und Chromium — beide sind in der Umgebung vorinstalliert, **kein**
`playwright install`:

```js
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: [
    '--no-sandbox',
    '--disable-quic',
    '--disable-features=PostQuantumKyber,TLS13KyberSupport,EncryptedClientHello,UseDnsHttpsSvcb',
    '--ssl-version-max=tls1.2',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, locale: 'de-DE' });
```

Vier Stolpersteine, die sonst jede Session neu sucht:

1. **Keine `proxy:`-Option setzen.** Chromium übernimmt den Proxy aus der Umgebung, und
   `no_proxy` nimmt `localhost` bereits aus. Eine explizite Proxy-Option schickt auch die
   Anfragen an `localhost:4200` in den Proxy — die App lädt dann gar nicht.
2. **Die TLS-Flags oben sind Pflicht.** Ohne sie bricht der Tunnel zu Supabase mit
   `ERR_CONNECTION_RESET` ab; der Post-Quantum-ClientHello ist dem Proxy zu groß.
3. **Das Tutorial-Overlay erscheint pro Tab neu** und fängt alle Klicks ab. Nach jedem
   Tabwechsel „Überspringen" klicken, sonst laufen alle folgenden Klicks in den Timeout.
4. **Stabile Selektoren:** Tabs tragen `data-tutorial="nav-match|search|stats|group|profile"`,
   Dialoge liegen in `.options-menu-sheet`, Bestätigungen in `app-dialog` (Button `.primary`).

Ablauf für Matches (erzeugt Statistiken): Match-Tab → Spieler-Chips wählen → je Spieler
„📚 Deck wählen" → „▶ Spiel starten" → im Tracker ⋮ → „🏁 Spiel beenden" → Sieger 🏆 →
„Match speichern & beenden" → den `app-dialog` bestätigen.

---

## Weiterführend

`PROMPTING.md` im Projektwurzelverzeichnis erklärt dem User, wie er Aufgaben formuliert. Die dortige Vokabular-Tabelle („was der User sagt" → „welche Datei") ist auch für Claude nützlich.
