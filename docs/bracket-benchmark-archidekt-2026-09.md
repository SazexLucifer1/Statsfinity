# Bracket-Benchmark: Auswertung am Archidekt-Vorrat (September 2026)

Ergebnisse einer abgeschlossenen Untersuchung. Die Daten dahinter (Archidekt-Decks, Simulationsläufe, Forge-Partien)
sind am 29.09.2026 aus Repo und Datenbank entfernt worden (`sql/forge-archidekt-entfernen-2026-09-29.sql`). Hier
stehen **nur Kennzahlen** – keine Decklisten, keine Decknamen, keine Verweise auf einzelne fremde Decks.

Wozu es diese Datei gibt: als **Vergleichsmaßstab** für die spätere Auswertung an Decks, die in Statsfinity selbst
gebaut werden. Deshalb steht die Methode genau dabei – die zweite Liste muss gleich gerechnet werden, sonst sind die
Zahlen nicht vergleichbar.

## Grundlage

- **48.638 Commander-Decks** von Archidekt, jedes mit der Bracket-Stufe, die sein Ersteller selbst angegeben hat
  (Stand 17.09.2026). Das ist eine Selbstauskunft, keine gemessene Stärke.
- Die Merkmale je Deck kamen aus Kartenauswertung und einem Goldfish-Simulator (ein Spieler, kein Gegner).

## Methode: AUC

Für ein Merkmal und zwei Stufen: Zieht man zufällig ein Deck der höheren und eines der niedrigeren Stufe – wie oft
hat das höhere den größeren Wert? Gleichstand zählt halb (Mann-Whitney-U über Ränge, keine Schwelle).

| AUC        | Bedeutung                                        |
| ---------- | ------------------------------------------------ |
| 0,50       | trennt gar nicht                                 |
| 0,65       | schwach, aber vorhanden                          |
| 0,80       | deutlich                                         |
| unter 0,50 | trennt andersherum (kleiner Wert = höhere Stufe) |

Die **Stärke** ist der Abstand zu 0,50, die Richtung nur ihr Vorzeichen.

## Trennschärfe je Merkmal (Bracket 2 gegen Bracket 4)

35.829 Decks, bei denen die Kartenauswertung mindestens 60 % der Karten verstanden hat.

| Merkmal                          |   AUC | Stärke |
| -------------------------------- | ----: | -----: |
| Game Changer                     | 0,898 |  0,398 |
| Tutoren                          | 0,771 |  0,271 |
| verfügbares Mana in Zug 3 (Sim.) | 0,660 |  0,160 |
| Anteil Combo-Karten              | 0,634 |  0,134 |
| Länder (weniger = höher)         | 0,366 |  0,134 |
| spielbeendende Combos            | 0,633 |  0,133 |
| Rampe                            | 0,622 |  0,122 |
| _Rauschgrenze: erkannte Karten_  | 0,404 |  0,096 |
| Mana in Zug 5 (Sim.)             | 0,592 |  0,092 |
| schnellste 10 % Siege (Sim.)     | 0,415 |  0,085 |
| Schaden bis Zug 10 (Sim.)        | 0,420 |  0,080 |
| Leerlaufzüge (Sim.)              | 0,423 |  0,077 |
| Streuung der Siegzüge (Sim.)     | 0,561 |  0,061 |
| Median-Siegzug (Sim.)            | 0,465 |  0,035 |
| Siegquote (Sim.)                 | 0,529 |  0,029 |
| Interaktion                      | 0,509 |  0,009 |

Befunde:

- **Karten schlagen Simulation.** Die beiden stärksten Merkmale sind gezählte Karten, beide stehen in `bracket.ts`.
  Alles, was der Simulator über das Gewinnen ausrechnet, liegt im Rauschen.
- **Rauschgrenze:** Die Spalte „wie viele Karten die Auswertung überhaupt versteht“ trennt mit 0,096 besser als fast
  jede simulierte Zahl. Merkmale darunter sind von der eigenen blinden Stelle nicht zu unterscheiden.
- **Interaktion trennt gar nicht.**
- **Vorsicht, teils zirkulär:** Wer sein Deck einstuft, liest dieselbe Game-Changer-Liste, die hier gezählt wird.
  Ein Teil der 0,898 misst, wie gut Deckbauer das Regelwerk anwenden.

## Grundlage von Urteil F (Combo + mindestens 2 Tutoren ⇒ mindestens Bracket 4)

Verteilung der Decks mit **beiden** Merkmalen über die angegebenen Stufen:

| Stufe | Decks | Anteil der Stufe |
| ----: | ----: | ---------------: |
|     1 |    75 |            0,8 % |
|     2 |    68 |            0,7 % |
|     3 |   457 |            4,7 % |
|     4 | 2.120 |           21,2 % |
|     5 | 5.595 |           57,3 % |

93 % liegen in Bracket 4 oder 5, von Stufe 2 zu Stufe 4 ist es Faktor 30. Einzeln trennen die Merkmale viel
schwächer (eine Combo allein: 9,9 % der B2-Decks, zwei Tutoren allein: 6,0 %). 61 % der B4-Decks zeigen keines der
beiden – das Urteil ist nur eine Untergrenze. Steht so in `src/app/bracket.ts`.

## Sieg-Definition

Von 1.320 Ergebnis-Texten in Commander Spellbook zählen **43** als Sieg im weiten Sinn („Endpunkt eines Decks“),
**28** im engen („beendet das Spiel sofort“), neun fallen durch Ausnahmen („Infinite damage to all creatures“ ist
ein Boardwipe). Anlass: Ein cEDH-Deck mit 22 vollständigen Combos hatte nach der engen Definition keine einzige
Sieg-Combo. Die Muster stehen in SQL (`sql/sieg-definition-breit-2026-09-17.sql`), Urteil F nutzt die enge.

## Forge: echte 4er-Partien mit Bots (28./29.09.2026)

Idee: Stufe eines Decks = gegen welche Test-Decks es mithält. Engine: Forge (Open Source), dazu ein eigener
Combo-Pilot, der erkannte Sieg-Combos vorführt.

**Hinweis zu Rundenzahlen:** Forge teilt die Zugzahl im Ergebnis durch 2 (für Duelle gebaut). Alle damals notierten
„Runden“ sind deshalb etwa halb so groß wie die echten. Die Winraten stimmen.

### Test-Decks: höhere Stufe gegen drei Decks der Stufe darunter (fair 25 %)

| Probe       | Standard-Bot | mit Combo-Pilot | nach Deck-Tausch |
| ----------- | -----------: | --------------: | ---------------: |
| B2 gegen B1 |         35 % |            30 % |                – |
| B3 gegen B2 |         25 % |            25 % |             20 % |
| B4 gegen B3 |         15 % |            15 % |             20 % |
| B5 gegen B4 |          5 % |            25 % |              5 % |

Je 20 Partien (95-%-Intervall etwa ±18 Punkte). Ohne Pilot gab es in 180 Partien keinen einzigen Combo-Sieg.

### Probe am Vorrat: 45 Decks, 2.104 Partien, je Deck gegen drei feste B4-Test-Decks

| angegebene Stufe | Decks | Partien | Winrate | Combo-Siege |
| ---------------: | ----: | ------: | ------: | ----------: |
|                1 |     9 |     421 |    18 % |           2 |
|                2 |     9 |     424 |    23 % |           3 |
|                3 |     9 |     412 |    29 % |          16 |
|                4 |     9 |     418 |    24 % |          22 |
|                5 |     9 |     429 |    18 % |          36 |

AUC der Deck-Winraten: 1|2 0,605 · 2|3 0,648 · 3|4 0,389 · 4|5 0,327 · **1–2 gegen 4–5: 0,515**.

Befund: Bis Bracket 3 steigt die Winrate, danach fällt sie – cEDH-Decks gewinnen so selten wie Bracket-1-Decks,
obwohl ihre Combo-Siege mit der Stufe steigen. Die Bots spielen starke Decks nicht stark: Sie wirken aus, was geht,
entfernen, was sich entfernen lässt, und blocken schlecht (Beispiel: bei 4 Leben den tödlichen Angreifer ungeblockt
gelassen, zwei kleinere doppelt geblockt). **Als Bracket-Maßstab untauglich** – deshalb eingestellt.

## Was daraus folgt

Die Einstufung bleibt bei den Kartenregeln (`bracket.ts`). Die nächste Messung läuft an Decks aus Statsfinity mit
**vom Besitzer selbst gewählter** Stufe und mit derselben AUC-Rechnung wie oben.
