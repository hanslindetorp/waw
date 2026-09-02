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
| **Steg 3** | DAW-fönster: timeline/section med layers och segments | Ja |

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

Valfri utökning: en "Exportera projekt som ZIP"-knapp som buntar ihop de riktiga `File`-objekten tillsammans med den genererade `wa.xml`, i exakt samma mappstruktur — ett komplett, redo-att-hosta-paket. **Implementerad** (se 1.6 för vad den numera också bäddar in).

### 1.6 Workstation-state — separat editor-tillstånd (implementerad 2026-08-30)

GUI-tillstånd (öppna paneler, markerat element) sparas i en egen fil,
`workstation-state.json`, bredvid `wa.xml` i samma projekt/zip — **aldrig**
inuti `wa.xml` själv. Grundprincipen: `wa.xml` är "leverans"-XML och ska gå
att dela/embedda utan att UI-skräp från arbetsytan följer med.

- Samma live-synk-mönster som `wa.xml` självt (avsnitt 1.3): en riktig VFS-fil,
  hålls kontinuerligt uppdaterad, fångas av export-ZIP:ens vanliga
  mapp-vandring utan specialkod.
- Gömd i filhanteraren (användarna ska inte se eller redigera den direkt),
  men följer alltid med vid export.
- `selectedElementId` refererar elementets XML-`id`-**attribut**, aldrig ett
  internt/sessionslokalt träd-id — det senare är inte stabilt över en
  spara/ladda-cykel.
- Best-effort vid inläsning: en trasig fil, en okänd panel, eller ett
  `selectedElementId` som inte längre finns i dokumentet ignoreras tyst.
  Ska aldrig få hela projektet att krascha vid öppning.
- Valfri, ej implementerad utökning: en `<?workstation-state src="..."?>`
  processing instruction i `wa.xml` för att peka ut filen explicit (t.ex.
  om flera `wa.xml`-liknande filer någon gång behöver särskiljas) — enkel
  filnamnskonvention (`workstation-state.json` i projektroten) räcker för
  nu.

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
waxml.trig(selector)   // t.ex. waxml.trig(".test") — triggar alla matchande noder, inkl. <section>
waxml.stop(selector)
```
Fungerar över både vanliga ljudnoder (`AudioBufferSourceNode`) och `<Composition>/<section>` samtidigt, via delad `class`- eller `id`-selector.

### 2.5 Sökvägsupplösning — vad som är känt att fungera
- `Loader.getPath(url, localPath)` avgör absolut/relativ genom att kolla om strängen innehåller `"//"` — täcker `http(s)://`, och även `blob:https://...` (som alltid innehåller ett inbäddat `https://`).
- `Loader.loadAudio()` använder `fetch()`, som stödjer `blob:`-scheman transparent.
- Riktiga relativa filer (t.ex. `Aa.mp3`) ska **inte** kombineras med en trasig `localpath` i produktion — värt att komma ihåg om test-XML återanvänds med skarpa mappstrukturer.

### 2.6 Proaktiv graf-laddning, frikopplad från Play (implementerad 2026-08-30)

Ursprungligen laddades den levande grafen (`updateFromString`) lazy, först
vid första tryck på PLAY — vilket i praktiken gjorde grafens existens
beroende av att det fanns en `<Composition>/<Section>` att trigga.
Omvärderat: ett dokument behöver inte kunna "starta" för att grafen ska
vara meningsfull (en Mixers egen routing, live rattnudge, VU-metrar,
sololampor är lika verkliga utan en Composition).

- Grafen (om)laddas nu proaktivt vid **varje strukturell ändring** (element
  skapas/tas bort/flyttas) — debouncad 400ms så en serie strukturella
  ändringar i rad blir en enda omladdning. Attributändringar bygger
  fortfarande aldrig om (samma distinktion som redan fanns).
- `isPlaying` (transporten aktivt triggar något) och `isDocumentLoaded`
  (finns en levande graf att läsa/skriva mot) är nu separata flaggor —
  all live-integration (Mixerns metrar/lampor/rattnudge) gate:ar på den
  senare, inte på om PLAY någonsin tryckts.
- Säkerhetstimeout (8s) runt själva laddningsanropet: en `updateFromString()`
  som aldrig löser sig (bekräftat möjligt, se buggtabellen nedan) kärvar
  inte längre fast hela mekanismen för resten av sessionen.

---

## 3. Buggar i WebAudioXML.js — identifierade och åtgärdade under detta arbete

| # | Plats | Problem | Status |
|---|---|---|---|
| 1 | `BufferSourceObject.js`, `set src()` | Rå strängkonkatenering (`localPath + src`) istället för `Loader.getPath()` — dubbelprependade eller korrumperade absoluta URL:er (inkl. `blob:`) | ✅ Patchad |
| 2 | `musical-structure/Wave.js`, `set src()` | Samma mönster som #1 | ✅ Patchad |
| 3 | `Music.js`, `addSuffix()` | La på en felaktig filändelse (`.mp3` etc.) på `blob:`/`data:`-URI:er baserat på en naiv koll av de fyra sista tecknen | ✅ Patchad |
| 4 | `Parser.js`, `loadXML()` | Embedded-XML-grenen (`if(this._xml){...}`) anropade aldrig `resolve()` — `parser.init()` hängde sig för evigt vid inbäddad XML. Rest av en pre-Promise-implementation (`//Loader.checkLoadComplete()`) | ✅ Patchad |
| 5 | `WebAudio`, `updateFromString()` | Den inre `parser.initFromString(str).then(xml => {...})`-kedjan hade ingen `.catch()` kopplad tillbaka till den yttre Promise:ns `reject()` — kastade något inuti `.then()` (t.ex. bugg #7 nedan) blev en egen, okopplad "unhandled rejection", och den yttre Promise:n som `updateFromString()` faktiskt returnerar löste sig aldrig. Gjorde att en enda trasig/minimal dokumentstruktur kunde hänga hela laddningen för evigt, tyst | ✅ Patchad (`.catch(reject)` tillagd) |
| 6 | `Connector`, konstruktor | `setTimeout(() => xml.obj.fade(...), 1000)` antog att `xml.obj` fortfarande fanns kvar när timeouten körde — kraschade om grafen hann laddas om (t.ex. via #5/proaktiv laddning, avsnitt 2.6) inom den sekunden | ✅ Patchad (null-koll före `.fade()`-anropet) |
| 7 | `Parser.js`, `initFromString()` | Parser-error-kollen läste `this._xml.firstElementChild.tagName` — kraschade (`Cannot read properties of null`) för varje giltigt dokument vars rot-element saknar barn-element (t.ex. ett helt tomt nyskapat projekt), eftersom `firstElementChild` då är `null`. Maskerades tidigare av bugg #5 (kraschen hängde bara laddningen tyst istället för att synas) | ✅ Patchad (bytt till `xml.querySelector("parsererror")`, oberoende av dokumentets struktur) |
| 8 | WAM-host (`initWAMsWhenAllAreLoaded()` m.fl.) | Fel case i en `querySelector("wam")` mot schemats `<Wam>`, plus en ordningsbugg — WAM-initieringen kördes innan `parseXML()` hunnit fylla `this.imports` — gjorde att WAM-inserts aldrig faktiskt startade | ✅ Patchad |
| 9 | `Music.js`, `getPosition()` | Returnerade en fryst stub när `pos` var odefinierad, istället för att fråga den aktiva sektionen | ✅ Patchad (delegerar till `this.currentSection.getPosition()`) |
| 10 | `Bus`/`Motif.prototype.remove` | Definierade som pilfunktioner — fel `this`-bindning, kraschade vid teardown av grafen | ✅ Patchad |
| 11 | iMus-sidan av grafen (`Track`/`Bus`) | Ingen teardown mellan ombyggnader (ingen `.disconnect()`) — hörbar distorsion när en ny `<Layer>` lades till medan grafen redan spelade | ✅ Patchad (`remove()`-kaskad genom musikEngine-trädet) |
| 12 | `Parser.js`, `parseXML()` (`case "composition":`) | En synkron "XXX really bad hack"-rad anropade `this.waxml.musicEngine.parseXML(xmlNode)` **innan** `WebAudio`s eget `this._xml` hunnit sättas (mitt i `initFromString()`s egen trädvandring, långt före `updateFromString()`s `.then()`) — orsakade en `TypeError` i `getInputBus`/`querySelectorAll` så fort en `<Layer output="#MixChan-N">` routades till en `<Mixer>` med riktigt innehåll. Kraschen fångades tyst av appens eget reload-felhantering (bara en `console.warn`), så en `<Section>` som spelades upp efteråt räknade position i takt med rå `audioContext.currentTime` istället för från takt 1 — allvarlig bugg, hittad via ett verkligt repro-projekt (`template.zip`) 2026-09-04 | ✅ Patchad (raden borttagen; `<Composition>`-parsningen triggas nu istället efter `initAudio()` är klar) |
| 13 | `WebAudio.updateFromString()` | `resolve(xml)` kördes så fort `this.initAudio(xml)` bara hade *startats* (inte `await`ats) — en caller som väntade på `updateFromString()` trodde grafen var klar innan den async `initAudio()`/iMus-kedjan ens hunnit börja köra. Upptäcktes som en direkt följd av fix #12 (första versionen av den fixen flyttade bara `resolve()` men body:n körde fortfarande före `initAudio()` var klar) | ✅ Patchad (`resolve()` flyttad in i `initAudio(xml).then(() => {...})`) |
| 14 | `Connector.connect()`, `output`-attributets `default:`-gren | `xmlNode.obj.connect(target.obj.input)` antog att både käll- och mål-objektet redan var byggda — kunde krascha/hänga beroende på ordning efter fix #12/#13 ändrade när `Connector` körs relativt resten av grafuppbyggnaden | ✅ Patchad (null-koll: `if(xmlNode.obj && target.obj && target.obj.input)`) |
| 15 | `Music.stop`/`iMus.stop("all")` | Gick via `new Selection(myInstance, "all", defaultInstance)`, som inte tillförlitligt återställde varje sektions `playing`/`sectionStart` vid ett globalt stopp | ✅ Patchad (`selector == "all"` itererar nu `defaultInstance.sections` direkt och anropar `stopAllSounds()`/`stop()` på var och en) |
| 16 | `WebAudio.initAudio()`, variabel- och mix-selektorer | `querySelectorAll("var")` och `querySelectorAll("*[mix]")` missade element med versalt taggnamn/attribut (`<Var>`, `solo`) | ✅ Patchad (`"var, Var"` respektive `"*[mix], *[solo]"`) |

Bugg #12–16 hittades och åtgärdades tillsammans under en gemensam felsökningssession (Hans + Claude Code) 2026-09-04, utlöst av ett verkligt projekt där `<Layer output="#MixChan-N">` routade till en `<Mixer>` med riktiga `<Chain>`-effekter — se [architecture-overview.md](architecture-overview.md) för en sammanfattning ur app-sidans perspektiv.

**Känt, ej åtgärdat (medvetet nedprioriterat):**
- `addSuffix()`/`loadFile()` i `Music.js` använder fortfarande den äldre, separata path-resolution-vägen (inte `Loader.getPath()`). Fungerar idag, men är en dubblerad kodväg. Hans har en pågående, större omskrivning av hela paketet planerad — lämnas orört tills dess, med en note-to-self-kommentar i koden.

---

## 4. `<Composition>` — integrerad musikstruktur

Den tidigare separata `<imusic>`-strukturen (motiv, sektioner, arrangement — laddad via ett fristående `data-music-structure`-attribut) är nu integrerad som ett barn-element till root-noden:

```xml
<waxml version="1.0">
    <AudioBufferSourceNode id="ljud1" class="test" src="Aa.mp3" />
    <Composition>
        <section class="test" tempo="144" timeSign="4/4">
            <layer id="layer1" loopEnd="4.0.0" src="audio/drums.mp3"/>
        </section>
    </Composition>
</waxml>
```

- Root-elementet heter `<waxml>` (tidigare `<audio>` — omdöpt i schemat sedan detta skrevs). `arrangement`/`track`/`region` heter numera `section`/`layer`/`segment`; `motif`/`leadin` slogs ihop till ett enda `stinger`-element.
- Två separata parsers samexisterar i denna version (`Parser.js` för huvudgrafen, `MusicParser` för `<Composition>`) — ett medvetet mindre omfattande ingrepp, inte en fullständig sammanslagning av loading-pipelines.
- `Parser.js` har fått en guard som hoppar över `<Composition>`-noden i den vanliga ljudnods-genomgången.
- `updateFromString()`/`initFromString()` bygger nu om **båda** graferna (ljud + komposition) vid varje anrop.
- `<layer>`s gamla `loopLength`-attribut (antal takter) är ersatt av `loopEnd`, som anger en absolut musikalisk position (`bar.beat.offbeat`, t.ex. `"4.0.0"`) istället för en längd — matchar hur övriga positions-/tidsattribut i schemat redan uttrycks.
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
   - Timeline med layers/segments om vald i XML-editorn (Steg 3)
   - Grafisk representation av markerad komponent (signalkedja, WAM-modul, mixer, etc.) (Steg 3)

---

## 6. Datamodeller (Steg 1+)

- **Användare**: Admin (allt), Manager (organiserar användare/grupper), Användare (egna projekt). Lagringsgräns per användare, satt av manager (default 100 Mb).
- **Grupper** (nästlingsbara): Admin organiserar toppnivå, Managers kan skapa undergrupper i tilldelade grupper. Lagringsgräns per grupp.
- **Projekt**: initieras alltid med ett default `wa.xml`. Kan sparas som mallar och delas. Filhanterare knuten 1:1 till projekt.
- **WAXML-objekt**: hanteras av WAXML.js (extern, färdig). Applikationens jobb är GUI för dessa objekt, inte logiken bakom dem. Mest avancerade objektet: `<Composition>/<section>` (tidigare "timeline"/"arrangement"), med layers, segments, master.

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
4. Lägger till/redigerar `<Composition>/<section>`, sätter id, tempo, taktart.
5. Drar filer till filhanteraren och/eller direkt till preview/section → skapar layer/segment-referenser.
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

---

## 11. `<Mixer>` — kanalmix, solo/blend/quantize (implementerad 2026-08-30)

Tillkommen efter det att denna spec ursprungligen skrevs — inte en del av
den initiala arkitekturgenomgången, men en tillräckligt central ny
byggsten (eget GUI-fönster, eget litet API mot WAXML.js) för att höra
hemma här. Se `docs/components-reference.md` (avsnittet om
`wa-mixer-view.js`) för själva GUI-implementationen i detalj — det här
avsnittet dokumenterar kontraktet mot WAXML.js.

### 11.1 Attribut (schema)

`<Mixer>` kan ha, utöver de vanliga noduttributen:

| Attribut | Typ | Betydelse |
|---|---|---|
| `solo` | tal 0–1 (var `mix`) | Kontinuerlig kanal-väljar-position bland barnen — 0 väljer första barnet, 1 sista, jämnt fördelat däremellan |
| `blend` | tal 0–1 (var `crossFadeRange`) | Hur brett crossfadet är runt `solo`-positionen när den hamnar mellan två barn istället för exakt på ett |
| `transitionTime` | ms, 0–2000 | Hur snabbt/mjukt en solo/blend-ändring rampar in |
| `quantize` | sträng (`off`/`bar`/`beat`/taktantal/taktart/tidsvärde) | Fördröjer en solo-ändring till nästa musikaliska gräns istället för att applicera direkt |
| `selectIndex` | heltal ≥ 0 | Alternativ till `solo` — väljer ett barn exakt via index istället för en kontinuerlig position |

### 11.2 Live-API mot `<Mixer>`s waxml-objekt

Varje `<Mixer>`s barn får en egen intern `GainNode` (`obj.inputs[]`) —
crossfadet mellan dem styrs helt via detta API, kallat direkt av GUI:t när
grafen är laddad (`playerStore.isDocumentLoaded`, se avsnitt 2.6 — kräver
inte att transporten spelar):

```js
obj.solo = value          // sätter/flyttar solo-positionen (0-1); respekterar quantize internt
obj.blend = value         // sätter crossfade-bredden (0-1)
obj.transitionTime = ms   // sätter ramptiden
obj.clearSolo()           // rampar alla kanaler till unity gain omedelbart — respekterar INTE quantize, skickar aldrig "update"
obj.getChannelGain(index) // live-avläsning, 0-1, linjär amplitud (samma domän som GainNode.gain överallt annars)
```

`obj` dispatchar ett `"update"`-event när en `quantize`-fördröjd
`solo`-ändring faktiskt har applicerats — GUI:t använder detta för att
släcka sin egen "väntar på quantize"-indikator (en blinkande kant), som
annars aldrig skulle veta när det verkliga läget landat.

### 11.3 Equal-power crossfade — visuell mappning

Crossfadet mellan två kanaler är **equal-power**: vid exakt mittpunkten
mellan två kanaler har båda `gain ≈ 0.7071` (cos/sin av 45°), inte 0.5 —
det är kvadraten (**power** = amplitud²) som summerar till 1 mellan de två
inblandade kanalerna. GUI:t använder därför `gain²` (inte `gain` rakt av,
och inte en dB-omräkning) direkt som CSS-opacitet på respektive
kanals sololampa — en kanal exakt mitt i ett crossfade läses då som
exakt halvtänd (opacitet 0.5), och de två lampornas opacitet summerar
visuellt till "en lampas värde ljus" i varje position, matchande
crossfade-lagen istället för en godtycklig display-kurva.
