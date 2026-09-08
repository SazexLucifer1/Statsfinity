# Anfrage an Archidekt — Entwurf

Der Archidekt-Import (`scripts/import-deck-corpus.js --source=archidekt`) ist fertig gebaut, **läuft
aber nicht**, solange von dort keine Antwort vorliegt. Das Skript verweigert den Dienst von selbst
und verlangt zusätzlich `--erlaubnis-liegt-vor` (im Workflow: das Feld `permission_granted`).

## Warum überhaupt fragen

Der Lauf ist für Archidekt ohnehin sichtbar: Der User-Agent nennt Statsfinity namentlich und
verlinkt dieses Repo, und 30 Anfragen pro Minute über Stunden von einer GitHub-Actions-IP stehen in
jedem Zugriffsprotokoll. Anonym zu crawlen wäre nicht besser, sondern schlechter — dann sieht es
nach etwas aus, das man sperrt, statt nach einem Projekt, dem man antwortet.

Der eigentliche Grund ist aber ein praktischer: Eine Sperre nach 40.000 gezogenen Decks kostet mehr
als eine Nachricht vorher. Und genau dieselbe Frage — „ist das mit euren Nutzungsbedingungen
vereinbar?" — ist der Anlass, überhaupt von EDHREC wegzugehen.

## Wohin damit

Archidekt hat ein eigenes Forum und einen Discord; die aktuelle Kontaktmöglichkeit steht auf deren
Seite. Am ehesten passt das Forum, weil die API-Fragen dort auch bisher beantwortet wurden.

## Text (englisch)

> **Subject: Permission request — one-time bulk read of public Commander decklists**
>
> Hi,
>
> I run Statsfinity (https://github.com/SazexLucifer1/Statsfinity), a small non-commercial
> Magic: The Gathering companion app. Around twenty people use it — mostly my own playgroup — to
> track matches and manage decks. It is free, has no ads, and I have no plans to change that.
>
> I would like to ask for permission before doing something, rather than after.
>
> **What I would like to do:** perform a one-time read of public Commander decklists through your
> public API, in order to compute my own card-recommendation statistics ("X% of decks with this
> commander play this card"). Today the app fetches those suggestions from EDHREC, which their
> terms do not really allow for building something of my own — so I need my own dataset.
>
> **How it would be done:**
>
> - Rate limited to 30 requests per minute (your forum mentions the limiter starting around 40).
> - A one-time crawl, not continuous polling. No daily or hourly refresh.
> - Identified: every request sends `User-Agent: Statsfinity/1.0 (+https://github.com/SazexLucifer1/Statsfinity)`.
> - Only public decks, only the Commander format.
>
> **What happens to the data:**
>
> - Raw decklists are stored privately and are never republished or redistributed.
> - What becomes publicly visible in my app are only aggregate numbers I compute myself
>   (inclusion rates per commander), never your decklists, deck names, or user names.
> - Archidekt would be credited as the data source in the app.
>
> **What I will not do:** rebuild or re-host your deck browser, mirror your content, or run
> anything commercial on top of it.
>
> If this is not something you want, please just say so and I will not do it — the importer is
> already written but is switched off until I hear back. If you would prefer different limits, a
> different time window, or a different approach entirely, I am happy to adjust.
>
> Thanks for building Archidekt, and thanks for keeping the read API open.
>
> — Fabian

## Wenn die Antwort da ist

- **Ja:** Workflow „Deck corpus import" starten, `aufgabe=import`, `source=archidekt`,
  `permission_granted=true`. Vorher einmal mit `dry_run=true` und `limit=20` prüfen, dass die
  Antwortform stimmt.
- **Nein:** Diese Datei mit der Antwort ergänzen und die Archidekt-Quelle aus dem Import-Skript
  entfernen. Der Korpus lebt dann von den Precons und den eigenen Decks weiter — für echte
  Empfehlungen bräuchte es allerdings eine andere große Quelle.
- **Keine Antwort:** Nichts tun. Ein stillschweigendes „wird schon passen" ist genau die Annahme,
  die bei EDHREC zum Problem geworden ist.
