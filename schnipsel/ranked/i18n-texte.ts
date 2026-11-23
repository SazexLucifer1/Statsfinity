// Aus src/app/i18n/ entfernte Texte des Ranked-Systems (23.11.2026).
// Je Eintrag die Sprache in eckigen Klammern; beim Wiedereinbau in das Modul des Präfixes zurück.

// src/app/i18n/group.ts
// [de]
    'group.rankedTurnOff': 'Ranked-System ausschalten',
// [de]
    'group.rankedTurnOn': 'Ranked-System einschalten',
// [de]
    'group.rankedConfirmOff':
      'Ranked-System für diese Gruppe ausschalten? Ränge, LP und die Auswahl Ranked/Frei verschwinden für alle Mitglieder. Im Hintergrund läuft die Wertung weiter – du als Gruppenleiter siehst sie im Statistik-Tab, und beim Wiedereinschalten ist sie für alle wieder da.',
// [de]
    'group.rankedReset': 'Rangliste zurücksetzen',
// [de]
    'group.rankedResetConfirm':
      'Rangliste dieser Gruppe zurücksetzen? Alle starten neu bei Silber V, ab jetzt zählen nur neue Partien. Die Partien selbst bleiben in der Statistik. Abzeichen gibt es dabei keine – dafür „Saison beenden“.',
// [de]
    'group.rankedResetDone': 'Die Rangliste startet neu.',
// [de]
    'group.rankedEndSeason': 'Saison beenden',
// [de]
    'group.rankedEndSeasonConfirm':
      'Saison beenden? Jeder mit Konto und fertiger Einstufung bekommt für jede Wertung (Modus + Format) ein dauerhaftes Abzeichen mit Endrang und LP in sein Profil. Danach startet die Rangliste neu bei Silber V.',
// [de]
    'group.rankedEndSeasonDone': 'Saison beendet: {{count}} Abzeichen vergeben, die neue Saison läuft.',
// [de]
    'group.rankedSeasonFailed': 'Das hat nicht geklappt. Ist sql/ranked-saison-2026-10-06.sql schon ausgeführt?',
// [de]
    'group.rankedConfirmOn':
      'Ranked-System für diese Gruppe einschalten? Alle Ranked-Partien der Gruppe zählen dann für die Ränge, auch die bisherigen.',
// [en]
    'group.rankedTurnOff': 'Turn off ranked system',
// [en]
    'group.rankedTurnOn': 'Turn on ranked system',
// [en]
    'group.rankedConfirmOff':
      'Turn off the ranked system for this group? Ranks, LP and the ranked/casual choice disappear for all members. The ranking keeps running in the background – as group leader you see it in the stats tab, and it is back for everyone when you turn it on again.',
// [en]
    'group.rankedReset': 'Reset leaderboard',
// [en]
    'group.rankedResetConfirm':
      'Reset this group\'s leaderboard? Everyone starts again at Silver V, from now on only new games count. The games themselves stay in the stats. No badges are awarded – use “End season” for that.',
// [en]
    'group.rankedResetDone': 'The leaderboard starts over.',
// [en]
    'group.rankedEndSeason': 'End season',
// [en]
    'group.rankedEndSeasonConfirm':
      'End the season? Everyone with an account and finished placement gets a permanent badge with final rank and LP in their profile for each ranking (mode + format). Then the leaderboard starts over at Silver V.',
// [en]
    'group.rankedEndSeasonDone': 'Season ended: {{count}} badges awarded, the new season is running.',
// [en]
    'group.rankedSeasonFailed': 'That did not work. Has sql/ranked-saison-2026-10-06.sql been run yet?',
// [en]
    'group.rankedConfirmOn':
      'Turn on the ranked system for this group? All ranked games of the group count towards the ranks, including past ones.',

// src/app/i18n/match.ts
// [de]
    'match.ranked': 'Ranked',
// [de]
    'match.casual': 'Frei',
// [de]
    'match.rankedAria': 'Ranked oder freies Match',
// [de]
    'match.rankedEditHint': 'Zählt dieses Match für die Ränge?',
// [en]
    'match.ranked': 'Ranked',
// [en]
    'match.casual': 'Casual',
// [en]
    'match.rankedAria': 'Ranked or casual match',
// [en]
    'match.rankedEditHint': 'Does this match count towards the ranks?',

// src/app/i18n/profile.ts
// [de]
    'profile.friends.rankingElo': 'Elo unter Freunden',
// [de]
    'profile.friends.rankingEloHint': 'Nur aus Freundesspielen, gerechnet wie das Rangsystem einer Gruppe.',
// [de]
    'profile.friends.eloEmpty': 'Noch keine Freundesspiele. Im Match-Tab oben auf „Freunde“ umschalten.',
// [de]
    'profile.friends.placement': 'Einstufung {{games}}/10',
// [de]
    'profile.rank.infoAria': 'Wie das Rangsystem funktioniert',
// [de]
    'profile.rank.info':
      'Der Rang gilt je Gruppe, Spielmodus und Format – gewertet werden nur Ranked-Partien dieser Gruppe. Die ersten 10 Partien sind die Einstufung: Jeder startet in der Mitte bei Silber V, die Einstufungspartien zählen stärker, und erst danach steht fest, wo man einsteigt – das kann auch Holz oder Gold sein. Jeder Rang hat fünf Divisionen (V bis I) zu je 100 LP: Holz, Eisen, Bronze, Silber, Gold, Platin, Diamant und ganz oben Infinity. Ein Sieg gegen gleich starke Gegner bringt rund 50 LP, gegen einen stärkeren Tisch mehr, gegen einen schwächeren weniger. Wer nicht gewinnt, verliert – egal ob Zweiter oder Letzter, gleich viel: Es zählt nur der Sieg, und gegen einen starken Sieger verliert man weniger als gegen einen schwachen. Dazu kommen 5 LP für jede gewertete Partie: Wer im Commander-Pod im Schnitt jedes vierte Spiel gewinnt, steigt langsam auf.',
// [de]
    'profile.rank.tier.wood': 'Holz',
// [de]
    'profile.rank.tier.iron': 'Eisen',
// [de]
    'profile.rank.tier.bronze': 'Bronze',
// [de]
    'profile.rank.tier.silver': 'Silber',
// [de]
    'profile.rank.tier.gold': 'Gold',
// [de]
    'profile.rank.tier.platinum': 'Platin',
// [de]
    'profile.rank.tier.diamond': 'Diamant',
// [de]
    'profile.rank.tier.infinity': 'Infinity',
// [de]
    'profile.rank.unranked': 'Nicht eingerankt',
// [de]
    'profile.rank.unrankedHint': 'Noch keine Spiele in {{mode}} – der Rang erscheint nach 10 gewerteten Partien.',
// [de]
    'profile.rank.lp': '{{lp}} LP',
// [de]
    'profile.badges.title': 'Saison-Abzeichen',
// [de]
    'profile.badges.infoAria': 'Was sind Saison-Abzeichen?',
// [de]
    'profile.badges.info': 'Der Endrang am Ende einer Ranked-Saison, je Wertung (Spielmodus + Format). Der Gruppenleiter beendet eine Saison im Gruppen-Tab, danach startet die Rangliste neu - die Abzeichen bleiben dauerhaft.',
// [de]
    'profile.rank.toNext': 'Noch {{lp}} LP bis {{next}}',
// [de]
    'profile.rank.detail': '{{games}} Partien · {{wins}} Siege · Bestwert {{peak}}',
// [de]
    'profile.rank.placement': 'Einstufung {{games}}/{{total}}',
// [de]
    'profile.rank.inPlacement': 'In Einstufung',
// [de]
    'profile.rank.placementHint': 'Noch {{left}} Partien bis zum Rang · {{wins}} Siege bisher',
// [de]
    'profile.rank.modeAria': 'Spielmodus für den Rang',
// [de]
    'profile.rank.formatAria': 'Format für den Rang',
// [de]
    'profile.rank.groupAria': 'Gruppe für den Rang',
// [de]
    'profile.rank.modeLabel': 'Rang in {{mode}}',
// [en]
    'profile.friends.rankingElo': 'Elo among friends',
// [en]
    'profile.friends.rankingEloHint': 'Only from friend games, calculated like a group’s ranking system.',
// [en]
    'profile.friends.eloEmpty': 'No friend games yet. Switch to “Friends” at the top of the Match tab.',
// [en]
    'profile.friends.placement': 'Placement {{games}}/10',
// [en]
    'profile.rank.infoAria': 'How the rank system works',
// [en]
    'profile.rank.info':
      'Ranks are per group, game mode and format – only ranked games of that group count. The first 10 games are placements: everyone starts in the middle at Silver V, placement games count more, and only after them is it settled where you enter – that can be Wood or Gold, too. Each rank has five divisions (V to I) of 100 LP each: Wood, Iron, Bronze, Silver, Gold, Platinum, Diamond and, at the top, Infinity. A win against equally strong opponents earns about 50 LP, more against a stronger table, less against a weaker one. Everyone who does not win loses the same, whether second or last: only the win counts, and losing to a strong winner costs less than losing to a weak one. On top of that, every rated game adds 5 LP: winning one game in four in a Commander pod slowly moves you up.',
// [en]
    'profile.rank.tier.wood': 'Wood',
// [en]
    'profile.rank.tier.iron': 'Iron',
// [en]
    'profile.rank.tier.bronze': 'Bronze',
// [en]
    'profile.rank.tier.silver': 'Silver',
// [en]
    'profile.rank.tier.gold': 'Gold',
// [en]
    'profile.rank.tier.platinum': 'Platinum',
// [en]
    'profile.rank.tier.diamond': 'Diamond',
// [en]
    'profile.rank.tier.infinity': 'Infinity',
// [en]
    'profile.rank.unranked': 'Not ranked',
// [en]
    'profile.rank.unrankedHint': 'No games in {{mode}} yet – the rank appears after 10 rated games.',
// [en]
    'profile.rank.lp': '{{lp}} LP',
// [en]
    'profile.badges.title': 'Season badges',
// [en]
    'profile.badges.infoAria': 'What are season badges?',
// [en]
    'profile.badges.info': 'The final rank at the end of a ranked season, per ranking (game mode + format). The group leader ends a season in the group tab, then the leaderboard starts over - the badges stay permanently.',
// [en]
    'profile.rank.toNext': '{{lp}} LP to {{next}}',
// [en]
    'profile.rank.detail': '{{games}} games · {{wins}} wins · peak {{peak}}',
// [en]
    'profile.rank.placement': 'Placements {{games}}/{{total}}',
// [en]
    'profile.rank.inPlacement': 'In placements',
// [en]
    'profile.rank.placementHint': '{{left}} games until your rank · {{wins}} wins so far',
// [en]
    'profile.rank.modeAria': 'Game mode for the rank',
// [en]
    'profile.rank.formatAria': 'Format for the rank',
// [en]
    'profile.rank.groupAria': 'Group for the rank',
// [en]
    'profile.rank.modeLabel': 'Rank in {{mode}}',

// src/app/i18n/stats.ts
// [de]
    'stats.friends.eloTitle': 'Elo unter Freunden',
// [de]
    'stats.friends.eloInfo':
      'Nur aus Freundesspielen (Match-Tab → „Freunde“), gerechnet wie das Rangsystem einer Gruppe. Gruppenpartien zählen hier nicht - sonst würden Runden mit ganz anderen Gegnern vermischt.',
// [de]
    'stats.friends.eloEmpty': 'Noch keine Freundesspiele in diesem Zeitraum.',
// [en]
    'stats.friends.eloTitle': 'Elo among friends',
// [en]
    'stats.friends.eloInfo':
      "Only from friend games (Match tab → “Friends”), calculated like a group's ranking system. Group games do not count here - otherwise rounds with completely different opponents would be mixed.",
// [en]
    'stats.friends.eloEmpty': 'No friend games in this period yet.',
