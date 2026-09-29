# Bracket-Benchmark (September 2026)

Ergebnisse einer abgeschlossenen Untersuchung. Die Daten dahinter (eine externe Deck-Stichprobe und Simulationsläufe) sind am
29.09.2026 aus Repo und Datenbank entfernt worden. Hier stehen **nur Kennzahlen** – keine Decklisten, keine
Decknamen, keine Verweise auf einzelne Decks.

Wozu es diese Datei gibt: Sie ist der **Ausgangspunkt** des Benchmarks, den die App seit dem 29.09.2026 selbst
fortschreibt (siehe „Ab jetzt: der Benchmark lernt aus Statsfinity-Decks“ ganz unten). Die Startwerte dort stammen
von hier.

## Grundlage

- **48.638 Commander-Decks** einer externen Stichprobe, jedes mit der Bracket-Stufe, die sein Ersteller selbst
  angegeben hat (Stand 17.09.2026). Das ist eine Selbstauskunft, keine gemessene Stärke.
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

## Was daraus folgt

Die Einstufung bleibt bei den Kartenregeln (`bracket.ts`). Die gemessenen Teile – die Spannen des Tuning-Grads und
die Tutorenschwelle von Urteil F – lernt die App seitdem an eigenen Decks weiter.

## Ab jetzt: der Benchmark lernt aus Statsfinity-Decks

Seit dem 29.09.2026 (`sql/bracket-benchmark-2026-09-29.sql`):

- **Stichprobe:** jedes Commander-Deck (nicht gelöscht, mindestens 60 Karten), dessen Besitzer das Bracket **selbst
  gewählt** hat – auch private Decks. Je Deck werden nur fünf Zahlen gespeichert (Tutoren je 100 Karten, Game
  Changer, spielbeendende Combos, Ø Manawert, Anteil ungetappter Länder) in `bracket_benchmark_decks`, die für
  Clients nicht lesbar ist.
- **Täglich:** Am Ende des nächtlichen Spellbook-Abgleichs misst `bracket_benchmark_aktualisieren()` alle Decks neu
  und schreibt je Bracket die Mediane nach `bracket_benchmark`.
- **100er-Regel:** Die Werte eines Brackets werden erst überschrieben, wenn **mindestens 100 Decks dieses Brackets**
  in der Stichprobe liegen. Darunter bleibt stehen, was vorher dort stand – anfangs die Startwerte aus dieser Datei.
- **Tuning-Spannen:** je Merkmal von Median Bracket 2 (zählt 0) bis Median Bracket 5 (zählt 1).
- **Urteil F:** die kleinste Tutorenzahl, bei der unter den Decks mit Gewinn-Combo mindestens 90 % Bracket 4 oder 5
  gewählt haben (mindestens 20 solche Decks). Neu bestimmt erst, wenn Bracket 2, 3 und 4 je 100 Decks haben.
- **Nicht gelernt:** die offiziellen Kriterien (Game Changer, Mass Land Denial, Extra-Turn-Schleifen, Combos).

Wer die Messung ändert, ändert sie an **beiden** Stellen: SQL-Funktion und die Merkmale im Client
(`deck-viewer.service.ts`) müssen dasselbe messen, sonst vergleicht der Tuning-Grad Äpfel mit Birnen.
