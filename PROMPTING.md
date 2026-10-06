# Aufträge an Claude formulieren

Eine Anleitung für die Arbeit an Statsfinity. Ziel: weniger Tokens, weniger Nachbesserungsrunden, schnellere Ergebnisse.

---

## Zuerst die Wahrheit: woran es meistens liegt

Der größte Kostentreiber ist **nicht** die Formulierung deiner Aufträge. Er ist, dass Claude in jeder neuen Session bei null anfängt und das Projekt neu erkunden muss.

Genau dagegen wirkt die `CLAUDE.md` in diesem Projekt: Sie enthält jetzt eine Karte der Architektur, damit Claude weiß, dass es keinen Router gibt, wo die Services liegen und dass Texte gegrept statt gelesen werden. Das spart pro Session ein Vielfaches dessen, was ein besserer Prompt bringt.

Was du selbst in der Hand hast, ist trotzdem spürbar — vor allem, weil es die teuerste Sorte Verschwendung verhindert: **etwas bauen, das du so nicht wolltest.**

Drei Dinge kosten wirklich:

| Ursache                             | Was dann passiert                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Unklarer **Ort**                    | Claude durchsucht das halbe Projekt, bevor es losgeht                            |
| Unklares **Ziel**                   | Claude baut etwas, du korrigierst, Claude baut um — die teuerste Runde von allen |
| **Mehrere Themen** in einem Auftrag | Claude lädt Kontext für alle gleichzeitig                                        |

---

## Die vier Bausteine

Ein guter Auftrag beantwortet vier Fragen. Nicht förmlich, nicht als Formular — einfach so, dass alle vier drinstehen.

**Ort** — Wo? · **Beobachtung** — Was ist jetzt? · **Ziel** — Was soll sein? · **Grenze** — Was bleibt unangetastet?

### Beispiel 1

> ❌ „Der Profil-Tab sieht komisch aus"

Claude weiß nicht, was „komisch" heißt, muss den ganzen Tab lesen (über 1200 Zeilen) und rät bei der Lösung.

> ✅ „Profil-Tab: die Umschalter oben sind viel zu groß, und darunter stehen leere Riesenkästen, wenn noch keine Daten da sind. Umschalter kompakter, leere Kästen ganz ausblenden. Nur das Layout — die Statistiklogik nicht anfassen."

Ort, Beobachtung, Ziel, Grenze. Claude springt direkt in `profile-tab/` und ändert nur die Darstellung.

### Beispiel 2

> ❌ „Kannst du die Farben mal überarbeiten?"

> ✅ „Suche-Tab, Farbfilter: aktuell muss ich für Grün-Weiß beide einzeln anklicken und bekomme dann auch alles, was _nur_ Grün ist. Ich hätte gern Mehrfachauswahl mit ‚genau diese Farben' als Standard und einem Umschalter auf ‚enthält'."

### Beispiel 3

> ❌ „Der Text stimmt nicht"

> ✅ „Im Match-Tab steht auf dem Knopf ‚➕ Hinzufügen' — mach daraus ‚Spieler hinzufügen'. Englisch bitte mit."

Bei Textänderungen ist der **wörtliche aktuelle Text** das Wertvollste, was du liefern kannst: Claude findet ihn damit in einem Suchlauf, statt alle Textdateien durchsuchen zu müssen.

---

## Vokabular: was du sagst → wo Claude landet

Wenn du diese Begriffe benutzt, entfällt die Suche.

| Du sagst …                                             | Claude geht nach …                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Beschriftung, Text, Übersetzung, „da steht …"          | `src/app/i18n/` (je Bereich eine Datei)                                                 |
| Match-Tab, neues Match erfassen, Partie nachtragen     | `src/app/match-tab/`, `game-session.service.ts`                                         |
| Suche-Tab, Kartensuche, Precons, öffentliche Decks     | `src/app/search-tab/`, `public-card-search/`, `precon-browser/`, `public-deck-browser/` |
| Statistik-Tab, Auswertungen, Diagramme, Zahlen         | `src/app/stats-tab/`                                                                    |
| Spiel-Analysen, Zugreihenfolge, Nemesis, Rauswürfe     | `match-insights.ts`, `match-insights/`                                                  |
| Elo, Ranked, Rang, LP, Saison, Abzeichen               | `elo.ts`, `profile-rank/`, `ranked-badges/`, `ui/rank-badge/`                           |
| Gruppe, Mitspieler, Spielerliste, Rechte               | `src/app/group-tab/`, `group.service.ts`                                                |
| Freunde, Freundesspiele, Freunde-Statistik             | `friends.service.ts`, `friends-panel/`, `friend-status/`, `friends-stats/`              |
| Profil, Konto, Einstellungen                           | `src/app/profile-tab/`, `profile.service.ts`                                            |
| Postfach, Benachrichtigungen                           | `comment-inbox/`, `deck-comment-inbox.service.ts`                                       |
| Lebenspunkte-Zähler, In-Game, laufendes Spiel          | `src/app/ingame-tracker/`, `game-session.service.ts`                                    |
| Goldfish, Solo-Testen                                  | `src/app/goldfish-tracker/`                                                             |
| Deck-Ansicht, Deck öffnen, Kartenliste eines Decks     | `src/app/deck-detail-view/`, `deck-viewer.service.ts` (+ `deck-*.service.ts`)           |
| Bracket, Power-Wert, Game Changer                      | `bracket.ts`, `deck-bracket.service.ts`                                                 |
| Deck-Check, Richtwerte, Farbquellen, Starthand         | `deck-check.ts`, `deck-check/`, `deck-check.service.ts`                                 |
| Primer, Steckbrief, Kommentare, Likes                  | `deck-primer/`, `deck-steckbrief/`, `deck-comments/`, `deck-social/`                    |
| Bannliste, Bauregeln, Kartenzahl                       | `banlist.service.ts`, `deck-regeln.ts`                                                  |
| Deck importieren, Moxfield/Archidekt-Link              | `deck-import.service.ts`, `deck-import-dialogs/`                                        |
| Deck-PDF, Proxys drucken                               | `deck-pdf.service.ts`, `deck-pdf-dialog/`                                               |
| Turnier, Swiss, Platzierungen                          | `src/app/tournament-panel/`, `tournament.service.ts`                                    |
| Anmeldung, Login, Passwort                             | `src/app/login/`, `auth.service.ts`                                                     |
| Erklär-Tour, Fragezeichen, Tutorial                    | `tutorial.service.ts`, `tutorial-overlay/`, `i18n/tutorial.ts`                          |
| Diagramm, Balken, Netz/Sechseck, Filter, ⋮-Menü, Icons | `src/app/ui/`                                                                           |
| Farben, Abstände, Rundungen, Grundlayout               | `src/styles.scss`                                                                       |
| Kartendaten, Scryfall, Kartenbilder-Sprache            | `scryfall.service.ts`, `card-data.service.ts`, `art-language.service.ts`                |
| Manasymbole                                            | `src/app/ui/mana-symbol/`                                                               |
| Weißer Bildschirm, App lädt nicht mehr                 | `app-recovery.service.ts`, `global-error-handler.ts`                                    |

Du musst **keine Dateipfade** nennen. Ein Begriff aus der linken Spalte reicht völlig.

---

## Fünf Vorlagen zum Kopieren

**Text ändern**

```
Im [Bereich] steht "[aktueller Text wörtlich]".
Mach daraus "[neuer Text]". Englisch mit anpassen.
```

**Fehler melden**

```
[Bereich]: Wenn ich [was du tust], dann [was passiert].
Erwartet hätte ich [was passieren sollte].
[Fehlermeldung / Screenshot, falls vorhanden]
```

**Layout / Aussehen**

```
[Bereich]: [was dich stört] — auf dem iPhone [/ am Desktop].
Hätte gern: [Zielzustand].
[Was unangetastet bleiben soll.]
```

**Neue Funktion**

```
Ich möchte [Funktion] im [Bereich].
Ablauf: [1-3 Sätze, wie es sich benutzen soll].
Frag nach, wenn etwas unklar ist, bevor du baust.
```

**Nur eine Frage, keine Änderung**

```
Nur eine Frage, bitte nichts ändern: [Frage].
```

Der letzte ist unterschätzt. „Wie funktioniert eigentlich die Turnierwertung?" ohne den Zusatz führt manchmal dazu, dass Claude gleich anfängt umzubauen.

---

## Was du weglassen kannst

Das steht alles schon in `CLAUDE.md` und kostet nur Platz:

- „Denk dran, es ist Angular" / Erklärungen zum Projekt — steht in der Karte
- Dateipfade, wenn du den Bereich benannt hast
- Höflichkeitsfloskeln, Entschuldigungen für „dumme Fragen"

Was du dafür **hinzufügen** solltest: den wörtlichen Text, die genaue Fehlermeldung, den Screenshot. Konkretes Material ist immer billiger als eine Beschreibung davon.

## Was ohnehin passiert

Diese beiden Dinge sind in `CLAUDE.md` als Standardregel hinterlegt — du musst sie nicht anordnen, darfst es aber jederzeit:

- **Der PR wird automatisch angelegt.** Änderungen committen, pushen und den PR eröffnen gehört zu jeder Aufgabe dazu.
- **Gemerged wird nicht.** Der PR bleibt offen, damit du ihn über die Cloudflare-Preview auf dem iPhone testen kannst. Erst dein „kann rein" merged ihn.

Ein „bitte danach einen PR anlegen, aber noch nicht mergen" schadet trotzdem nie — es kostet eine Zeile und stellt sicher, dass es auch dann passiert, wenn eine Session die Projektregeln einmal nicht mitbekommt.

---

## Eine Sache pro Auftrag

> ❌ „Der Profil-Tab ist zu voll, die Turnierwertung stimmt nicht und beim Deck-Import fehlen manchmal Karten."

Das sind drei Baustellen in drei Bereichen. Claude lädt Kontext für alle drei, und der PR wird unprüfbar — du kannst in der Preview nicht sagen, welche der drei Änderungen dir gefällt.

> ✅ Drei Aufträge nacheinander, jeder mit eigenem PR.

**Ausnahme:** Mehrere Änderungen im _selben_ Bereich ruhig bündeln. „Profil-Tab: Umschalter zu groß, leere Kästen ausblenden, und die Commander-Namen werden abgeschnitten" ist ein guter Auftrag — Claude ist ohnehin in dieser Datei.

---

## Wann Plan-Mode, wann direkt

**Direkt loslegen** bei: Textänderungen, Farben und Abständen, kleinen Fehlern mit klarer Fehlermeldung, allem, was du in einem Satz beschreiben kannst.

**Plan-Mode** bei: neuen Funktionen, allem, was mehrere Bereiche berührt, allem, wo du selbst noch nicht ganz sicher bist, was du willst.

Plan-Mode kostet mehr Tokens im Voraus. Er spart aber die teuerste Runde überhaupt — „falsch gebaut, alles noch mal". Bei allem Größeren lohnt er sich fast immer.

---

## Neue Session statt weiterreden

Wenn das Thema wechselt: **neue Session.**

Eine Unterhaltung wird bei jeder Nachricht komplett mitgeschickt. Wenn du nach einer langen Deck-Import-Debatte im selben Fenster nach einer Textänderung fragst, zahlst du die ganze Deck-Import-Unterhaltung noch einmal mit — für eine Änderung, die zwei Zeilen braucht.

Faustregel: **Neues Thema, neuer Bereich, neuer PR → neue Session.** Nachbessern am selben Thema → gleiche Session.

---

## Die Slash-Commands

Vier eingecheckte Kurzbefehle nehmen dir das Formulieren ab. Du schreibst nur noch, worum es geht — der Rest ist hinterlegt.

| Befehl     | Wofür                            | Beispiel                                                    |
| ---------- | -------------------------------- | ----------------------------------------------------------- |
| `/text`    | Beschriftungen und Übersetzungen | `/text Im Match-Tab "➕ Hinzufügen" → "Spieler hinzufügen"` |
| `/fix`     | Fehler beheben                   | `/fix Turnierwertung zählt Unentschieden doppelt`           |
| `/ui`      | Layout und Aussehen              | `/ui Profil-Tab: Umschalter kompakter, leere Kästen weg`    |
| `/feature` | Neue Funktionen                  | `/feature Decks nach Farbidentität filtern können`          |

Sie stecken in `.claude/commands/` und sind eingecheckt — sie funktionieren also auch in Web-Sessions, nicht nur lokal.

---

## Der Kern in fünf Zeilen

1. **Ort nennen** — ein Begriff aus der Vokabular-Tabelle reicht
2. **Wörtlich zitieren** — Texte, Fehlermeldungen, Screenshots statt Umschreibungen
3. **Eine Sache pro Auftrag** — außer sie liegen im selben Bereich
4. **Grenze setzen** — „nur das Layout", „die Logik nicht anfassen"
5. **Neues Thema → neue Session**
