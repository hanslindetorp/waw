# WAW — arkitekturöversikt (nuläge)

Det här dokumentet beskriver hur appen faktiskt är byggd, som den ser ut
just nu. `WAXML-Workstation-spec.md` (samma mapp) var den ursprungliga
planen inför bygget — mycket har hänt sedan dess, så se det dokumentet som
historik/utgångspunkt och det här som fakta om nuläget. Ett syskondokument,
[components-reference.md](components-reference.md), går igenom varje fil
för sig i mer detalj; det här dokumentet fokuserar på hur delarna hänger
ihop.

Ett tredje dokument, [mixer-solo-engine-todo.md](mixer-solo-engine-todo.md),
listar vad som fortfarande saknas i `waxml.js` för att Mixerns solo-funktion
ska fungera live — värt att läsa om du jobbar vidare på Mixern.

## Vad appen är

WAW ("WAXML Workstation") är ett rent klient-baserat verktyg (Steg 0 —
inget backend än) för att bygga och förhandslyssna på "transmutable"/
adaptiv musik i formatet WAXML, som sen spelas upp av ett separat,
fristående bibliotek (`waxml.js`, i projektroten) som Hans bygger parallellt.
Appen själv skriver eller läser aldrig ljud direkt — den genererar/redigerar
WAXML-XML och skickar den till `waxml.js` för uppspelning.

Ingen ramverk: Custom Elements (`class extends HTMLElement`) + native ES
modules, inget bygg-steg (filerna serveras precis som de ligger på disk).

## De fem panelerna (utökat, 2026-09-22)

`index.html` lägger upp fem `<wa-panel>`-element sida vid sida i
`<main class="app-panels">`, var och en med ett stabilt `id` (används av
`workstation-state.js`, se nedan):

| Panel (`id`)   | Komponent            | Vad den visar |
|----------------|-----------------------|----------------|
| `inputPanel`   | `<wa-input-panel>`    | Externa live-signaler (idag: webbkamera) mappade mot `<Var>`, se eget avsnitt nedan |
| `fileManager`  | `<wa-file-manager>`   | Filträd över det virtuella filsystemet (VFS) |
| `xmlEditor`    | `<wa-xml-editor>`     | Trädvy över XML-dokumentet + Inspector för markerad nod |
| `preview`      | `<wa-preview>`        | Kontext-beroende förhandsvisning av markerad nod |
| `xmlCode`      | `<wa-xml-code>`       | Rå XML-text, tvåvägssynkad med trädet |

`inputPanel` är, precis som Code-panelen, kollapsad som standard i ett nytt
projekt — den lägger sig längst till vänster, före File Manager.

`<wa-panel>` själv (`js/components/wa-panel.js`) är en generisk
visa/dölj/resize-wrapper — kollapsad blir den en smal ikonrand och lämnar
sin bredd till närmaste expanderade panel till vänster. Har en publik
`collapsed`-getter och skickar `"collapse-change"`- och `"width-change"`-
event vid kollaps/expand respektive breddändring — båda läses av
`workstation-state.js` (se nedan) för att spara layouten.

Utöver panelerna finns `<header class="app-header">` med tre menyer —
`<wa-file-menu>` (New/Open/Save/Save As/Share...), `<wa-edit-menu>` (Undo/
Redo/Copy/Cut/Paste) och `<wa-view-menu>` (Workstation/Library (DEMO), se
eget avsnitt nedan) — men **ingen** spelkontroll längre: den globala
Play/Stop-ytan flyttade ut ur headern till en egen, alltid synlig rad
längst ner i fönstret, se nästa avsnitt.

## Bottom bar — Triggers/Variables flyttade ut ur headern (nytt, 2026-09-20)

Den globala transportytan (Play/Stop, CSS-trigger-selectorn, trigger-
shortcuts, Var-rattar) satt tidigare i `<wa-player-bar>` i app-headern.
Den ytan finns kvar (och `wa-player-bar.js` som fil är oförändrad) men
används numer **bara** av Library (DEMO)-vyns egen, minimala bottom bar
(se nästa avsnitt) — headerns instans är borta. I stället finns en ny,
alltid synlig `<wa-bottom-bar id="bottomBar">` fastspikad längst ner i
fönstret (utanför `<main>`, se `index.html`), byggd i
`js/components/wa-bottom-bar.js`, som `app.js` döljer/visar tillsammans
med `<main>` beroende på vilken top-level-vy som är aktiv (se View-menyn
nedan — bottom bar hör bara hemma i Workstation-vyn).

Två staplade rader, var och en delad i en Triggers- och en Variables-
kolumn av en gemensam vertikal delare:

- **Global rad** (alltid synlig): Play/Stop/selector-fältet och varje
  root-nivå `<Command>` (nu **både** `type="trig"` och `type="set"` — en
  "set"-knapp visar `variable=value` och anropar
  `playerStore.setVariable()` direkt, ett litet `=`-ikon skiljer den
  visuellt från en trig-knapps play-triangel) till vänster, varje
  root-nivå `<Var>`-ratt (via `<wa-var-knobs>`, se nedan) till höger.
- **Lokal rad** (visas bara när den aktuella XML-markeringen själv har
  egna `<Command>`/`<Var>`-barn): samma två kolumner, men scopeade till
  det markerade elementet i stället för dokumentroten, utan egna
  "+"-knappar. Markerar man rotelementet självt visas aldrig en
  redundant lokal rad som ändå bara skulle visa samma sak som den
  globala.

Bredden mellan Triggers- och Variables-kolumnen balanseras dynamiskt
efter faktiskt innehåll (`_recalcLayout`, körd på varje render och
fönster-resize) — mäter varje kolumns egen "ovikta" naturliga bredd
(över båda raderna) och delar tillgänglig bredd proportionellt, med golv
satt av kolumnens egna fasta kontroller (Play/Stop/fältet, eller
"+"-knappen för Var). Målet (per Hans) är att bottom bar aldrig ska
behöva scrolla i någon riktning — allt som inte får plats radbryts inom
sin egen kolumn i stället, så baren bara växer på höjden.

`wa-var-knobs.js` (`js/components/wa-var-knobs.js`) generaliserades i
samma veva till att ta ett godtyckligt scope-nod i stället för att alltid
läsa dokumentroten — `setScopeNode(nodeId)` (`null` = root) — så både den
globala och lokala raden kan återanvända samma komponent, bara riktad mot
olika `<Var>`-listor. En ratts eget värde lever aldrig i `xmlStore` (ett
`<Var>`s XML-attribut ändras aldrig av att vrida på ratten) utan bara i
komponentens egen `_values`-`Map`, och skrivs direkt till
`playerStore.setVariable()` — samma mönster som `live-property.js`s
sidokanal, se "Live-ljud utan att stoppa uppspelningen" nedan.

## De centrala singletons-modulerna

Allt state i appen går genom ett litet antal moduler som exporterar en
enda delad instans (`export const x = new X()`), var och en ett
`EventTarget` som skickar `"change"` när något ändras. Varje
komponent/panel prenumererar på de den bryr sig om och ritar om sig själv
från grunden vid varje ändring (ingen virtual-DOM-diffning, ingen
reaktivitets-framework — bara "lyssna, rendera om helt").

### `xmlStore` (js/xml-editor/xml-store.js)

Den viktigaste modulen. Håller:
- `root` — hela XML-dokumentet som ett rent, immutable-format
  träd av vanliga objekt: `{ id, tagName, attributes, children, textContent,
  parent }`. **`id` här är ett internt, sessionslokalt löpnummer**
  (`"node_7"`, från `xml-tree-ops.js`s `generateNodeId()`) — **inte** samma
  sak som XML-elementets `id`-*attribut* (`node.attributes.id`, det
  användarsynliga/redigerbara `id="Foo"`). Det interna id:t återställs och
  delas ut på nytt varje gång dokumentet omtolkas från text (`parseXmlString`),
  så det är **aldrig** stabilt över tid — spara/referera alltid via
  `attributes.id` om referensen ska överleva ett reload eller en
  text-redigering. Se `workstation-state.js` för ett konkret exempel på just
  den fällan.
- `schema` — ett parsat XSD-schema (se `schema-parser.js` nedan), driver
  Inspector-fälten, trädets "lägg till barn"-meny, m.m.
- `selectedNodeId` — internt trädid (se ovan) för vilken nod som är markerad.
  Delas av alla paneler (Inspector, Preview, XML-kod-highlight, ...).
- `codeValue` / `lineMap` — den levande genererade XML-texten plus vilka
  textrader som hör till vilken nod (för XML-kod-panelens
  markering/synk).

Alla mutationer (`updateAttributes`, `insertNewChild`, `removeNode`,
`updateTagName`, `updateTextContent`, `reparentNode`, `setCodeValue`, ...)
går via rena funktioner i `xml-tree-ops.js` och slutar med
`_syncCode()`/`_emit()`, som skickar ett `"change"`-event med ett
`detail.structural`-flagga:

- **`structural = true`** (default): kan ha ändrat *formen* på dokumentet
  (nod tillagd/borttagen/omordnad/omdöpt). `player-store.js` lyssnar
  specifikt på detta för att stoppa uppspelning och tvinga en omladdning av
  den levande ljudgrafen nästa gång man trycker Play.
- **`structural = false`**: bara ett attributvärde ändrades (`updateAttributes`,
  `updateTextContent`). Ändrar aldrig dokumentets form, så uppspelningen
  fortsätter ostört — det här är vad som gör att man kan dra i en Mixer-ratt
  eller Inspector-slider *medan* musiken spelas utan att den hackar.

### `selection` (js/state/selection.js)

Litet, separat state: vilken **VFS-nod** (fil/mapp i File Manager) som är
markerad. Helt skild från `xmlStore.selectedNodeId` (som är XML-*element*
markering) — de råkar bara heta liknande saker. Kopplingen mellan de två
görs av `document-sync.js` (se nedan): markera en `.xml`/`.waxml`-fil i File
Manager öppnar den filen för redigering i XML-panelerna.

### `vfs` (js/vfs/VFS.js)

Ett rent minnesbaserat virtuellt filsystem (mappar/filer), med samma
metodsignaturer som den tänkta framtida PHP-backend-API:n (Steg 1) ska få
— så bara implementationen behöver bytas ut sen, inte GUI-anropen. Varje
fil-nod slår in ett riktigt `File`-objekt plus en `sessionUrl`
(`URL.createObjectURL`, en `blob:`-URL) för uppspelning under sessionen.
Skickar `"change"` och `"path-change"` (den senare när en flytt/omdöpning
ändrar en fils exportsökväg — `document-sync.js` lyssnar på detta för att
hålla `src`/`source`-attribut i XML-dokumentet pekande rätt).

### `playerStore` (js/waxml-integration/player-store.js)

Globalt uppspelningsläge, oberoende av vilken Preview-vy som visas just nu
— att byta från att titta på en `<Section>` till en `<Mixer>` ska aldrig
avbryta pågående uppspelning (`wa-bottom-bar.js` äger nu start/stopp-
kontrollerna, se eget avsnitt nedan — tidigare `wa-player-bar.js` i
headern, som numer bara lever vidare i Library (DEMO)-vyns egen minimala
bottom bar; alla andra vyer bara *läser* det här state:t). Lyssnar på
`xmlStore`s `"change"`-event: en strukturell ändring stoppar uppspelning
och schemalägger en omladdning av den levande grafen (proaktivt, inte
bara lat vid nästa Play — se "Live-ljud utan att stoppa uppspelningen"
nedan, punkt 8); en icke-strukturell ändring stör aldrig pågående ljud,
men kan bära en `liveNudge`-detalj som nudgar ett Composition-sidans
levande objekt direkt (samma avsnitt, punkt 4).

`WaxmlBridge` (js/waxml-integration/waxml-bridge.js) är det enda stället
som pratar direkt med det globala `window.waxml`-objektet (biblioteket
`waxml.js` skapar). Central regel därifrån: `waxml.init()` (som startar
`AudioContext`) får bara anropas inifrån en riktig user-gesture-handler
(klick), aldrig proaktivt.

## Live-ljud utan att stoppa uppspelningen

Två saker samverkar för att en pågående dragrörelse (en Mixer-ratt, en
Inspector-slider) ska kunna både committa kontinuerligt till `xmlStore`
**och** höras direkt i den redan spelande ljudgrafen, utan att någotdera
avbryter det andra:

1. **`applyLiveProperty(nodeId, propName, value)`**
   (js/waxml-integration/live-property.js) — sätter ett värde direkt på
   motsvarande levande waxml-objekt, om ett sådant finns just nu
   (`playerStore.isPlaying`). Helt separat från `xmlStore`; `xmlStore`
   förblir alltid sanningskällan, det här är bara en "peta även på det som
   redan låter"-sidokanal. Delad mellan `wa-mixer-view.js` och
   `wa-node-inspector.js`.

2. **`gain-units.js`** (`linearRatioToDb`) — `gain`-attributet är i XML
   alltid en linjär amplitud-ratio 0–1 (1 = 0dB, 0 = -∞dB), men
   `BiquadFilterNode.gain` i Web Audio är dB-nativt medan `GainNode.gain`
   (och `Send`) är linjärt — konverteringen är `20·log10(ratio)`, **inte**
   `10·log10` (den senare är för power-ratio, inte amplitud). 0.5 linjärt
   = -6.02dB, inte -3dB. All dB-matte i appen (Mixerns rattar, Inspectorns
   live-nudge) går genom den här enda formeln så de aldrig kan divergera.

3. **`_isLocalEdit`-guard-mönstret** — det stora, återkommande knepet i
   hela kodbasen. Varje panel bygger om sig själv *helt* (`innerHTML = ""`
   + återuppbyggnad) vid varje `xmlStore`-`"change"`. Det är enkelt och
   robust — utom när panelen SJÄLV precis skrev ändringen som orsakade
   eventet, och användaren fortfarande håller in musknappen på en kontroll
   som nu skulle rivas och byggas upp på nytt mitt i draget (webbläsarens
   pointer-capture följer inte med till det nya elementet — draget bryts
   tyst halvvägs). Lösningen, redan etablerad i `wa-node-inspector.js`
   innan Mixern fick sin egen, återanvänd i `wa-mixer-view.js`:
   ```js
   this._isLocalEdit = true;
   xmlStore.updateAttributes(node.id, { ...attrs, foo: v }); // "change" fires synchronously
   this._isLocalEdit = false;
   ```
   och i panelens egen `"change"`-lyssnare:
   ```js
   xmlStore.addEventListener("change", () => {
       if (this._isLocalEdit) return; // skippa bara SITT EGET återritande
       this.render();
   });
   ```
   Skriften går ut som vanligt till `xmlStore` och alla ANDRA lyssnare
   (kodpanelen, trädet, andra preview-paneler) — bara panelens egen
   rebuild hoppas över. Gäller bara kontroller med en egen, oberoende
   visuell uppdateringsväg (en ratt som roterar sig själv via CSS-transform,
   en slider vars `value` redan är satt av webbläsaren) — inte
   klick/select-baserade kontroller vars visuella korrekthet helt beror på
   en full omritning (en `<select>`, en knapp med `.active`-klass satt vid
   byggtid).

4. **Live-nudge-`ALLOWLIST` för Composition-sidan** (utökat, 2026-09-08/09)
   — utöver Mixerns/Inspectorns `applyLiveProperty`-sidokanal (punkt 1)
   finns en *andra*, nyare live-väg specifikt för `<Section>`/`<Layer>`/
   `<Stinger>` (`XmlStore.LIVE_NUDGEABLE_COMPOSITION_TAGS`), som numer
   alla exponerar ett generiskt `.set(param, value)` på `waxml.js`-sidan.
   `xmlStore.updateAttributes()` bygger en `liveNudge`-detalj
   (`_buildLiveNudge`) på `"change"`-eventet när ändringen stannar
   icke-strukturell, och `player-store.js` läser den och anropar
   `.set()` direkt på det levande objektet (`_applyLiveNudge`) — ingen
   omladdning. Vilka attributnamn som faktiskt får nudgas live är en
   **allowlist**, inte en denylist (`XmlStore.LIVE_NUDGE_ALLOWED_ATTRS`:
   `changeOnNext`, `cuePoint`, `randomOffset`, `upbeat`, `active`,
   `fadeTime`, `tags`, `blockRetrig`, `release`, `pan`, `filter`, `delay`,
   plus `gain` — konverterad dB↔linjärt via `gain-units.js` och skickad
   som `.set("volume", ...)`) — per Hans (2026-09-09): ett tidigare
   denylist-baserat försök missade tyst `length` (ingen case för det i
   `waxml.js`s egen `.set()`-switch), så designen vändes om: allt som
   inte är känt säkert tvingar i stället fram en full ombyggnad
   (`_attributeChangeNeedsRebuild`). `mute` är ett särfall — den går
   alltid via `<Section>`/`<Stinger>`-vyns egen dedikerade
   `setMuteState(0|1)`-anrop (se Section Preview nedan), aldrig genom det
   här generiska spåret. `loopEnd` togs medvetet BORT från allowlistan
   igen (2026-09-10) — `waxml.js`s `Track`-konstruktor löser bara ett
   *ärvt* `loopEnd` en gång, vid konstruktion, så en live `.set()` på en
   förälder aldrig når ett redan spelande, ärvande barn.
5. **`$var`-referenser tvingar alltid full ombyggnad.** Ett attribut vars
   värde blir (eller slutar vara) en `"$namn"`-referens till ett `<Var>`
   (`isVariableControlled`, `xml-editor/variable-references.js`) räknas
   som strukturellt även om det annars skulle kvalat för en live-nudge —
   `waxml.js` kopplar bara upp den där referensens egen Watcher genom att
   gå igenom hela dokumentet på nytt (`Parser.parseXML`/
   `updateFromString`); en ren live-property-nudge skickar bara den
   bokstavliga `"$namn"`-strängen till nodens egen setter, som tyst
   avvisar den. Samma mekanism gäller `ROUTING_REBUILD_ATTRS`
   (`output`/`input`/`bus`) och `OscillatorNode`s `type` — inget av det
   har en fungerande live-motsvarighet i `waxml.js` alls.
6. **`xmlStore`s enda UI-koppling: `"notice"`-eventet** (nytt, 2026-09-22).
   Modulen är annars strikt UI-agnostisk (varje vy bara lyssnar på sitt
   eget `"change"`) — ett undantag: `_applyActiveFadeTimeWorkaround`
   (nästa punkt) skickar `dispatchEvent(new CustomEvent("notice", ...))`
   för ett meddelande som måste nå användaren direkt, inte bara trigga en
   omritning. `app.js` kopplar in den mot `showNotice()`
   (`wa-notice-dialog.js`, en enkel OK-popup, samma
   backdrop+dialog-stomme som `wa-file-conflict-dialog.js`).
7. **`active`/`fadeTime`-workaround för `<Layer>`** (nytt, 2026-09-22):
   en känd `waxml.js`-bugg gör att `active` bara faktiskt slår igenom när
   `fadeTime` är exakt `"0"`. Varje ändring av `active` på en `<Layer>`
   (aldrig ett värde den redan hade, aldrig ett borttaget `active`) sätter
   därför `fadeTime="0"` i **samma** attributskrivning
   (`_applyActiveFadeTimeWorkaround`) — och forceras dessutom till en
   full omladdning i stället för en live-nudge
   (`_attributeChangeNeedsRebuild`s egen kod för samma fall), eftersom en
   ren `.set("active", ...)` inte räcker för ett redan spelande spår.
   Första gången det händer i en session visas en engångspopup via
   `"notice"`-eventet ovan, så fadeTime-ändringen inte misstolkas som en
   egen, oavsiktlig redigering.
8. **`playerStore` laddar grafen proaktivt, inte bara vid första Play**
   (utökat). `isDocumentLoaded` (skild från `isPlaying`) är det nya,
   bredare "finns det en levande graf att läsa/skriva mot alls"-läget —
   varje strukturell `xmlStore`-ändring schemalägger en omladdning
   (400ms debounce, `_scheduleReload`) oavsett om något spelar. Det gör
   att t.ex. Mixerns VU-mätare, solo-lampor och `wa-var-knobs.js`s rattar
   är meningsfulla även innan användaren någonsin tryckt Play. `play()`
   väntar in en redan pågående omladdning i stället för att bara
   konstatera att en var på gång — en bugg (per Hans, 2026-09-04) lät
   Play/trig köra före grafen faktiskt var redo.

## Projektets livscykel (Ny / Öppna / Spara / Dela) (utökat, 2026-09-03/18)

Allt går genom `js/project/project-manager.js`, anropat från
`wa-file-menu.js` (New/Open/Save/Save As/Share...) och, för Export, från
Share-dialogens `wa-api-view.js`:

- **`createDefaultProject()`** — nollställer `vfs`, skapar ett tomt
  `wa.xml` (rot-elementet läses från schemats `rootElements[0]`, inte
  hårdkodat), lägger en `audio/`-mapp, och initierar
  `workstation-state.json` (se nedan).
- **`openProjectFromFile(file, handle)`** — `.zip`: packas upp via
  `js/vfs/zip-import.js` (JSZip, whitelist av filändelser — se
  `SUPPORTED_EXTENSIONS`), letar sen efter `wa.xml` i roten (case-
  insensitive, med fallback till första `.xml`/`.waxml`-filen den hittar).
  En enstaka `.xml`-fil: laddas direkt utan zip-uppackning. `loadTemplate(name)`
  gör motsvarande men från `templates/`-mappen i stället för en zip — se
  "File-menyn" nedan för varför den funktionen numer saknar en anropande
  meny-post.
- **`saveProject()` / `saveProjectAs()`** (nytt, 2026-09-03) — den vanliga
  "Save"/"Save As...": bygger projektets **egna** zip
  (`buildProjectZipBlob()` — hela `vfs`-trädet, `workstation-state.json`
  inkluderat, för en senare återöppning i Workstation) och skriver den via
  File System Access API (`showSaveFilePicker`) där webbläsaren stödjer
  det (Chrome/Edge), annars klassisk `<a download>`. Ett projekt öppnat via
  native filväljaren behåller sitt filhandtag (`savedFileHandle`,
  modul-privat state i `project-manager.js`) så en vanlig Save skriver
  tillbaka direkt utan att fråga igen; Save As frågar och minns alltid.
- **`exportProjectAsZip()`** — separat väg, bara nådd via Share-dialogens
  Export-knapp (nytt, 2026-09-18) — bygger i stället
  `buildWebExportZipBlob()`: samma `vfs`-vandring men **utan**
  `workstation-state.json` (Workstations egen editor-state hör inte hemma
  på en live-sajt) och **med** en färsk kopia av det körande `waxml.js`
  bifogad, hämtad via `fetch("waxml.js")` — allt en webbutvecklare behöver
  för att droppa in projektet i en egen sida. Frågar alltid efter plats
  och minns den aldrig (till skillnad från Save As) — Export är till för
  att lämna över en kopia, Save/Save As är för den egna arbetsfilen.

`document-sync.js` håller **exakt en** VFS-fil "utcheckad" som det
dokument som just nu är öppet i `xmlStore`/XML-panelerna — markera en
annan `.xml`-fil i File Manager (t.ex. en `<include>`-fil) byter vilken
som är "levande", med en 400ms debounce innan ändringar skrivs tillbaka
till `vfs`.

## Workstation-state (nytt, 2026-08-30)

`js/project/workstation-state.js` sparar GUI-tillstånd (öppna paneler,
markerat element) i en egen fil, `workstation-state.json`, **bredvid**
`wa.xml` i `vfs` — aldrig inuti `wa.xml` själv, som ska förbli ren
"leverans"-XML utan UI-skräp (se instruktionsdokumentet
`~/Downloads/workstation-state-instructions.md` som initierade det här).

Samma mönster som `document-sync.js` använder för `wa.xml`: en riktig
`vfs`-fil, hålls levande synkad (400ms debounce, `xmlStore`s `"change"` +
varje panels `"collapse-change"`/`"width-change"`-event, plus numer
`wa-webcam-input.js`s eget `"state-change"`, se Input-panelen nedan).
Fångas av `saveProject()`/`saveProjectAs()`s vanliga `vfs`-vandring
(`buildProjectZipBlob`) utan någon specialkod där (bara en
`flushWorkstationState()`-flush innan, för att garantera att den sparade
filen är helt aktuell) — **inte** av `exportProjectAsZip()`, som numer
(se "Projektets livscykel" ovan) medvetet utesluter den här filen ur sin
egen zip, eftersom den byggs för en live-sajt, inte för återöppning i
Workstation.

Viktigt: `selectedElementId` i JSON-filen är **XML-`id`-attributet**
(`node.attributes.id`), inte `xmlStore`s interna, sessionslokala trädid —
se förklaringen under `xmlStore` ovan för varför. Vid inläsning slås det
upp mot det just laddade dokumentets träd (`findNodeByAttributeId`); hittas
ingen träff (borttaget element, eller ett `wa.xml` redigerat utanför
Workstation) ignoreras det tyst — kraschar aldrig laddningen.

`js/vfs/zip-import.js`s filändelse-whitelist (`SUPPORTED_EXTENSIONS`)
fick `.json` tillagt för att den här filen faktiskt ska packas upp ur en
zip — annars hade den tyst hoppats över vid import.

## Input-panelen och webbkameran (nytt, 2026-09-22)

Den nya, längst-till-vänster `inputPanel` (se "De fem panelerna" ovan)
hostar staplade, kollapsbara "input-kanal"-sektioner som mappar externa
live-signaler mot WAXML `<Var>`-element — idag bara en sektion, **Web
Camera** (`js/components/wa-webcam-input.js`), som kör MediaPipes hand-/
pose-/face-landmark-spårning i webbläsaren (hämtad som ett CDN-modul-
skript, `@mediapipe/tasks-vision`, ingen extra backend). `wa-input-panel.js`
själv äger bara sektions-listans layout (kollapsa/expandera var och en) —
tanken är att MIDI/OSC/"External JavaScript" ska bli fler sektioner här
senare, var och en med samma "driv ett `<Var>` live"-mönster.

**Arkitektoniskt central regel** (per Hans): hela INPUT-lagret ligger
medvetet **utanför** WAXML-dokumentet/schemat — inga nya XML-element, inga
schemaändringar. Det enda den skriver till är ett helt vanligt root-nivå
`<Var>`, via `playerStore.setVariable()` — samma anrop `wa-var-knobs.js`s
rattar redan använder. Panelens egen state (vilka landmärkes-kombinationer
som är sparade, vilken metrik som mappar mot vilket `<Var>`, vilka
MediaPipe-modeller som är påslagna, vald kamera) persisteras **bara** i
`workstation-state.json` — aldrig i `wa.xml`, precis som panel-layouten i
övrigt (se `workstation-state.js` ovan). `wa-webcam-input.js` exponerar
`getState()`/`applyState()`, kopplade in via `workstation-state.js`s
`registerLayoutExtras({ webcamInput: ... })` och ett `"state-change"`-event
(`composed: true`, samma mönster som `columns-change`/`split-change` från
andra paneler).

**Interaktion** (nära verbatim porterad från Hans egen referens-
implementation, https://msw.waxml.org/): kameran/modellerna laddas bara
efter en explicit Start-knapp — aldrig automatiskt bara för att panelen
är synlig, samma "aldrig återuppta AudioContext utan en riktig user-
gesture"-regel som `waxml-bridge.js` följer för ljudmotorn. Klick på en
landmärkespunkt i videobilden väljer den; en, två, tre eller fler valda
punkter tolkas automatiskt som punkt (x/y/z), avstånd (dist2d/dist3d),
triangel (area/omkrets) respektive polygon. Varje beräknad metrik kan
mappas mot ett befintligt eller nytt root-`<Var>` via en popup,
`wa-var-picker.js` (`js/components/wa-var-picker.js`, samma
imperativa `openVarPicker()`-mönster som `wa-voice-picker.js`s
`openVoicePicker()`) — "New Variable..." skapar `<Var>`:et direkt via en
ny hjälpare, `xmlStore.addRootVar(name)`, som återanvänder samma
gruppering-med-övriga-root-Vars-logik `wa-bottom-bar.js`s egen "+"-knapp
redan hade (faktoriserad dit den nu bor). Bara mappade metriker skickas
någonsin vidare till `playerStore.setVariable()` — allt annat är rent
visningsläge.

## View-meny, Library (DEMO) och Share-dialogen (nytt, 2026-09-10/13)

`js/state/view.js` exporterar `viewState`, ett minimalt singleton-state
(`"workstation"` | `"library"`) helt fristående från `xmlStore`/`vfs`/
`playerStore` — poängen (per Hans) är att det riktiga projektet ska
fortsätta köra live i bakgrunden precis som i Workstation oavsett vilken
vy som visas, ett vy-byte river eller laddar aldrig om något, det bara
togglar vilken del av DOM:en som är synlig (`app.js`s `applyView`, som
döljer/visar `<main>`, `<wa-bottom-bar>` och `<wa-library-view>` i tur och
ordning och byter `<title>`).

`<wa-view-menu>` (`js/components/wa-view-menu.js`) är headerns tredje meny
och togglar mellan de två vyerna. **Library (DEMO)**
(`js/components/wa-library-view.js`) är en medveten sketch av en framtida
publicerings-/distributionsvy — ett Spotify-likt bibliotek av
"produktioner" där det riktigt öppna projektet alltid ligger mitt i en
lista av tio påhittade produktioner (namn/skapare/beskrivning — allt
genererat, inga externa tjänster inblandade) och alltid är markerat som
"Your project"/aktivt. Projektets egen beskrivning i högerspalten är
**inte** slumpad text utan en riktig, genererad sammanfattning
(`describeRealProject`) som räknar Sections/transitions/Layers/Stingers/
ljudfiler/Mixer-kanaler direkt ur `xmlStore.root`. Bottombaren återanvänder
`<wa-player-bar minimal>` rakt av (samma delade `xmlStore`/`playerStore`-
singletons gör att den automatiskt skickar exakt samma
`trig()`/`setVariable()`-anrop som header-instansen tidigare gjorde) —
`minimal` är ett rent CSS-attribut på `wa-player-bar.js` som döljer
Play-knappen/selector-fältet/"+"-knapparna och bara visar Stop, de
befintliga shortcuts-knapparna och Var-rattarna.

**Share-dialogen** (File-menyns "Share..."-post, `wa-share-dialog.js`) är
en modal overlay ovanpå Workstation som wrappar `wa-api-view.js` — den
komponenten var tidigare en egen top-level "API"-vy (View-menyn hade en
tredje post för den), men bor numer bara här. Innehållet är i övrigt
oförändrat: instruktioner + fyra genererade kod-exempel (HTML-`<script>`-
tagg, HTML-attribut, JavaScript-API) byggda live från det öppna
projektets root-nivå `<Command type="trig">` och `<Var>`, plus en riktig
**Export...**-knapp (nytt, 2026-09-18) som faktiskt bygger och laddar ner
ett embeddningsbart zip-paket via `exportProjectAsZip()` — se
"Projektets livscykel" ovan för hur den skiljer sig från Save/Save As.

## Schemat (XSD)

`js/xml-editor/schema-parser.js` tolkar `schemas/waxml.xsd` (laddas som
appens default-schema i `app.js`) till ett enkelt JS-objekt
(`{ rootElements, elements: { TagName: { allowedChildren, allowedAttributes,
allowsText, allowsAnyAttribute } } }`), inklusive upplösning av namngivna
`simpleType`/`attributeGroup`/`group`-referenser och `xs:union`-typer (en
attributtyp som kan vara flera annars orelaterade former, t.ex. `gain`:
ett 0–1-tal ELLER en `"-XdB"`-sträng ELLER ett matematiskt uttryck).
Schemat driver praktiskt taget hela redigeringsupplevelsen: Inspectorns
kontroller per attributtyp, trädets "lägg till barn"-meny, Mixerns
filter-typ-meny (samma `type`-enum som `<BiquadFilterNode>` deklarerar).

En redan hittad och fixad bugg här (2026-08-30): `applyBaseKeyword` satte
en förvald `minValue=0, maxValue=100` på alla decimal/heltal-attribut
**innan** de riktiga `xs:minInclusive`/`maxInclusive`-facetterna lästes,
vilket gjorde att `applyFacets`s "bara fyll i om `undefined`"-koll aldrig
fick chansen att ta över — `gain`s riktiga 0–1-gräns (`gainValue`-typen i
XSD:t) syntes aldrig i Inspectorns slider, som visade 0–100 istället.

## Mixer-vyn (den mest komplexa panelen)

`js/components/wa-mixer-view.js` (~3100 rader) är en egen, stor arkitektur
värd att känna till separat — se
[components-reference.md](components-reference.md#wa-mixer-viewjs) för
detaljer om channel-strip-layouten, filter/insert/send-sektionerna, och
solo/blend/quantize-designet. Motorsidan (`waxml.js`) för solo/blend/
quantize är **inte** byggd än — se
[mixer-solo-engine-todo.md](mixer-solo-engine-todo.md).

**Bara element med ett riktigt ljudsignalvärde får en egen channel strip**
(nytt, 2026-09-21) — `<Mixer>`s barn filtreras genom `hasAudioSignal()`
(`MIXER_NO_SIGNAL_TAGS = {Var, Send, Envelope}`): en variabeldeklaration,
ett aux-send (hör hemma inuti en `<Chain>`, inte som egen kanal) respektive
en automationskurva är inga egna ljudkällor. `<Include>` räknas **inte**
hit (rättat efter en första felaktig gissning) — den drar in ett helt
annat WAXML-dokument och har ett riktigt eget ljudutflöde, som en
sub-master.

**Var-styrd solo** (nytt, 2026-09-05): när `<Mixer solo="$namn">` pekar på
ett `<Var>` (`isVariableControlled`, se `variable-references.js`) låses
både den stora crossfade-slidern och varje kanals egen Solo-knapp mot
direkta klick — `waxml.js`s Watcher äger redan positionen, ett klick här
skulle bara slåss med den. Bugg som täpptes till i samma veva: de
per-kanal-lamporna tände aldrig vid `$var`-styrd solo (räknades tidigare
bara som "aktiv" om `soloRaw` gick att `parseFloat`:a), och slidern läste
aldrig tillbaka det verkliga live-värdet alls.

## Undo/Redo (nytt, 2026-09-01)

`js/project/edit-history.js` är en enda kombinerad ångra/gör om-stack som
täcker **både** `xmlStore` och `vfs` tillsammans (en fil-drag och en
attributändring hamnar på samma logiska "steg" om de händer nära i tid).
Snabba ändringar i följd (t.ex. att dra i en slider) coalescas till ett
enda ångra-steg via en 500ms idle-debounce, keyed på den *första*
ändringen i en burst — `commitBurst()` kan tvingas fram tidigt av
`undo()`/`redo()` själva, så Cmd+Z direkt efter en enda klick-ändring
ångrar rätt sak istället för att vänta in debouncen. `applyingHistory`
gate:ar bort att en ångra/gör om-operation själv råkar spelas in som ett
nytt steg. Historiken nollställs (`resetEditHistory()`) vid varje nytt/
öppnat projekt.

Tangentbordsgenvägarna (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z eller +Y) är globala
men hoppar över redigerbara fält — letar igenom shadow-DOM-gränser
(`while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;`)
för att hitta det *faktiska* fokuserade elementet, så native textfälts-
ångra inte kapas.

## Multi-select, kopiera/klipp ut/klistra in (nytt, 2026-09-06/07)

`xmlStore` fick en riktig multi-selektion (`selectedNodeIds`, en `Set` som
alltid innehåller `selectedNodeId` när den är satt) utöver den gamla
enkel-`selectedNodeId` — `toggleNodeSelection(id)` (Cmd/Ctrl-klick) och
`selectRange(ids)` (Shift-klick, den *synliga* rad-ordningen räknas ut av
den anropande vyn, t.ex. `wa-xml-tree.js`s `_flatten()` eller
`wa-file-manager.js`s `_flattenVisibleIds()` — `xmlStore` självt har ingen
uppfattning om vad som är synligt just nu). `wa-edit-menu.js` (headerns
tredje meny, se ovan) driver Undo/Redo/Copy/Cut/Paste, med samma
Cmd/Ctrl+C/X/V-genvägar, skippade i redigerbara fält
(`isEditableContext()`, samma vakt `edit-history.js`s Undo/Redo redan
använder).

- **Copy** snapshottar den aktuella markeringen by reference (ingen
  kloning än) — `_topLevelSelection()` filtrerar bort en markerad nod vars
  förälder också är markerad (en förälder drar redan med sig sina barn).
- **Cut** rör **inte** dokumentet alls förrän en lyckad paste — bara
  id:n markeras som "väntar på flytt" (`clipboardCutIds`, läst av
  `wa-xml-tree.js` för en streckad "markerad för klipp"-stil); Escape
  släpper en väntande cut utan att flytta något (`clearPendingCut`).
- **Paste** validerar varje klippbords-nods tagg mot målets
  `schema.allowedChildren` **innan** något rör dokumentet — antingen
  landar alla noder, eller ingen (`wa-edit-menu.js` visar en
  `showToast()`-varning vid avslag, `js/ui/toast.js`, ny minimal
  toast-modul, se komponentreferensen). En kopia klonas fräscht per
  paste (nya id:n varje gång, samma `idMap` som `wa-xml-tree.js` läser
  för att bära över hopfällt/expanderat state till klonen) — en cut
  reparenterar i stället noden på plats med samma id, en gång, sen töms
  klippbordet.

## File Manager: multi-select, mappdrop och namnkollisioner (nytt, 2026-09-15/18)

`wa-file-manager.js` fick sin egen, separata Finder/Explorer-stil
multi-selektion (`_selectedIds`, samma Cmd/Ctrl/Shift-klick-konvention som
`xmlStore`s ovan, men en helt egen `Set` — filträdet har ingen koppling
till XML-editorns markering). Skild från den delade `selection`-singleton
(`state/selection.js`), som fortfarande bara pekar på **en** "aktiv" fil
(drivet av File Managers senaste klick) — `_setActiveSelection` håller de
två synkade utan att en extern `selection`-ändring kollapsar en pågående
multi-markering.

- **Namnkollision vid uppladdning/flytt** (nytt, 2026-09-18): droppar man
  en eller flera filer (från Finder, eller genom att dra dem till en annan
  mapp internt) på en mapp som redan har en fil med samma namn, frågar
  appen en gång — `wa-file-conflict-dialog.js`, samma imperativa
  `await openFileConflictDialog(names)`-mönster som `wa-voice-picker.js`
  — Replace/Keep both (Finder-stil omdöpning, `"kick.wav"` →
  `"kick (2).wav"`)/Cancel (hela batchen, inte bara de kolliderande
  filerna). En `.zip` packas alltid upp direkt och kan aldrig kollidera
  på det här sättet — den blir aldrig själv en fil i mappen.
- **Riktigt mapp-drop från OS** (nytt, 2026-09-16): `dataTransfer.items`
  + `webkitGetAsEntry()` läser en riktig `FileSystemEntry` (rekursivt för
  en katalog) i stället för `dataTransfer.files`, som annars plattar till
  en dropped mapp till en oanvändbar noll-byte-"fil". Läses av synkront,
  innan något `await`, eftersom `dataTransfer`s egen item-lista bara är
  giltig under själva drop-eventets synkrona körning.
- **Ljudfil-förhandsvisning kräver nu dubbelklick** (nytt, 2026-09-16):
  ett enkelklick väljer bara; dubbelklick på just en ljudfil (`.mp3/.wav/
  .ogg/.m4a`, `isPreviewableAudioFile`) visar OCH startar uppspelning av
  dess waveform-preview i en ny, alltid monterad `wa-file-preview.js`
  (panel 1-oberoende, lyssnar direkt på `selection`) — allt annat
  (mappar, `.xml`-filer) aktiverar/öppnas fortfarande på ett enkelklick,
  precis som förut. Ett rent klick-och-dra (ingen föregående separat
  klick) uppdaterar bara File Managers egen lokala highlight, aldrig den
  delade `selection` — annars bytte Preview-panelen fil så fort
  drag-tröskeln passerades, innan användaren ens släppt.

## Section Preview — DAW-vyn för `<Section>` (nytt, 2026-08–09)

`js/components/wa-section-view.js` (stor fil, se
[components-reference.md](components-reference.md) för detaljer) är den
mest komplexa vyn i Preview-panelen: ett Logic/Ableton-likt arrangefönster
för en markerad `<Section>`, med egen transport, zoom och drag-redigering.
Centrala drag:

- **Layout**: en rad per `<Layer>` (LAYERS) och en rad per `<Stinger>`
  (STINGERS), delat 80/20 med en dragbar delare (`.stinger-divider`) —
  Layer-arean har alltid minst en rads höjd reserverad, Stinger-arean
  minst en linjals höjd.
- **Zoom**: H/V-knappar (fasta steg) plus pinch/Ctrl+scroll (kontinuerlig,
  `_onWheelZoom`) — pinchens `deltaX`/`deltaY` styr H (`pxPerSecond`) och V
  (`rowHeight`) **oberoende av varandra**, och horisontell zoom håller
  tidspositionen under muspekaren visuellt fast (läses av före, återställs
  som ny `scrollLeft` efter omritning).
- **Tidslinjen växer dynamiskt** (`_ensureTimelineCovers`) istället för
  att vara hårdkodad till ett fast antal takter — triggas av scroll nära
  högerkanten och av uppspelningens egen autoscroll, så en loopande
  `<Layer>` fortsätter rendera repriser istället för att ta slut i tomrum.
- **Loop-markören** (repristecken: tunt+tjockt streck + två prickar,
  vitt) sitter vid en `<Layer>`s effektiva `loopEnd` — dragbar (skriver
  `loopEnd` som musikalisk position, `bar.beat.offbeat`), dubbelklick i
  en Layer-rad sätter `loopEnd` direkt till klickpositionen (grid-snappad).
- **`<Segment>`s längd** är dragbar från högerkanten
  (`_buildSegmentResizeHandle`) — skriver `length` i sekunder.
- **Namnbyte** (Layer/Stinger radetikett, Segments box, Section-labeln i
  transportraden, samt tempo/taktart) är dubbelklicks-redigerbara inline,
  samma mönster som Mixerns egen channel-strip-namnbyte — skriver `label`
  (eller `tempo`/`timeSign`/`id` för transportradens fält) direkt på
  `xmlStore`.
- **`<Stinger>`**: en dragbar "anchor"-linje styr `quantize`; fyra
  referensstreck (takt 0, anchor, och två till i samma avstånd) visas
  permanent, inte bara under drag. Ett triggat `<Stinger>` (dubbelklick,
  bara under uppspelning) får en egen live positionspekare
  (`_activeStingerTriggers`), beräknad relativt takt 0 i dess eget
  quantize-raster.
- **Filsläpp**: en fil släppt på ett `<Segment>` eller `<Stinger>` i den
  här vyn lägger till en ny `<Option>` (befintlig bar `src` på
  elementet blir automatiskt en egen `<Option>` före den nya) — skiljer
  sig medvetet från XML-trädet, där samma drop bara skriver om `src`
  rakt av.
- **Schema-validering vid drag-and-drop** i XML-trädet (`wa-xml-tree.js`):
  ett drop visar aldrig en dropp-indikator och committar aldrig en
  omflyttning som skulle bryta mot `allowedChildren` (t.ex. en `<Layer>`
  i en `<Layer>`).
- **Per-rad Layer/Stinger-kontroller** (`_buildLayerControls`, nytt
  2026-09-11, delvis pausat 2026-09-15): tänkt att vara en volymfader+VU,
  Mute/Solo-knappar och en output-routingknapp, identiska för `<Layer>`
  och `<Stinger>` (samma attributnamn `gain`/`mute`/`output` på båda).
  **Just nu är bara output-knappen faktiskt synlig** — fader/Mute/Solo är
  medvetet avstängda i koden (`wrap.appendChild(...)`-anropen är
  utkommenterade) tills en känd bugg är åtgärdad; koden för dem finns kvar
  intakt (`_buildGainFader`/`_buildMuteButton`/`_buildSoloButton`) och slås
  på igen med en enrads-ändring. Solo saknar ett eget XML-attribut helt —
  klick mutear alla ANDRA syskon av samma tagg (Layer/Stinger är separata
  solo-pooler) via samma `_writeMute` Mute-knappen använder, så resultatet
  är oskiljbart från att ha mutat alla andra för hand; bara S-knappens
  egen highlight lever i minnet, aldrig sparat.
- **"Reveal"-gest** (nytt, 2026-09-08): `xmlStore.selectNode(id, { reveal:
  true })` är ett tredje, explicit läge utöver vanlig markering/`open` —
  ber `wa-xml-tree.js` expandera varje hopfälld förälder till noden och
  scrolla in den i vyn. Bara satt av en dubbelklickning på en Layer-etikett
  eller en Segment/Option-box här (och motsvarande i Composition-vyn) —
  aldrig av en vanlig enkelklickning eller ett filsläpp, som inte får rycka
  undan trädets egen scroll-/fäll-state under användaren.

## Composition Preview — vy för spelsekvensen av Sections (nytt, 2026-09-05→21)

`js/components/wa-composition-view.js` (~1770 rader) är en syster-vy till
Section Preview på samma nivå i `wa-preview.js`s state-`Map` (`"section"`
respektive en ny egen state för Composition) — samma grundlayout (linjal
överst, rader nedanför, pinch/knapp-zoom) men raderna visar hela
`<Composition>`s `<Section>`-barn i spelordning i stället för en enskild
Sections `<Layer>`-spår. Ingenting importeras från `wa-section-view.js`
självt (den filen är en enda stor, hopkopplad klass) — bara den DOM-fria
matten i `section-model.js` återanvänds, zoom/linjal/drag-teknikerna är
avskrivna, inte importerade.

- **Reguljära Sections** (utan `from`/`to`) loopar tills en annan Section
  triggas; **"transition"-Sections** (`from`/`to` satta) spelar
  automatiskt mellan två reguljära Sections vid en synk-punkt
  (`syncTo`-attributet — schemats gamla `quantize` döptes om till
  `syncTo` 2026-09-07, se `schemas/waxml.xsd`). Motorsidans egna
  auto-val av rätt transition (`from`/`to`/`syncTo`) byggs parallellt av
  Hans i `waxml.js`, med delvis annan/placeholder-syntax — den här vyn
  producerar bara schema-korrekt XML och gör sitt bästa för
  live-trigger-/pending-feedback tills båda sidor är i mål.
- **`tempo`/`timeSign`-arv vid skapande** (nytt, 2026-09-21): en ny
  reguljär Section kopierar `tempo`/`timeSign` explicit från sin
  `<Composition>`-förälder redan vid infogning (`xmlStore.insertNewChild`),
  inte bara via den vanliga live-attributarvskedjan (se
  `attribute-inheritance.js`). En ny **transition** gör tvärtom och ärver
  i stället från sin "to"-Sections *effektiva* värde (`_insertTransition`)
  — per Hans ska en transition spela i den takt/taktart den *anländer
  till*, även när "to"-Sectionen själv overridar Compositionens värde.
- **`<Composition>` är nu raderbar** (nytt, 2026-09-21): Backspace/Delete
  på en direkt markerad `<Composition>` tar bort den — tidigare hanterade
  bara `wa-section-view.js`s egen `_onKeyDown` Section-radering (även av
  en Section vald inifrån sig själv), ingen vy lyssnade på en direkt
  markerad Composition. Samma `defaultPrevented`-vakt som
  `wa-player-bar.js`/`wa-bottom-bar.js` använder, av samma skäl: flera
  oberoende `keydown`-lyssnare på `document` måste stoppa varandra så
  inte en enda Backspace kaskadar (`removeNode` väljer den borttagna
  nodens *förälder* som ny markering, vilket annars skulle trigga den här
  vyns egen Composition-raderingslogik en gång till, direkt efter).
- **Multi-select + kopiera/klipp ut/klistra in**: samma delade
  `xmlStore`-mekanik som resten av XML-editorn (se eget avsnitt nedan) —
  ingen egen implementation här.
- **Playhead** följer den riktiga motorn, inte bara det senast
  app-triggade valet — `_onSectionTrig` lyssnar på `waxml.js`s egen
  "en Section är på väg att låta"-event (`section`/`time`/`delay`), ingen
  gissning eller klient-sidig uppskattning av väntetid längre.

## WAM-inserts och IO-routing (nytt, 2026-08–09)

- **WAM-inserts** (`js/wam/wam-catalog.js`, `wa-wam-picker.js`,
  `wa-wam-stack.js`, `wam-gui.js`, `wa-wam-view.js`): en channel strip i
  Mixern kan få ett eller flera `<Wam>`-insert. Vid val från katalogen
  förhandsdeklareras **alla** modulens parametrar som `<Parameter>`-barn i
  en enda batch (`ensureParametersDeclared`) så att första ratt-touchen
  inte triggar en störande strukturell ombyggnad. `getLiveObjects`
  matchar mot XML-`id`-**attributet** (`[id='...']`), inte det interna
  trädid:t — lätt att blanda ihop.
- **IO-routing** (`js/xml-editor/io-routing.js`, `wa-io-picker.js`): ett
  klick på `output`/`input`/`bus` i Inspector öppnar en förankrad,
  hierarkisk popup (samma expand/collapse-konvention som XML-trädet) för
  att välja mål-`id` istället för att skriva `#id` för hand. Dessa tre
  attribut (plus `<OscillatorNode>`s `type`) tvingar alltid en full
  graf-ombyggnad vid ändring (`XmlStore.ROUTING_REBUILD_ATTRS`) — waxml.js
  har ingen live-property-koppling för routing.
- **Attribut-arv**: `Layer`/`Section` visar och tillåter redigering av
  ärvda värden (`fadeTime`/`loopEnd`/`changeOnNext`/`tempo`/`timeSign`)
  från närmaste förälder (Section → Composition), enligt waxml.js egna
  defaultvärden (`js/xml-editor/attribute-inheritance.js`).

## File-menyn — Save/Save As/Share (nytt, 2026-09-03; förenklad 2026-09-14)

`js/components/wa-file-menu.js` + `js/project/project-manager.js`:

- **New/Open/Save/Save As/Share...** med standardgenvägar (⌘N/O/S, ⇧⌘S —
  Cmd/Ctrl beroende på plattform) för de fyra första. Cmd/Ctrl+N/O kan inte
  alltid ta över webbläsarens egna reserverade genvägar; Save/Save As gör
  det tillförlitligt.
- **Native filväljare** (File System Access API, `showOpenFilePicker`/
  `showSaveFilePicker`) används där webbläsaren stödjer det (Chrome/Edge),
  med den klassiska `<a download>`-varianten som fallback. Ett projekt
  öppnat via den native väljaren behåller sitt filhandtag, så en vanlig
  Save skriver tillbaka direkt utan att fråga igen.
- **Share...** öppnar `<wa-share-dialog>` (se eget avsnitt ovan) — dit
  flyttade den gamla "Export Project..."-posten (bygger nu ett annat zip
  än Save/Save As, se "Projektets livscykel" ovan).
- Nya `<Section>`-element får en unik `class` automatiskt (A–Z, sen
  A1/B1/…) så de är direkt användbara som PLAY/STOP-trigger-selektor.

**Templates borttaget ur menyn (2026-09-14):** File-menyn hade tidigare
även en Templates-sektion (en post per undermapp i `templates/`, listad
via `templates/manifest.json`) — den togs bort i samma förenkling som
flyttade Export till Share-dialogen. `js/project/template-loader.js` och
`project-manager.js`s `loadTemplate()`/`listTemplates()` finns kvar i
koden och fungerar, men har **ingen anropande UI längre** — död kod tills
något (Templates-menyn igen, eller en ny ingång) faktiskt kallar dem.

## Panel-layout: öppna/stäng och zoom (nytt, 2026-09-03/04)

- Att öppna en panel (t.ex. Code eller File Manager) tar nu synligt plats
  från grannpanelerna istället för att osynligt klämmas ihop till
  ingenting — men **inte** via kontinuerlig CSS `flex-shrink` (gjorde
  bredd-draget i resize-handtaget märkbart laggigt), utan via en
  engångs, explicit breddöverföring från en specifik granne vid
  öppning/stängning (`wa-panel.js`).
- Generisk pinch-zoom på panelnivå (`wa-panel.js`) är borttagen — fanns
  bara kvar i Preview-panelen (`wa-preview.js`), där den ser bra ut för
  Mixer/övriga vyer som inte har egen semantisk zoom (Section Preview har
  sin egen, se ovan, och stoppar propagering dit den generiska aldrig
  når).
- Horisontell svep-navigering som råkade trigga webbläsarens bakåt/framåt
  är blockerad globalt (`overscroll-behavior-x: none`).

## `waxml.js`-buggar hittade under Section-preview/Mixer-arbetet (2026-09)

Utöver bugglistan i `WAXML-Workstation-spec.md` avsnitt 3 (från den
ursprungliga arkitekturgenomgången) hittades och åtgärdades ett antal till
under det här arbetet — alla i `waxml.js`, alla Hans egna fixar (den här
appen redigerar aldrig `waxml.js` själv):

- **WAM host-init kördes aldrig** — fel case (`querySelector("wam")` vs
  schemats `<Wam>`) plus en ordningsbugg (`initWAMsWhenAllAreLoaded()`
  kördes innan `parseXML()` hunnit fylla `this.imports`).
- **`Music.getPosition()` returnerade en fryst stub** när `pos` var
  odefinierad — löst genom att delegera till
  `this.currentSection.getPosition()` istället för att skriva om `pos`.
- **`Bus`/`Motif.prototype.remove`** var pilfunktioner — fel `this`-bindning,
  kraschade vid teardown.
- **Distorsion vid ny `<Layer>`** — iMus-sidan av grafen hade ingen
  teardown mellan ombyggnader (ingen `.disconnect()` på Track/Bus) —
  löst med en `remove()`-kaskad genom hela musikEngine-trädet.
- **Allvarlig positionsbugg**: en `<Section>` som spelades upp efter att
  en `<Mixer>`-routad `<Layer>` (`output="#MixChan-N"`)  fanns i
  dokumentet startade positionräkningen från fel ställe (räknade i takt
  med `audioContext.currentTime` istället för från takt 1). Root cause:
  en synkron "XXX really bad hack"-rad i `Parser`s generiska nod-genomgång
  anropade `musicEngine.parseXML()` **innan** `WebAudio`s eget `_xml`
  hunnit sättas — kraschade tyst (fångades av `player-store.js`s eget
  reload-felhantering, syntes aldrig för användaren). Löst genom att ta
  bort den hacken och istället trigga `<Composition>`-parsningen efter
  `initAudio()` är klar; ett par följdfel (null-koll i `Connector.connect`,
  `iMus.stop("all")` som inte återställde `playing`/`sectionStart`
  korrekt) hittades och åtgärdades i samma veva.

## Konventioner värda att känna till innan man ändrar kod

- **Full omritning, inte diffning.** Nästan varje panel gör
  `container.innerHTML = ""` + bygger om alltifrån från `xmlStore`s
  aktuella state vid varje relevant `"change"`. Enkelt och robust, men
  betyder att DOM-referenser till "samma" element inte överlever ett
  `xmlStore`-event om du inte explicit skyddar dig med `_isLocalEdit`.
- **Strukturell vs. attribut-ändring är en medveten, genomgående
  distinktion** — påverkar om uppspelningen stoppas (`player-store.js`)
  och om en panel behöver bry sig alls.
- **Internt trädid ≠ XML `id`-attribut.** Den här distinktionen dyker upp
  på flera ställen (se `xmlStore`-avsnittet ovan) och är lätt att glömma —
  leta efter `node.id` (internt, `"node_N"`) kontra `node.attributes.id`
  (XML-attributet, det enda som är meningsfullt att spara/dela/referera
  över tid).
- **`_wireVerticalDrag`/kontinuerlig commit + `_isLocalEdit`** är det
  etablerade svaret på "dra i en kontroll → committa varje tick → höras
  live → utan att draget går sönder". Kopiera det mönstret för nya
  drag-baserade kontroller istället för att uppfinna nåt eget.
