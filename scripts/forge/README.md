# Bracket-Simulation mit Forge

Ziel: Ein Deck spielt in 4er-Pods gegen je drei Test-Decks einer Stufe – 100 Partien gegen Bracket 1,
100 gegen Bracket 2 … bis 5 – mit Bots, die Bedrohungen bewerten, entfernen und auf Sieg spielen.
Aus den fünf Winrates ergibt sich die Stufe.

## Warum Forge und kein eigener Simulator

Die Anforderung „jede Commander-legale Karte, ohne Ausnahme“ heißt über 32.000 Karten mit eigenem
Regeltext. [Forge](https://github.com/Card-Forge/forge) (Open Source, Java, GPL-3) hat genau das seit
über 15 Jahren gebaut: Kartenskripte, vollständiges Regelwerk, Bots mit Bedrohungsbewertung und einen
Kommandozeilen-Modus, der Bot gegen Bot spielt. Ein Nachbau in TypeScript wäre ein Mehrjahresprojekt
und trotzdem lückenhafter. Forge läuft **nur als externes Programm** in einer GitHub Action – kein
Forge-Code landet in der App.

Der bisherige Goldfish-Simulator (`src/app/goldfish-sim.ts`) bleibt davon unberührt.

## Befunde des Durchstichs (28.09.2026, Forge `2ccbbb0`)

**Kartenabdeckung** (`card-coverage.js`, gegen den Scryfall-Export vom 27.09.2026):

|                                                            | Karten |  Anteil |
| ---------------------------------------------------------- | -----: | ------: |
| Commander-legal                                            | 32.116 |   100 % |
| Forge kennt sie nicht                                      |    131 |  0,41 % |
| Forge kennt sie, markiert sie aber mit `AI:RemoveDeck:All` |  2.456 |  7,65 % |
| voll spielbar                                              | 29.529 | 91,94 % |

`AI:RemoveDeck:All` heißt **nicht** „funktioniert nicht“: Die Regeln der Karte sind umgesetzt, Forge
sagt nur, dass der Bot sie schlecht einsetzt, und nimmt sie deshalb aus zufällig gebauten Bot-Decks.
Darunter stehen erstaunlich gewöhnliche Karten (Beast Within, Toxic Deluge, die Signets, die
Filter-Länder). Ob der Bot sie wirklich falsch spielt, zeigt erst ein Blick in echte Spielprotokolle.

**Laufzeit:** eine 4er-Commander-Partie mit einfachen Decks 40–85 Sekunden auf 4 Kernen, rund 2 GB
Arbeitsspeicher. 500 Partien je Deck (100 je Stufe) sind damit mehrere Rechenstunden – verteilt auf
fünf parallele Runner (einer je Stufe) gut unter dem 6-Stunden-Limit einer GitHub Action.

**Ausgabe:** Forge schreibt am Ende jeder Partie maschinenlesbare Zeilen:

```
Game Outcome: Turn 38
Game Outcome: Ai(1)-Tahngarth, Talruum Hero has lost because life total reached 0
Game Outcome: Ai(2)-Ertai, Wizard Adept has won because all opponents have lost
Game Result: Game 1 ended in 42840 ms. Ai(2)-Ertai, Wizard Adept has won!
```

„Turn 38“ zählt die Züge **aller** Spieler; die Runde ist `ceil(38 / 4)`. Der Verlustgrund
(Lebenspunkte, Commander-Schaden, Gift, leere Bibliothek, …) steht je Spieler dabei.

## Selbst ausführen

```bash
scripts/forge/forge-setup.sh .forge          # Forge in gepinnter Fassung holen und bauen (Java 21, Maven)
cd .forge/forge/forge-gui                    # Forge sucht "res/" im Arbeitsverzeichnis
java -Xmx3g -Djava.awt.headless=true \
  -jar ../forge-gui-desktop/target/forge-gui-desktop-*-jar-with-dependencies.jar \
  sim -D /pfad/zu/decks -d a.dck b.dck c.dck d.dck -f Commander -n 10 -c 600 -q
```

- `-D` Ordner der Decks, `-d` die Dateinamen (**ohne** Ordner – ein voller Pfad in `-d` wird nicht gefunden)
- `-f Commander` Format, `-n` Anzahl Partien, `-c` Zeitlimit je Partie in Sekunden (danach Remis)
- `-q` nur Ergebnisse statt des vollen Spielprotokolls, `-a` AI-Profil je Spieler, `-s` Zufallsseed

Deckformat (`.dck`):

```
[metadata]
Name=Mein Deck
[Commander]
1 Atraxa, Praetors' Voice
[Main]
1 Sol Ring
36 Forest
```

Kartenabdeckung neu berechnen (kein Build nötig, nur die Kartenskripte):

```bash
node scripts/forge/card-coverage.js .forge/forge/forge-gui/res oracle-cards.jsonl.gz bericht.md
```

Oder in GitHub: „Actions“ → „Forge card coverage“ → „Run workflow“; der Bericht hängt als Artefakt am Lauf.

## Nächste Schritte

1. ~~Durchstich + Abdeckung~~ (dieser Stand)
2. Test-Decks je Bracket, von Hand kuratiert, Kalibrierungsturnier
3. Runner (`run-pod.js`), Deck-Umwandlung, Siegplan-Analyse, Tabellen, Workflow
4. Anbindung in der App
