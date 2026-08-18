# WAXML Workstation — Teknisk spec

Version: utkast efter arkitektur-genomgång i Claude web chat.
Nästa steg: implementation i Claude Code (Steg 0 / Demo).

---

## 0. Fasindelning

| Fas | Innehåll | Backend krävs? |
|---|---|---|
| **Steg 0 — Demo** (NY) | Klientbaserad prototyp av filhanterare + preview, session i RAM, för användartester med studenter | Nej |
| **Steg 1 — MVP** | Konton, grupper, riktig filhanterare (PHP/MySQL), delning (playback/embedded/full), preview | Ja |
| **Steg 2** | Grafisk + kodbaserad XML-editor (kopieras in från befintlig Lovable-prototyp) | Ja |
| **Steg 3** | DAW-fönster: timeline/arrangement med tracks och segment | Ja |

Steg 0 är tillagt efter arkitekturdiskussionen och går före allt annat: syftet är att validera GUI/UX-flödet för filhantering och ljuduppspelning med riktiga användare (studenter) innan konton, betalning och en riktig backend byggs.

---

## 1. Steg 0 — Demo: klientbaserad arkitektur

### 1.1 Syfte
Låta studenter testa filhanterings- och preview-delarna av UI:t utan inloggning, utan riktig lagring, och utan att Hans behöver bygga backend först. Fungerar som ett labb för att stämma av UX-beslut tidigt.

### 1.2 Grundprincip: allt i RAM, ingen persistence
- Uppladdade filer hanteras som `File`-objekt direkt från drag-and-drop eller `<input type="file">` — lämnar aldrig klienten.
- Ljudpreview/waveform via `URL.createObjectURL(file)` + Web Audio API.
- Zip-filer packas upp klientsidan med JSZip.
- Mapp/fil-strukturen hålls i ett träd i minnet (samma form som den framtida `folders`/`files`-datamodellen, se avsnitt 6).
- **Ingen backend behövs i denna fas** — hela demot kan hostas statiskt.

### 1.3 VFS-abstraktion (viktig för att undvika slit-och-släng-kod)
Bygg en tunn modul med samma metodsignaturer som den framtida PHP-API:n kommer ha:

```
listFolder(id)
createFolder(parentId, name)
uploadFile(parentId, file)
rename(id, newName)
delete(id)
moveFile(id, newParentId)
```

I Demo-fasen implementeras dessa mot ett JS-objekt i minnet. När backend byggs (Steg 1) byts bara *implementationen* ut mot `fetch()`-anrop — resten av GUI:t rörs inte. Detta är samma idé som ett repository-pattern.

### 1.4 Kända begränsningar i Demo-fasen
- Refresh/stängd flik = allt försvinner. Visa tydlig varning via `beforeunload`.
- Delning/embed (kräver persistenta länkar) testas inte i denna fas.
- Stora zip-filer packas upp i webbläsarens RAM — inget problem för studenttest, men inte representativt för stora produktionsbibliotek.

### 1.5 Export-flöde (dubbla URL-lager)
Varje fil i VFS:en har två adresser:

1. **Session-URL** (för live-preview i demot): `URL.createObjectURL(file)` — en riktig `blob:`-URL som WAXML kan spela upp direkt.
2. **Export-URL** (för WAXML-koden studenten kopierar ut): en relativ sökväg byggd genom att gå från filen till roten i VFS-trädet och slå ihop mappnamnen, t.ex. `drums/kick.wav`. Detta matchar hur WAXML redan tolkar relativa sökvägar (relativt `wa.xml`-filens plats), så en exporterad `wa.xml` blir direkt användbar när studenten senare hostar filerna på riktigt.

Valfri utökning: en "Exportera projekt som ZIP"-knapp som buntar ihop de riktiga `File`-objekten tillsammans med den genererade `wa.xml`, i exakt samma mappstruktur — ett komplett, redo-att-hosta-paket.

---

## 2. WAXML-integration i Demo-fasen

### 2.1 Uppstart
`WebAudioXML.js` inkluderas **statiskt** i sidans `<head>`, med en minimal tom `<audio version="1.0"></audio>` som `data-source` (t.ex. som en `data:text/xml,...`-URI). Detta gör att bibliotekets normala `window`-`"load"`-gated initiering fungerar helt naturligt, utan hack.

### 2.2 Omladdning av innehåll
All efterföljande uppdatering av ljud-/kompositionsinnehåll (t.ex. när en student väljer en ny fil) sker via WAXML:s egen metod:

```js
waxml.updateFromString(xmlString)   // returnerar en Promise
```

**Inte** genom att skapa/ta bort `<script>`-element eller trigga syntetiska `window`-eventer — det introducerar race conditions mellan flera parallella `WebAudio`-instanser (se avsnitt 3, känd historik).

### 2.3 AudioContext / user gesture
Webbläsare kräver en användarinteraktion för att starta ljud. Demot sätter varken `interactionArea` eller `data-waxml-pointer`, så WAXML:s automatiska resume-koppling triggas aldrig. Lösning: anropa `waxml.init()` explicit i klick-hanteraren för en tydlig "Spela"/"Starta ljud"-knapp:

```js
waxml.init();   // resumar suspended AudioContext, no-op om redan igång
waxml.trig(".test");
```

### 2.4 Trigger-API (bekräftat)
```js
waxml.trig(selector)   // t.ex. waxml.trig(".test") — triggar alla matchande noder, inkl. <arrangement>
waxml.stop(selector)
```
Fungerar över både vanliga ljudnoder (`AudioBufferSourceNode`) och `<Composition>/<arrangement>` samtidigt, via delad `class`- eller `id`-selector.

### 2.5 Sökvägsupplösning — vad som är känt att fungera
- `Loader.getPath(url, localPath)` avgör absolut/relativ genom att kolla om strängen innehåller `"//"` — täcker `http(s)://`, och även `blob:https://...` (som alltid innehåller ett inbäddat `https://`).
- `Loader.loadAudio()` använder `fetch()`, som stödjer `blob:`-scheman transparent.
- Riktiga relativa filer (t.ex. `Aa.mp3`) ska **inte** kombineras med en trasig `localpath` i produktion — värt att komma ihåg om test-XML återanvänds med skarpa mappstrukturer.

---

## 3. Buggar i WebAudioXML.js — identifierade och åtgärdade under detta arbete

| # | Plats | Problem | Status |
|---|---|---|---|
| 1 | `BufferSourceObject.js`, `set src()` | Rå strängkonkatenering (`localPath + src`) istället för `Loader.getPath()` — dubbelprependade eller korrumperade absoluta URL:er (inkl. `blob:`) | ✅ Patchad |
| 2 | `musical-structure/Wave.js`, `set src()` | Samma mönster som #1 | ✅ Patchad |
| 3 | `Music.js`, `addSuffix()` | La på en felaktig filändelse (`.mp3` etc.) på `blob:`/`data:`-URI:er baserat på en naiv koll av de fyra sista tecknen | ✅ Patchad |
| 4 | `Parser.js`, `loadXML()` | Embedded-XML-grenen (`if(this._xml){...}`) anropade aldrig `resolve()` — `parser.init()` hängde sig för evigt vid inbäddad XML. Rest av en pre-Promise-implementation (`//Loader.checkLoadComplete()`) | ✅ Patchad |

**Känt, ej åtgärdat (medvetet nedprioriterat):**
- `addSuffix()`/`loadFile()` i `Music.js` använder fortfarande den äldre, separata path-resolution-vägen (inte `Loader.getPath()`). Fungerar idag, men är en dubblerad kodväg. Hans har en pågående, större omskrivning av hela paketet planerad — lämnas orört tills dess, med en note-to-self-kommentar i koden.

---

## 4. `<Composition>` — integrerad musikstruktur

Den tidigare separata `<imusic>`-strukturen (motiv, sektioner, arrangement — laddad via ett fristående `data-music-structure`-attribut) är nu integrerad som ett barn-element till root-noden:

```xml
<audio version="1.0">
    <AudioBufferSourceNode id="ljud1" class="test" src="Aa.mp3" />
    <Composition>
        <arrangement class="test" tempo="144" timeSignature="4/4">
            <track id="track1" loopLength="16" src="audio/drums.mp3"/>
        </arrangement>
    </Composition>
</audio>
```

- Root-elementet `<audio>` kommer i en framtida version heta `<waxml>`.
- Två separata parsers samexisterar i denna version (`Parser.js` för huvudgrafen, `MusicParser` för `<Composition>`) — ett medvetet mindre omfattande ingrepp, inte en fullständig sammanslagning av loading-pipelines.
- `Parser.js` har fått en guard som hoppar över `<Composition>`-noden i den vanliga ljudnods-genomgången.
- `updateFromString()`/`initFromString()` bygger nu om **båda** graferna (ljud + komposition) vid varje anrop.
- Cleanup/uppstädning av gamla iMusic-noder vid omladdning är ett känt uppföljningsjobb (Hans äger detta).

---

## 5. GUI-layout (gäller fullt ut från Steg 1, delmängd byggs i Steg 0)

Fyra vertikala, individuellt visa/dölja-bara paneler med justerbar bredd:

1. **Filhanterare** *(Steg 0: byggs i RAM-version; Steg 1: kopplas till riktig backend)*
   - Skapa/organisera/ladda upp/radera/döp om filer och mappar
   - Drag-and-drop eller upload-knapp
   - Zip-filer packas upp automatiskt med mappstruktur bevarad
   - Tillåtna filtyper: mp3, wav, ogg, m4a, WAXML-filer, eller zip med dessa
   - Knuten till ett "projekt" (Steg 1+)
   - Markerad ljudfil → mediaspelare med waveform i preview-fönstret
   - Markerad XML-fil → öppnas i XML-fönstret (Steg 2)
   - Ljudfiler kan dras till andra paneler (skapar referenser)
   - Individuell delning via absoluta länkar (Steg 1+)
   - Lagringsgräns per användare (Steg 1+)

2. **Grafisk XML-editor** *(Steg 2)* — visar XML-hierarki grafiskt, kopplad till XML-schema för redigeringsregler. Bas finns redan till 80 % i en Lovable-prototyp.

3. **XML-kod** *(Steg 2)* — synkad med den grafiska editorn, färgkodad mot mörk bakgrund.

4. **Preview** *(Steg 0: byggs för enskild ljudfil; Steg 3: full timeline)*
   - Ljudspelare för markerad fil
   - Timeline med tracks/segment om vald i XML-editorn (Steg 3)
   - Grafisk representation av markerad komponent (signalkedja, WAM-modul, mixer, etc.) (Steg 3)

---

## 6. Datamodeller (Steg 1+)

- **Användare**: Admin (allt), Manager (organiserar användare/grupper), Användare (egna projekt). Lagringsgräns per användare, satt av manager (default 100 Mb).
- **Grupper** (nästlingsbara): Admin organiserar toppnivå, Managers kan skapa undergrupper i tilldelade grupper. Lagringsgräns per grupp.
- **Projekt**: initieras alltid med ett default `wa.xml`. Kan sparas som mallar och delas. Filhanterare knuten 1:1 till projekt.
- **WAXML-objekt**: hanteras av WAXML.js (extern, färdig). Applikationens jobb är GUI för dessa objekt, inte logiken bakom dem. Mest avancerade objektet: `<Composition>/<arrangement>` (tidigare "timeline"), med tracks, segment, master.

Databasskiss (Steg 1, matchar VFS-metoderna från avsnitt 1.3):

```sql
CREATE TABLE folders (
  id INT PRIMARY KEY AUTO_INCREMENT,
  parent_id INT NULL,
  name VARCHAR(255),
  user_id INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE TABLE files (
  id INT PRIMARY KEY AUTO_INCREMENT,
  folder_id INT NULL,
  original_name VARCHAR(255),
  stored_name VARCHAR(255),  -- UUID + extension, aldrig originalnamnet på disk
  mime_type VARCHAR(100),
  size_bytes INT,
  user_id INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);
```

---

## 7. Kärnfunktionalitet per fas

- **Steg 0 (Demo)**: filhanterare (RAM) + preview av enskild ljudfil + WAXML-uppspelning av genererad `wa.xml` (inkl. `<Composition>`).
- **Steg 1**: konton/projekt/filhanterare mot riktig backend. Delning i tre format (playback, embedded, full) med rättighetsnivåer (visa/redigera/ladda ner). Embed-version styrbar via WAXML-kommandon från värdsidans script.
- **Steg 2**: grafisk + kodbaserad XML-editor.
- **Steg 3**: fullt DAW-fönster.

---

## 8. Interaktionsflöde (exempel, gäller Steg 1+)

1. Admin skapar grupp + manager, kopplar ihop dem.
2. Manager skapar användare i gruppen.
3. Användaren skapar projekt → default `wa.xml` initieras.
4. Lägger till/redigerar `<Composition>/<arrangement>`, sätter id, tempo, taktart.
5. Drar filer till filhanteraren och/eller direkt till preview/arrangemang → skapar track/segment-referenser.
6. Projektet autosparas kontinuerligt.
7. Delas via länkar för respektive format, med valda rättigheter.

*(I Steg 0/Demo motsvaras detta av: välj/dra fil → generera `wa.xml`-sträng med blob-URL → `updateFromString()` → trigga uppspelning.)*

---

## 9. Tekniska beslut

- **Backend (Steg 1+)**: PHP + MySQL.
- **Frontend**: vanilla JS. Web Components för återanvändbara komponenter.
- **Steg 0 (Demo)**: ren klient, ingen backend. Kan hostas statiskt.
- **WAXML.js**: driver ljud-/musiklogik. Endast GUI byggs i detta projekt.
- **Embed-stöd**: projekt ska kunna styras från en värdsidas eget script via den globala `waxml`-variabeln.
- **Språk i GUI**: engelska, genomgående.
- **Betalning (Steg 1+)**: Stripe (eller likvärdigt). Nivåer: Free (1 användare, 5 Mb), PRO (1 användare, 100 Mb, 10 $/mån), Organisation (flera användare, 1000 Mb totalt, 100 $/mån). Automatiskt konto + grupp + lagringsutrymme vid godkänd betalning, hanterat av manager vid signup.

---

## 10. Öppna frågor att lösa innan/under Steg 1

- Zip-uppackning: spegla mappstruktur 1:1 eller platta ut? Namnkrock-hantering?
- Lagringsgräns: mätt per user+group tillsammans eller separat? Hård eller mjuk gräns vid överskridande?
- Delade länkar: publika utan auth, eller signerade/tidsbegränsade?
- Nedgradering (Stripe): blockera uppladdning automatiskt vid överskriden lagring, eller bara flaggning?
- Autosave: periodisk, per-interaktion, eller explicit spara-knapp?
