# LTI-lagret (PHP, för waxml.org)

Det här är serversidan som låter en uppgift i WAW öppnas från Canvas (LTI 1.3) och
skicka tillbaka poäng och kommentar till betygsboken. Den är skriven i vanlig PHP utan
beroenden (inget Composer), för ett webbhotell med PHP 8.x, MySQL och `openssl`/`curl`
(waxml.org har det).

```
Canvas ──login──▶ login.php ──▶ (Canvas loggar in eleven) ──launch──▶ launch.php
                                                                       │ kontrollerar Canvas signatur
                                                                       ▼
                         viewer.html?project=…&view=…&lti=<token>&api=…/done.php
                                                                       │ eleven gör uppgiften, trycker Done
                                                                       ▼
 betygsboken ◀── poäng + kommentar ◀── done.php (räknar om poängen på servern)
```

Vad som ligger var:

| Fil | Uppgift |
|---|---|
| `login.php` | Canvas anropar den först ("OIDC login") |
| `launch.php` | Canvas postar den signerade launchen hit; eleven skickas vidare till viewern |
| `jwks.php` | Verktygets publika nyckel (Canvas använder den för att kontrollera poängen) |
| `done.php` | Viewerns Done: räknar om poängen, sparar, skickar till betygsboken |
| `admin.php` | Kontrollsida: adresser, Canvas-inställningar, registrera Canvas, ladda upp facit, se resultat |
| `lib/` | Koden (`Lti`, `Jwt`, `Evaluate` …). Skyddad av `.htaccess`. |
| `tests/` | Tester. Behövs **inte** på servern. |
| `config.sample.php` | Mall för `config.php` |

## Installera på waxml.org (med FileZilla)

1. **Databas.** Skapa en MySQL-databas i one.coms kontrollpanel (avsnittet för databaser).
   Skriv upp *värdnamn, databasnamn, användare och lösenord*.
2. **Config.** Kopiera `config.sample.php` till `config.php` (på din dator), öppna den i en
   textredigerare och fyll i:
   - `db` – uppgifterna från steg 1
   - `token_secret` och `admin_key` – två långa slumpmässiga strängar. I Terminal:
     `openssl rand -hex 32` (kör två gånger).
   - `allowed_origins` – adressen (utan sökväg) till sidan där `viewer.html` ligger.
   - `viewer_url` – hela adressen till `viewer.html`.
3. **Ladda upp.** Skapa mappen `lti` i den publika mappen (`httpd.www`) på servern och ladda
   upp: `login.php`, `launch.php`, `jwks.php`, `done.php`, `admin.php`, `config.php` och mappen
   `lib/` (med dess dolda fil `.htaccess` – slå på "visa dolda filer" i FileZilla under *Server*-menyn
   om den inte syns). `tests/` och `config.sample.php` behövs inte.
4. **Öppna kontrollsidan:** `https://waxml.org/waw/lti/admin.php?key=DIN_ADMIN_KEY`. Första gången
   skapas tabellerna och verktygets nyckel. Spara adressen till kontrollsidan privat.
5. **Canvas.** (Kräver att någon har rätt att skapa en *Developer Key*.)
   - Admin → Developer Keys → + Developer Key → + LTI Key → *Method: Paste JSON*, klistra in
     JSON-rutan från kontrollsidan.
   - Slå på nyckeln och notera dess **Client ID** (siffran i listan).
   - Installera verktyget i kontot eller kursen (Settings → Apps → + App → *By Client ID*).
     Då visas ett **Deployment ID**.
   - På kontrollsidan, avsnitt 2: lägg till plattformen med Client ID (och gärna Deployment ID).
     Adresserna som är ifyllda gäller Canvas Cloud; har skolan en egen Canvas-adress är de andra.
6. **Facit.** Exportera projektet med *Export → Public pages → Export for publishing*. Det ger
   `namn.zip` (utan bedömningen) och `namn.assessment.json`. Klistra in innehållet i
   `namn.assessment.json` på kontrollsidan, avsnitt 3, med projektnamn `namn`.
7. **Publicera.** Lägg `namn.zip` i `public/` i WAW-repot, kör
   `node scripts/build-template-manifest.js`, committa och släpp (så att sidan som viewern ligger på
   har både `viewer.html` och zippen).
8. **Länken till uppgiften** (det läraren skriver i Canvas) är
   `https://waxml.org/waw/lti/launch.php?project=NAMN&view=VY-ID`. VY-ID syns i adressen på
   fliken *Public pages*.

## Viewern: var ligger den?

Eleven skickas till `viewer_url` i `config.php`, och zippen hämtas från `public/` bredvid den.
Två sätt:

- **En kopia på waxml.org** (rekommenderas för provning): ladda upp `viewer.html`, `waxml.js`,
  mapparna `css/`, `js/` och `schemas/` samt `public/` (med uppgifternas zip-filer) till
  `waxml.org/waw/`. Då är viewern och verktyget på samma sida, och studenternas sida på GitHub
  berörs inte. Kopian måste uppdateras för hand när viewerns kod ändras.
- **GitHub Pages:** sätt `viewer_url` till viewerns adress där, och lägg dess adress i
  `allowed_origins`. Kräver att `viewer.html` och zippen finns i den gren som Pages visar
  (`release`).

Adressen till verktyget är `base_url` (här `https://waxml.org/waw/lti`); den står också i
`js/viewer.js` (`LTI_API_PREFIXES`) och måste vara densamma.

## Bra att veta

- **Facit.** Bedömningen räknas om på servern av det värden sidan mätte, så ingen kan skicka ett
  påhittat betyg. Men *referensen* i ett jämförelseproblem (till exempel filter A:s inställningar)
  finns i själva ljudgrafen i zippen och kan alltså läsas av den som tittar. Det som hålls
  hemligt är toleranser, mål och kommentarer.
- **Placeringarna i Canvas-JSON:en** (`assignment_selection`, `link_selection`) är min bästa
  tolkning av Canvas dokumentation och är inte provade mot ett riktigt Canvas. Visas inte verktyget
  där du väntar dig, är det raden att ändra.
- **Cookies används inte** (de är opålitliga i en iframe). En launch kopplas till sin inloggning med
  ett engångstoken i databasen, inte med webbläsaren; se kommentaren överst i `lib/Lti.php`.
- **Vilka servrar viewern får prata med** står i `js/viewer.js` (`LTI_API_PREFIXES`). Byter
  verktyget adress måste den ändras.
- **Personuppgifter.** Databasen sparar elevens LMS-id (pseudonymt), resultat och de uppmätta
  värdena. Bestäm hur länge det får finnas kvar.

## Köra testerna

Testerna kräver PHP 8.x med `openssl` och `sqlite`. Med Docker (som har rätt PHP):

```
docker run --rm --network none -v "$PWD":/app -w /app php:8.5-cli php lti/tests/run.php
```

Bedömningens testfall genereras ur JavaScript-versionen och PHP-versionen måste klara dem:

```
node scripts/make-assessment-vectors.mjs     # efter varje ändring i js/assessment/evaluate.js
```
