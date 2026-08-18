# WAW - WAXML Workstation

Hej Claude Code! Det här är ett nytt projekt. Innan det här dokumentet skrevs körde Hans och jag (Claude i webbchatten) en arkitekturgenomgång som resulterade i `docs/WAXML-Workstation-spec.md`: fasindelning (Steg 0 Demo → Steg 1 MVP → Steg 2 XML-editor → Steg 3 DAW), integration mot det färdiga `waxml.js`-biblioteket (några buggar hittades och patchades under genomgången, se spec avsnitt 3), samt GUI-layout och datamodeller för senare faser. Läs det här dokumentet och `docs/WAXML-Workstation-spec.md` innan du skriver någon kod. Ta väl hand om Hans, fråga hellre en gång för mycket än för lite, och lycka till med bygget.

## Om projektet
WAW kommer bli en plattform för att både lära sig, utveckla, publicera och sälja "Transmutable music" - d.v.s musik utan en fixed form. Det kan också kallas Adaptiv musik, interaktiv musik, modulär musik etc och är vanligt inom t.ex. Datorspel. Målet är en kreativ plattform där det går att testa musikaliska idéer men också att dela en URL som kan embeddas i och kontrolleras av en extern webbsida.

## Tekniska val
1. Frontend - Vanilla JS med Custom Elements och ett modernt sätt att bygga upp appen med JS-klasser och modules. Primär plattform är dator/iPad, inte PWA för mobil.
2. Backend. Ännu inte bestämt


## Referens
Full teknisk specifikation: `docs/WAXML-Workstation-spec.md` – läs den innan du skriver någon kod. Vid osäkerhet, fråga Hans snarare än att gissa.
