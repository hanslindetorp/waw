# WAW molntjänst — beslut och plan (2026-11-06, status 2026-11-17)

## Status: pausad 2026-11-17 (Hans bygger nya funktioner i appen)
Inget är köpt, registrerat eller uppsatt än, och ingen serverkod är skriven. Allt hittills är beslut och research.

### När du återvänder — gör så här
1. **Läs "Beslut" nedan** och säg till om något ska ändras.
2. **Provkonto:** klicka *Try for free* på <https://www.clever.cloud/pricing/> och skapa kontot (provkrediter, inget kort). Lösenord och betalning hanterar bara du.
3. **Jämförelse (valfritt, en eftermiddag):** skapa även ett gratiskonto hos Scalingo. Be Claude förbereda en minimal Node + Postgres-testapp och deploya den på båda. Mät hur snabbt `git push` går och vad det kostar.
4. **Domän:** kolla att `waw.audio` är ledig och vad den kostar hos en registrar (one.com går bra). Köp i Empowering Leadership Sweden ABs namn med tvåstegsverifiering. Kolla också `wawplayer.audio` (spelare/filer, ska ligga på en annan domän än appen). Båda verkade lediga enligt DNS 2026-11-06, men det är inte en registrering.
5. **Kollegan:** bestäm om han ska få skrivåtkomst till GitHub-repot och till staging (Hans svarade nej 2026-11-06; ompröva när staging finns).
6. **Öppna frågor** (listan strax nedan).
7. **Säg till Claude** att starta bygget: servermapp, Postgres i Docker (fråga först innan Docker startas), LTI-koden flyttad från PHP till Node med samma testfall.

### Öppna frågor
- Leverantör: Clever Cloud (rekommenderad kandidat, ej provad) eller Scalingo (har bekräftat PITR men ingen objektlagring). Scaleway gick inte att läsa (403).
- Gallringstid för elevresultat (förslag 12 månader, pseudonymisera sedan) och en biträdesavtalsmall som en jurist granskat.
- Personuppgiftsbiträdesavtal och användarvillkor med rättighetsbekräftelse för uppladdat ljud.
- Om Postgres hos Clever Cloud har återställning till tidpunkt (PITR). Inte bekräftat; dagliga backuper finns.
- Nivåer och priser för betaltjänster (affärslogik, ej klar). Gäller även tak för video (mpg/m4v är tung trafik).
- Plattformsregistrering för betalande skolor (LTI Dynamic Registration eller admin) — ej utrett.
- Om `integrity`-attributet ska införas i `waxml.js` (Hans beslut).


Underlag: Hans svar på kontrollfrågorna, `docs/WAXML-Workstation-spec.md` (avsnitt 6–10), LTI-avsnittet och
biblioteksavsnittet i `docs/architecture-overview.md` samt `documentation/WAW LTI var ett Activity-skikt passar.md`
(lokal, gitignorerad).

## Varför
LTI-prototypen (PHP på waxml.org via FileZilla) kräver att Hans gör manuella steg för att kollegan ska kunna testa
en uppgift i Canvas. Målet för första versionen: **kollegan publicerar en uppgift i WAW och får en LTI-adress som
fungerar direkt, utan att Hans rör något.**

## Beslut
- **Stack:** Node (ESM, vanlig JS utan byggsteg, så som resten av projektet) + Postgres + objektlagring. Servern kör
  `js/assessment/evaluate.js` och `targets.js` direkt, så `Evaluate.php`, `Targets.php` och paritetsvektorerna behövs inte längre.
- **Namn:** WAW behålls. Domäner: `waw.audio` för appen (förstahandsval; `waw.app` är upptaget) och `wawplayer.audio` för spelaren och filerna. `waxml.org` tillhör open source-projektet och används inte för tjänsten.
- **Juridisk enhet:** Empowering Leadership Sweden AB (avtalspart för kunder, Stripe och personuppgiftsbiträdesavtal).
- **Konton och roller:** WAW-konto = identitet för den som skapar (lärare och studenter kan båda ha det). Roller i en kurs
  kommer alltid från LMS:ets `roles`-claim vid varje launch — samma person kan vara student i en kurs och lärare i en annan.
  LTI-användare (`platform + sub`) och WAW-konton är skilda identitetsrymder och slås inte ihop automatiskt.
- **Publicerade versioner är oföränderliga.** Ändring ger ny version; en inlämning hör alltid till den version den gjordes mot.
- **Plattformsregistrering:** lärare/institutioner registrerar sig själva, men bara med betald plan. Därför finns
  *entitlements* (plan → rättigheter) i datamodellen från början, även innan Stripe är på plats.
- **Ljudfiler:** alla med WAW-konto får ladda upp; LTI-användare behöver inget konto. Tillåtna typer (att bekräfta): mp3, ogg, wav,
  m4a, mpg, m4v, xml, json, js, txt, csv. Filerna lagras exakt som uppladdade (ingen normalisering, ingen transkodning — adaptiv musik
  och sömlösa loopar). Innehållsadresserad lagring (hash).
- **Delning/embed ingår.** AI och betalning väntar tills grunden står (Hans, 2026-11-06).
- **Rättigheter ≠ isolering.** Separata domäner skyddar appens nycklar från projektets kod. *Vem som får spela* avgörs av servern med en signerad,
  tidsbegränsad **biljett** per projektversion; filerna ligger bakom signerade adresser. Nivåer: offentlig, olistad (hemlig länk), bara vissa
  webbplatser (embed, `frame-ancestors`), LTI-launch (biljett från launchen), privat för vissa WAW-konton. Åtkomst styrs, kopiering går inte att
  stoppa (det vore DRM).
- **Poängutskick till Canvas som kö med omförsök**, så att en långsam Canvas aldrig hänger elevens skärm. Cachea plattformens JWKS, sätt hastighetsgränser.

## Körbart innehåll och isolering (beslutat 2026-11-09)
Bakgrund: `waxml.js` kör länkade `.js` med `eval()` och använder `eval()` även på uttryck, kommandon och argument i själva XML:en. Ett
WAXML-projekt är alltså ett program, och xml och text som länkas in är lika körbara som js.
- **WAXML (öppen källkod) förblir tillåtande:** vilken länkning som helst, som "HTML för ljud och musik". Ansvaret ligger hos den som bygger.
- **WAW kräver att filer som utvärderas ligger på WAW** (js, xml, text, json). De körs i spelarens isolerade rum och fryses (hash) vid publicering.
  Det genomdrivs med CSP i spelaren, så `waxml.js` behöver inte ändras.
- **Spelaren ligger i ett eget "rum"** (egen adress utan inloggning/cookies, helst egen domän) och bäddas in i en `sandbox`-iframe. Appens
  inloggningscookie är knuten till appens adress. Publicerade uppgifter och delade länkar körs alltid där.
- **Världens komponenter importeras, de länkas inte live:** en extern komponent (URL) hämtas vid redigeringen, sparas fryst hos WAW med källa,
  licens och version, och projektet pekar på kopian. Det ger stabilitet, spårbarhet och ett ställe att granska. Grunden för bibliotek/marknadsplats.
  Importflödet (byggs i biblioteks-/komponentfasen, inte i första molnsteget): (1) URL anges i editorn, (2) WAW hämtar och sparar en fryst kopia
  med hash, källa, hämtningsdatum och licens (en `sources`-förteckning per projekt), (3) länken skrivs om till kopian, (4) komponentens egna
  länkar importeras också, med djupgräns, (5) "Sök uppdateringar" visar en skillnad innan en ny version godkänns. Namnkrockar löses med
  prefixbyte på id:n, som för uppgiftspaketen. Samma mönster som npm, Go-moduler och lockfiler.
- **Idé för `waxml.js` (Hans beslut, ej påbörjad):** ett `integrity`-attribut efter HTML:s modell, t.ex. `<include href="https://…" integrity="sha256-…" />`.
  Runtime vägrar köra filen om hashen inte stämmer. Då kan live-länkning fortsätta i den öppna världen utan att en ändrad fil körs, och
  WAW-importen fyller i hashen automatiskt.
- **Externa ljudfiler:** tillåtna bara i fri delning och embeds. LTI-uppgifter använder bara filer på WAW.
- **Editorn:** importerade projekt med kod ger en varning. Att köra förhandsvisningen alltid i spelarens rum är en senare, större ombyggnad.

## Leverantör och kostnader (research 2026-11-11, priser per 30 dagar exkl. moms, avlästa ur Clever Clouds kalkylator)
Rekommenderad första kandidat: **Clever Cloud** (EU/Frankrike, git-deploy, Node + Postgres + Cellar hos samma leverantör, kostnadsspärr, provkrediter
utan kort). Kunskapen om dem kommer nästan helt från deras egna sidor; ingenting är provkört. Valet är billigt att ändra eftersom stacken (Node,
Postgres, S3-API) är standard.
- Node: `pico` 256 MB 4,50 €, `nano` 512 MB 6 €, `XS` 1 GB 16 €, `S` 32 €. PostgreSQL: `DEV` (delad, 5 anslutningar) 0 €, `XXS` från 4,90 €, `XS Small` (1 GB, 5 GB disk) 19,50 €.
- Cellar: lagring 0,02 €/GB, **utgående trafik 0,09 €/GB** (ca tio gånger Bunny.net, 0,01 USD/GB i Europa/Nordamerika). Cloudflare R2 har gratis utgående trafik.
- Förslag för att börja: staging = Node `pico`/`nano` + Postgres `DEV`; produktion = Node `nano` × 2 + Postgres `XS Small`; Cellar 100 GB. Totalt ca 40 €/månad
  (ca 450 kr). Vid prov med 1000 elever räcker troligen 2 × `XS` (ca 55–70 € totalt); skalning är att lägga till instanser.
- Trafik är liten för ljud (Elgitarrtestet 0,56 MB; 1000 elever ≈ 1 GB). Video (mpg/m4v) är kostnadsrisken, så sätt tak per konto. Byt till Bunny
  för leverans när trafiken växer. Bunny är slovensk, vilket är lättare ur GDPR-synpunkt än en amerikansk CDN.
- Domännamn säljer Clever Cloud inte: köp hos en registrar och lägg en CNAME-post (t.ex. `app.waw.audio`) mot Clever Clouds adress. På rotdomänen går inte
  CNAME. Gratis testadress finns (`*.cleverapps.io`, bara för test).
- Deploy: GitHub-integration, så `main` → staging och `release` → produktion (var och en är en egen app som följer sin gren). Migreringar körs vid start.

## Tjänster
1. Hosting för Node med git-deploy, staging + produktion, HTTPS, eget domännamn.
2. Hanterad Postgres med automatisk backup (inkl. återställning till tidpunkt) och migreringar.
3. Objektlagring + CDN för ljud; användarfiler serveras från en **separat domän** utan cookies (`X-Content-Type-Options: nosniff`,
   Content-Type ur en vitlista, aldrig körbart i appens origin) — särskilt viktigt för `.js`, `.xml` och `.json`.
4. E-post (transaktionell).
5. CI (GitHub Actions): tester + deploy. Staging uppdateras automatiskt, så kollegan kan testa mot Canvas utan Hans.
6. Felrapportering och uptime-övervakning.
7. Senare: Stripe, Anthropic API (nyckel på servern, kvot per lärare), sökindex för biblioteket (Postgres fulltext räcker).

## GDPR med så lite strul som möjligt
- EU-ägd leverantör och EU-region (undviker överföringar till tredje land).
- LTI: lagra bara pseudonymt `sub`, poäng och elevens svar. Begär inte namn eller e-post i launchen.
- Hans är personuppgiftsbiträde åt institutionerna: ett personuppgiftsbiträdesavtal (DPA) behövs som mall, plus gallringsregel
  (förslag: konfigurerbar per institution) och radering på begäran.
- Vad som sparas i molnet utöver poäng och kommentar (som skickas till Canvas): de slumpade målvärdena och elevens exakta svar, per publicerad version. Slumpmålen kan räknas om från seed, men sparas ändå.
- "Alltid kvar" går att kombinera med GDPR genom att pseudonymisera i stället för att radera: efter gallringstiden byts `sub` mot en engångshash så att posten inte längre går att koppla till en person och kan finnas kvar för statistik. Gallringstiden bestäms av institutionen i biträdesavtalet. Kontrollera avtalsmallen med jurist.
- Konton (e-post) är personuppgifter; ingen annan elevdata samlas in.

## Ordning
1. **Publicera utan manuella steg:** Publish-knapp (zip-löst: projektet lagras på servern), facit till DB, launch-URL visas.
   LTI-koden flyttas från PHP till Node med samma testfall.
2. Konton, roller, entitlements, plattformsregistrering.
3. Ljudlagring + uppladdning med rättighetsbekräftelse (vem/när/villkorsversion), bibliotek och sökning.
4. Deep Linking, sedan Activity-skiktet (line-item-tabell, elev-state) enligt Activity-dokumentet.
5. Stripe, AI-assistent, embed-statistik.

Prototypen på waxml.org körs tills den nya står och provats mot KMH:s Canvas.
