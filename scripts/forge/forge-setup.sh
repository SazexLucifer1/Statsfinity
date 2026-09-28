#!/usr/bin/env bash
# Holt Forge (Open-Source-Regel-Engine für Magic, https://github.com/Card-Forge/forge) in einer fest
# gepinnten Fassung und baut die Desktop-Variante, deren Kommandozeilen-Modus "sim" Bot-gegen-Bot-
# Partien spielt. Begründung und Befunde: scripts/forge/README.md
#
#   scripts/forge/forge-setup.sh [zielordner]      (Standard: ./.forge)
#
# Danach liegen dort:
#   <ziel>/forge/forge-gui/res                                     Kartenskripte, Editionen, ...
#   <ziel>/forge/forge-gui-desktop/target/*-jar-with-dependencies.jar
#
# GEPINNT statt "neueste": Forge ändert täglich Karten und Bot-Logik. Zwei Simulationsläufe sind nur
# vergleichbar, wenn sie mit derselben Forge-Fassung gespielt wurden - deshalb wird die Fassung
# später auch mit jedem Ergebnis gespeichert. Wer sie hebt, rechnet die Test-Decks neu durch.
set -euo pipefail

FORGE_COMMIT="${FORGE_COMMIT:-2ccbbb01326e28b38788c50f7f0e01b5d12f32b3}"
ZIEL="${1:-.forge}"
REPO="$ZIEL/forge"

mkdir -p "$ZIEL"
if [ ! -d "$REPO/.git" ]; then
  git init -q "$REPO"
  git -C "$REPO" remote add origin https://github.com/Card-Forge/forge
fi
if [ "$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)" != "$FORGE_COMMIT" ]; then
  # Nur dieser eine Commit, ohne Historie: das Repo ist mit Historie mehrere GB groß.
  GIT_LFS_SKIP_SMUDGE=1 git -C "$REPO" fetch -q --depth 1 origin "$FORGE_COMMIT"
  GIT_LFS_SKIP_SMUDGE=1 git -C "$REPO" checkout -q FETCH_HEAD
fi

# Combo-Pilot (scripts/forge/pilot): Einhängepunkte in AiController als Patch, der Pilot selbst als Datei.
# Immer vom sauberen Stand aus anwenden, dann ist der Schritt beliebig oft wiederholbar. Hat sich am Piloten
# etwas geändert (anderer Stempel), wird neu gebaut - sonst spielte ein alter Bot weiter.
PILOT="$(cd "$(dirname "$0")" && pwd)/pilot"
git -C "$REPO" checkout -q -- forge-ai/src/main/java/forge/ai/AiController.java
git -C "$REPO" apply "$PILOT/forge.patch"
cp "$PILOT/ComboPilot.java" "$REPO/forge-ai/src/main/java/forge/ai/ComboPilot.java"
STEMPEL=$(cat "$PILOT/forge.patch" "$PILOT/ComboPilot.java" | sha256sum | cut -c1-16)
if [ "$(cat "$REPO/.pilot-stempel" 2>/dev/null || true)" != "$STEMPEL" ]; then
  rm -f "$REPO"/forge-gui-desktop/target/forge-gui-desktop-*-jar-with-dependencies.jar
fi

JAR=$(ls "$REPO"/forge-gui-desktop/target/forge-gui-desktop-*-jar-with-dependencies.jar 2>/dev/null | head -1 || true)
if [ -z "$JAR" ]; then
  # Nur das Desktop-Modul samt seiner Abhängigkeiten - Android, iOS und Adventure-Editor bleiben
  # draußen. Dauert beim ersten Mal einige Minuten (Maven lädt Abhängigkeiten).
  (cd "$REPO" && mvn -q -B -pl forge-gui-desktop -am package -DskipTests -Dcheckstyle.skip)
  JAR=$(ls "$REPO"/forge-gui-desktop/target/forge-gui-desktop-*-jar-with-dependencies.jar | head -1)
  echo "$STEMPEL" > "$REPO/.pilot-stempel"
fi

echo "Forge $FORGE_COMMIT mit Combo-Pilot $STEMPEL bereit: $JAR"
