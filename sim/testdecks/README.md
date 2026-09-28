# Test-Decks der Bracket-Simulation

Jedes zu prüfende Deck spielt je 100 Partien in 4er-Pods gegen drei dieser Decks – erst Bracket 1,
dann 2 … bis 5. Diese 20 Decks sind damit der Maßstab der ganzen Einstufung. Sie liegen deshalb **fest
im Repo**: Ändert jemand sein Deck in Statsfinity oder auf Archidekt, verschieben sich nicht
stillschweigend alle Ergebnisse.

Erzeugt mit `scripts/forge/testdeck-export.js` (dort steht die Auswahl als Tabelle `TESTDECKS`).
Jede Liste hat genau 100 Karten, und Forge kennt jede Karte (Stand Forge `2ccbbb0`).

## Bracket 1 – Exhibition

Nur Decks, deren **Primer ausdrücklich begründet, warum sie Bracket 1 sind**. Alle von Archidekt, alle
ohne Game Changer, Tutoren, Extra-Züge und Combos (Commander Spellbook: „E“).

| Deck                                                                                    | Commander                                             | Begründung im Primer (Zitat)                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Parnesse's Bazaar of Terrible(ly Fun) Cardboard](https://archidekt.com/decks/25085549) | Parnesse, the Subtle Brush                            | „Why Bracket 1? This is an Exhibition deck. Its primary objective is to show people strange cards and give every opponent at least one free sample—not to efficiently win.“ |
| [Oops all Orzhov](https://archidekt.com/decks/13186988)                                 | Ardbert, Warrior of Darkness                          | „my lone Bracket 1 deck themed around a couple of pretty strict restrictions: every single card has to be Orzhov, and every creature has to be legendary.“                  |
| [Cosmic Horror – A Lovecraftian Theme Deck](https://archidekt.com/decks/11556047)       | Vhal, Candlekeep Researcher + Cultist of the Absolute | „My first attempt at a true bracket 1 deck.“ – ein reines Themen-Deck                                                                                                       |
| [Lucky Charms](https://archidekt.com/decks/22519265)                                    | Ramos, Dragon Engine                                  | „This deck was built with the following restrictions. Targeting bracket 1.“ – nur Charms, Tore und Mehrfarbiges                                                             |

Ersetzt, weil Forge die Karte nicht kennt: _Wernog, Rider's Chaplain_ → Plains (Oops all Orzhov),
_Arvinox, the Mind Flail_ → Swamp (Cosmic Horror), _Far Out_ → Plains (Lucky Charms).

Verworfen: „Lila Slivers“ (Forge kennt den Commander nicht, 101 Karten) und „Lost in the Woods“
(94 Wälder – als Kunstprojekt Bracket 1, als Maßstab unbrauchbar).

## Bracket 2 – Core

Unveränderte Precons aus Statsfinity (Michi), vier verschiedene Siegpläne.

| Deck                 | Commander                    | Siegplan                 |
| -------------------- | ---------------------------- | ------------------------ |
| Rebellion Rising     | Neyali, Suns' Vanguard       | Tokens, Aggro            |
| Draconic Destruction | Atarka, World Render         | Drachen, große Kreaturen |
| Endless Punishment   | Valgavoth, Harrower of Souls | Drain, Bestrafung        |
| Necron Dynasties     | Szarekh, the Silent King     | Artefakte, Friedhof      |

## Bracket 3 – Upgraded

Aufgewertete Decks der Gruppe, höchstens drei Game Changer, keine frühen Zwei-Karten-Combos.

| Deck                        | Besitzer | Commander                 | Game Changer |
| --------------------------- | -------- | ------------------------- | -----------: |
| X-Creatures                 | Bene     | Ivy, Gleeful Spellthief   |            2 |
| Sorin & Lurrus Inkasso GmbH | Fabian   | Sorin of House Markov     |            1 |
| Chocobos                    | Fabian   | Choco, Seeker of Paradise |            3 |
| Guess the pill right or die | Fabian   | The Celestial Toymaker    |            3 |

Sorin & Lurrus hatte 101 Karten; eine Plains weniger.

## Bracket 4 – Optimized

| Deck                                    | Besitzer | Commander               | Game Changer / Tutoren |
| --------------------------------------- | -------- | ----------------------- | ---------------------- |
| Azir in Dune                            | Fabian   | Hazezon, Shaper of Sand | 8 / 9                  |
| Elf Ramp                                | Maik     | Marwyn, the Nurturer    | 4 / 4                  |
| F steht für Freunde die was Unternehmen | Bene     | Jodah, the Unifier      | 4 / 5                  |
| Ein Waschbär?!                          | Maik     | Muerra, Trash Tactician | 8 / 6                  |

„Two Headedgiant Mastermind“ (Edric) auf Wunsch raus. „Nazgul Counterspell“ ersetzt durch
„Ein Waschbär?!“: Die Liste hat 114 Karten und ist damit kein legales Commander-Deck.

## Bracket 5 – cEDH

Turniersieger 2026, jeweils Platz 1 eines Turniers mit über 200 Spielern. Listen über die API von
[EDHTop16](https://edhtop16.com).

| Commander                 | Turnier                                                                                                                              | Spieler        | Bilanz |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------ |
| Witherbloom, the Balancer | [Breach the Bay 2](https://topdeck.gg/deck/breach-the-bay-2/WIpu1iugTsUeknwC5xs4h3Tul0U2) – 429 Spieler, 22.08.2026                  | Andrei Blanton | 7-2-0  |
| Kinnan, Bonder Prodigy    | [SIEGE cEDH 10K](https://topdeck.gg/deck/level-7s-siege-at-the-castle-10k/10XZGpOw5vVlD7VeYRO1XvBv3Ft2) – 308 Spieler, 13.06.2026    | Janos Nado     | 5-0-3  |
| Thrasios + Tymna          | [Land, Go Open 10k](https://topdeck.gg/deck/land-go-open-10k-cedh-tournament/ZlePjFOXYabVI36O3Ky5iyQ9uV43) – 212 Spieler, 23.05.2026 | Thack Chumpley | 5-2-2  |
| Ishai + Rograkh           | [The Cookout 2026](https://topdeck.gg/deck/the-cookout-2026/yDmurQQALDMAZ5XelLf8KibSaaB3) – 238 Spieler, 29.08.2026                  | spuki          | 5-1-3  |

Ishai + Rograkh hat 2026 drei große Turniere gewonnen (auch Misplay on the Lake und Summer Classic 3).

## Kalibrierung

`scripts/forge/calibrate.js` prüft, ob die Stufen überhaupt trennen:

- **innen:** die vier Decks einer Stufe gegeneinander – jedes sollte um 25 % liegen.
- **stufe:** ein Deck der Stufe k gegen drei Decks der Stufe k−1 – sollte deutlich über 25 % liegen.

### Erster Lauf (28.09.2026, Forge `2ccbbb0`, Standard-Bot, je Probe 20 Partien)

Innerhalb der Stufe (fair wären 25 %):

| Stufe | Decks und Siegquote                                                    | Ø Runde des Endes |
| ----- | ---------------------------------------------------------------------- | ----------------: |
| B1    | Ardbert 50 %, Ramos 20 %, Parnesse 15 %, Vhal 5 %                      |               7,0 |
| B2    | Valgavoth 40 %, Atarka 25 %, Szarekh 25 %, Neyali 10 %                 |               5,3 |
| B3    | Celestial Toymaker 50 %, Sorin 35 %, Choco 15 %, Ivy 0 %               |               6,1 |
| B4    | Marwyn 40 %, Jodah 30 %, Hazezon 25 %, Muerra 5 %                      |               6,0 |
| B5    | Witherbloom 45 %, Ishai/Rograkh 25 %, Kinnan 10 %, Thrasios/Tymna 10 % |               6,1 |

Ein Deck der Stufe k gegen drei Decks der Stufe k−1 (soll deutlich über 25 %):

| Probe       |  Siege | Quote |
| ----------- | -----: | ----: |
| B2 gegen B1 | 7 / 20 |  35 % |
| B3 gegen B2 | 5 / 20 |  25 % |
| B4 gegen B3 | 3 / 20 |  15 % |
| B5 gegen B4 | 1 / 20 |   5 % |

**Die Stufen trennen nicht – ab Bracket 3 kehrt sich das Verhältnis sogar um.** Der Grund steht in den
Verlustgründen: In allen 180 Partien hat **kein einziges Deck per Combo gewonnen**, jede Partie endete über
Lebenspunkte (einmal Gift). Der Standard-Bot von Forge spielt jedes Deck als Kreaturen-Deck; Tutoren, schnelles
Mana und Combos – genau das, was Bracket 4 und 5 ausmacht – setzt er nicht in Siege um. cEDH-Listen mit wenigen
Kreaturen verlieren dadurch gegen Bracket-4-Decks, die einfach angreifen.

Folge: Mit dem Standard-Bot misst die Simulation, wie gut sich ein Deck als Kreaturen-Deck spielen lässt, nicht
seine Stufe. Nächster Versuch: Forges vorausschauende Such-KI („full simulation“), die Züge durchrechnet und einen
Spielsieg als besten Spielstand erkennt.

### Such-KI von Forge (28.09.2026, je eine B5-Partie)

Forge hat neben dem Standard-Bot eine vorausschauende KI, die Züge durchrechnet (in der Oberfläche wählbar, im
Kommandozeilen-Modus nur mit einer kleinen lokalen Änderung an `SimulateMatch.java` – Umgebungsvariable
`FORGE_AI_SIMULATION=full|hybrid`, **nicht** im Repo, weil sie nichts gebracht hat):

- **full**: bei 3 GB Speicher `OutOfMemoryError` (jede geprüfte Aktion kopiert den ganzen Spielstand mit vier
  Spielern). Mit 10 GB 4,5 Minuten für knapp drei Runden, dann bricht die Partie mit einem Forge-Fehler ab – alle
  vier Spieler „gewinnen“ gleichzeitig. Keine Combo.
- **hybrid**: schnell (30 s), aber zwei der vier cEDH-Bots verlieren an ihrem **eigenen Pact of Negation**, weil
  sie die Kosten im nächsten Unterhalt nicht zahlen können. Gewonnen wird wieder über Lebenspunkte. Keine Combo.

Ergebnis: Keiner der drei Forge-Bots spielt Combos. Damit die Simulation Bracket 4 und 5 erkennt, braucht der Bot
eine eigene Combo-Steuerung, die den Siegplan des Decks kennt.
