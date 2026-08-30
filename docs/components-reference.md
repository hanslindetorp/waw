# WAW — komponentreferens

En fil, en sektion. Komplement till [architecture-overview.md](architecture-overview.md),
som beskriver hur delarna hänger ihop — det här dokumentet går igenom var
och en för sig. Radnummer är ungefärliga (filerna växer) men pekar rätt
inom några rader.

## Innehåll
- [Paneler](#paneler): wa-file-manager, wa-xml-editor (+ wa-xml-tree,
  wa-node-inspector, wa-schema-input), wa-preview (+ wa-section-view,
  wa-mixer-view), wa-xml-code
- [Header](#header): wa-file-menu, wa-player-bar
- [Delat ramverk](#delat-ramverk): wa-panel
- [Kärn-datamoduler](#kärn-datamoduler): xml-store, xml-tree-ops,
  schema-parser, attribute-controls, src-attribute, xml-tokenizer,
  section-model, waveform
- [Persistence](#persistence): VFS, zip-import, drag-types, selection,
  document-sync, project-manager, workstation-state
- [Ljud/uppspelning](#ljuduppspelning): player-store, waxml-bridge,
  live-property, gain-units
- [Bootstrap](#bootstrap): app.js, index.html

---

## Paneler

### wa-file-manager.js (~485 rader)

Filträdet för `vfs` — panel 1. Renderas rekursivt (`_renderChildren` →
`_renderFolderNode`/`_renderFileNode`), mappar sorteras före filer, sen
alfabetiskt. Expanderat/kollapsat state hålls i en `_collapsedIds`-`Set`
(samma mönster som `wa-xml-tree.js`s eget). Full omritning av hela trädet
vid varje `vfs`-`"change"` — ingen diffning.

**Uppladdning**: `ACCEPTED = ".mp3,.wav,.ogg,.m4a,.xml,.zip"` (för filväljar-
inputen). Två ingångar: verktygsfältets Upload-knapp laddar alltid till
`ROOT_ID`; varje mapprad har egen `+`-knapp scopead till just den mappen.
OS-dragdrop mot hela panelen landar också på `ROOT_ID` om inte en specifik
mapprad fångar upp den. `.zip`-filer går via `importZip`; allt annat via
`vfs.uploadFile`.

**Byt namn / radera**: inline UI, aldrig `prompt()`/`confirm()`. Dubbelklick
eller pennikonen byter namn-`<span>` mot ett textfält (Enter committar,
Escape/blur-utan-ändring återställer). Radera-knappen (✕) togglar en
`.confirming`-klass som CSS visar som "Delete? Yes/No" istället för
ikonerna.

**Drag-and-drop internt**: filer/mappar är dragbara; bara mappar är giltiga
drop-mål. `_moveNode` skyddar mot no-op-drops och mot att dra en mapp in i
sig själv eller en egen ättling. En drop som missar alla mapprader (tomt
utrymme eller på en fil) tolkas som "flytta till toppnivå".

**Dra fil UT ur File Manager**: ja — samma `VFS_FILE_DRAG_TYPE` (se
`drag-types.js`) som interna flyttar läses av externa drop-mål, framför
allt `wa-xml-tree.js` (sätter `src`-attribut på drop) och Mixerns
insert/send-sektioner. Mappar får medvetet `effectAllowed = "move"` (inte
`"copyMove"`) så webbläsaren visar "ej tillåtet"-markör över XML-trädet,
som bara accepterar filer.

**Markering / öppna dokument**: klick på en filrad anropar
`selection.select(node.id)` — själva öppnandet av `.xml`/`.waxml`-filer för
redigering sker inte här utan i `document-sync.js`, som lyssnar på samma
`selection`-singleton.

### wa-xml-editor.js (~45 rader)

Ren komposition, ingen egen logik. Staplar `<wa-schema-input>` (fast
höjd, överkant), `<wa-xml-tree>` (`flex: 1 1 auto`, scrollar) och
`<wa-node-inspector>` (docked underst, `max-height: 40%`) i sitt shadow
DOM. All kommunikation mellan dem sker via det delade `xmlStore`-
singleton-objektet, inte via denna wrapper.

#### wa-xml-tree.js (~1088 rader)

Rendermodellen är **inte** ett nästlat DOM-träd utan en platt,
indenterad CSS-grid ("Finder list view") — `_flatten()` gör en
depth-first-vandring av `xmlStore.root` till en platt array av rad-
beskrivningar (plus syntetiska "add element"-släprader efter sista synliga
barnet), `render()` river `.container.innerHTML` och bygger om alla
grid-celler från den arrayen varje gång. Indentering är bara
`depth * 18px` padding — nästling kan aldrig ackumulera fel. Kolumn-
uppsättningen (vilka attribut som visas som egna kolumner) är
användarkonfigurerbar via högerklick på headern, standard `["id", "class"]`.

**Prestanda-knep värt att känna till**: `_onStoreChange` jämför
`xmlStore.root`/`schema` med referens-likhet — om oförändrat (dvs. eventet
var *bara* en markeringsändring) hoppas hela `render()` över till förmån
för `_updateSelectionHighlight()`, som bara togglar `.selected`-klassen på
befintliga celler. Det här är medvetet för att bevara webbläsarens
dubbelklicks-detektion, som kräver *samma* DOM-element mellan båda klicken
— en full ombyggnad vid varje markering skulle tyst göra dubbelklick-för-
att-redigera-attribut obrukbart. **Rör inte den optimeringen utan att
tänka på det.**

**Interaktioner**: klick markerar (`xmlStore.selectNode`); dubbelklick på
tag-namn öppnar en popover med schema-tillåtna namn
(`xmlStore.updateTagName`); "+" lägger till barn (öppnar samma popover om
schemat tillåter fler än en typ, skapar direkt om bara en, skapar ett
generiskt `"element"` utan schema); ✕ raderar, ⎘ duplicerar; attribut-
celler redigeras inline via dubbelklick (Enter/Escape/blur). Dra-och-
släpp för omordning/omflyttning är helt schema-drivet (drop-zon beräknas
från Y-position i raden: övre 25% = "före", nedre 25% = "efter", mitten =
"in i"/reparent). Filsläpp från File Manager hanteras i tre zoner (sätt
`src`, infoga `AudioBufferSourceNode` före/efter), gated av schemats
deklarerade src-attribut och tillåtna barn.

Inga tangentbordsgenvägar i den här filen (bara Enter/Escape inuti
attribut-redigeringsfältet).

#### wa-node-inspector.js (~980 rader)

Attributpanelen för markerad nod. Med aktivt schema visas **varje**
schema-deklarerat attribut (även osatta) — inget separat "lägg till
attribut"-flöde behövs då, användaren ser hela listan direkt. Utan schema
(eller för en tagg schemat inte känner till): bara de attribut som redan
finns + en fri "lägg till attribut"-rad.

Har egen tag-namn-fält (read-only om schemat bara tillåter en root-typ)
och text-content-fält (visas bara om schemat/`allowsText` tillåter det).
Kontroller per attributtyp (boolean → checkbox, enum → select + "Custom..."-
läge, number → slider+textfält med pennikon-toggle till fritext, union →
samma pennikon-cykling mellan medlemstyper). Se
[architecture-overview.md](architecture-overview.md#live-ljud-utan-att-stoppa-uppspelningen)
för `_isLocalEdit`-mönstret och live-audio-nudgen som skiljer den här
filens `onChange` från en trivial attributsättning.

#### wa-schema-input.js (~209 rader)

Låter användaren byta aktivt XSD-schema: filuppladdning
(`<input accept=".xsd,.xml">` + `FileReader`) eller URL-fetch, båda via
`parseXsdSchema()` → `xmlStore.setSchema(schema, fileName)`.
**Rör aldrig det öppna dokumentet** — `setSchema`/`clearSchema` skickar
sitt `"change"`-event med `structural: false` explicit (så
`player-store.js` inte tolkar ett schemabyte som att ljudgrafen behöver
laddas om), och varken trädet eller markeringen nollställs. Element/
attribut som blir schema-ogiltiga med det nya schemat renderas bara fritt
(oskyddad text/tagg) tills användaren nästa gång interagerar med dem.

### wa-preview.js (~309 rader)

Panel 3 — kontext-beroende förhandsvisning av markerad nod. Håller en
`Map` av "states" (`empty`/`section`/`mixer`/`audio`/`missing`/`fallback`)
och togglar vilken som är synlig via CSS (`display: none` på alla utom
den aktiva) — `<wa-section-view>` och `<wa-mixer-view>` förblir båda
monterade hela tiden och lyssnar själva på `xmlStore`, samma mönster som
låter dem hålla sitt eget state levande medan de är dolda.

**"Sticky" context-vy**: markera något *inuti* en redan visad `<Section>`
eller `<Mixer>` (t.ex. klicka en Layer-box i arrange-vyn, eller ett filter
i en channel strip) byter inte bort panelen till en bar attributlista —
`isDescendantOfTag(node, tagName)` gör en riktig träd-vandring uppåt
(`.parent`-kedjan) istället för en hårdkodad tagg-whitelist, så det gäller
för *alla* framtida elementtyper nästlade i en Mixer/Section, inte bara
de som fanns när koden skrevs.

För allt annat: hittar schemat en src/source-attribut-deklaration
(`findSrcAttribute`) → visar waveform + WAXML play/stop-knappar (via
`WaxmlBridge`); annars fallback-vy med rå attributlista.

#### wa-section-view.js (~2670 rader — den näst största filen i appen)

DAW-stil arrange-vy för **en** `<Section>`s interna tidslinje-struktur.

**Datamodell** (se `section-model.js` nedan för matten): en `<Section>`
har en eller flera parallella `<Layer>`-spår. Ett Layer har antingen en
egen `src` (kontinuerlig waveform, inget eget `pos`/`length`) eller
`<Segment>`-barn (positionerade på tidslinjen via `pos`,
bar.beat.offbeat-notation, och valfri `length`). Ett Segment kan i sin tur
ha `<Option>`-barn som alternativ (delar Segmentets tidsslot — Options
inuti ett Segment har **inget eget** `pos`). `<Stinger>` är barn direkt
till `<Section>`, ligger **utanför** den linjära tidslinjen och kan
triggas när som helst under uppspelning — dess egna `<Option>`-barn har
DÄREMOT ett meningsfullt `pos`/`upbeat` (staplas ovanpå Stingerns egen
ankarposition). `<Command>` kan förekomma under Layer/Segment/Option/
Stinger, ren klickbar tagg utan tidslinje-geometri.

**Nyckel-interaktioner**: dra ljudfiler från File Manager till en
Layer/Segment/Option/Stinger för att skapa/ersätta innehåll (native HTML5
DnD); dra befintliga Option/Segment-boxar för omordning/omflyttning
(egna `dataTransfer`-typer `OPTION_DRAG_TYPE`/`SEGMENT_DRAG_TYPE`, en
transparent 1×1-drag-bild för att kringgå en webbläsarbugg i klippta
scroll-containrar); dra en Stingers ankare för att skriva om `quantize`,
eller dess innehåll för att skriva om `pos`; dra en Layers loop-markör för
`loopLength`; klick (+Cmd/Ctrl för multi-select) för markering, Delete/
Backspace för radering; dubbelklick på en Stinger triggar den live under
uppspelning.

**Arkitektoniskt notabelt**:
- **Ingen `_isLocalEdit`-guard här** — till skillnad från Mixern/Inspector
  skriver den här vyn ingenting till `xmlStore` under själva draget
  (flyttar DOM-element direkt via `style.left`), bara vid `pointerup`/drop.
  En medveten annan lösning på samma "rivs mitt i draget"-problem.
- **Uppspelning är helt extern** — vyn startar/stoppar aldrig ljud själv,
  läser bara `playerStore.isPlaying`/`activeSectionId` och animerar sin
  egen playhead. Att BYTA vilken Section man TITTAR på får aldrig avbryta
  det som faktiskt SPELAS.
- **Inget seek/scrub i waxml.js** — Play startar alltid från början; känd
  begränsning, dokumenterad i filens header-kommentar.
- **Grid/snapping**: `_effectiveGridBeats` väljer finaste rutnäts-
  upplösning som fortfarande är ≥ ett minsta pixelavstånd vid aktuell
  zoom, begränsat uppåt av användarens eget menyval.
- **Ljud-svansar ritas medvetet UTANFÖR sin box** (`.timed-box` har inget
  `overflow: hidden`) — ett Segment/Option vars riktiga avkodade ljud är
  längre än sin kvantiserade `length` visar överskottet visuellt istället
  för att klippa det.
- **`_getActiveSectionNode()` måste användas istället för
  `xmlStore.getSelectedNode()`** för "vilken Section visar jag" — den
  globala markeringen pekar väldigt ofta på något INUTI Sectionen, inte
  Sectionen själv.
- Inget publikt API (attribut/events) på `<wa-section-view>` — all
  kommunikation med resten av appen sker via de delade singletonsen
  (`xmlStore`, `playerStore`, `WaxmlBridge`, `vfs`).

**Gotchas**: `pos` och `length`/`loopLength`/`quantize` använder helt
olika grammatik — lätt att blanda ihop. `parseDivision`s hantering av
`"ms"`-värden återger MEDVETET en trolig bugg i `waxml.js` (multiplicerar
istället för dividerar med 1000) — fixa inte det här utan att också
bekräfta/fixa motorn. Ett Options `pos` betyder olika saker beroende på
förälder (ignoreras i ett Segment, meningsfullt i en Stinger) — känd
skarp kant i schemat.

#### wa-mixer-view.js (~2500 rader — den största filen i appen)

Analog-mixer-stil channel-strip-vy för en `<Mixer>`. Se
[architecture-overview.md](architecture-overview.md#mixer-vyn-den-mest-komplexa-panelen)
för sammanhanget och [mixer-solo-engine-todo.md](mixer-solo-engine-todo.md)
för vad som saknas motor-sidan.

**Varje barn till `<Mixer>` får en egen channel strip.** En "Full Channel
Strip" (skapad via kanaltyp-menyns "+"-knapp) byggs av: en mute-`GainNode`
(alltid först), 0+ `BiquadFilterNode` (EQ, i XML-ordning uppifrån-ner),
insert-`Wam`-noder, `Send`-noder, en `StereoPannerNode`, och en volym-
`GainNode` (alltid sist bland GainNodes). `_classifyChain()` är den
centrala heuristiken som skiljer mute- från volym-GainNode (position, inte
tagg — det finns ingen XML-nivå-markör) och pre- vs. post-fader Sends
(positionen relativt volym-noden i XML:et) — **återanvänds överallt** en
"vilken är chainens riktiga X" behövs; en glömd användning av den (istället
för en naiv `find(tagName === "GainNode")`) var en riktig, hittad bugg.

**Sektionshöjder** (Filter/Insert/Send) är delade mellan ALLA kanaler —
satta av vilken kanal som har MEST innehåll av den typen, så rader ligger
i linje oavsett hur mycket EQ/insert/send en enskild kanal har. Insert/
Send är annars innehålls-anpassade (ingen fast minimihöjd) och delar
`flex-grow` sinsemellan för överbliven höjd.

**Solo-designet** (den mest genomarbetade delen, se separat kommentar-
historik i filen): en horisontell 0–1-slider (`solo`-attributet) väljer
kontinuerligt mellan kanaler; varje kanals egen Solo-knapp hoppar slidern
till sin position men **lampan lyser aldrig direkt vid klick** — den
läser uteslutande av en live `getChannelGain(index)`-avläsning (som ännu
inte finns i `waxml.js`), eftersom den verkliga övergången kan vara
fördröjd (`quantize`) eller gradvis (`transitionTime`) och att hoppa i
förväg skulle ljuga om det. En separat blinkande kant (`.standby`) visar
istället "du har klickat, väntar på verkligt läge", buren av instans-state
(`_pendingSoloChannelIndex`) eftersom commit-anropet triggar en synkron
full omritning som annars skulle riva bort just den knapp som klickades.

**Live-drag-kontroller** (gain/freq/Q/pan-rattar, fader, send-nivå):
committar nu kontinuerligt (varje pointermove) till `xmlStore` via en
`_commitAttributes()`-helper som sätter `_isLocalEdit` runt anropet — se
architecture-overview.md för själva mönstret. Alla utom fadern (egen
pointer-wiring) delar `_wireVerticalDrag(el, startValue, min, max,
onLiveChange, onCommit)`.

**Filter-sektionens "+"** öppnar en meny med `BiquadFilterNode`s hela
`type`-enum (läst live från schemat, `getBiquadTypeOptions()`) — samma
mönster som kanaltyp-menyn (`_toggleChannelTypeMenu`). Nya filter får
typberoende startfrekvens (`FILTER_TYPE_DEFAULT_FREQUENCY`: highshelf
4000Hz, peaking 400Hz, lowshelf 150Hz, övriga 300Hz).

### wa-xml-code.js (~235 rader)

Rå XML-textpanelen — panel 4. **DOM-struktur**: tre exakt överlappande,
absolut-positionerade lager (`.line-bg` för radmarkering, `.highlight`
för syntax-färgad, icke-interaktiv `<pre>`-liknande text, och en riktig
`<textarea>` överst med `color: transparent`/synlig caret) — det klassiska
"transparent textarea ovanpå highlightad kopia"-tricket. Highlightning
konsumerar `tokenizeXml()` (se `xml-tokenizer.js`) direkt.

**Text → store**: odebouncat — varje `input`-event anropar
`xmlStore.setCodeValue()` direkt, skyddat av en egen `_isLocalEdit`-flagga
så butikens resulterande `"change"` inte snurrar tillbaka och skriver
över textarean mitt i skrivandet. Tab infogar två mellanslag istället för
att flytta fokus.

**Caret ↔ träd, båda vägar**: klick/piltangenter i textarean räknar
radnummer till caret-positionen → `xmlStore.getNodeIdAtLine()` →
`xmlStore.selectNode()`. Omvänt: vid varje `"change"` läses
`xmlStore.getLineRange(selectedNodeId)` och markerar rätt rad-intervall
med en subtil bakgrund. **Ingen auto-scroll** åt något håll när
markeringen ändras externt — bara highlight/klass uppdateras.

---

## Header

### wa-file-menu.js (~209 rader)

Tre menyval: **New Project**, **Open Project**, **Export Project...**.
New och Open går båda genom en inline "Släng nuvarande projekt och
starta/öppna...?"-bekräftelse (ingen `confirm()`) innan de anropar
`createDefaultProject()`/öppnar filväljaren (`accept=".zip,.xml,.waxml"`)
→ `openProjectFromFile(file)`. Export har ingen bekräftelse — anropar
`exportProjectAsZip()` direkt.

### wa-player-bar.js (~176 rader)

Global Play/Stop, oberoende av vilken Preview-vy som visas (se
architecture-overview.md). Stop, inte Pause — inget separat pausat läge.
Ett fritt redigerbart CSS-selector-textfält (auto-ifyllt när en `<Section>`
markeras, men aldrig låst) avgör vad PLAY faktiskt triggar
(`playerStore.setTriggerSelector`). Ingen tempo- eller transportposition-
visning. Renderar dessutom en snabbknapp per root-nivå
`<Command type="trig">`, grupperade visuellt via delat `class`-attribut
(kommentar i filen flaggar att `<Command>`s schema inte formellt
deklarerar `class`/`id` — läser alltså odeklarerad data, värt att fixa i
schemat).

---

## Delat ramverk

### wa-panel.js (~213 rader)

Generisk visa/dölj/resize-wrapper, används av alla fyra huvudpaneler (se
architecture-overview.md). Kollapsad krymper panelen till en smal
ikonrand och lämnar sin bredd till närmaste expanderade panel till
vänster (`_findAbsorbingNeighbor`) — inte nödvändigtvis den enda panelen
märkt `fill`. Publik `collapsed`-getter; `toggleCollapse(force)` skickar
ett `"collapse-change"`-CustomEvent (tillagt 2026-08-30 för
`workstation-state.js`s räkning).

---

## Kärn-datamoduler

### xml-store.js, xml-tree-ops.js, schema-parser.js

Se [architecture-overview.md](architecture-overview.md) — dessa tre är
kärnan i hela redigeringsupplevelsen och beskrivs där i detalj
(dokumentträdets form, strukturell/icke-strukturell-flaggan, det interna
trädid:t kontra XML `id`-attributet, schema-tolkningen och 2026-08-30-
buggen i `applyBaseKeyword`).

### attribute-controls.js (~49 rader)

Två rena hjälpfunktioner åt `wa-node-inspector.js`: `testPattern(pattern,
value)` (regex-validering mot ett XSD-`pattern`) och
`getSmartRange(attrName, schemaMin, schemaMax)` — om schemat inte
deklarerar min/max, gissa ett rimligt intervall från attributnamnet
(`gain`→0–1, `pan`→-1–1, `frequency`→0–20000, `detune`→±1200, osv.), annars
härled steglängd (0.01/0.1/1) från spannets storlek.

### src-attribute.js (~45 rader)

Delad logik för "vilket attribut på den här noden pekar på en fil":
`getSchemaSrcAttributeName`/`findSrcAttribute` (schema-driven, med
fallback till bokstavligt `src`/`source` utan schema) och
`resolvePlayableUrl(value)` — riktiga URL:er (http/blob/data) passerar
rakt igenom, VFS-exportsökvägar (`"drums/kick.wav"`) slås upp mot
`vfs.findByExportPath` och löses till sessionens `blob:`-URL. Används av
både `wa-xml-tree.js`s fil-drop och `wa-preview.js`/`waxml-bridge.js`.

### xml-tokenizer.js (~102 rader)

`tokenizeXml(code)` — radvis, kontextfri tokenisering (ingen token delas
över en radgräns) till `{type, text}`-listor: `comment` (även `<? ?>`),
`bracket`, `tag`, `attr-name`, `attr-value` (citattecknen inkluderade),
`text`. Konsumeras uteslutande av `wa-xml-code.js`s highlight-lager.

### section-model.js (~301 rader)

Ren matte/parsning åt `wa-section-view.js` — ingen DOM, ingen
sidoeffekt. `readSectionInfo` (tempo/timeSign/bar-/beat-duration),
`parseDivision` (bar-antal, `"X/Y"`-bråk, `"bar"`/`"beat"`, explicit
`"Xs"`/`"Xms"` → sekunder — med den medvetet ospikade `"ms"`-buggen, se
ovan), `parsePosition`/`readPos`/`secondsToPosString` (den ANDRA,
1-indexerade `bar.beat.offbeat`-grammatiken för `pos`, medvetet
omimplementerad separat från `waxml.js`s egen `eval()`-baserade
`posStringToObject`), `quantizeDroppedFileLength` (musikaliskt avrundad
längd för nydroppat ljud), plus Stinger-specifik ankar-matte
(`readStingerQuantizePosition` m.fl.).

### waveform.js (~35 rader)

Beroendefri waveform-rendering (min/max-peakar per pixelkolumn på en
`<canvas>`, ingen extern lib) — `decodeAudioBuffer(url, audioContext)` +
`drawWaveform(canvas, audioBuffer, color)`.

---

## Persistence

### VFS.js, zip-import.js, drag-types.js, selection.js, document-sync.js, project-manager.js, workstation-state.js

Se [architecture-overview.md](architecture-overview.md) för hela
livscykeln (Ny/Öppna/Exportera, `document-sync.js`s "utcheckad fil"-
mönster, `workstation-state.js`s design). Ett par detaljer värda att
komplettera med här:

- **`drag-types.js`** (14 rader, hela filen): en `VFS_FILE_DRAG_TYPE`-
  MIME-typ-konstant plus `vfsDragState = { fileId: null }` — ett muterbart
  sidokanal-objekt som kringgår webbläsarens "protected mode" för
  `dataTransfer` under `dragover` (där `getData()` inte fungerar än), så
  ett drop-mål kan slå upp VILKEN fil som dras redan innan drop (t.ex. för
  att förhandsvisa dess riktiga avkodade längd). Sätts av
  `wa-file-manager.js` vid `dragstart`/`dragend`.
- **`zip-import.js`**: filändelse-whitelist (`SUPPORTED_EXTENSIONS`) —
  allt annat hoppas TYST över vid zip-uppackning. `.json` lades till
  2026-08-30 specifikt för `workstation-state.json`.
- **`VFS.js`**: varje fil-nod bär en `sessionUrl` (`URL.createObjectURL`)
  som revokeras explicit vid `delete()`/`updateFileContent()` — inget
  läckage av object-URLs över en sessions livstid, så länge allt går via
  VFS:ens egna metoder (aldrig genom att peta i `_nodes` direkt).

---

## Ljud/uppspelning

### player-store.js, waxml-bridge.js, live-property.js, gain-units.js

Se [architecture-overview.md](architecture-overview.md#live-ljud-utan-att-stoppa-uppspelningen).
Kort sammanfattning av ansvarsfördelningen: `playerStore` äger globalt
play/stop-state och lyssnar på `xmlStore`s `structural`-flagga (stoppar +
tvingar omladdning vid en strukturell ändring, ignorerar attribut-
ändringar helt); `WaxmlBridge` är enda stället som pratar direkt med det
globala `window.waxml` (och håller den regeln att `waxml.init()` bara får
anropas inifrån en riktig klick-handler); `live-property.js` och
`gain-units.js` är de två små, delade byggstenarna (`applyLiveProperty`,
`linearRatioToDb`) som låter `wa-mixer-view.js` och `wa-node-inspector.js`
peta direkt på redan-spelande ljud utan att gå via `xmlStore`.

---

## Bootstrap

### app.js (~36 rader)

Laddar default-schemat (`schemas/waxml.xsd`) → `createDefaultProject()`.
Registrerar alla `<wa-panel>`-element hos `workstation-state.js`
(`registerPanels`). En `beforeunload`-guard varnar vid stängning/reload
— Steg 0 kör helt i RAM, ingen persistence överlever ett refresh förutom
det man just exporterat som zip.

### index.html

De fyra panelernas markup (med stabila `id`-attribut —
`fileManager`/`xmlEditor`/`preview`/`xmlCode` — som `workstation-state.js`
använder som JSON-nycklar), `<wa-file-menu>`/`<wa-player-bar>` i headern.
Laddar JSZip (CDN) och `waxml.js` (lokal fil, med en no-op placeholder-
`data-source` som ersätts direkt via `updateFromString()`).
