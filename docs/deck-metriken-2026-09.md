# Was macht ein cEDH-Deck aus? Gemessen an 250 Decks

> Erhoben am 2026-09-14 mit `node scripts/analyze-deck-corpus.js`.
> Die Messwerte je Deck stehen in `deck-metriken-2026-09.csv` daneben, damit jede Zahl hier
> nachrechenbar ist.

## Was gemessen wurde

| Korpus | Decks | Was es ist |
| --- | --- | --- |
| cEDH | 250 | EDHRECs Durchschnittsdeck je cEDH-Commander |
| Nicht-cEDH | 285 | **Dieselben Commander**, ohne cEDH-Filter |
| Precon | 92 | Commander-Precons ab 2023 (MTGJSON) |

Der mittlere Korpus ist der wichtigste: Weil dort dieselben Commander stehen, misst der
Unterschied zur ersten Spalte die **Bauweise** und nicht den Commander. Ein Kinnan-Deck bleibt ein
Kinnan-Deck; was es zum cEDH-Deck macht, steht in den Zahlen dazwischen.

Alle Kennzahlen kommen aus `src/app/deck-metrics.ts`, die Simulationswerte aus
`src/app/goldfish-sim.ts` (2000 Spiele je Deck).
**Die Annahmen der Simulation stehen im Kopfkommentar jener Datei** und gehören zu jeder Zahl
dazu, die hier mit "Simulation" beginnt.

## Alle Kennzahlen

Trennschärfe: Wie oft liegt ein zufälliges cEDH-Deck über einem zufälligen Deck der
Vergleichsgruppe? **0,5 heißt "die Metrik weiß nichts"**; 1,0 und 0,0 trennen beide vollständig,
nur in entgegengesetzte Richtung - bei Ländern und Manawert liegen cEDH-Decks eben DARUNTER. Je
weiter ein Wert von 0,5 entfernt ist, desto mehr sagt die Kennzahl aus.

| Gruppe | Kennzahl | Median cEDH | Median Nicht-cEDH | Median Precon | Trennschärfe vs. Precon | vs. Nicht-cEDH |
| --- | --- | --- | --- | --- | --- | --- |
| A Tempo | Fast Mana (erzeugt mehr als es kostet) | 7 | 2 | 1 | 0,973 | 0,93 |
| A Tempo | Durchschnittlicher Manawert | 2,24 | 3,05 | 3,51 | 0,053 | 0,154 |
| A Tempo | Anteil Karten für 0-1 Mana | 0,24 | 0,09 | 0,04 | 0,99 | 0,91 |
| A Tempo | Länder | 30 | 35 | 38 | 0,034 | 0,099 |
| A Tempo | Ungetappte Länder (%) | 100 | 92 | 78 | 0,981 | 0,857 |
| A Tempo | Mana in Zug 3 (bestenfalls) | 3,6 | 3,1 | 2,9 | 0,977 | 0,87 |
| A Tempo | Günstigste gewinnende Combo (Mana) | 6 | 8 | 9 | 0,183 | 0,291 |
| A Tempo | Frühestmöglicher Siegzug | 6 | 6 | – | – | 0,505 |
| A Tempo | Simulation: Median-Siegzug | 7 | 8 | 9 | 0,187 | 0,34 |
| A Tempo | Simulation: Sieg bis Zug 4 (Anteil) | 0 | 0 | 0 | 0,748 | 0,697 |
| A Tempo | Simulation: Sieg bis Zug 10 (Anteil) | 0,03 | 0 | 0 | 0,751 | 0,692 |
| B Redundanz | Vollständige Combos im Deck | 5 | 1 | 0 | 0,892 | 0,695 |
| B Redundanz | Davon gewinnende | 1 | 0 | 0 | 0,759 | 0,679 |
| B Redundanz | Verschiedene Siegwege | 2 | 0 | 0 | 0,749 | 0,678 |
| B Redundanz | Tutoren | 6 | 1 | 0 | 0,977 | 0,912 |
| B Redundanz | Kartenziehen | 9,5 | 11 | 14 | 0,208 | 0,367 |
| C Interaktion | Freie Interaktion | 5 | 2 | 1 | 0,804 | 0,77 |
| C Interaktion | Konter | 5 | 1 | 0 | 0,853 | 0,718 |
| C Interaktion | Entfernung | 9 | 11 | 12 | 0,234 | 0,376 |
| C Interaktion | Bretträumung | 1 | 2 | 3 | 0,151 | 0,33 |
| C Interaktion | Rampe | 20 | 17 | 13 | 0,831 | 0,659 |
| C Interaktion | Interaktionsdichte | 0,21 | 0,16 | 0,15 | 0,722 | 0,681 |
| D Kontrolle | Game Changer | 13 | 1 | 0 | 0,986 | 0,933 |
| D Kontrolle | Farben in der Manabasis | 5 | 5 | 5 | 0,5 | 0,5 |

## Die acht stärksten Trennlinien

Schwelle ist jeweils der Schnitt mit dem besten Verhältnis aus Treffern und Fehlalarmen
(Youden-Index) gegenüber den Precons.

| Kennzahl | Schwelle | erkennt cEDH | schlägt bei Precons fälschlich an |
| --- | --- | --- | --- |
| Anteil Karten für 0-1 Mana | ≥ 0,1 | 96 % | 4,3 % |
| Game Changer | ≥ 3 | 96 % | 0 % |
| Ungetappte Länder (%) | ≥ 93 | 92,4 % | 2,2 % |
| Tutoren | ≥ 2 | 93,2 % | 3,3 % |
| Mana in Zug 3 (bestenfalls) | ≥ 3,2 | 90 % | 0 % |
| Fast Mana (erzeugt mehr als es kostet) | ≥ 4 | 90,8 % | 0 % |
| Länder | ≤ 35 | 93,6 % | 0 % |
| Durchschnittlicher Manawert | ≤ 3 | 89,2 % | 4,3 % |

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

### 2. Ein einzelner Wert reicht nicht, sieben zusammen schon

Jede Einzelregel schlägt bei 10–42 % der normalen Decks derselben Commander ebenfalls an. Zählt
man dagegen, **wie viele von sieben Signalen** zutreffen (Fast Mana ≥ 4, Tutoren ≥ 2, ungetappte
Länder ≥ 93 %, Game Changer ≥ 3, freie Interaktion ≥ 3, Konter ≥ 3, mindestens eine Siegcombo),
wird die Trennung sauber:

| Mindestens … Signale | cEDH | Nicht-cEDH (gleiche Commander) | Precon |
| --- | --- | --- | --- |
| 3 | 94,4 % | 31,2 % | **0 %** |
| 4 | 92,8 % | 16,8 % | **0 %** |
| 6 | 69,6 % | 6,3 % | 0 % |

Median: cEDH **6 von 7** Signalen, normale Decks 2, Precons 0. **Kein einziger der 92 Precons
erreicht drei Signale.**

Für die Bracket-Automatik heißt das: **ab vier Signalen ist ein Deck nachweislich kein
Bracket-2-Deck**, und der Vorschlag „das sieht nach cEDH aus" ist ab dieser Schwelle belegt statt
geraten. Die knapp 17 %, die in der Vergleichsgruppe mit anschlagen, sind vermutlich keine Fehlalarme,
sondern echte Bracket-4-Decks — es ist der Durchschnittsbau derselben, ohnehin starken Commander,
nicht eine Gruppe schwacher Decks.

### 3. Die Simulation ist jetzt regelfest — und trennt trotzdem schlechter als die Zählerei

Die erste Fassung der Simulation hatte drei Spielregeln falsch (erster Zug ohne Ziehen, Mulligan
ohne den im Mehrspieler freien ersten, Manakreaturen ohne Einsatzverzögerung) und kannte weder
Manafarben noch Kartenziehen. Alle fünf Punkte sind behoben und an den Comprehensive Rules belegt,
nachzulesen im Kopfkommentar von `goldfish-sim.ts`.

Was das gebracht hat: Die **Reihenfolge stimmt jetzt** — der Median-Siegzug liegt bei cEDH auf
Zug 7, bei denselben Commandern ohne cEDH-Bau auf 8, bei Precons auf 9. Vorher lagen alle drei
zwischen 8 und 9, die Simulation konnte die Gruppen also gar nicht auseinanderhalten. Gewinnen
können überhaupt: 137 der 250 cEDH-Decks, 59 der 285 Vergleichsdecks, 8 der 92 Precons.

Was es **nicht** gebracht hat: Die Trennschärfe bleibt bei **0,75** und damit deutlich unter dem,
was simples Abzählen leistet (0,97–0,99 bei Fast Mana, Tutoren, ungetappten Ländern). Ein
Zwischenstand an drei Decks hatte 0,99 gezeigt — das war Rauschen einer zu kleinen Stichprobe und
ist am vollen Korpus widerlegt.

Der Grund liegt weiterhin am Material, nicht mehr am Modell: In einer Singleton-Durchschnittsliste
müssen beide Combo-Teile gezogen werden, und die Simulation kennt nach wie vor kein ausgelöstes
oder bedingtes Ziehen (Rhystic Study, Kaskade) und keine Alternativkosten.

**Konsequenz unverändert:** Die Simulation gehört **nicht** in die Bracket-Rechnung. Sie taugt als
eigene Anzeige („dieses Deck gewinnt im Median in Zug 7") und wird erst dann ein Kriterium, wenn
sie an echten Einzellisten statt an Durchschnittsdecks gemessen wird.

### 4. Was diese Auswertung nicht beantwortet

Sie trennt cEDH von Precon und teilweise vom Durchschnittsbau — **nicht Bracket 3 von Bracket 4.**
Dafür fehlen gelabelte Decks. EDHREC führt zu jedem Deck eine eigene Bracket-Angabe
(`/pages/decks/<slug>.json`, Feld `bracket`), liefert dort aber keine Kartenlisten, und ohne Liste
ist keine Kennzahl rechenbar. Das ist der nächste Schritt, wenn die 3/4-Grenze geschärft werden
soll.
<!-- EINORDNUNG:ENDE -->

## Grenzen dieser Auswertung

- **Durchschnittsdecks, keine Einzellisten.** EDHRECs Durchschnittsdeck je Commander glättet
  Ausreißer. Ein einzelnes, extrem gebautes Deck sieht anders aus als der Durchschnitt seiner
  Bauart.
- **Combos nur bis drei Karten.** Alles darüber ist in einem 100-Karten-Deck praktisch nie
  vollständig, treibt aber die Datenmenge ins Unermessliche (siehe `ladeCombos()`).
- **Die Simulation kennt kein ausgelöstes oder bedingtes Kartenziehen** (Rhystic Study, Kaskade)
  und keine Alternativkosten (Force of Will). Farbiges Mana, einfaches Ziehen, Einsatzverzögerung
  und der Mulligan folgen seit der Überarbeitung den Comprehensive Rules; alles Übrige ist im
  Kopfkommentar von `goldfish-sim.ts` als Vereinfachung aufgezählt. Sie unterschätzt Decks
  dadurch — die Zahlen sind eine Untergrenze.
- **Freie Interaktion erkennt nur den Wortlaut "without paying its mana cost"** plus Konter für
  ein Mana. Force of Will ("rather than pay") fällt durchs Raster; das ist in
  `deck-metrics.spec.ts` als bekannte Lücke festgehalten.
