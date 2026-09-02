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

## De fyra panelerna

`index.html` lägger upp fyra `<wa-panel>`-element sida vid sida i
`<main class="app-panels">`, var och en med ett stabilt `id` (används av
`workstation-state.js`, se nedan):

| Panel (`id`)   | Komponent            | Vad den visar |
|----------------|-----------------------|----------------|
| `fileManager`  | `<wa-file-manager>`   | Filträd över det virtuella filsystemet (VFS) |
| `xmlEditor`    | `<wa-xml-editor>`     | Trädvy över XML-dokumentet + Inspector för markerad nod |
| `preview`      | `<wa-preview>`        | Kontext-beroende förhandsvisning av markerad nod |
| `xmlCode`      | `<wa-xml-code>`       | Rå XML-text, tvåvägssynkad med trädet |

`<wa-panel>` själv (`js/components/wa-panel.js`) är en generisk
visa/dölj/resize-wrapper — kollapsad blir den en smal ikonrand och lämnar
sin bredd till närmaste expanderade panel till vänster. Har en publik
`collapsed`-getter och skickar ett `"collapse-change"`-event vid
kollaps/expand.

Utöver panelerna finns `<header class="app-header">` med `<wa-file-menu>`
(Ny/Öppna/Exportera projekt) och `<wa-player-bar>` (global Play/Stop).

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
avbryta pågående uppspelning (`wa-player-bar.js` äger start/stopp-kontrollerna
i headern; alla andra vyer bara *läser* det här state:t). Lyssnar på
`xmlStore`s `structural`-flagga: en strukturell ändring stoppar uppspelning
och tvingar nästa Play att ladda om hela den levande grafen (via
`waxml-bridge.js`); en icke-strukturell ändring stör aldrig pågående ljud.

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

## Projektets livscykel (Ny / Öppna / Exportera)

Allt går genom `js/project/project-manager.js`, anropat från
`wa-file-menu.js`:

- **`createDefaultProject()`** — nollställer `vfs`, skapar ett tomt
  `wa.xml` (rot-elementet läses från schemats `rootElements[0]`, inte
  hårdkodat), lägger en `audio/`-mapp, och initierar
  `workstation-state.json` (se nedan).
- **`openProjectFromFile(file)`** — `.zip`: packas upp via
  `js/vfs/zip-import.js` (JSZip, whitelist av filändelser — se
  `SUPPORTED_EXTENSIONS`), letar sen efter `wa.xml` i roten (case-
  insensitive, med fallback till första `.xml`/`.waxml`-filen den hittar).
  En enstaka `.xml`-fil: laddas direkt utan zip-uppackning.
- **`exportProjectAsZip()`** — vandrar hela `vfs`-trädet in i en `JSZip`
  och triggar nedladdning. `wa.xml`s innehåll behöver aldrig skrivas
  separat här — `document-sync.js` (nedan) håller den filen levande
  synkad i `vfs` redan, så den fångas av samma vandring som allt annat.

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
varje panels `"collapse-change"`-event), fångas av `exportProjectAsZip`s
vanliga `vfs`-vandring utan någon specialkod där (bara en
`flushWorkstationState()`-flush innan export, för att garantera att den
sparade filen är helt aktuell).

Viktigt: `selectedElementId` i JSON-filen är **XML-`id`-attributet**
(`node.attributes.id`), inte `xmlStore`s interna, sessionslokala trädid —
se förklaringen under `xmlStore` ovan för varför. Vid inläsning slås det
upp mot det just laddade dokumentets träd (`findNodeByAttributeId`); hittas
ingen träff (borttaget element, eller ett `wa.xml` redigerat utanför
Workstation) ignoreras det tyst — kraschar aldrig laddningen.

`js/vfs/zip-import.js`s filändelse-whitelist (`SUPPORTED_EXTENSIONS`)
fick `.json` tillagt för att den här filen faktiskt ska packas upp ur en
zip — annars hade den tyst hoppats över vid import.

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

`js/components/wa-mixer-view.js` (~2500 rader) är en egen, stor arkitektur
värd att känna till separat — se
[components-reference.md](components-reference.md#wa-mixer-viewjs) för
detaljer om channel-strip-layouten, filter/insert/send-sektionerna, och
solo/blend/quantize-designet. Motorsidan (`waxml.js`) för solo/blend/
quantize är **inte** byggd än — se
[mixer-solo-engine-todo.md](mixer-solo-engine-todo.md).

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

## File-menyn — Save/Save As/Templates (nytt, 2026-09-03)

`js/components/wa-file-menu.js` + `js/project/project-manager.js`:

- **New/Open/Save/Save As** med standardgenvägar (⌘N/O/S, ⇧⌘S — Cmd/Ctrl
  beroende på plattform). Cmd/Ctrl+N/O kan inte alltid ta över webbläsarens
  egna reserverade genvägar; Save/Save As gör det tillförlitligt.
- **Native filväljare** (File System Access API, `showOpenFilePicker`/
  `showSaveFilePicker`) används där webbläsaren stödjer det (Chrome/Edge),
  med den klassiska `<a download>`-varianten som fallback. Ett projekt
  öppnat via den native väljaren behåller sitt filhandtag, så en vanlig
  Save skriver tillbaka direkt utan att fråga igen.
- **Templates**: en ny sektion i File-menyn, under en avdelare, en post
  per undermapp i `templates/` (mappnamnet = menynamnet). Eftersom en
  webbläsare inte kan lista en vanlig statisk mapps innehåll själv, läser
  appen `templates/manifest.json` istället — regenereras med
  `node scripts/build-template-manifest.js` **varje gång** en mall
  läggs till/ändras (`js/project/template-loader.js` gör själva
  hämtningen/uppbyggnaden i `vfs`).
- Nya `<Section>`-element får en unik `class` automatiskt (A–Z, sen
  A1/B1/…) så de är direkt användbara som PLAY/STOP-trigger-selektor.

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
