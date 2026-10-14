-- Commander, die zugleich im Maybeboard stehen, zurück ins Deck holen (14.10.2026).
--
-- Gefunden an Maiks Deck "420": Smaug the Impenetrable war is_commander UND is_maybeboard. Jede
-- Analyse lässt das Maybeboard weg - der Commander fehlte also in der Combo-Liste ("Keine
-- gefunden"), in der Kartenzahl ("99 Karten - Commander verlangt genau 100") und in der
-- Bannlisten-Prüfung. Nur winning_combos_in_deck bekommt die Commander getrennt übergeben und
-- fand die Combos trotzdem; daher B4 ohne sichtbare Combo.
--
-- Entstanden im Bearbeiten-Modus (Karte im Maybeboard als Commander markiert) oder beim Import
-- (Commander-Zeile im Sideboard-Abschnitt). Beides verhindert die App seit diesem Datum; dieses
-- Skript repariert die schon gespeicherten Fälle. Stand 14.10.2026 unter den öffentlichen Decks:
-- "420", "Draw", "Wie viel Deck haben wir noch?".
--
-- Gefahrlos mehrfach ausführbar.

update public.deck_cards
set is_maybeboard = false
where is_commander
  and is_maybeboard;
