/** Übersetzungen: tutorial. Beide Sprachen bewusst nebeneinander - wer eine ändert, sieht die andere. */
export const tutorial = {
  de: {
    // --- Bedienung der Tour ---
    'tutorial.skip': 'Schließen',
    'tutorial.back': '← Zurück',
    'tutorial.next': 'Weiter →',
    'tutorial.finish': 'Fertig',

    // --- Match-Tab ---
    'tutorial.match.intro.title': 'Match-Tab',
    'tutorial.match.intro.text':
      'Hier startest du neue Partien und siehst weiter unten den Match-Verlauf deiner Gruppe. Diese Tour zeigt dir den Bildschirm der Reihe nach - mit „Schließen“ brichst du jederzeit ab.',
    'tutorial.match.header.title': 'Die Knöpfe oben',
    'tutorial.match.header.text':
      'Das Fragezeichen erklärt dir immer den Bildschirm, auf dem du gerade bist. Daneben: Fehler oder Wünsche melden, Sprache zwischen Deutsch und Englisch umschalten, An- und Abmelden.',
    'tutorial.match.navBar.title': 'Die Bereiche der App',
    'tutorial.match.navBar.text':
      'Unten wechselst du zwischen Match, Suche, Statistik, Gruppe und Profil. Läuft eine Partie oder ein Turnier, erscheint dort zusätzlich ein eigener Knopf, der dich zurückbringt. Die Zahl am Profil-Symbol zeigt ungelesene Deck-Kommentare.',
    'tutorial.match.mode.title': 'Spielmodus & Format',
    'tutorial.match.mode.text':
      'Wähle zuerst die Kategorie (Normal, Two-Headed Giant, Archenemy, Cube, Draft oder Spezialevent), darunter das gespielte Format (z.B. Commander oder Modern). Je nach Kategorie erscheinen weiter unten passende Zusatz-Optionen.',
    'tutorial.match.friends.title': 'Gruppe oder Freunde',
    'tutorial.match.friends.text':
      'Mit „Freunde“ spielst du eine Partie ohne Gruppe - mit deinen Freunden aus dem Profil (und Gästen ohne Account). Solche Partien zählen in deinem Profil und in der Freunde-Rangliste, nie in der Gruppenstatistik.',
    'tutorial.match.ranked.title': 'Ranked oder Frei',
    'tutorial.match.ranked.text':
      'Nutzt deine Gruppe das Rangsystem, legst du hier fest, ob die Partie für die Ränge (LP) zählt. Freie Partien landen trotzdem in der Statistik. Nachträglich umstellen lässt sich das im Match-Verlauf.',
    'tutorial.match.series.title': 'Einzelspiel oder Best of 3',
    'tutorial.match.series.text':
      'Bei Best of 3 startet nach jedem gespeicherten Spiel automatisch das nächste mit denselben Spielern, bis jemand zwei Siege hat.',
    'tutorial.match.tournament.title': 'Turniere',
    'tutorial.match.tournament.text':
      'Hier erstellst du ein Turnier für deine Gruppe oder öffnest das laufende - mit Paarungen, Zeitlimit und Tabelle.',
    'tutorial.match.players.title': 'Mitspieler auswählen',
    'tutorial.match.players.text':
      'Tippe die Namen aller Mitspieler an. Neue Spieler legst du im Gruppen-Tab an. Ohne Anmeldung trägst du die Namen hier einfach selbst ein - gespeichert wird die Partie dann aber nicht. Spielen andere aus der Gruppe gerade, kannst du ihrer laufenden Partie beitreten.',
    'tutorial.match.commanders.title': 'Commander & Decks',
    'tutorial.match.commanders.text':
      'Sobald Spieler ausgewählt sind, bekommt jeder sein Deck: aus den eigenen Decks, von jemand anderem geliehen oder per Commander-Suche, wenn es kein Deck in der App gibt.',
    'tutorial.match.extras.title': 'Zusatz-Optionen je Modus',
    'tutorial.match.extras.text':
      'Two-Headed Giant: Spieler zu Teams zuordnen. Archenemy: genau einen Archenemy markieren. Cube: einen bestehenden Cube wählen oder neu anlegen. Draft: ein Set suchen und auswählen.',
    'tutorial.match.start.title': 'Spiel starten',
    'tutorial.match.start.text':
      'Sobald alles ausgefüllt ist, öffnet dieser Knopf den Live-Tracker für die Partie. Auch dort gibt es eine Erklärung - im Menü hinter ⋮ in der Mitte.',
    'tutorial.match.backfill.title': 'Partie nachtragen',
    'tutorial.match.backfill.text':
      'Für Partien, die ohne Handy am Tisch gespielt wurden: gleiche Auswahl wie oben, dann nur noch Sieger und Datum eintragen - ganz ohne Tracker.',
    'tutorial.match.history.title': 'Match-Verlauf',
    'tutorial.match.history.text':
      'Die vergangenen Partien der Gruppe mit Siegern, Decks und - bei Ranked-Partien - den gewonnenen oder verlorenen LP. Live getrackte Partien zeigen dazu Dauer, Startspieler (▶) und die Lebenspunkte-Kurve. Mit den entsprechenden Rechten korrigierst du hier den Sieger, stellst Ranked/Frei um oder löschst ein Match.',

    // --- Suche-Tab ---
    'tutorial.search.intro.title': 'Suche',
    'tutorial.search.intro.text':
      'Hier stöberst du ohne Gruppe und auch ohne Anmeldung: in allen Magic-Karten, in offiziellen Precons und in den öffentlichen Decks aller Spieler.',
    'tutorial.search.subtabs.title': 'Karten, Precons, Decks',
    'tutorial.search.subtabs.text': 'Mit diesen drei Reitern wechselst du, wonach du suchst.',
    'tutorial.search.cards.title': 'Karten',
    'tutorial.search.cards.text':
      'Suche nach Namen und grenze mit Typ, Kreaturtyp, Manawert, Farbe, Effekt (z.B. Kartenziehen) oder Fähigkeit ein. Ein Tipp auf eine Karte öffnet die große Vorschau.',
    'tutorial.search.precons.title': 'Precons',
    'tutorial.search.precons.text':
      'Alle offiziellen Commander-Precons, nach Name und Jahr filterbar - mit kompletter Kartenliste.',
    'tutorial.search.decks.title': 'Öffentliche Decks',
    'tutorial.search.decks.text':
      'Die Decks aller Spieler, die nicht privat gestellt sind. Filtere nach Name, Farbidentität, Archetyp und Kreaturtyp und sortiere nach Neuheit oder Winrate.',
    'tutorial.search.deckTile.title': 'Eine Deck-Kachel',
    'tutorial.search.deckTile.text':
      'Jede Kachel zeigt Aufrufe, Likes und die Bilanz des Decks. Ein Tipp auf das Commander-Bild öffnet den Steckbrief, „Deck ansehen“ darin die komplette Liste samt Primer und Kommentaren. Über „von …“ gelangst du zum Profil des Besitzers. Ein roter Rahmen warnt vor Karten, die im Format gebannt sind.',

    // --- Statistik-Tab ---
    'tutorial.stats.intro.title': 'Statistik-Tab',
    'tutorial.stats.intro.text':
      'Ranglisten und Auswertungen für deine Gruppe. Bist du in mehreren Gruppen, wählst du oben, welche du ansiehst. „Global“ zeigt alle Gruppen, „Freunde“ vergleicht dich mit deinen Freunden über alle Gruppen hinweg.',
    'tutorial.stats.filters.title': 'Zeitraum, Format & Modus',
    'tutorial.stats.filters.text':
      'Wähle ein Jahr (oder alle Zeiten), das Format und die Spielmodi, die in die Auswertung einfließen. Modi, die dir gesperrt wurden, sind markiert.',
    'tutorial.stats.playerDetails.title': 'Spieler-Details',
    'tutorial.stats.playerDetails.text':
      'Wähle einen Spieler, um seine persönlichen Werte zu sehen: Siege nach Modus und Format, gespielte Decks und Commander.',
    'tutorial.stats.overview.title': 'Übersicht',
    'tutorial.stats.overview.text':
      'Gesamtzahlen für den gewählten Zeitraum: Spiele, aktive Spieler und unterschiedliche Commander.',
    'tutorial.stats.ranking.title': 'Rangliste',
    'tutorial.stats.ranking.text':
      'Die Spieler-Rangliste, sortierbar nach Winrate, Siegen oder Spielen. Wer noch nicht genug Spiele hat, steht weiter unten bei „Spiele bis zur Qualifikation“.',
    'tutorial.stats.elo.title': 'Elo-Wertung',
    'tutorial.stats.elo.text':
      'Die Ränge der Gruppe von Holz bis Infinity, je Format getrennt. Es zählen nur Ranked-Partien: Der Sieger gewinnt LP gegen jeden Gegner, alle anderen verlieren gegen den Sieger. Das i neben der Überschrift erklärt die Rechnung.',
    'tutorial.stats.insights.title': 'Spiel-Analysen',
    'tutorial.stats.insights.text':
      'Winrate je Startplatz, Spieldauer und Deck gegen Deck. Mit gewähltem Spieler zusätzlich Form, Winrate je Monat, Angst- und Lieblingsgegner sowie der Jahresrückblick als Bild zum Teilen.',
    'tutorial.stats.h2h.title': 'Head-to-Head',
    'tutorial.stats.h2h.text':
      'Aufklappen, zwei Spieler wählen und sehen, wer in gemeinsamen Partien wie oft gewonnen hat - und mit welchen Commandern.',
    'tutorial.stats.decksCommanders.title': 'Decks & Commander',
    'tutorial.stats.decksCommanders.text':
      'Die erfolgreichsten Decks und Commander. Eigene Decks bleiben einzeln, Precons und nicht verlinkte Commander werden je Commander-Name zusammengefasst.',
    'tutorial.stats.colors.title': 'Farben',
    'tutorial.stats.colors.text':
      'Ganz unten: welche Farben und Farbkombinationen in deiner Gruppe am häufigsten gespielt werden und wie erfolgreich sie sind.',
    'tutorial.stats.admin.title': 'Für Gruppenleiter',
    'tutorial.stats.admin.text':
      'Als Leiter der Gruppe kannst du ganz unten in der Danger Zone die komplette Statistik der Gruppe zurücksetzen.',

    // --- Statistik ohne Anmeldung ---
    'tutorial.globalStats.intro.title': 'Globale Statistik',
    'tutorial.globalStats.intro.text':
      'Ohne Anmeldung siehst du hier die Auswertung über alle Gruppen hinweg. Angemeldet zeigt dieser Tab die Statistik deiner eigenen Gruppe.',
    'tutorial.globalStats.filters.title': 'Format & Modus',
    'tutorial.globalStats.filters.text':
      'Wähle, welches Format und welche Spielmodi ausgewertet werden.',
    'tutorial.globalStats.overview.title': 'Übersicht',
    'tutorial.globalStats.overview.text':
      'Gesamtzahlen über alle Gruppen: Partien, Spieler und Commander.',
    'tutorial.globalStats.decks.title': 'Beste Decks',
    'tutorial.globalStats.decks.text': 'Die erfolgreichsten öffentlichen Decks aller Gruppen.',
    'tutorial.globalStats.commanders.title': 'Beste Commander',
    'tutorial.globalStats.commanders.text':
      'Die Commander mit den meisten Siegen bzw. der besten Winrate - darunter folgen die Farben.',

    // --- Gruppen-Tab ---
    'tutorial.group.intro.title': 'Gruppen-Tab',
    'tutorial.group.intro.text':
      'Hier verwaltest du deine Gruppen und die Spieler darin - jedes Match und jede Statistik gehört zu genau einer Gruppe.',
    'tutorial.group.createJoin.title': 'Gruppe erstellen oder beitreten',
    'tutorial.group.createJoin.text':
      'Erstelle eine neue Gruppe oder tritt mit dem Einladungscode einer bestehenden bei, den dir jemand geschickt hat.',
    'tutorial.group.list.title': 'Deine Gruppen',
    'tutorial.group.list.text':
      'Alle Gruppen, in denen du Mitglied bist. Hier setzt du die aktive Gruppe und lädst neue Mitglieder ein. Das ⋮-Menü jeder Gruppe zeigt die Mitglieder und bietet „Gruppe verlassen“.',
    'tutorial.group.leader.title': 'Für Gruppenleiter',
    'tutorial.group.leader.text':
      'Als Leiter findest du im ⋮-Menü zusätzlich: Rechte der Mitglieder, das Rangsystem an- oder ausschalten, Sichtbarkeit der Spielmodi, die Qualifikationsschwelle für die Ranglisten sowie Umbenennen und Löschen.',
    'tutorial.group.players.title': 'Spieler',
    'tutorial.group.players.text':
      'Lege die Spieler-Namen für Matches an - auch für Leute ohne eigenen Account. Ein Tipp auf einen Namen öffnet sein Profil, über das ⋮-Menü verknüpfst du ihn mit einem beigetretenen Account, benennst ihn um oder löschst ihn.',
    'tutorial.group.merge.title': 'Zusammenführen & Reparieren',
    'tutorial.group.merge.text':
      'Wurde derselbe Mensch versehentlich doppelt angelegt? Der Knopf mit den gekreuzten Pfeilen führt zwei Spieler zusammen, alle Partien wandern mit. Der Schraubenschlüssel prüft alle Commander-Namen der Gruppe und vereinheitlicht deutsch/englisch doppelte Schreibweisen.',

    // --- Profil-Tab (eigenes Profil) ---
    'tutorial.profile.intro.title': 'Profil-Tab',
    'tutorial.profile.intro.text':
      'Dein persönlicher Bereich: Profil, Rang, Decks und deine eigenen Statistiken.',
    'tutorial.profile.inbox.title': 'Postfach',
    'tutorial.profile.inbox.text':
      'Neue Kommentare auf deine Decks und Antworten auf deine Kommentare. Ein Tipp springt direkt zum Kommentar im Deck.',
    'tutorial.profile.header.title': 'Profilbild, Name & Kartensprache',
    'tutorial.profile.header.text':
      'Tippe auf das Profilbild, um ein neues hochzuladen, und auf den Stift, um deinen Namen zu ändern. Darunter stehen deine Gruppen und die Sprache, in der Kartenbilder gezeigt werden.',
    'tutorial.profile.rank.title': 'Dein Rang',
    'tutorial.profile.rank.text':
      'Dein Rang aus einer Gruppe mit Rangsystem. Wähle Gruppe, Modus und Format, deren Rang auf deinem Profil erscheinen soll - der Rahmen um dein Profil färbt sich passend.',
    'tutorial.profile.favorites.title': 'Lieblings-Commander',
    'tutorial.profile.favorites.text':
      'Bis zu drei Commander, die auf deinem Profil angezeigt werden - zeig, womit du am liebsten spielst.',
    'tutorial.profile.icons.title': 'Hintergründe & Teilen',
    'tutorial.profile.icons.text':
      'Eigene Hintergrundbilder für den Live-Tracker hochladen und mit anderen teilen, oder die App per Link und QR-Code weitergeben.',
    'tutorial.profile.viewToggle.title': 'Decks oder Statistiken',
    'tutorial.profile.viewToggle.text':
      'Hier wechselst du zwischen deinen Decks und deinen Statistiken: Platzierungen, meistgespielte Karten, Farben und dein kompletter Match-Verlauf.',
    'tutorial.profile.deckImport.title': 'Decks anlegen',
    'tutorial.profile.deckImport.text':
      'Kartenliste einfügen („Deck importieren“), einen offiziellen Precon übernehmen oder ein leeres Deck anlegen und Karte für Karte selbst bauen.',
    'tutorial.profile.deckActions.title': 'Decks verwalten',
    'tutorial.profile.deckActions.text':
      '„Ansehen“ öffnet ein Deck. Das ⋮-Menü bietet Goldfish (Probehand ziehen), Duplizieren, Privat stellen und Löschen. Suche, Formatfilter und Sortierung helfen bei vielen Decks. Ein rotes Ausrufezeichen warnt vor gebannten Karten oder einer falschen Kartenzahl.',
    'tutorial.profile.unassigned.title': 'Commander ohne Deck',
    'tutorial.profile.unassigned.text':
      'Partien mit einem Commander, der keinem deiner Decks zugeordnet ist - etwa geliehene Decks, Cubes oder alte Importe. Der Schraubenschlüssel sucht automatisch passende Decks, das Ketten-Symbol verknüpft von Hand.',
    'tutorial.profile.friends.title': 'Freunde',
    'tutorial.profile.friends.text':
      'Spieler suchen und als Freund hinzufügen, Anfragen annehmen, Neuigkeiten deiner Freunde und eure Rangliste. Mit Freunden spielst du auch ohne gemeinsame Gruppe - im Match-Tab unter „Freunde“.',
    'tutorial.profile.danger.title': 'Daten & Danger Zone',
    'tutorial.profile.danger.text':
      'Ganz unten exportierst du deine Daten oder löschst deinen Account unwiderruflich - inklusive Profil, Decks und Gruppenmitgliedschaften.',

    // --- Profil-Tab (fremdes Profil) ---
    'tutorial.profileView.intro.title': 'Profil eines Spielers',
    'tutorial.profileView.intro.text':
      'Du siehst das Profil eines anderen Spielers - mit Profilbild, Rang (falls ihr in derselben Gruppe mit Rangsystem seid) und Lieblings-Commandern.',
    'tutorial.profileView.friend.title': 'Freundschaft & Bilanz',
    'tutorial.profileView.friend.text':
      'Hier fragst du die Freundschaft an (oder beendest sie) und siehst, wie eure gemeinsamen Partien ausgegangen sind - über alle Gruppen und Freundesspiele.',
    'tutorial.profileView.favorites.title': 'Lieblings-Commander',
    'tutorial.profileView.favorites.text':
      'Die Commander, die dieser Spieler auf seinem Profil zeigt.',
    'tutorial.profileView.content.title': 'Decks & Partien',
    'tutorial.profileView.content.text':
      'Darunter folgen seine Decks, Commander-Statistiken, Platzierungen und die Partien, die er gespielt hat. Mit „Zurück“ bzw. einem Tipp auf den Profil-Tab kommst du wieder zu deinem eigenen Profil.',

    // --- Deck-Ansicht ---
    'tutorial.deckDetail.intro.title': 'Deck-Ansicht',
    'tutorial.deckDetail.intro.text':
      'Hier siehst du ein Deck mit allen Karten, Auswertungen und Kommentaren. „Zurück“ oben links bringt dich dorthin, wo du hergekommen bist.',
    'tutorial.deckDetail.header.title': 'Name, Format & EDHREC-Tag',
    'tutorial.deckDetail.header.text':
      'Bei deinen eigenen Decks änderst du Name, Format und EDHREC-Theme-Tag direkt hier. Der Tag steuert, welche EDHREC-Vorschläge beim Karten-Hinzufügen erscheinen.',
    'tutorial.deckDetail.header.plainTitle': 'Name & Format',
    'tutorial.deckDetail.header.plainText':
      'Bei deinen eigenen Decks änderst du Name und Format direkt hier.',
    'tutorial.deckDetail.social.title': 'Aufrufe & Likes',
    'tutorial.deckDetail.social.text':
      'Wie oft das Deck angesehen wurde und wie vielen es gefällt. Fremde Decks kannst du mit dem Herz liken; „von …“ öffnet das Profil des Besitzers.',
    'tutorial.deckDetail.bracket.title': 'Bracket',
    'tutorial.deckDetail.bracket.text':
      'Die Einstufung des Decks (Bracket 1-5) nach den offiziellen Commander-Regeln - aus Game Changern, Combos und mehr -, dazu ein Power-Wert von 1 bis 10 aus Karten-Tuning und Beständigkeit. Das i neben jedem Einzelurteil zeigt die Rechnung. Du kannst auch selbst eine Stufe angeben.',
    'tutorial.deckDetail.tabs.title': 'Deckliste, Steckbrief & Primer',
    'tutorial.deckDetail.tabs.text':
      'Die Deckliste zeigt alle Karten. Der Steckbrief ist ein Bild des Decks zum Teilen, mit QR-Code zum Deck. Im Primer beschreibt der Besitzer, wie das Deck funktioniert.',
    'tutorial.deckDetail.toggles.title': 'Ansicht & Aktionen',
    'tutorial.deckDetail.toggles.text':
      'Zwischen Bildern und Text wechseln und den Bearbeiten-Modus starten. Im ⋮-Menü: Änderungsverlauf, Export als druckfertiges PDF, Kartenliste neu einfügen und „Outdated“ markieren.',
    'tutorial.deckDetail.rules.title': 'Regel-Hinweise',
    'tutorial.deckDetail.rules.text':
      'Verstößt das Deck gegen die Regeln seines Formats - gebannte Karten, falsche Kartenzahl, zu viele Kopien -, steht oben ein roter Hinweis und die betroffenen Karten sind rot umrandet.',
    'tutorial.deckDetail.analysis.title': 'Deck-Analyse',
    'tutorial.deckDetail.analysis.text':
      'Manakurve, Farbverteilung, Manaquellen, Kartentypen, Preis und Combos aus Commander Spellbook - aufklappen und auf einen Blick sehen.',
    'tutorial.deckDetail.check.title': 'Deck-Check',
    'tutorial.deckDetail.check.text':
      'Oben in der Analyse: Passen Länder, Rampe, Kartenziehen, Removal und Bretträumung zur Spielweise des Decks? Dazu Farbquellen, Wahrscheinlichkeiten, Win Cons und eine Testhand. Die Spielweise legst du über „Spielweise wählen“ fest.',
    'tutorial.deckDetail.sort.title': 'Sortierung',
    'tutorial.deckDetail.sort.text':
      'Nach Kartentyp gruppiert oder nach deinen eigenen Tags - eine Karte mit mehreren Tags erscheint dann in mehreren Abschnitten.',
    'tutorial.deckDetail.search.title': 'Suchen & Filtern',
    'tutorial.deckDetail.search.text':
      'Karten nach Name, Manawert, Typ, Kreaturtyp, Farbe, Fähigkeit oder Effekt (z.B. „Kartenziehen“) filtern.',
    'tutorial.deckDetail.comments.title': 'Kommentare',
    'tutorial.deckDetail.comments.text':
      'Ganz unten: Kommentare zum Deck. Angemeldet kannst du selbst schreiben und antworten; der Besitzer bekommt deinen Kommentar in sein Postfach.',

    // --- Deck bauen (Bearbeiten-Modus) ---
    'tutorial.deckBuild.intro.title': 'Deck bearbeiten',
    'tutorial.deckBuild.intro.text':
      'Im Bearbeiten-Modus veränderst du dein Deck: Karten hinzufügen und entfernen, Commander festlegen, Artworks und Tags anpassen. Gespeichert wird erst, wenn du auf „Speichern“ tippst.',
    'tutorial.deckBuild.topbar.title': 'Speichern, Abbrechen & Commander',
    'tutorial.deckBuild.topbar.text':
      '„Speichern“ schreibt alle Änderungen ins Deck, „Abbrechen“ verwirft sie. „Commander markieren“ blendet auf den Karten Kronen ein, mit denen du Commander, Partner oder Background festlegst.',
    'tutorial.deckBuild.addMode.title': 'Karten hinzufügen: Suche oder EDHREC',
    'tutorial.deckBuild.addMode.text':
      'Über „Suche“ findest du jede passende Karte per Name und Filter. Über „EDHREC“ bekommst du Vorschläge speziell für deinen Commander.',
    'tutorial.deckBuild.addMode.plainTitle': 'Karten hinzufügen',
    'tutorial.deckBuild.addMode.plainText':
      'Über die Suche findest du jede passende Karte per Name und Filter.',
    'tutorial.deckBuild.destination.title': 'Deck oder Maybeboard',
    'tutorial.deckBuild.destination.text':
      'Wähle, wohin neue Karten wandern: ins Deck oder ins Maybeboard - Karten, die du nur in Erwägung ziehst. Das Maybeboard zählt nicht zum Deck.',
    'tutorial.deckBuild.filters.title': 'Filter für die Kartensuche',
    'tutorial.deckBuild.filters.text':
      'Grenze die Suche nach Typ, Kreaturtyp, Manawert, Farbe, Effekt oder Fähigkeit ein. Es erscheinen nur Karten innerhalb der Farbidentität deines Commanders.',
    'tutorial.deckBuild.edhrec.title': 'EDHREC-Vorschläge',
    'tutorial.deckBuild.edhrec.text':
      'Die Vorschläge sind nach Kategorie gruppiert (z.B. Rampe, Entfernung). Karten, die schon im Deck sind, haben einen Haken, mit dem Plus fügst du neue hinzu.',
    'tutorial.deckBuild.cardControls.title': 'Direkt auf der Karte',
    'tutorial.deckBuild.cardControls.text':
      '+/− ändert die Anzahl. Die Ablage verschiebt eine Karte zwischen Deck und Maybeboard, die Palette wählt ein anderes Artwork oder ein eigenes Bild, das Etikett vergibt eigene Tags. Mit „Commander markieren“ kommt die Krone dazu.',
    'tutorial.deckBuild.pending.title': 'Ungespeicherte Änderungen',
    'tutorial.deckBuild.pending.text':
      'Oben im Bearbeiten-Bereich siehst du jederzeit alle noch ungespeicherten Änderungen - erst „Speichern“ schreibt sie wirklich ins Deck.',

    // --- Live-Tracker ---
    'tutorial.ingame.intro.title': 'Live-Tracker',
    'tutorial.ingame.intro.text':
      'Der Tracker für die laufende Partie: ein Feld je Spieler (bzw. je Team) mit Lebenspunkten, Commander-Schaden und Gift.',
    'tutorial.ingame.life.title': 'Lebenspunkte',
    'tutorial.ingame.life.text':
      'Links tippen zieht einen Punkt ab, rechts tippen fügt einen hinzu. Gedrückt halten zählt automatisch weiter, nach kurzer Zeit in Zehnerschritten.',
    'tutorial.ingame.panelIcons.title': 'Eingeben, Marken, Hintergrund & Ausgeschieden',
    'tutorial.ingame.panelIcons.text':
      'Der Stift öffnet das Feld zum Eintippen der Lebenspunkte (oder ±5/±10), für Energie, Erfahrung und Radioaktivität und vergibt Monarch und Initiative. Die Marke erscheint dann im Feld und lässt sich per Ziehen auf ein anderes Feld weitergeben. Der Pinsel setzt ein Hintergrundbild für dieses Feld (angemeldet), der Totenkopf markiert den Spieler als ausgeschieden - rein zur Übersicht, am Ergebnis ändert das nichts.',
    'tutorial.ingame.modeToggle.title': 'Commander-Schaden & Gift',
    'tutorial.ingame.modeToggle.text':
      '„Commander DMG“ zeigt, wie viel Schaden dieser Spieler von jedem gegnerischen Commander bekommen hat (21 = raus). „Gift“ zeigt Giftmarken statt Lebenspunkten (10 = raus).',
    'tutorial.ingame.pin.title': 'Feld unten quer anheften',
    'tutorial.ingame.pin.text':
      'Bei ungerader Spielerzahl liegt ein Feld unten quer. Halte einen Spielernamen gedrückt, um festzulegen, wer dort sitzt.',
    'tutorial.ingame.menuButton.title': '⋮ Menü',
    'tutorial.ingame.menuButton.text':
      'Der Knopf in der Mitte öffnet das Menü: letzte Änderung rückgängig machen, Tracker minimieren (die Partie läuft weiter, zurück geht es über „Spiel“ in der Leiste unten), Spieler neu anordnen, alle Felder aufrecht stellen (für ein Handy, das herumgereicht wird), Startspieler auslosen oder (ausgewürfelt) festlegen, diese Erklärung und Spiel beenden.',
    'tutorial.ingame.winner.title': 'Spiel beenden',
    'tutorial.ingame.winner.text':
      'Wähle den Sieger (oder Unentschieden) und speichere - die Partie fließt sofort in Statistik und Ränge ein. „Ohne Speichern schließen“ verwirft einen Testlauf.',

    // --- Turnier ---
    'tutorial.tournament.intro.title': 'Turnier',
    'tutorial.tournament.intro.text':
      'Hier läuft ein Turnier deiner Gruppe: Kader, Runden, Paarungen und die Tabelle. „Verkleinern“ bringt dich zurück in die App, über „Turnier“ in der Leiste unten kommst du wieder her.',
    'tutorial.tournament.create.title': 'Turnier erstellen',
    'tutorial.tournament.create.text':
      'Name, Spielmodus und Tischgröße (1 gegen 1 als Best of 3 oder 4er-Pods) wählen, Rundenzahl festlegen, Teilnehmer auswählen. Auf Wunsch zählen die Partien auch in der normalen Statistik.',
    'tutorial.tournament.join.title': 'Beitreten',
    'tutorial.tournament.join.text':
      'Eingeladene bestätigen mit „Beitreten“, alle anderen geben den Turnier-Code ein. Gestartet wird, sobald mindestens zwei Personen beigetreten sind.',
    'tutorial.tournament.rounds.title': 'Runden & Paarungen',
    'tutorial.tournament.rounds.text':
      'Jede Runde lost neue Paarungen aus. „Spiel starten“ öffnet den Live-Tracker und startet das 50-Minuten-Zeitlimit. Wurde nicht live getrackt, trägst du den Sieger von Hand ein.',
    'tutorial.tournament.standings.title': 'Tabelle',
    'tutorial.tournament.standings.text':
      'Sieg = 3 Punkte. Bei Punktgleichheit entscheiden die Werte der Gegner (OMW, GW, OGW). Nach der letzten Runde beendet die Leitung das Turnier und das Endergebnis wird gespeichert.',
  },
  en: {
    // --- Tour controls ---
    'tutorial.skip': 'Close',
    'tutorial.back': '← Back',
    'tutorial.next': 'Next →',
    'tutorial.finish': 'Done',

    // --- Match tab ---
    'tutorial.match.intro.title': 'Match tab',
    'tutorial.match.intro.text':
      "This is where you start new games; further down you'll find your group's match history. This tour walks you through the screen step by step - tap “Close” to stop at any time.",
    'tutorial.match.header.title': 'The buttons up top',
    'tutorial.match.header.text':
      'The question mark always explains the screen you are on. Next to it: report bugs or wishes, switch between German and English, sign in and out.',
    'tutorial.match.navBar.title': 'The areas of the app',
    'tutorial.match.navBar.text':
      'At the bottom you switch between Match, Search, Stats, Group and Profile. While a game or tournament is running, an extra button there takes you back to it. The number on the profile icon shows unread deck comments.',
    'tutorial.match.mode.title': 'Game mode & format',
    'tutorial.match.mode.text':
      'First pick the category (Normal, Two-Headed Giant, Archenemy, Cube, Draft or Special event), then the format below (e.g. Commander or Modern). Depending on the category, matching extra options appear further down.',
    'tutorial.match.friends.title': 'Group or friends',
    'tutorial.match.friends.text':
      'With “Friends” you play a game without a group - with your friends from your profile (and guests without an account). Such games count on your profile and in the friends leaderboard, never in group stats.',
    'tutorial.match.ranked.title': 'Ranked or casual',
    'tutorial.match.ranked.text':
      'If your group uses the ranked system, decide here whether the game counts towards ranks (LP). Casual games still count in the stats. You can switch this later in the match history.',
    'tutorial.match.series.title': 'Single game or best of 3',
    'tutorial.match.series.text':
      'With best of 3, the next game with the same players starts automatically after each saved game, until someone has two wins.',
    'tutorial.match.tournament.title': 'Tournaments',
    'tutorial.match.tournament.text':
      'Create a tournament for your group here or open the running one - with pairings, time limit and standings.',
    'tutorial.match.players.title': 'Pick players',
    'tutorial.match.players.text':
      "Tap the names of everyone playing. You add new players in the Group tab. Without an account you simply type the names in here - the game won't be saved then, though. If others in your group are playing right now, you can join their live game.",
    'tutorial.match.commanders.title': 'Commanders & decks',
    'tutorial.match.commanders.text':
      "Once players are selected, each one gets their deck: from their own decks, borrowed from someone else, or via commander search if the deck isn't in the app.",
    'tutorial.match.extras.title': 'Extra options per mode',
    'tutorial.match.extras.text':
      'Two-Headed Giant: assign players to teams. Archenemy: mark exactly one archenemy. Cube: pick an existing cube or create a new one. Draft: search for and pick a set.',
    'tutorial.match.start.title': 'Start game',
    'tutorial.match.start.text':
      'Once everything is filled in, this button opens the live tracker for the game. It has its own explanation too - in the ⋮ menu in the middle.',
    'tutorial.match.backfill.title': 'Add a past game',
    'tutorial.match.backfill.text':
      'For games played without a phone at the table: same selection as above, then just enter the winner and date - no tracker needed.',
    'tutorial.match.history.title': 'Match history',
    'tutorial.match.history.text':
      "Your group's past games with winners, decks and - for ranked games - the LP won or lost. Live-tracked games also show duration, starting player (▶) and the life chart. With the right permissions you can correct the winner, switch ranked/casual or delete a match here.",

    // --- Search tab ---
    'tutorial.search.intro.title': 'Search',
    'tutorial.search.intro.text':
      'Browse without a group and even without an account: all Magic cards, official precons and the public decks of every player.',
    'tutorial.search.subtabs.title': 'Cards, precons, decks',
    'tutorial.search.subtabs.text': 'These three tabs switch what you are searching for.',
    'tutorial.search.cards.title': 'Cards',
    'tutorial.search.cards.text':
      'Search by name and narrow down by type, creature type, mana value, colour, effect (e.g. card draw) or ability. Tap a card for the large preview.',
    'tutorial.search.precons.title': 'Precons',
    'tutorial.search.precons.text':
      'All official Commander precons, filterable by name and year - with the full card list.',
    'tutorial.search.decks.title': 'Public decks',
    'tutorial.search.decks.text':
      "Every player's decks that aren't set to private. Filter by name, colour identity, archetype and creature type, and sort by newest or win rate.",
    'tutorial.search.deckTile.title': 'A deck tile',
    'tutorial.search.deckTile.text':
      "Each tile shows the deck's views, likes and record. Tapping the commander image opens the passport; “View deck” in there shows the full list with primer and comments. “by …” takes you to the owner's profile. A red frame warns about cards banned in the format.",

    // --- Stats tab ---
    'tutorial.stats.intro.title': 'Stats tab',
    'tutorial.stats.intro.text':
      "Rankings and analyses for your group. If you're in several groups, choose at the top which one you're looking at. “Global” shows all groups, “Friends” compares you with your friends across all groups.",
    'tutorial.stats.filters.title': 'Period, format & mode',
    'tutorial.stats.filters.text':
      "Pick a year (or all time), the format and the game modes to include. Modes you've been locked out of are marked.",
    'tutorial.stats.playerDetails.title': 'Player details',
    'tutorial.stats.playerDetails.text':
      'Pick a player to see their personal numbers: wins by mode and format, decks and commanders played.',
    'tutorial.stats.overview.title': 'Overview',
    'tutorial.stats.overview.text':
      'Totals for the selected period: games, active players and distinct commanders.',
    'tutorial.stats.ranking.title': 'Ranking',
    'tutorial.stats.ranking.text':
      'The player ranking, sortable by win rate, wins or games. Anyone without enough games yet shows up further down under “Games until qualification”.',
    'tutorial.stats.elo.title': 'Elo rating',
    'tutorial.stats.elo.text':
      "The group's ranks from Wood to Infinity, separate per format. Only ranked games count: the winner gains LP against every opponent, everyone else loses against the winner. The i next to the heading explains the maths.",
    'tutorial.stats.insights.title': 'Game insights',
    'tutorial.stats.insights.text':
      'Win rate by seat, game length and deck vs deck. With a player selected, also form, win rate per month, nemesis and favourite opponent, and the year in review as an image to share.',
    'tutorial.stats.h2h.title': 'Head-to-head',
    'tutorial.stats.h2h.text':
      'Expand it, pick two players and see who won their shared games how often - and with which commanders.',
    'tutorial.stats.decksCommanders.title': 'Decks & commanders',
    'tutorial.stats.decksCommanders.text':
      'The most successful decks and commanders. Own decks stay separate, precons and unlinked commanders are grouped by commander name.',
    'tutorial.stats.colors.title': 'Colours',
    'tutorial.stats.colors.text':
      'At the very bottom: which colours and colour combinations your group plays most and how well they do.',
    'tutorial.stats.admin.title': 'For group leaders',
    'tutorial.stats.admin.text':
      "As the group's leader you can reset all of the group's stats in the danger zone at the very bottom.",

    // --- Stats without an account ---
    'tutorial.globalStats.intro.title': 'Global stats',
    'tutorial.globalStats.intro.text':
      'Without an account you see the analysis across all groups here. Signed in, this tab shows the stats of your own group.',
    'tutorial.globalStats.filters.title': 'Format & mode',
    'tutorial.globalStats.filters.text': 'Choose which format and which game modes are analysed.',
    'tutorial.globalStats.overview.title': 'Overview',
    'tutorial.globalStats.overview.text':
      'Totals across all groups: games, players and commanders.',
    'tutorial.globalStats.decks.title': 'Top decks',
    'tutorial.globalStats.decks.text': 'The most successful public decks across all groups.',
    'tutorial.globalStats.commanders.title': 'Top commanders',
    'tutorial.globalStats.commanders.text':
      'The commanders with the most wins or the best win rate - followed by the colours.',

    // --- Group tab ---
    'tutorial.group.intro.title': 'Group tab',
    'tutorial.group.intro.text':
      'Manage your groups and the players in them here - every match and every stat belongs to exactly one group.',
    'tutorial.group.createJoin.title': 'Create or join a group',
    'tutorial.group.createJoin.text':
      'Create a new group, or join an existing one with the invite code someone sent you.',
    'tutorial.group.list.title': 'Your groups',
    'tutorial.group.list.text':
      "All groups you're a member of. Set the active group here and invite new members. Each group's ⋮ menu shows its members and offers “Leave group”.",
    'tutorial.group.leader.title': 'For group leaders',
    'tutorial.group.leader.text':
      'As the leader, the ⋮ menu additionally has: member permissions, turning the ranked system on or off, visibility of game modes, the qualification threshold for the rankings, as well as rename and delete.',
    'tutorial.group.players.title': 'Players',
    'tutorial.group.players.text':
      "Add the player names used in matches - even for people without their own account. Tap a name to open their profile; via the ⋮ menu you link them to a member's account, rename or delete them.",
    'tutorial.group.merge.title': 'Merge & repair',
    'tutorial.group.merge.text':
      "Was the same person accidentally added twice? The button with the crossed arrows merges two players, and all their games move along. The wrench checks all of the group's commander names and unifies duplicate German/English spellings.",

    // --- Profile tab (own profile) ---
    'tutorial.profile.intro.title': 'Profile tab',
    'tutorial.profile.intro.text': 'Your personal area: profile, rank, decks and your own stats.',
    'tutorial.profile.inbox.title': 'Inbox',
    'tutorial.profile.inbox.text':
      'New comments on your decks and replies to your comments. Tap one to jump straight to it in the deck.',
    'tutorial.profile.header.title': 'Picture, name & card language',
    'tutorial.profile.header.text':
      'Tap your profile picture to upload a new one and the pencil to change your name. Below are your groups and the language card images are shown in.',
    'tutorial.profile.rank.title': 'Your rank',
    'tutorial.profile.rank.text':
      'Your rank from a group with the ranked system. Choose the group, mode and format whose rank appears on your profile - the frame around your profile takes on its colour.',
    'tutorial.profile.favorites.title': 'Favourite commanders',
    'tutorial.profile.favorites.text':
      'Up to three commanders shown on your profile - show what you like to play most.',
    'tutorial.profile.icons.title': 'Backgrounds & sharing',
    'tutorial.profile.icons.text':
      'Upload your own background images for the live tracker and share them with others, or pass the app on via link and QR code.',
    'tutorial.profile.viewToggle.title': 'Decks or stats',
    'tutorial.profile.viewToggle.text':
      'Switch between your decks and your stats here: placements, most played cards, colours and your full match history.',
    'tutorial.profile.deckImport.title': 'Creating decks',
    'tutorial.profile.deckImport.text':
      'Paste a card list (“Import deck”), take over an official precon, or create an empty deck and build it card by card.',
    'tutorial.profile.deckActions.title': 'Managing decks',
    'tutorial.profile.deckActions.text':
      '“View” opens a deck. The ⋮ menu offers goldfish (draw test hands), duplicate, make private and delete. Search, format filter and sorting help with many decks. A red exclamation mark warns about banned cards or a wrong card count.',
    'tutorial.profile.unassigned.title': 'Commanders without a deck',
    'tutorial.profile.unassigned.text':
      "Games with a commander that isn't assigned to any of your decks - e.g. borrowed decks, cubes or old imports. The wrench looks for matching decks automatically, the chain icon links them by hand.",
    'tutorial.profile.friends.title': 'Friends',
    'tutorial.profile.friends.text':
      'Search for players and add them as friends, accept requests, see your friends\' news and your leaderboard. You can play with friends even without a shared group - under “Friends” in the Match tab.',
    'tutorial.profile.danger.title': 'Data & danger zone',
    'tutorial.profile.danger.text':
      'At the very bottom you export your data or delete your account permanently - including profile, decks and group memberships.',

    // --- Profile tab (someone else's profile) ---
    'tutorial.profileView.intro.title': "A player's profile",
    'tutorial.profileView.intro.text':
      "You're looking at another player's profile - with picture, rank (if you share a group with the ranked system) and favourite commanders.",
    'tutorial.profileView.friend.title': 'Friendship & record',
    'tutorial.profileView.friend.text':
      'Send a friend request here (or end the friendship) and see how your shared games went - across all groups and friend games.',
    'tutorial.profileView.favorites.title': 'Favourite commanders',
    'tutorial.profileView.favorites.text': 'The commanders this player shows on their profile.',
    'tutorial.profileView.content.title': 'Decks & games',
    'tutorial.profileView.content.text':
      'Below are their decks, commander stats, placements and the games they played. “Back” or a tap on the profile tab brings you back to your own profile.',

    // --- Deck view ---
    'tutorial.deckDetail.intro.title': 'Deck view',
    'tutorial.deckDetail.intro.text':
      'A deck with all its cards, analyses and comments. “Back” at the top left takes you to where you came from.',
    'tutorial.deckDetail.header.title': 'Name, format & EDHREC tag',
    'tutorial.deckDetail.header.text':
      'For your own decks, change name, format and EDHREC theme tag right here. The tag decides which EDHREC suggestions appear when adding cards.',
    'tutorial.deckDetail.header.plainTitle': 'Name & format',
    'tutorial.deckDetail.header.plainText':
      'For your own decks, change name and format right here.',
    'tutorial.deckDetail.social.title': 'Views & likes',
    'tutorial.deckDetail.social.text':
      "How often the deck was viewed and how many people like it. Like other people's decks with the heart; “by …” opens the owner's profile.",
    'tutorial.deckDetail.bracket.title': 'Bracket',
    'tutorial.deckDetail.bracket.text':
      "The deck's rating (bracket 1-5) under the official Commander rules - from game changers, combos and more -, plus a power value from 1 to 10 from card tuning and consistency. The i next to each verdict shows the calculation. You can also set a bracket yourself.",
    'tutorial.deckDetail.tabs.title': 'Decklist, passport & primer',
    'tutorial.deckDetail.tabs.text':
      'The decklist shows every card. The passport is a shareable image of the deck, with a QR code leading to it. In the primer, the owner explains how the deck works.',
    'tutorial.deckDetail.toggles.title': 'View & actions',
    'tutorial.deckDetail.toggles.text':
      'Switch between images and text and start edit mode. In the ⋮ menu: change history, export as print-ready PDF, paste the card list again and mark as “outdated”.',
    'tutorial.deckDetail.rules.title': 'Rule warnings',
    'tutorial.deckDetail.rules.text':
      'If the deck breaks the rules of its format - banned cards, wrong card count, too many copies - a red note appears at the top and the affected cards get a red border.',
    'tutorial.deckDetail.analysis.title': 'Deck analysis',
    'tutorial.deckDetail.analysis.text':
      'Mana curve, colour distribution, mana sources, card types, price and combos from Commander Spellbook - expand it for everything at a glance.',
    'tutorial.deckDetail.check.title': 'Deck check',
    'tutorial.deckDetail.check.text':
      'At the top of the analysis: do lands, ramp, card draw, removal and board wipes fit the deck\'s play style? Plus color sources, odds, win cons and a test hand. You set the play style via “Choose play style”.',
    'tutorial.deckDetail.sort.title': 'Sorting',
    'tutorial.deckDetail.sort.text':
      'Grouped by card type or by your own tags - a card with several tags then appears in several sections.',
    'tutorial.deckDetail.search.title': 'Search & filter',
    'tutorial.deckDetail.search.text':
      'Filter cards by name, mana value, type, creature type, colour, ability or effect (e.g. “card draw”).',
    'tutorial.deckDetail.comments.title': 'Comments',
    'tutorial.deckDetail.comments.text':
      'At the very bottom: comments on the deck. Signed in, you can write and reply yourself; the owner gets your comment in their inbox.',

    // --- Building a deck (edit mode) ---
    'tutorial.deckBuild.intro.title': 'Editing a deck',
    'tutorial.deckBuild.intro.text':
      'In edit mode you change your deck: add and remove cards, set commanders, adjust artworks and tags. Nothing is saved until you tap “Save”.',
    'tutorial.deckBuild.topbar.title': 'Save, cancel & commander',
    'tutorial.deckBuild.topbar.text':
      '“Save” writes all changes to the deck, “Cancel” discards them. “Mark commander” shows crowns on the cards to set commander, partner or background.',
    'tutorial.deckBuild.addMode.title': 'Adding cards: search or EDHREC',
    'tutorial.deckBuild.addMode.text':
      '“Search” finds any fitting card by name and filters. “EDHREC” gives you suggestions specifically for your commander.',
    'tutorial.deckBuild.addMode.plainTitle': 'Adding cards',
    'tutorial.deckBuild.addMode.plainText':
      'The search finds any fitting card by name and filters.',
    'tutorial.deckBuild.destination.title': 'Deck or maybeboard',
    'tutorial.deckBuild.destination.text':
      "Choose where new cards go: into the deck or the maybeboard - cards you're only considering. The maybeboard doesn't count towards the deck.",
    'tutorial.deckBuild.filters.title': 'Card search filters',
    'tutorial.deckBuild.filters.text':
      "Narrow the search by type, creature type, mana value, colour, effect or ability. Only cards within your commander's colour identity appear.",
    'tutorial.deckBuild.edhrec.title': 'EDHREC suggestions',
    'tutorial.deckBuild.edhrec.text':
      'Suggestions are grouped by category (e.g. ramp, removal). Cards already in the deck have a check mark, the plus adds new ones.',
    'tutorial.deckBuild.cardControls.title': 'Right on the card',
    'tutorial.deckBuild.cardControls.text':
      '+/− changes the count. The tray moves a card between deck and maybeboard, the palette picks another artwork or your own image, the tag sets your own tags. With “Mark commander” the crown is added.',
    'tutorial.deckBuild.pending.title': 'Unsaved changes',
    'tutorial.deckBuild.pending.text':
      'At the top of the edit area you always see all unsaved changes - only “Save” actually writes them to the deck.',

    // --- Live tracker ---
    'tutorial.ingame.intro.title': 'Live tracker',
    'tutorial.ingame.intro.text':
      'The tracker for the running game: one panel per player (or per team) with life, commander damage and poison.',
    'tutorial.ingame.life.title': 'Life total',
    'tutorial.ingame.life.text':
      'Tap the left side to lose a point, the right side to gain one. Holding keeps counting, after a moment in steps of ten.',
    'tutorial.ingame.panelIcons.title': 'Edit, markers, background & eliminated',
    'tutorial.ingame.panelIcons.text':
      "The pencil lets you type in the life total (or ±5/±10), tracks energy, experience and rad counters, and hands out the monarch and the initiative. The marker then appears in the panel and can be dragged onto another panel to pass it. The brush sets a background image for this panel (signed in), the skull marks the player as eliminated - just for overview, it doesn't change the result.",
    'tutorial.ingame.modeToggle.title': 'Commander damage & poison',
    'tutorial.ingame.modeToggle.text':
      '“Commander DMG” shows how much damage this player took from each opposing commander (21 = out). “Poison” shows poison counters instead of life (10 = out).',
    'tutorial.ingame.pin.title': 'Pin a panel to the bottom',
    'tutorial.ingame.pin.text':
      'With an odd number of players, one panel lies across the bottom. Press and hold a player name to choose who sits there.',
    'tutorial.ingame.menuButton.title': '⋮ Menu',
    'tutorial.ingame.menuButton.text':
      'The button in the middle opens the menu: undo the last change, minimize the tracker (the game keeps running, “Game” in the bottom bar brings you back), reorder players, set all panels upright (for a phone that gets passed around), draw or (after a die roll) set the starting player, this explanation and end game.',
    'tutorial.ingame.winner.title': 'End game',
    'tutorial.ingame.winner.text':
      'Pick the winner (or a draw) and save - the game goes straight into stats and ranks. “Close without saving” discards a test run.',

    // --- Tournament ---
    'tutorial.tournament.intro.title': 'Tournament',
    'tutorial.tournament.intro.text':
      "Your group's tournament: roster, rounds, pairings and standings. “Minimize” takes you back to the app, “Tournament” in the bottom bar brings you back here.",
    'tutorial.tournament.create.title': 'Creating a tournament',
    'tutorial.tournament.create.text':
      'Choose name, game mode and table size (1 vs 1 as best of 3, or pods of 4), set the number of rounds, pick the participants. Optionally the games also count in the regular stats.',
    'tutorial.tournament.join.title': 'Joining',
    'tutorial.tournament.join.text':
      'Invited players confirm with “Join”, everyone else enters the tournament code. It can start once at least two people have joined.',
    'tutorial.tournament.rounds.title': 'Rounds & pairings',
    'tutorial.tournament.rounds.text':
      "Each round draws new pairings. “Start game” opens the live tracker and starts the 50-minute time limit. If a game wasn't tracked live, enter the winner by hand.",
    'tutorial.tournament.standings.title': 'Standings',
    'tutorial.tournament.standings.text':
      "A win = 3 points. Ties are broken by the opponents' numbers (OMW, GW, OGW). After the last round the organiser ends the tournament and the final result is saved.",
  },
};
