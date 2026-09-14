# Was macht ein starkes Commander-Deck aus? Gemessen an 1.054 Decks

> Erhoben am 2026-09-14 mit `node scripts/analyze-deck-corpus.js`.
> Die Messwerte je Deck stehen in `deck-metriken-2026-09.csv` daneben, damit jede Zahl hier
> nachrechenbar ist - eine Zeile je Deck, mit Korpus, Bracket-Label und Fundstelle.

## Was gemessen wurde

| Korpus | Decks | Was es ist | Wer es so nennt |
| --- | --- | --- | --- |
| cEDH | 250 | EDHRECs Durchschnittsdeck je cEDH-Commander | EDHREC-Tag `cedh` |
| Nicht-cEDH | 285 | **Dieselben Commander**, ohne cEDH-Filter | – |
| Precon | 92 | Commander-Precons ab 2023 (MTGJSON) | Wizards (Produkt) |
| Bracket 1-5 | 427 | Durchschnittsdeck je Commander **und Bracket** | die Deck-Autoren selbst |

Die ersten beiden Korpora beantworten die Frage nach der Bauweise: Weil dort dieselben Commander
stehen, misst der Unterschied die **Bauweise** und nicht den Commander. Ein Kinnan-Deck bleibt ein
Kinnan-Deck; was es zum cEDH-Deck macht, steht in den Zahlen dazwischen.

Der vierte Korpus beantwortet die Frage, die die Bracket-Automatik wirklich stellt - und für die
der ersten Auswertung jede Grundlage fehlte: **Wie sieht ein Bracket-3-Deck aus, und wie ein
Bracket-4-Deck?**

### Woher die Bracket-Labels stammen

| Bracket | Decks im Korpus | Echte Listen dahinter | Fundstelle bei EDHREC |
| --- | --- | --- | --- |
| 1 — Exhibition | 59 | 6.190 | `/average-decks/<commander>/exhibition.json` |
| 2 — Core | 100 | 198.986 | `/average-decks/<commander>/core.json` |
| 3 — Upgraded | 100 | 247.389 | `/average-decks/<commander>/upgraded.json` |
| 4 — Optimized | 100 | 119.275 | `/average-decks/<commander>/optimized.json` |
| 5 — cEDH | 68 | 37.579 | `/average-decks/<commander>/cedh.json` |

**Das Label stammt von EDHREC, nicht von uns und nicht aus einer eigenen Heuristik.** EDHREC führt
zu jedem eingereichten Deck eine Bracket-Angabe (Feld `bracket` in
`/pages/decks/<commander>.json`) und mittelt unter obigen Adressen je Bracket über genau diese
Decks. Die Spalte "Echte Listen dahinter" ist die Zahl, die EDHREC selbst im Feld
`bracket_counts` nennt; Durchschnitte unter 50 Listen sind verworfen.

Was dabei **nicht** nachgeprüft werden konnte: ob EDHREC die Bracket-Angabe des Deck-Autors von
Moxfield bzw. Archidekt übernimmt oder die Stufe selbst errechnet. `edhrec.com` und beide
Deckseiten sind aus der Umgebung dieses Laufs gesperrt, und `json.edhrec.com` sagt dazu nichts.
Die belastbare Aussage ist deshalb: ein **Fremdlabel von EDHREC**, erhoben über eine bekannte Zahl
echter Listen — wer es ursprünglich vergibt, steht unter Vorbehalt.

Alle Kennzahlen kommen aus `src/app/deck-metrics.ts`, die Simulationswerte aus
`src/app/goldfish-sim.ts` (2000 Spiele je Deck).
**Die Regeln, nach denen die Simulation spielt, stehen im Kopfkommentar jener Datei**, jede mit
ihrer Nummer aus den Comprehensive Rules; der Wortlaut in `docs/mtg-regeln.md`.

## Was die Simulation vom Korpus erfasst

Die alte Simulation rechnete Mana als reine Zahl, kannte kein Kartenziehen und keine
Einsatzverzögerung. Diese Zählung über alle 1.054 Decks sagt,
wie groß die Lücke war - und damit, worauf die Zahlen weiter unten jetzt beruhen.

| Im Korpus | Anzahl | Anteil |
| --- | --- | --- |
| Zaubersprüche (ohne Länder) | 69.206 | 100 % |
| … davon mit farbigen Kosten | 56.666 | 81,9 % |
| … davon mit Hybrid-Kosten | 492 | 0,7 % |
| … davon mit Phyrexia-Kosten | 465 | 0,7 % |
| … davon mit {X} | 1.481 | 2,1 % |
| … mit Manasymbolen, die die Tabelle nicht kennt | 0 | 0 % |
| Karten mit Kategorie "Kartenziehen" | 11.561 | – |
| … davon zieht in der Simulation wirklich | 3.626 | 31,4 % |
| Karten, die in der Simulation ziehen (alle) | 3.875 | – |
| Manakreaturen mit {T} (Einsatzverzögerung) | 2.994 | – |
| Länder | 23.745 | – |
| … davon mit bekannter Farbe | 20.358 | 85,7 % |

Die Ziehzeilen sind die ehrlichsten: Von den Karten, die Scryfalls Kategorien als Kartenziehen
führen, zieht in der Simulation nur ein knappes Drittel wirklich. Erfasst ist, was **unbedingt**
passiert — beim Wirken eines Instants oder einer Hexerei, beim Ins-Spiel-Kommen, oder in jedem
Versorgungs-, Zieh- oder Endschritt. Alles Bedingte (ein Rhystic Study zieht ohne Gegner nichts),
jede aktivierte Ziehfähigkeit und alles über Kampfschaden bleibt draußen. Die Simulation
unterschätzt Ziehdecks also weiterhin, nur nicht mehr um alles.

## Alle Kennzahlen

Trennschärfe: Wie oft liegt ein zufälliges Deck der ersten Gruppe über einem zufälligen Deck der
zweiten? **0,5 heißt "die Metrik weiß nichts"**; 1,0 und 0,0 trennen beide vollständig, nur in
entgegengesetzte Richtung - bei Ländern und Manawert liegen cEDH-Decks eben DARUNTER. Je weiter ein
Wert von 0,5 entfernt ist, desto mehr sagt die Kennzahl aus.

| Gruppe | Kennzahl | Median cEDH | Median Nicht-cEDH | Median Precon | Trennschärfe vs. Precon | vs. Nicht-cEDH |
| --- | --- | --- | --- | --- | --- | --- |
| A Tempo | Fast Mana (erzeugt mehr als es kostet) | 7 | 2 | 1 | 0,973 | 0,93 |
| A Tempo | Durchschnittlicher Manawert | 2,24 | 3,05 | 3,51 | 0,053 | 0,154 |
| A Tempo | Anteil Karten für 0-1 Mana | 0,24 | 0,09 | 0,04 | 0,99 | 0,91 |
| A Tempo | Länder | 30 | 35 | 38 | 0,034 | 0,1 |
| A Tempo | Ungetappte Länder (%) | 100 | 92 | 78 | 0,981 | 0,856 |
| A Tempo | Mana in Zug 3 (bestenfalls) | 3,6 | 3,1 | 2,9 | 0,977 | 0,869 |
| A Tempo | Günstigste gewinnende Combo (Mana) | 6 | 8 | 9 | 0,183 | 0,291 |
| A Tempo | Frühestmöglicher Siegzug | 6 | 6 | – | – | 0,506 |
| A Tempo | Simulation: Median-Siegzug | 8 | 8 | 8,5 | 0,213 | 0,358 |
| A Tempo | Simulation: Sieg bis Zug 4 (Anteil) | 0 | 0 | 0 | 0,75 | 0,706 |
| A Tempo | Simulation: Sieg bis Zug 10 (Anteil) | 0,06 | 0 | 0 | 0,767 | 0,71 |
| B Redundanz | Vollständige Combos im Deck | 5 | 1 | 0 | 0,892 | 0,695 |
| B Redundanz | Davon gewinnende | 1 | 0 | 0 | 0,759 | 0,68 |
| B Redundanz | Verschiedene Siegwege | 2 | 0 | 0 | 0,749 | 0,678 |
| B Redundanz | Tutoren | 6 | 1 | 0 | 0,977 | 0,912 |
| B Redundanz | Kartenziehen | 10 | 11 | 14 | 0,21 | 0,369 |
| C Interaktion | Freie Interaktion | 5 | 2 | 1 | 0,804 | 0,771 |
| C Interaktion | Konter | 5 | 1 | 0 | 0,853 | 0,718 |
| C Interaktion | Entfernung | 9 | 11 | 12 | 0,233 | 0,375 |
| C Interaktion | Bretträumung | 1 | 2 | 3 | 0,15 | 0,332 |
| C Interaktion | Rampe | 20 | 17 | 13 | 0,833 | 0,659 |
| C Interaktion | Interaktionsdichte | 0,21 | 0,16 | 0,15 | 0,722 | 0,68 |
| D Kontrolle | Game Changer | 13 | 1 | 0 | 0,986 | 0,933 |
| D Kontrolle | Farben in der Manabasis | 5 | 5 | 5 | 0,5 | 0,5 |

## Dieselben Kennzahlen entlang der Brackets

Hier steht, was die Auswertung vorher nicht konnte. Die fünf Spalten sind Mediane über Decks, deren
Bracket ihre Autoren selbst angegeben haben; die letzten beiden Spalten sind die Grenzen, um die es
in der Praxis geht - **4 gegen 3** und **5 gegen 4**.

| Kennzahl | B1 | B2 | B3 | B4 | B5 | Trennschärfe 4 vs. 3 | 5 vs. 4 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Fast Mana (erzeugt mehr als es kostet) | 1 | 1 | 1 | 2 | 8 | 0,6 | 0,986 |
| Durchschnittlicher Manawert | 3,08 | 3,09 | 3,06 | 2,91 | 2,06 | 0,39 | 0,08 |
| Anteil Karten für 0-1 Mana | 0,07 | 0,07 | 0,08 | 0,11 | 0,27 | 0,671 | 0,964 |
| Länder | 36 | 36 | 36 | 35 | 29 | 0,283 | 0,036 |
| Ungetappte Länder (%) | 89 | 86 | 91 | 94 | 100 | 0,655 | 0,907 |
| Mana in Zug 3 (bestenfalls) | 3 | 3 | 3 | 3,1 | 3,7 | 0,615 | 0,902 |
| Günstigste gewinnende Combo (Mana) | 11 | 9,5 | 9 | 9 | 4 | 0,431 | 0,22 |
| Frühestmöglicher Siegzug | – | 4 | 4 | 4 | 4 | 0,519 | 0,443 |
| Simulation: Median-Siegzug | 9 | 9 | 9 | 8 | 7 | 0,369 | 0,254 |
| Simulation: Sieg bis Zug 4 (Anteil) | 0 | 0 | 0 | 0 | 0,02 | 0,564 | 0,732 |
| Simulation: Sieg bis Zug 10 (Anteil) | 0 | 0 | 0 | 0 | 0,18 | 0,578 | 0,712 |
| Vollständige Combos im Deck | 0 | 0 | 1 | 4 | 6 | 0,619 | 0,672 |
| Davon gewinnende | 0 | 0 | 0 | 0 | 2 | 0,562 | 0,642 |
| Verschiedene Siegwege | 0 | 0 | 0 | 0 | 2 | 0,58 | 0,627 |
| Tutoren | 0 | 0 | 0 | 3 | 7 | 0,919 | 0,937 |
| Kartenziehen | 12 | 12 | 11 | 10 | 9 | 0,432 | 0,417 |
| Freie Interaktion | 1 | 1 | 1 | 3 | 6 | 0,656 | 0,802 |
| Konter | 1 | 1 | 1 | 2 | 8 | 0,547 | 0,762 |
| Entfernung | 11 | 11 | 11 | 10 | 8 | 0,444 | 0,36 |
| Bretträumung | 2 | 2 | 2 | 3 | 1 | 0,544 | 0,239 |
| Rampe | 15 | 15 | 15 | 16 | 22 | 0,536 | 0,754 |
| Interaktionsdichte | 0,13 | 0,14 | 0,15 | 0,16 | 0,22 | 0,55 | 0,705 |
| Game Changer | 0 | 0 | 1 | 7 | 16 | 0,981 | 0,953 |
| Farben in der Manabasis | 5 | 5 | 5 | 5 | 5 | 0,5 | 0,5 |

## Die acht stärksten Trennlinien: cEDH gegen Precon

Schwelle ist jeweils der Schnitt mit dem besten Verhältnis aus Treffern und Fehlalarmen
(Youden-Index) gegenüber den Precons.

| Kennzahl | Schwelle | erkennt cEDH | schlägt bei Precons fälschlich an |
| --- | --- | --- | --- |
| Anteil Karten für 0-1 Mana | ≥ 0,1 | 96 % | 4,3 % |
| Game Changer | ≥ 3 | 96 % | 0 % |
| Ungetappte Länder (%) | ≥ 93 | 92,4 % | 2,2 % |
| Tutoren | ≥ 2 | 93,2 % | 3,3 % |
| Mana in Zug 3 (bestenfalls) | ≥ 3,2 | 90 % | 0 % |
| Fast Mana (erzeugt mehr als es kostet) | ≥ 3 | 94 % | 3,3 % |
| Länder | ≤ 35 | 93,6 % | 0 % |
| Durchschnittlicher Manawert | ≤ 3,01 | 89,2 % | 4,3 % |

## Die acht stärksten Trennlinien: Bracket 4 gegen Bracket 3

Dieselbe Rechnung an der Grenze, die eine Bracket-Automatik tatsächlich ziehen muss.

| Kennzahl | Schwelle | erkennt Bracket 4 | schlägt bei Bracket 3 fälschlich an |
| --- | --- | --- | --- |
| Game Changer | ≥ 3 | 98 % | 10 % |
| Tutoren | ≥ 2 | 90 % | 21 % |
| Länder | ≤ 34 | 44 % | 9 % |
| Anteil Karten für 0-1 Mana | ≥ 0,1 | 62 % | 35 % |
| Freie Interaktion | ≥ 4 | 37 % | 12 % |
| Ungetappte Länder (%) | ≥ 94 | 52 % | 27 % |
| Simulation: Median-Siegzug | ≤ 7,5 | 33,3 % | 12,5 % |
| Vollständige Combos im Deck | ≥ 2 | 70 % | 48 % |

## Was daraus folgt

<!-- EINORDNUNG:START -->
### 1. cEDH ist an der Manabasis erkennbar, nicht an der Combo

Die stärksten Trennlinien sind alle Tempo-Kennzahlen, und keine davon hat mit dem Sieg zu tun:
Anteil billiger Karten, Game Changer, ungetappte Länder, Tutoren, Fast Mana. Ein cEDH-Deck spielt
**30 Länder statt 38**, davon **100 % ungetappt statt 78 %**, dazu **7 Fast-Mana-Karten statt 1**.
Das ist die eigentliche Antwort auf „was macht ein cEDH-Deck aus": nicht die Combo im Deck,
sondern die Fähigkeit, in Zug 2 bis 3 schon drei bis vier Mana zu haben.

Umgekehrt ist der Sieg selbst der **schwächste** Teil: „Günstigste gewinnende Combo" trennt kaum
(0,18 in der Gegenrichtung), und nur 58 % der cEDH-Decks haben überhaupt eine vollständige
Siegcombo aus unserer Combo-Tabelle. Der Grund ist die Datenlage, nicht das Deck — Combos über
drei Karten sind gar nicht erfasst, und ein Durchschnittsdeck enthält die Teile oft nur einzeln.

### 2. Die Grenze zwischen Bracket 3 und 4 ziehen zwei Kennzahlen, nicht sieben

Das ist der Teil, den die erste Auswertung offenlassen musste, weil ihr die gelabelten Decks
fehlten. Mit ihnen fällt die Antwort deutlich aus — und sie ist kürzer als erwartet:

| Kennzahl | B1 | B2 | B3 | B4 | B5 | Trennschärfe 4 vs. 3 |
| --- | --- | --- | --- | --- | --- | --- |
| Game Changer | 0 | 0 | 1 | **7** | 16 | **0,981** |
| Tutoren | 0 | 0 | 0 | **3** | 7 | **0,919** |
| Anteil Karten für 0-1 Mana | 0,07 | 0,07 | 0,08 | 0,11 | 0,27 | 0,671 |
| Freie Interaktion | 1 | 1 | 1 | 3 | 6 | 0,656 |
| Ungetappte Länder (%) | 89 | 86 | 91 | 94 | 100 | 0,655 |

**Bracket 1 bis 3 sind an den Kennzahlen praktisch nicht zu unterscheiden.** Manawert, Länderzahl,
Kartenziehen, Entfernung: über die ersten drei Stufen hinweg ändert sich fast nichts. Das ist kein
Messfehler, sondern die Bracket-Definition — 1 bis 3 unterscheiden sich vor allem in dem, was ein
Deck *nicht* tut (keine Game Changer, keine Zwei-Karten-Combo, kein Massen-Landentzug), und
Verzicht ist an einer Kartenliste schwerer zu messen als Zutaten.

Ab Bracket 4 springt es: **Game Changer von 1 auf 7, Tutoren von 0 auf 3.** Eine einzelne Schwelle
reicht hier schon weit — „mindestens 3 Game Changer" erkennt 98 % der Bracket-4-Decks und schlägt
bei 10 % der Bracket-3-Decks an. Für die Bracket-Automatik heißt das: Die Game-Changer-Zählung, die
sie ohnehin führt, ist nicht eine Kennzahl unter vielen, sondern **die** Kennzahl an dieser Grenze.

### 3. Sieben Signale zusammen ordnen die Brackets, einzeln tut es keines

Zählt man, **wie viele von sieben Signalen** zutreffen (Fast Mana ≥ 3, Tutoren ≥ 2, ungetappte
Länder ≥ 93 %, Game Changer ≥ 3, freie Interaktion ≥ 3, Konter ≥ 3, mindestens eine Siegcombo),
ergibt sich eine saubere Treppe:

| Mindestens … Signale | B1 | B2 | B3 | B4 | B5 | Precon | cEDH-Korpus |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | 5,1 % | 8 % | 24 % | **84 %** | 100 % | **0 %** | 94,8 % |
| 4 | 0 % | 1 % | 13 % | **62 %** | 100 % | 0 % | 93,6 % |
| 6 | 0 % | 0 % | 1 % | 21 % | 80,9 % | 0 % | 70,8 % |

Median: B1 **1**, B2 **1**, B3 **1**, B4 **4**, B5 **7** von 7. **Kein einziger der 92 Precons
erreicht drei Signale**, und von den Bracket-1- und Bracket-2-Decks unter 10 %.

Damit ist die Schwelle belegt statt geraten: **ab vier Signalen ist ein Deck nachweislich kein
Bracket-2-Deck** (1 % Fehlalarm), und ab vier Signalen liegt es mit 62 % zu 13 % eher in Bracket 4
als in Bracket 3. Die 13 % Bracket-3-Decks, die mitanschlagen, sind vermutlich keine Fehlalarme,
sondern vorsichtig eingestufte Decks — das Bracket ist eine Angabe am Deck, keine bestandene
Prüfung, und an dieser Grenze liegen die Stufen ohnehin dicht beieinander.

### 4. Die Simulation spielt jetzt nach den Regeln — und trennt trotzdem nicht besser als Abzählen

Die Simulation ist neu gebaut: farbige Kosten statt einer bloßen Manazahl, Hybrid, Phyrexia und
{X}, Kartenziehen, Einsatzverzögerung bei Manakreaturen, Mehrspieler-Ziehschritt im ersten Zug.
Jede Regel steht mit ihrer Nummer im Kopfkommentar von `goldfish-sim.ts`, der Wortlaut in
`docs/mtg-regeln.md`. Das Ergebnis ist zweigeteilt, und beide Hälften gehören in die Antwort:

**Was besser wurde.** Entlang der Bracket-Labels ordnet die Simulation jetzt streng monoton — über
die Decks, die überhaupt eine Siegcombo haben, steigt der Anteil gewonnener Spiele von
0,7 % (B1) über 1,3 %, 3,1 %, 6,6 % auf **35,5 % (B5)**, der Median-Siegzug fällt von Zug 9 auf
Zug 7. Eine Kennzahl, die die fünf Stufen in der richtigen Reihenfolge sortiert, hatte die
Auswertung vorher nicht.

**Was nicht besser wurde.** Die Trennschärfe je Deck stieg nur von 0,760 auf **0,767** gegenüber
den Precons und von 0,697 auf 0,710 gegenüber dem Durchschnittsbau — sie liegt damit weiter
deutlich unter dem simplen Abzählen (0,97–0,99). Der Regelumbau hat die Simulation *richtig*
gemacht, nicht *trennschärfer*.

**Warum, ist jetzt gemessen statt vermutet.** Der Engpass ist nicht das Manamodell, sondern die
Combo-Tabelle: Eine vollständige gewinnende Combo haben nur 14 % der Bracket-1-, 18 % der
Bracket-2-, 27 % der Bracket-3-, 41 % der Bracket-4- und 62 % der Bracket-5-Decks. Alle übrigen
bekommen von der Simulation eine Null — nicht weil sie langsam wären, sondern weil ihr Siegweg
(drei Karten, Kampfschaden, ein Sturm-Zug) in der Tabelle nicht steht. Eine Simulation kann nicht
trennen, was sie nicht sieht.

**Konsequenz, unverändert:** Die Simulation gehört **nicht** als Einzelwert in die
Bracket-Rechnung. Sie taugt als eigene Anzeige („dieses Deck gewinnt im Median in Zug X") und wird
als Kennzahl erst interessant, wenn die Combo-Tabelle mehr Siegwege kennt — nicht, wenn die
Simulation noch mehr Regeln lernt. Das ist die klarste Auskunft dieses Laufs: Der nächste Schritt
liegt bei den Daten, nicht beim Modell.

### 5. Was diese Auswertung nicht beantwortet

- **Bracket 1 gegen 2 gegen 3.** Die drei sind an Kartenlisten fast identisch (siehe Punkt 2). Wer
  sie trennen will, braucht Kriterien über Verzicht, nicht über Zutaten.
- **Streuung innerhalb eines Brackets.** Alle Bracket-Zeilen sind Durchschnittsdecks; wie weit ein
  einzelnes Bracket-4-Deck vom Mittel abweicht, steht hier nicht. Dafür bräuchte es Einzellisten
  von Moxfield oder Archidekt, die aus dieser Umgebung nicht erreichbar sind (siehe „Grenzen").
  Die Trennschärfen zwischen benachbarten Brackets sind dadurch systematisch zu optimistisch.
<!-- EINORDNUNG:ENDE -->

## Grenzen dieser Auswertung

- **Durchschnittsdecks, keine Einzellisten - auch bei den Bracket-Decks.** EDHRECs Durchschnittsdeck
  glättet Ausreißer. Einzellisten hätten von Moxfield oder Archidekt kommen sollen; beide Seiten
  sind aus der Umgebung, in der dieser Lauf entstand, nicht erreichbar (die Egress-Policy
  beantwortet den CONNECT mit HTTP 403). Der Bracket-Korpus ist deshalb ein Kompromiss: das
  Fremdlabel bleibt, die Streuung innerhalb eines Brackets fehlt. Wer den Lauf in einer Umgebung
  ohne diese Sperre wiederholt, sollte Einzellisten ziehen — die Trennschärfen zwischen
  benachbarten Brackets sind an Mittelwerten systematisch zu hoch.
- **Ein Durchschnitt je Commander und Bracket, nicht je Deck.** 100 Commander × 5 Brackets ergibt
  höchstens 500 Zeilen; dieselben Commander tauchen in mehreren Brackets auf. Die Bracket-Spalten
  vergleichen also dieselben Commander unterschiedlich gebaut - das ist gewollt, macht die Gruppen
  aber nicht unabhängig.
- **Combos nur bis drei Karten.** Alles darüber ist in einem 100-Karten-Deck praktisch nie
  vollständig, treibt aber die Datenmenge ins Unermessliche (siehe `ladeCombos()`).
- **Die Simulation kennt nur Combo-Siege.** Ein Deck, das über Kreaturenschaden gewinnt, gewinnt
  dort nie. Alle weiteren Grenzen stehen im Kopfkommentar von `goldfish-sim.ts`, jeweils mit der
  Richtung, in die sie das Ergebnis verschieben.
- **Freie Interaktion erkennt nur den Wortlaut "without paying its mana cost"** plus Konter für
  ein Mana. Force of Will ("rather than pay") fällt durchs Raster; das ist in
  `deck-metrics.spec.ts` als bekannte Lücke festgehalten.
