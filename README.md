# Statsfinity

Deutsch- und englischsprachige, **mobile-first** Companion-App für **Magic: The Gathering** – optimiert für das iPhone (Safari), installierbar als Web-App auf dem Home-Bildschirm. Matches erfassen, Statistiken auswerten, Decks verwalten und analysieren, Turniere spielen – allein, in Gruppen oder mit Freunden.

## Funktionen

### Match & Live-Tracker

- **Match erfassen**: Spielmodus (Normal, Two-Headed Giant, Archenemy, Cube, Draft, Spezialevent) und Format wählen, Mitspieler antippen, Decks zuweisen, als **Ranked** oder **Frei** starten.
- **Lebenspunkte-Tracker** im Vollbild: Leben, Gift, Commander-Schaden, Monarch, Initiative und frei wählbare Zähler; Felder zum Platz drehen oder aufrecht anordnen, Spieler neu anordnen, Rückgängig.
- **Startspieler auslosen**, Hintergrundbild je Spieler (auch eigene Uploads, mit der Gruppe teilbar).
- **Live-Session**: Mitspieler der Gruppe sehen den laufenden Stand auf ihren eigenen Geräten.
- **Rauswürfe**: In Commander-Partien fragt der Totenkopf, wer einen Spieler rausgeworfen hat.
- **Partie-Verlauf**: Startzeit, Dauer, Zugreihenfolge und Lebenspunkte-Kurve werden mitgeschrieben.
- **Nachtragen**: Partien ohne Tracker nachträglich erfassen; Bilanz von vor der App je Deck hinterlegen.
- **Goldfish-Modus**: Ein Deck allein testen – ziehen, mischen, Mulligan, Karten aufs Spielfeld, anlegen, tappen.

### Statistik

- Ranglisten mit Siegen und Winrate, erfolgreichste Commander und Decks, Match-Verlauf, Filter nach Jahr, Format, Modus und Gruppe.
- **Spiel-Analysen**: Vorteil der Zugreihenfolge, Spieldauer, Gegner und Nemesis, Form, Spiele und Winrate je Monat, Rauswürfe („wer wirft wen raus").
- **Elo-Wertung (Ranked)** je Gruppe, Spielmodus und Format mit Rängen von Holz bis Infinity, Einstufungsphase, **Saisons** mit Abzeichen; vom Gruppenleiter an- und abschaltbar.
- **Freunde-Ansicht**: Rangliste, „Du gegen X", Commander und Analysen über alle Gruppen hinweg.
- **Jahresrückblick** als teilbares Bild.
- **Globale Statistik** ohne Login.

### Decks

- **Import** aus deckstats.net, Moxfield, Archidekt, MTGGoldfish, TappedOut u. ä. per Text; leeres Deck anlegen; **Precons** importieren. Änderungen zum letzten Import werden erkannt und als Verlauf gespeichert.
- **Deck-Ansicht** mit Kartenliste, Bearbeiten-Modus, Manakurve, Farbverteilung, Effekt-Kategorien, Kartenpreis, Combos (Commander Spellbook) und Combo-Finder.
- **Bracket- und Power-Einschätzung** (Game Changer, Tutoren, Combos, Beständigkeit).
- **Deck-Check**: Länder, Rampe, Draw, Removal, Wipes und Win Cons gegen Richtwerte je Spielweise, Farbquellen, Starthand-Wahrscheinlichkeiten, Testhand. Die Richtwert-Tabelle liegt als Download in `public/richtwerte/`.
- **Bauregeln & Bannliste** je Format (Kartenzahl, Kopien, gebannte und restricted Karten).
- **Primer**: eigene Deck-Beschreibung mit Formatierung, Manasymbolen, Kartenlinks und Bildern.
- **Steckbrief**: quadratisches Bild zum Teilen mit Commander, Kennzahlen und QR-Code zum Deck.
- **Deck gegen Deck**: Bilanz des Decks gegen andere Decks.
- **PDF-Export** zum Proxy-Drucken, Artwork je Exemplar wählbar.
- **Öffentlich teilen**: Aufrufe, Likes und Kommentare (mit Antworten), Link per `?deck=<id>`.
- Löschen bewahrt die Statistik: Decks mit Partien bleiben als „Grabstein" erhalten.

### Suche

- **Kartensuche** über Scryfall mit Farb-, Manawert-, Effekt- und Schlagwort-Filtern.
- **Precon-Browser** und **öffentliche Decks** anderer Spieler stöbern.

### Gruppen, Freunde & Profil

- **Gruppen** per Einladungscode, Rollen und Rechte, Sichtbarkeit, mehrere Gruppen mit aktiver Gruppe.
- **Freunde**: Anfragen, Neuigkeiten, Freundesspiele außerhalb jeder Gruppe.
- **Profil** mit Rang, Abzeichen, Lieblings-Commander, meistgespielten Karten, Match-Historie; fremde Profile sind öffentlich ansehbar.
- **Postfach** für Freundesanfragen, Kommentare auf eigene Decks und Antworten.
- Einstellungen für Oberflächensprache (Deutsch/Englisch) und **Artwork-Sprache** der Kartenbilder.

### Turniere

- Swiss-Turniere mit 1-gegen-1 (Best of 3) oder 4er-Pods, automatische oder manuelle Rundenzahl, offizielle Tiebreaker, Platzierungen und Turnier-Historie.
- Beitritt per Turnier-Code, Synchronisation aller Geräte in Echtzeit.

### Sonstiges

- **Erklär-Touren**: Das Fragezeichen in der Kopfzeile erklärt den gerade sichtbaren Bildschirm.
- **Feedback** direkt aus der App.
- Impressum, Datenschutz und Nutzungsbedingungen in der App.

## Technik

- **Angular 21** (standalone components, Signals, TypeScript strict) – ohne Router, die Navigation läuft über ein Signal.
- **Supabase** als Backend (Postgres, Auth, Realtime, Storage).
- **Cloudflare Pages** als Hosting, dazu zwei Cloudflare Functions (`functions/api/`): Bild-Proxy für PDF/Steckbrief und Bracket-Schätzung.
- Externe Daten: [Scryfall](https://scryfall.com/) (Karten), [Commander Spellbook](https://commanderspellbook.com/) (Combos), EDHREC (nur für Alpha-Tester).
- Nächtliche GitHub-Actions-Läufe (`.github/workflows/`): Supabase-Backup, Scryfall- und Spellbook-Abgleich in Cache-Tabellen.

Eine ausführliche Karte der Architektur steht in [`CLAUDE.md`](CLAUDE.md).

## Setup

```bash
npm install
npm start
```

Die App läuft dann unter `http://localhost:4200` und spricht mit der in `src/app/supabase.client.ts` eingetragenen Supabase-Instanz.

| Befehl              | Zweck                                                 |
| ------------------- | ----------------------------------------------------- |
| `npm start`         | Dev-Server                                            |
| `npm run typecheck` | Schneller Build inkl. Template-Prüfung                |
| `npm run build`     | Produktions-Build nach `dist/statsfinity/browser`     |
| `npm test`          | Unit-Tests (Vitest)                                   |
| `npm run check:map` | Prüft, ob die Architektur-Karte in `CLAUDE.md` stimmt |

### Datenbank

Die Migrationen liegen datiert in `sql/` und laufen **nicht automatisch** – sie werden von Hand im Supabase-SQL-Editor ausgeführt. Fehlt eine Migration, schaltet die App die zugehörige Funktion meist still ab.

Die nächtlichen Abgleiche brauchen das Repo-Secret `SUPABASE_SERVICE_ROLE_KEY`.

### Deployment

Cloudflare Pages baut mit `npm run build` und veröffentlicht `dist/statsfinity/browser`; jeder Pull Request bekommt eine eigene Preview-URL. Sicherheits- und Cache-Header (inkl. CSP) stehen in `public/_headers` – neue externe Domains müssen dort freigeschaltet werden.

## Auf dem iPhone installieren

1. Seite in Safari öffnen.
2. Teilen-Menü → **„Zum Home-Bildschirm"**.
3. Die App startet dann im Vollbild ohne Browser-Leiste.

## Manasymbole

Die Manasymbole stammen aus der [Mana-Schriftart](https://mana.andrewgioia.com/) von Andrew Gioia (npm-Paket `mana-font`, MIT-Lizenz). Eingebunden ist sie in `src/styles/_mana.scss`; im Markup rendert sie die Komponente `app-mana-symbol` (`src/app/ui/mana-symbol/`).

## Rechtliches

Statsfinity ist ein inoffizielles Fan-Projekt und steht in keiner Verbindung zu Wizards of the Coast. Magic: The Gathering, Kartennamen, Kartenbilder und Manasymbole sind Eigentum von Wizards of the Coast. Kartendaten und -bilder werden über Scryfall bereitgestellt.
