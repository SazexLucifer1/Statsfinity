# Ranked-System (ausgebaut am 23.11.2026)

Das Rangsystem (Elo/LP, Ränge Holz bis Infinity, Saisons mit Abzeichen, Ranked/Frei beim
Match-Start, Rangfarben an Spielern, LP in der Match-Historie, Elo-Ranglisten unter Freunden) ist
auf Wunsch des Users aus der App entfernt. Dieser Ordner bewahrt den Code auf, falls es wieder
eingebaut werden soll. **Er liegt außerhalb von `src/` und wird weder gebaut noch getestet.**

## Inhalt

| Datei / Ordner             | Früher                                  | Was                                                                    |
| -------------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| `elo.ts`, `elo.spec.ts`    | `src/app/`                              | Die ganze Rechnung: Elo je Modus und Format, LP, Ränge, Einstufung, Saison-Ergebnisse |
| `ranked-badge.service.ts`  | `src/app/`                              | Saison beenden, Abzeichen schreiben/lesen (`ranked_badges`)            |
| `profile-rank/`            | `src/app/profile-rank/`                 | Rang-Kachel im Profil mit Auswahl von Gruppe, Modus und Format          |
| `ranked-badges/`           | `src/app/ranked-badges/`                | Saison-Abzeichen im Profil                                              |
| `ui/rank-badge/`           | `src/app/ui/rank-badge/`                | Rang-Abzeichen und `RANK_COLORS`/`rankStyle()` (einzige Farbtabelle)    |
| `styles-global.scss`       | Teil von `src/styles.scss`              | `.rank-frame` (Profilkopf) und `.rank-tinted` (Spieler-Chips/-Karten)   |
| `i18n-texte.ts`            | Teile von `src/app/i18n/*.ts`           | Alle entfernten Texte, je Sprache                                       |
| `entfernt.patch`           | –                                       | Alle Änderungen an den übrigen Dateien als Diff (siehe unten)           |

`entfernt.patch` enthält jede Stelle, die beim Ausbau aus den verbleibenden Dateien gestrichen
wurde: Gruppen-Service (Schalter `ranked_enabled`, Saisonstart `ranked_since`), Gruppen-Tab
(⋮-Menü: Rangsystem an/aus, Saison beenden, Rangliste zurücksetzen), Match-Tab und
Game-Session (Ranked/Frei, `matches.is_ranked`), Mtg-Service (Spalte laden/speichern,
`setMatchRanked()`), Statistik-Tab, Profil-Tab und Profil-Service (`profile_rank_choice()`,
`profiles.rank_mode`/`rank_format`/`rank_group_id`), Match-Historie (LP je Partie), Freunde
(Elo-Rangliste), Tour-Schritte und Texte.

## Wieder einbauen

1. Dateien zurück an ihren alten Ort verschieben (Tabelle oben), `styles-global.scss` wieder in
   `src/styles.scss` einfügen.
2. Den Rest zurückspielen - am besten auf dem Stand, auf dem der Ausbau passiert ist:
   ```bash
   git apply -R --3way schnipsel/ranked/entfernt.patch
   ```
   Auf einem deutlich neueren Stand greifen nicht mehr alle Stellen; dann den Patch als
   Nachschlagewerk lesen und von Hand einsetzen. Alternativ den Ausbau-Commit per
   `git revert` rückgängig machen.
3. Architektur-Karte in `CLAUDE.md` wieder ergänzen (Abschnitt „Elo-Wertung …“ und die Tabellen) -
   `npm run check:map` sagt, was fehlt.

## Datenbank

An der Datenbank wurde **nichts** geändert. Spalten, Tabellen und Funktionen der Migrationen
`sql/elo-rang-modus-2026-09-29.sql`, `sql/ranked-gruppe-2026-09-30.sql` und
`sql/ranked-saison-2026-10-06.sql` bleiben stehen, werden aber von der App nicht mehr gelesen oder
geschrieben. Neue Partien bekommen deshalb den Standardwert von `matches.is_ranked`; die Elo wurde
nie gespeichert, sondern immer aus den Partien gerechnet - beim Wiedereinbau ist sie sofort wieder da.
