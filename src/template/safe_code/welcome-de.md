---
# Welcome page for the `safe_code` type - de variant. See `welcome.md` for the
# structure; only user-visible values are translated.
greeting: Was soll ich lesen oder ändern?
suggestions:
  - title: Diese Codebasis verstehen
    description: Architektur, Module und wichtige Abläufe erkunden.
    prompt: Hilf mir, diese Codebasis zu verstehen. Finde die Hauptkomponenten, wichtige Einstiegspunkte, den Datenfluss und die Teile, die ich zuerst lesen sollte.
  - title: Code prüfen
    description: Finde Bugs, Risiken und Verbesserungsmöglichkeiten.
    prompt: Prüfe diesen Code auf Korrektheit, Bugs, Regressionen, Sicherheitsrisiken, Performance-Probleme und Wartbarkeit. Stelle die wichtigsten Funde nach vorn.
  - title: Bug beheben
    description: Finde die Ursache und mach die kleinste sichere Änderung.
    prompt: Untersuche diesen Bug, indem du den Code liest, finde die Ursache und nimm die kleinste zuverlässige Korrektur vor. Prüfe die Änderung, indem du die betroffenen Dateien erneut liest, statt irgendetwas auszuführen, und sag mir, was noch außerhalb von SafeCode ausgeführt werden muss.
  - title: Eine Funktion entwickeln
    description: Nimm die Änderung in allen betroffenen Dateien vor.
    prompt: Hilf mir, eine neue Funktion in diesem Projekt zu entwickeln. Lies zuerst den relevanten Code und die Architektur, schlage dann einen Umsetzungsplan vor und nimm die Änderungen vor. Prüfe das Ergebnis, indem du die entstandenen Dateien liest, und liste auf, was noch außerhalb von SafeCode gebaut oder getestet werden muss.
  - title: Code refaktorieren
    description: Verbessere die Struktur, ohne das Verhalten zu ändern.
    prompt: Refaktoriere diesen Code, damit er einfacher, klarer und wartbarer wird, und erhalte dabei das bestehende Verhalten. Erkläre die wichtigsten Änderungen und prüfe durch Lesen, dass nichts anderes von dem abhängt, was du verschoben hast.
  - title: Tests schreiben
    description: Hier schreiben, anderswo ausführen.
    prompt: Lies das aktuelle Verhalten und die vorhandenen Tests, finde wichtige Lücken und Randfälle und schreibe Tests, die sie abdecken. Halte dich an den Stil der umliegenden Tests. Ich führe sie außerhalb von SafeCode aus.
---
