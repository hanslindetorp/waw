# WAW — komponentreferens

En fil, en sektion. Komplement till [architecture-overview.md](architecture-overview.md),
som beskriver hur delarna hänger ihop — det här dokumentet går igenom var
och en för sig. Radnummer är ungefärliga (filerna växer) men pekar rätt
inom några rader.

## Innehåll
- [Paneler](#paneler): wa-input-panel (+ wa-webcam-input, wa-var-picker),
  wa-file-manager (+ wa-file-preview), wa-xml-editor (+ wa-xml-tree,
  wa-node-inspector, wa-schema-input), wa-preview (+ wa-section-view,
  wa-composition-view, wa-mixer-view), wa-xml-code
- [Header](#header): wa-file-menu, wa-edit-menu, wa-view-menu,
  wa-player-bar
- [Bottom bar](#bottom-bar): wa-bottom-bar, wa-var-knobs
- [Library (DEMO), Share och API](#library-demo-share-och-api):
  wa-library-view, wa-share-dialog, wa-api-view
- [Delat ramverk](#delat-ramverk): wa-panel, wa-file-conflict-dialog,
  wa-notice-dialog, wa-voice-picker, toast
- [Kärn-datamoduler](#kärn-datamoduler): xml-store, xml-tree-ops,
  schema-parser, attribute-controls, src-attribute, variable-references,
  xml-tokenizer, section-model, waveform
- [Persistence](#persistence): VFS, zip-import, drag-types, selection,
  view, document-sync, project-manager, workstation-state
- [Ljud/uppspelning](#ljuduppspelning): player-store, waxml-bridge,
  live-property, gain-units
- [Bootstrap](#bootstrap): app.js, index.html

---

## Paneler

### wa-input-panel.js (~80 rader)

Panel 1 (längst till vänster, kollapsad som standard). Ren layout-wrapper
— en stapel kollapsbara "input-kanal"-sektioner (idag bara en:
`data-section="webcam"`, som hostar `<wa-webcam-input>`). Äger ingen
egen state alls, bara kollapsa/expandera-togglingen av varje sektions
`.section-body`. Tänkt att växa med fler sektioner (MIDI, OSC, "External
JavaScript") senare — se
[architecture-overview.md](architecture-overview.md#input-panelen-och-webbkameran-nytt-2026-09-22)
för hela INPUT-lagrets arkitektur (utanför WAXML-schemat, skriver bara
till vanliga root-`<Var>` via `playerStore.setVariable()`).

### wa-webcam-input.js (~1125 rader)

MediaPipe hand-/pose-/face-landmark-spårning i webbläsaren, porterad
nära verbatim från Hans egen referensimplementation
(https://msw.waxml.org/, hämtad 2026-09-22). Laddar
`@mediapipe/tasks-vision` (version låst, `MEDIAPIPE_VERSION`) som ett
dynamiskt CDN-modulimport, plus tre modeller (`hand_landmarker`,
`pose_landmarker_lite`, `face_landmarker`) — alla tre laddas en gång och
hålls varma över senare Stop/Start-togglingar (`_ensureModelsLoaded`),
aldrig automatiskt bara för att panelen är synlig.

**Matte** (ren, DOM-fri, samma namn/formler som referensen): `dist2d`/
`dist3d` för två punkter, `area2d`/`area3d`/`circum2d`/`circum3d` för tre
(triangel), `area2d`/`circum2d` för fler (polygon) — `calcValues(pts,
type)` väljer rätt formelset från antal valda landmärken
(`typeForCount`).

**Interaktion**: klick på en landmärkespunkt i canvasen väljer/avväljer
den (`_onCanvasClick`/`_nearestLandmark`, hit-test mot alla just nu
synliga landmärken från de påslagna modellerna); "Add" sparar den
aktuella kombinationen som en ny rad (`_savedEntries`, `_buildSavedRow`)
med löpande liveberäknade värden. Varje beräknad metrik-nyckel (x/y/z,
dist2d/dist3d, ...) har en egen mappnings-kontroll
(`_buildMapControl`/`_refreshMapControl`) som öppnar `wa-var-picker.js`
och skickar `playerStore.setVariable(name, value)` för just de metriker
som faktiskt är mappade (`_sendMappedValues`) — allt annat är bara
visningsläge.

**Persistence**: `getState()`/`applyState()` (modell-toggles, vald
kamera, sparade rader + deras mappningar) — kopplas in av
`workstation-state.js`s `registerLayoutExtras({ webcamInput })` via ett
`"state-change"`-event (`composed: true`). Aldrig `wa.xml`-innehåll, se
architecture-overview.

### wa-var-picker.js (~225 rader)

Popup "välj ett root-`<Var>`, eller skapa ett nytt" — öppnad från
`wa-webcam-input.js`s per-metrik-mappningskontroller. Samma imperativa
mönster som `wa-voice-picker.js`s `openVoicePicker` (se Delat ramverk
nedan): `const name = await openVarPicker(anchorRect);`. "New
Variable..." skapar `<Var>`:et direkt (`xmlStore.addRootVar(name)`) med
ett föreslaget, redan genererat namn (`generateVarName`) redigerbart
innan commit — till skillnad från en voice (bara en textsträng) skapar
den här pickern alltså faktiskt ett nytt element vid val.

### wa-file-manager.js (~865 rader — mer än fördubblad sedan förra genomgången)

Filträdet för `vfs` — panel 2 (efter Input-panelen, se ovan). Renderas rekursivt (`_renderChildren` →
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

**Multi-select (nytt, 2026-09-15)**: egen Finder/Explorer-stil
`_selectedIds`-`Set`, skild från den delade `selection`-singleton —
Cmd/Ctrl-klick togglar en rad, Shift-klick markerar det synliga
intervallet från senaste vanliga klick (`_flattenVisibleIds`, respekterar
hopfällda mappar). Drar man en rad som redan är markerad följer HELA
multi-markeringen med i draget (annars kollapsas markeringen till bara
den dragna raden, som i ett riktigt filväljarfönster) — se
[architecture-overview.md](architecture-overview.md#file-manager-multi-select-mappdrop-och-namnkollisioner-nytt-2026-09-1518)
för hela mönstret, delat med `xmlStore`s egen multi-select.

**Namnkollision (nytt, 2026-09-18)**: `_handleFiles`/
`_moveNodesWithConflictCheck` frågar via `wa-file-conflict-dialog.js`
(Replace/Keep both/Cancel) innan en uppladdning eller intern flytt skulle
skriva över en redan existande fil med samma namn i målmappen — gäller
både ett Finder-drop och ett drag internt i File Manager, aldrig `.zip`
(packas alltid upp, blir aldrig en egen fil att kollidera).

**Riktigt mapp-drop från OS (nytt, 2026-09-16)**: `_handleDataTransfer`
läser `dataTransfer.items`/`webkitGetAsEntry()` (synkront, innan någon
`await`) för att få en riktig `FileSystemEntry` att rekursera igenom
(`_importEntries`/`_readAllEntries`) — en dropped mapp blir en riktig VFS-
mapp i stället för att plattas till en oanvändbar fil. Faller tillbaka
till den gamla `dataTransfer.files`-vägen om `webkitGetAsEntry` saknas.

**Ljudfil-förhandsvisning (ändrat, 2026-09-16)**: ett enkelklick på en
ljudfil (`isPreviewableAudioFile`, importerad från `wa-file-preview.js`,
se nedan) väljer bara — förhandsvisning + autoplay kräver nu ett
dubbelklick (`_wireFileDoubleClick`). Allt annat (mappar, `.xml`-filer)
är oförändrat enkelklicksaktiverat. Byt-namn-på-dubbelklick är avstängt
just för ljudfiler (`dblClickToRename: false`) eftersom dubbelklicket
redan betyder något annat där — pennikonen fungerar fortfarande.

### wa-file-preview.js (~310 rader, ny)

Panel 2:s (File Manager) egen yta har ingen waveform-vy — den här filen är
det: en alltid monterad, `xmlStore`-oberoende komponent som lyssnar direkt
på `selection` (samma singleton File Manager skriver till) och visar
waveform + transport (play/stop/loop/gå-till-start) + klicka-för-att-söka
för en markerad ljudfil, oavsett om filen ens refereras någonstans i XML:et
än. Spelar upp via en vanlig `<audio>`-tagg, inte WAXML-motorn/bridgen —
det här är en fristående asset-preview, inte en del av kompositionsgrafen,
så den varken behöver eller vill ha motorns gesture-gate:ade
`AudioContext`-livscykel. `bridge.audioContext` (en egen `WaxmlBridge`-
instans) återanvänds bara för `decodeAudioBuffer`s waveform-peaks, för att
undvika en andra samtidig `AudioContext`. Exporterar
`isPreviewableAudioFile(node)` (`.mp3/.wav/.ogg/.m4a`), delad med
`wa-file-manager.js` och `wa-preview.js` (som växlar till samma "file"-
state — se nedan — när en ljudfil markeras i File Manager, oavsett vilken
XML-nod som råkade vara markerad sen tidigare).

### wa-xml-editor.js (~125 rader — växte från 45)

Ren komposition, i grunden ingen egen logik. Staplar `<wa-schema-input>`
(dold sedan 2026-09-15 — se nedan; fast höjd, överkant), `<wa-xml-tree>`
(scrollar, ensam ägare av sin egen scroll-region) och
`<wa-node-inspector>` (docked underst) i sitt shadow DOM, delaren mellan
träd/Inspector nu dragbar och persisterad (`getSplitRatio`/
`setSplitRatio`, ett `"split-change"`-event — samma
`workstation-state.js`-mönster som `wa-panel.js`s eget). All annan
kommunikation mellan barnen sker via det delade `xmlStore`-singleton-
objektet, inte via denna wrapper.

`<wa-schema-input>` göms med `display: none` (inte borttagen) sedan
2026-09-15 — vilket schema som är laddat är i praktiken fast i den här
appen, så en bytbar/borttagbar schema-chip är bara skräp just nu; kommer
tillbaka den dag XML-editorn/Code-panelen bryts ut till ett mer
generellt, icke-WAXML-specifikt verktyg.

#### wa-xml-tree.js (~1540 rader — växte från 1088)

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

**Multi-select, klipp, "reveal" (nytt, 2026-09-06/08)**: klickhanteringen
(`_handleRowClick`, samma Finder/Explorer-mönster `wa-file-manager.js`
sen fick sin egen variant av) ropar `xmlStore.selectNode`/
`toggleNodeSelection`/`selectRange` beroende på Cmd/Ctrl-/Shift-modifierare
— se
[architecture-overview.md](architecture-overview.md#multi-select-kopieraklipp-ut-klistra-in-nytt-2026-09-0607).
En rad vars id finns i `xmlStore.clipboardCutIds` (en väntande cut, inte
än flyttad) får en streckad "markerad för klipp"-stil. `selectNode`s
`reveal: true`-läge (satt externt, t.ex. av ett dubbelklick i Section/
Composition-preview) expanderar varje hopfälld förälder till noden och
scrollar in den.

**Persisterad kolumn-/hopfällningsstate (nytt, 2026-09-15)**:
`getColumnsState()`/`applyColumnsState()` och
`getCollapsedState()`/`applyCollapsedState()` — lästa/satta av
`workstation-state.js` via `registerLayoutExtras`, skickar egna
`"columns-change"`/`"collapse-change"`-event (`composed: true`) så en
kolumnändring eller en fälld/expanderad rad faktiskt sparas i
`workstation-state.json`, inte bara i minnet för sessionen.

Inga egna tangentbordsgenvägar i den här filen (Undo/Redo/Copy/Cut/Paste
är globala, se `wa-edit-menu.js` — bara Enter/Escape inuti attribut-
redigeringsfältet hanteras lokalt här). Radering av en nod är fortfarande
bara `✕`-knappen i raden, eller en vy-specifik Backspace/Delete-lyssnare
(Mixer-kanaler, Section/Composition-preview, Command-/Var-genvägarna i
bottom bar) — ingen generell "Backspace tar bort markerad nod"-genväg
finns för XML-trädet självt.

#### wa-node-inspector.js (~1350 rader — växte från 980)

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

Ett `voice`-attributs kontroll (`_renderVoiceControl`, nytt 2026-09-15)
öppnar `wa-voice-picker.js` (se Delat ramverk nedan) i stället för ett
fritt textfält — samma `<Layer>`/`<Stinger>`-delade "voice"-grupperings-
koncept som schemat definierar.

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

### wa-preview.js (~400 rader — växte från 309)

Panel 4 — kontext-beroende förhandsvisning av markerad nod. Håller en
`Map` av "states" (nu nio: `empty`/`section`/`composition`/`file`/`mixer`/
`wam`/`audio`/`missing`/`fallback`) och togglar vilken som är synlig via
CSS (`display: none` på alla utom den aktiva) — `<wa-section-view>`,
`<wa-composition-view>` och `<wa-mixer-view>` förblir alla monterade hela
tiden och lyssnar själva på `xmlStore`, samma mönster som låter dem hålla
sitt eget state levande medan de är dolda.

**"Sticky" context-vy**: markera något *inuti* en redan visad `<Section>`
eller `<Mixer>` (t.ex. klicka en Layer-box i arrange-vyn, eller ett filter
i en channel strip) byter inte bort panelen till en bar attributlista —
`isDescendantOfTag(node, tagName)` gör en riktig träd-vandring uppåt
(`.parent`-kedjan) istället för en hårdkodad tagg-whitelist, så det gäller
för *alla* framtida elementtyper nästlade i en Mixer/Section, inte bara
de som fanns när koden skrevs. Samma idé har nu en syster,
`findAncestorOrSelf` (nytt, 2026-09-05/07), som returnerar den faktiska
förälder-noden i stället för bara ett booleskt svar — den avgör "vilken
`<Section>` hör den här markeringen till" för Layer/Segment/Option/
Stinger/Command, så att t.ex. en klickning rakt in i ett `<Layer>` från
XML-trädet öppnar rätt Section-vy i stället för att falla igenom till en
bar attributlista. Ett särfall: en vanlig (icke-`open`) markering av en
Section (eller dess ättling) som redan tillhör den Composition som just
nu visas i Composition-preview byter INTE bort panelen från Composition-
vyn — bara ett explicit "öppna" (dubbelklick, `selectNode`s `open`-läge)
tvingar bytet, samma "sticky"-princip som Mixer/Section ovan.

**Ny "file"-state** (nytt, 2026-09-10): en markering i `selection`
(File Manager, helt fristående från `xmlStore`) tar över panelen på
samma sätt som en ny XML-markering skulle, om filen är en förhandsvisbar
ljudfil (`isPreviewableAudioFile`, från `wa-file-preview.js`) — visar
`<wa-file-preview>`. En efterföljande, orelaterad `xmlStore`-`"change"`
(t.ex. en live attributändring nån annanstans) rycker inte undan
file-vyn av misstag; bara en genuint NY XML-trädmarkering gör det.

För allt annat: hittar schemat en src/source-attribut-deklaration
(`findSrcAttribute`) → visar waveform + WAXML play/stop-knappar (via
`WaxmlBridge`); annars fallback-vy med rå attributlista.

#### wa-section-view.js (~4340 rader — nu den STÖRSTA filen i appen, gick om Mixern)

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

**Per-rad Layer/Stinger-kontroller, delvis pausade (nytt 2026-09-11,
pausat 2026-09-15)**: `_buildLayerControls` bygger en volymfader+VU,
Mute/Solo och en output-routingknapp för varje Layer-/Stinger-rad — men
just nu är bara output-knappen faktiskt synlig, fader/Mute/Solo är
avstängda i väntan på en fix (koden finns kvar, tre rader kommenterade
ut). Se
[architecture-overview.md](architecture-overview.md#section-preview-daw-vyn-för-section-nytt-2026-08–09)
för hela historiken, inklusive Solo-designen (inget eget XML-attribut,
mutear syskon i stället) och "reveal"-gesten (`selectNode`s `reveal`-
läge, expanderar/scrollar XML-trädet till noden — satt av ett
dubbelklick på en Layer-etikett eller Segment/Option-box här).

#### wa-mixer-view.js (~3115 rader — näst störst, omkörd av Section-vyn)

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

**Bara element med signal blir kanaler (nytt, 2026-09-21)**:
`hasAudioSignal()`/`MIXER_NO_SIGNAL_TAGS` (`Var`, `Send`, `Envelope`)
filtrerar bort `<Mixer>`-barn som inte är egna ljudkällor innan
channel-strip-listan byggs — `<Include>` räknas medvetet INTE hit. Se
[architecture-overview.md](architecture-overview.md#mixer-vyn-den-mest-komplexa-panelen)
för det, och för Var-styrd solo (`solo="$namn"` låser både storslidern
och varje kanals Solo-knapp mot klick, `this._soloLocked`).

#### wa-composition-view.js (~1775 rader, ny)

Composition Preview — se
[architecture-overview.md](architecture-overview.md#composition-preview-vy-för-spelsekvensen-av-sections-nytt-2026-09-05→21)
för hela beskrivningen (spelsekvens-vy för `<Composition>`s `<Section>`-
barn, en syster-arkitektur till Section-vyn ovan men ingen delad kod
mellan dem förutom `section-model.js`s DOM-fria matte). Sammanfattat här:

- Reguljära vs. transition-Sections (`from`/`to`/`syncTo` — `syncTo` är
  det nya namnet på schemats gamla `quantize`, 2026-09-07), med en
  "From Section:"-popup för att välja transitionens startpunkt.
- `tempo`/`timeSign` kopieras explicit ner från `<Composition>` (eller,
  för en transition, från "to"-Sectionens eget effektiva värde) redan vid
  skapande — se `_insertTransition` och `xmlStore.insertNewChild`s egen
  Section-gren.
- `<Composition>` själv är raderbar med Backspace/Delete (nytt,
  2026-09-21) — `_onKeyDown`, med samma `defaultPrevented`-vakt mot
  dubbel-radering som `wa-bottom-bar.js`/`wa-player-bar.js` använder.
- Playhead/pending-feedback drivs av `waxml.js`s egna
  "Section-på-väg-att-trigga"-event (`_onSectionTrig`), inte en klient-
  sidig gissning.
- Multi-select + kopiera/klipp ut/klistra in via samma delade
  `xmlStore`-mekanik som resten av editorn — ingen egen implementation.

### wa-xml-code.js (~265 rader)

Rå XML-textpanelen — panel 5. **DOM-struktur**: tre exakt överlappande,
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

Bugg fixad 2026-09-08: `.gutter`/`.line-bg`/`.highlight` klipptes till den
synliga panelhöjden av sitt eget `overflow: hidden` (i stället för att
klippas av `.content`s, det avsedda stället) — `_syncScroll`s
`translateY` flyttade då bara en redan avklippt box runt på skärmen i
stället för att genuint scrolla fram rader bortom det som råkade synas
först. Fixat med `align-self: flex-start` (`.gutter`, opt-ar ut ur flex-
radens standard cross-axis-stretch) och `inset` bytt mot `top/left/right`
utan `bottom` (`.line-bg`/`.highlight`) — alla tre får nu sin naturliga,
odelade höjd i stället.

---

## Header

### wa-file-menu.js (~335 rader — omskriven 2026-09-03/14, växte från 209)

Fem menyval: **New**, **Open...**, **Save**, **Save As...**, **Share...**
— **Export Project...** och en Templates-sektion som tidigare satt här är
båda borta (2026-09-14, se
[architecture-overview.md](architecture-overview.md#file-menyn--savesave-asshare-nytt-2026-09-03-förenklad-2026-09-14)).
New och Open går båda genom en inline "Släng nuvarande projekt och
starta/öppna...?"-bekräftelse (ingen `confirm()`), Open via File System
Access API:s `showOpenFilePicker` där webbläsaren stödjer det (annars
klassisk `<input type="file">`). Save/Save As anropar
`saveProject()`/`saveProjectAs()` (se `project-manager.js` nedan) direkt,
ingen bekräftelse. Share öppnar `document.querySelector("wa-share-dialog")
.open()` — dialogen själv är monterad direkt i `<body>` (`index.html`),
inte här.

Genvägar: ⌘/Ctrl+N/O/S, ⇧⌘/Ctrl+S — `preventDefault()` anropas alltid,
även om webbläsaren i vissa fall ändå tar N/O själv (reserverade
webbläsargenvägar); S/⇧S är de som pålitligt fungerar.

### wa-edit-menu.js (~240 rader, ny)

Tredje menyn i headern: **Undo**, **Redo**, **Copy**, **Cut**, **Paste**
(med plattforms-korrekta genvägshintar, ⌘ på Mac annars "Ctrl"). Undo/
Redo delegerar rakt till `edit-history.js` (`undo()`/`redo()`,
`canUndo()`/`canRedo()` styr disabled-state); Copy/Cut/Paste till
`xmlStore.copySelection()`/`cutSelection()`/`pasteIntoSelection()` — se
[architecture-overview.md](architecture-overview.md#multi-select-kopiera-klipp-ut-klistra-in-nytt-2026-09-0607).
Egna globala Cmd/Ctrl+C/X/V-genvägar (skippade i redigerbara fält,
`isEditableContext()`) plus ett obetingat Escape som släpper en väntande
cut (`xmlStore.clearPendingCut()`) — den enda av de fem åtgärderna som
INTE kräver ett modifierat tangenttryck. Ett misslyckat paste (t.ex.
schema-ogiltig tagg för målet) visas som en `showToast()`-varning
(`js/ui/toast.js`, se Delat ramverk nedan) i stället för att tigas ihjäl.

### wa-view-menu.js (~130 rader, ny)

Fjärde menyn: **Workstation** / **Library (DEMO)** — togglar
`js/state/view.js`s `viewState` (se Persistence nedan). Samma
dropdown-stomme som `wa-file-menu.js`/`wa-edit-menu.js`, kopierad snarare
än delad (ingen egen logik gemensam bortom formen). Hade tidigare även en
tredje post, **API**, som togs bort 2026-09-13 när den vyn flyttade in i
Share-dialogen (se nedan) — bara två poster kvar nu.

### wa-player-bar.js (~520 rader — samma fil, ny hemvist 2026-09-20)

Filen är i grunden oförändrad (Play/Stop, det fritt redigerbara CSS-
selector-fältet, root-nivå `<Command type="trig">`-genvägar grupperade
via delat `class`, Var-rattar via `<wa-var-knobs>`) men **headern har
inte längre en egen instans** — den ytan flyttade ut till
`wa-bottom-bar.js` (se nedan). Komponenten lever kvar och monteras nu bara
en gång, i Library (DEMO)-vyns bottombar
(`js/components/wa-library-view.js`), med ett nytt `minimal`-attribut
(rent CSS) som döljer Play-knappen/selector-fältet/"+"-knapparna och bara
visar Stop + de befintliga shortcut-knapparna + Var-rattarna — Library-
vyn har redan en egen, större Stop-kontroll på annat håll i sitt eget UI.
`[hidden]` reserverar numer en Var-knapps höjd i förväg (`min-height`) så
komponenten inte hoppar i storlek första gången en `<Var>`-ratt dyker upp.

---

## Bottom bar

### wa-bottom-bar.js (~640 rader, ny — den globala transporten, 2026-09-20)

Ersättaren för headerns gamla `<wa-player-bar>`, se
[architecture-overview.md](architecture-overview.md#bottom-bar--triggersvariables-flyttade-ut-ur-headern-nytt-2026-09-20)
för hela designen (global rad + villkorlig lokal rad, dynamisk
Triggers/Variables-breddbalansering). Kort sammanfattat per fil:

- **Två `<wa-var-knobs>`-instanser**: `.global-knobs` (scope: `null` =
  dokumentroten) och `.local-knobs` (scope: `this._localScopeNode()`,
  bara monterad/synlig via `:host(.has-local)`).
- **`_qualifyingCommands(scopeNode)`** filtrerar `<Command>`-barn till de
  som faktiskt är användbara: `type="trig"` med ett `value`, ELLER
  `type="set"` med ett `variable` — grupperade visuellt precis som förr
  via delat `class`.
- **`_recalcLayout()`** (kört på render + `resize`) mäter varje kolumns
  "unwrapped" naturliga bredd (`naturalWrapWidth`, tvingar tillfälligt
  `flex-wrap: nowrap` på både `.shortcuts`-containern och varje enskild
  `.shortcut-group` för att få ett sant mått) och sätter CSS-custom-
  propertyn `--trig-col-w` — grid-template-columns egen `1fr` för
  Variables-kolumnen absorberar resten.
- **`_onKeyDown`**: Space togglar Play/Stop (samma
  `defaultPrevented`-vakt mot `wa-player-bar.js`s identiska lyssnare, som
  fortfarande kan vara monterad samtidigt i Library-vyn); Backspace/Delete
  tar bort en markerad `<Command>` som hör till antingen den globala
  (root) eller den aktuella lokala scope-noden.
- **`_addVarElement()`** anropar bara `xmlStore.addRootVar()` — den
  faktiska grupperings-/index-logiken bor numer i `xmlStore` självt (se
  Kärn-datamoduler nedan), delad med `wa-var-picker.js`s "New
  Variable..."-flöde.

### wa-var-knobs.js (~435 rader — generaliserad 2026-09-20, tidigare odokumenterad)

En ratt per `<Var>`-barn till en "scope"-nod. Att vrida en ratt rör
**aldrig** `xmlStore` — den anropar `playerStore.setVariable(name, value)`
direkt, som vilken annan ren live-kontroll som helst (jämför
`live-property.js`s `applyLiveProperty`) — en ratts position lever bara i
komponentens egen `_values`-`Map`, inte i dokumentet.

- **`setScopeNode(nodeId)`** (`null` = dokumentroten) pekar om instansen
  — det som gör att samma komponent kan återanvändas för både den globala
  och den lokala raden i `wa-bottom-bar.js`.
- **`getNaturalWidth()`**: läser den ovikta bredden (tvingar `flex-wrap:
  nowrap` tillfälligt, mäter, återställer) — bottom bars egen
  breddbalansering (ovan) läser detta.
- **Värdet återställs vid omladdning**: en `<Var>`s levande `Variable`-
  objekt börjar alltid om på sitt XML-`default` vid en ny
  `waxml.updateFromString()` — `_onPlayerChange` upptäcker övergången
  `isDocumentLoaded: false → true` och skickar tillbaka varje ratts redan
  uppdragna värde direkt, så en strukturell ändring nån annanstans i
  dokumentet inte tyst nollställer en ratt användaren just ställt in.
- Dra-gest väljer INTE noden (bara ett rent klick gör, avgjort i
  `pointerup` genom att jämföra mot ett litet `DRAG_THRESHOLD_PX`) —
  samma "dra ≠ markera"-princip som Mixerns rattar. Dubbelklick
  återställer till `default`.
- Backspace/Delete tar bort den markerade `<Var>`, om den är ett av den
  här instansens egna scope-barn (samma `defaultPrevented`-vakt som
  `wa-bottom-bar.js`/`wa-player-bar.js`, eftersom flera instanser kan
  vara monterade samtidigt).

---

## Library (DEMO), Share och API

### wa-library-view.js (~570 rader, ny)

Spotify-lik "bibliotek av produktioner"-sketch (se
[architecture-overview.md](architecture-overview.md#view-meny-library-demo-och-share-dialogen-nytt-2026-09-1013))
— monterad direkt i `<body>` (`index.html`), togglad synlig av `app.js`
via `viewState`. Tio påhittade produktioner (`FAKE_PRODUCTIONS`, statiska
namn/beskrivningar/CSS-gradient-thumbnails, ingen bild-fil behövs) plus
det riktiga, öppna projektet — alltid inklistrat mitt i listan
(`Math.floor(list.length / 2)`) och alltid markerat aktivt (grön prick).
`describeRealProject(root)` bygger en riktig, faktabaserad beskrivning
(inga externa tjänster) genom att räkna Sections/transitions/Layers/
Stingers/ljudfiler/Mixer-kanaler/övriga Web Audio-noder direkt ur
`xmlStore.root`. Bottombaren är en rak `<wa-player-bar minimal>`-instans
(se ovan).

### wa-share-dialog.js (~115 rader, ny)

Modal overlay ("Share...", File-menyn) som bara wrappar `<wa-api-view>` i
en dialog-stomme (backdrop, header med stängknapp, Escape/backdrop-klick
stänger) — `open()`/`close()` togglar `hidden`. Ingen egen logik utöver
det; allt innehåll kommer från `wa-api-view.js`.

### wa-api-view.js (~355 rader — oförändrat innehåll, ompositionerad 2026-09-13)

Var tidigare en egen top-level "API"-vy (View-menyn); bor numer bara
inuti Share-dialogen, komponenten själv är i övrigt oförändrad. Fem
genererade kodblock (HTML `<script data-source="...">`-taggen, plus
`trig`/`set` var sin variant av HTML-attribut och JavaScript-API), byggda
live från det öppna projektets root-nivå `<Command type="trig">` och
`<Var>` (`rootTrigCommands`/`rootVars`, samma filter `wa-player-bar.js`s
egna shortcuts/knobs använder). Kodblocken byggs av riktiga DOM-text-
noder, aldrig `innerHTML` — en Commands `value`/ett Vars `name` (fri,
användarskriven XML-text) kan aldrig tolkas som markup. En riktig
**Export...**-knapp (nytt, 2026-09-18) anropar `exportProjectAsZip()` och
visar ett kort "Exporting..."-läge medan JSZip jobbar.

---

## Delat ramverk

### wa-panel.js (~340 rader — växte från 213)

Generisk visa/dölj/resize-wrapper, används av alla fem huvudpaneler (se
architecture-overview.md — Input-panelen inräknad sedan 2026-09-22).
Kollapsad krymper panelen till en smal ikonrand och lämnar sin bredd till
närmaste expanderade panel till vänster (`_findAbsorbingNeighbor`) — inte
nödvändigtvis den enda panelen märkt `fill`. Publik `collapsed`-getter;
`toggleCollapse(force)` skickar ett `"collapse-change"`-CustomEvent
(tillagt 2026-08-30 för `workstation-state.js`s räkning). En bredd-
ändring (drag i resize-handtaget, eller `setWidthBasis()`) skickar numer
även `"width-change"` (nytt, 2026-09-03/04) — samma
`workstation-state.js`-lyssnare, så en manuellt satt panelbredd
persisteras precis som kollaps-state.

### wa-file-conflict-dialog.js (~155 rader, ny)

Modal fråga vid namnkollision (se `wa-file-manager.js` ovan) — Replace/
Keep both/Cancel. Används imperativt: `const action = await
openFileConflictDialog(names)`, löser till `"replace"` | `"keep-both"` |
`"cancel"` (även vid Escape/backdrop-klick). Samma
skapa-elementet-lägg-i-body-och-vänta-in-ett-Promise-mönster som
`wa-voice-picker.js`/`wa-var-picker.js`/`wa-io-picker.js`.

### wa-notice-dialog.js (~110 rader, ny)

Minimal en-knapps "OK"-popup för ett engångsmeddelande — `xmlStore`s
`"notice"`-event (se `_applyActiveFadeTimeWorkaround`, Kärn-datamoduler
nedan) är den enda anroparen just nu. Används fire-and-forget:
`showNotice("...")`, inget returvärde att vänta in (bara en knapp, inget
val). Samma backdrop+dialog-stomme som `wa-file-conflict-dialog.js`.

### wa-voice-picker.js (~205 rader, ny)

Popup "välj en redan använd voice, eller skriv en ny" — öppnas från
`wa-node-inspector.js`s `voice`-attributkontroll. Alla `<Layer>`/
`<Stinger>`/etc. som delar samma `voice`-värde behandlas av `waxml.js`
som ETT monofoniskt instrument, så att välja från vad som redan
finns i dokumentet (i stället för att skriva om det för hand varje gång)
skyddar mot en tyst felstavning som råkar skapa en andra, orelaterad
voice-grupp. Samma imperativa `await openVoicePicker(existingVoices,
anchorRect)`-mönster som de andra pickers-komponenterna ovan.

### js/ui/toast.js (~45 rader, ny)

Minimal, beroendefri notis-toast — `showToast(message, { kind, durationMs
})`, fästs direkt i `document.body` (inte i någon komponents shadow DOM,
eftersom det här är en app-bred angelägenhet). Enda anroparen just nu:
`wa-edit-menu.js`s Paste, vid ett avslaget (schema-ogiltigt) klistra-in-
försök. Inget annat notis-/banner-verktyg finns i appen sen tidigare —
`console.warn` används för bakgrunds-only-problem, native `alert()`/
`confirm()` undviks medvetet överallt (jämför File-menyns egna inline-
bekräftelser).

---

## Kärn-datamoduler

### xml-store.js (~715 rader — mer än fördubblad sedan förra genomgången), xml-tree-ops.js (~475 rader), schema-parser.js

Se [architecture-overview.md](architecture-overview.md) — dessa tre är
kärnan i hela redigeringsupplevelsen och beskrivs där i detalj
(dokumentträdets form, strukturell/icke-strukturell-flaggan, det interna
trädid:t kontra XML `id`-attributet, schema-tolkningen och 2026-08-30-
buggen i `applyBaseKeyword`). Sen dess har `xml-store.js` fått: en riktig
multi-selektion (`selectedNodeIds`, `toggleNodeSelection`/`selectRange`)
och copy/cut/paste (`copySelection`/`cutSelection`/`pasteIntoSelection`,
schema-validerat innan commit); `addRootVar(name)` (delad av
`wa-bottom-bar.js`s "+"-knapp och `wa-var-picker.js`s "New
Variable..."-flöde); en Composition-sidans live-nudge-allowlist
(`LIVE_NUDGE_ALLOWED_ATTRS`/`LIVE_NUDGEABLE_COMPOSITION_TAGS`, för
`<Section>`/`<Layer>`/`<Stinger>`s generiska `.set()`); och `"notice"` —
den enda UI-riktade eventtypen modulen skickar, för
`_applyActiveFadeTimeWorkaround`s `<Layer active>`/`fadeTime="0"`-
workaround (se `wa-notice-dialog.js` ovan). `xml-tree-ops.js` fick
motsvarande hjälpfunktioner: `cloneNode` (id-ombytt kloning, för paste/
duplicera), `reparentNode`/`isDescendantOf` (för cut-paste respektive
paste-in-i-sig-själv-skyddet), `generateVarName`/`generateCommandId`/
`generateSectionClass` (auto-namngivning för nya `<Var>`/`<Command>`/
`<Section>`).

### variable-references.js (~25 rader, ny)

`isVariableControlled(value)`/`variableNameFromValue(value)` — avgör om
ett attributs råa strängvärde är en `"$namn"`-referens till ett `<Var>`
(regex kopierad från `waxml.js`s egen `WebAudioUtils.nrOfVariableNames`,
eftersom `waxml.js` bara laddas som en `<script>`-tagg och inte exponerar
sina interna hjälpare på `window`). Central i två helt olika sammanhang:
`xml-store.js`s regel att en `$var`-referens alltid tvingar en full
ombyggnad (se ovan), och `wa-mixer-view.js`s Var-styrda solo-lås.

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

### VFS.js, zip-import.js, drag-types.js, selection.js, view.js, document-sync.js, project-manager.js, workstation-state.js

Se [architecture-overview.md](architecture-overview.md) för hela
livscykeln (Ny/Öppna/Spara/Dela, `document-sync.js`s "utcheckad fil"-
mönster, `workstation-state.js`s design). Ett par detaljer värda att
komplettera med här:

- **`drag-types.js`** (nu ~36 rader, växte från 14): en
  `VFS_FILE_DRAG_TYPE`-MIME-typ-konstant plus `vfsDragState = { fileId,
  fileIds }` — ett muterbart sidokanal-objekt som kringgår webbläsarens
  "protected mode" för `dataTransfer` under `dragover` (där `getData()`
  inte fungerar än), så ett drop-mål kan slå upp VILKEN/VILKA filer som
  dras redan innan drop. `fileIds` (plural, nytt för multi-select-draget,
  2026-09-15) kompletterar det ursprungliga `fileId` snarare än att
  ersätta det. Sätts av `wa-file-manager.js` vid `dragstart`/`dragend`;
  `getDraggedFileIds(dataTransfer)` är den delade läsaren andra drop-mål
  (t.ex. `wa-xml-tree.js`) använder.
- **`zip-import.js`**: filändelse-whitelist (`SUPPORTED_EXTENSIONS`) —
  allt annat hoppas TYST över vid zip-uppackning. `.json` lades till
  2026-08-30 specifikt för `workstation-state.json`.
- **`VFS.js`**: varje fil-nod bär en `sessionUrl` (`URL.createObjectURL`)
  som revokeras explicit vid `delete()`/`updateFileContent()` — inget
  läckage av object-URLs över en sessions livstid, så länge allt går via
  VFS:ens egna metoder (aldrig genom att peta i `_nodes` direkt).
- **`js/state/view.js`** (~27 rader, ny): `viewState`, en minimal
  singleton (`"workstation"` | `"library"`) för vilken top-level-vy som
  visas — helt fristående från `xmlStore`/`vfs`/`playerStore`, se
  `wa-view-menu.js` ovan och architecture-overview.md.
- **`project-manager.js`** (~315 rader, växte): `saveProject()`/
  `saveProjectAs()` (nytt, 2026-09-03) bygger projektets egen zip
  (`buildProjectZipBlob`, `workstation-state.json` inkluderat) och
  skriver via File System Access API eller `<a download>`;
  `exportProjectAsZip()` bygger i stället `buildWebExportZipBlob` (nytt,
  2026-09-18) — samma `vfs`-vandring men UTAN `workstation-state.json`
  och MED en färsk `fetch("waxml.js")`-kopia bifogad. Se
  architecture-overview.md för hela skillnaden. `savedFileHandle` är
  modul-privat state (inte en komponents) — samma "var kom/gick projektet
  senast"-resonemang som `document-sync.js`s `currentFileId`.
  `loadTemplate()`/`listTemplates()` finns kvar men saknar sen 2026-09-14
  en anropande meny-post (dödkod, se architecture-overview.md).
- **`workstation-state.js`** (~185 rader, växte): utöver panel-kollaps
  persisteras nu även varje panels bredd (`panelWidths`, via `wa-panel.js`s
  `"width-change"`), XML-trädets kolumner/hopfällning
  (`xmlTreeColumns`/`xmlTreeCollapsed`), tre delare (`splits`:
  `xmlEditorTreeInspector`, `sectionLayerStinger`), Section-vyns
  label-kolumnbredd (`sectionLabelWidth`), och `wa-webcam-input.js`s egen
  state (`webcamInput` — modell-toggles, kamera, sparade
  landmärkes-mappningar). `registerLayoutExtras()` är navet alla dessa
  vy-specifika lyssnare kopplas in genom.

---

## Ljud/uppspelning

### player-store.js (~340 rader, växte), waxml-bridge.js, live-property.js, gain-units.js

Se [architecture-overview.md](architecture-overview.md#live-ljud-utan-att-stoppa-uppspelningen).
Kort sammanfattning av ansvarsfördelningen: `playerStore` äger globalt
play/stop-state och lyssnar på `xmlStore`s `"change"`-event (stoppar +
schemalägger en omladdning vid en strukturell ändring; en
icke-strukturell ändring kan i stället bära en `liveNudge`-detalj som
nudgar ett Composition-sidans levande objekt direkt, se nedan);
`WaxmlBridge` är enda stället som pratar direkt med det globala
`window.waxml` (och håller den regeln att `waxml.init()` bara får
anropas inifrån en riktig klick-handler); `live-property.js` och
`gain-units.js` är de två små, delade byggstenarna (`applyLiveProperty`,
`linearRatioToDb`) som låter `wa-mixer-view.js` och `wa-node-inspector.js`
peta direkt på redan-spelande ljud utan att gå via `xmlStore`.

Nytt sen förra genomgången: **`isDocumentLoaded`** (skild från
`isPlaying`) — grafen laddas nu proaktivt vid varje strukturell ändring,
inte bara lat vid första Play, så VU-mätare/solo-lampor/Var-rattar är
meningsfulla innan Play någonsin tryckts. **`_applyLiveNudge`** läser
`xmlStore`s `liveNudge`-detalj och anropar `.set(param, value)` direkt på
ett `<Section>`/`<Layer>`/`<Stinger>`s levande objekt (ingen omladdning)
— se `xml-store.js`s `LIVE_NUDGE_ALLOWED_ATTRS`/
`LIVE_NUDGEABLE_COMPOSITION_TAGS` ovan. `play()` väntar nu in en redan
pågående omladdning i stället för att bara konstatera att en var på gång
(bugg per Hans, 2026-09-04).

---

## Bootstrap

### app.js (~90 rader — växte från 36)

Laddar default-schemat (`schemas/waxml.xsd`) → `createDefaultProject()`.
Registrerar alla `<wa-panel>`-element hos `workstation-state.js`
(`registerPanels`), plus tre extra shadow-DOM-interna refs
(`registerLayoutExtras`: `xmlTree`/`xmlEditor`/`sectionView` — ett
shadow-boundary-hopp in i `wa-xml-editor`/`wa-preview` — och sen
2026-09-22 `webcamInput`, ett hopp in i `wa-input-panel`). Kopplar
`xmlStore`s `"notice"`-event till `showNotice()` (se
`wa-notice-dialog.js` ovan) — den enda platsen appen känner till att den
kopplingen finns. Driver `viewState`s show/hide-logik
(`applyView`, togglar `<main>`/`<wa-bottom-bar>`/`<wa-library-view>` och
`<title>` — se `wa-view-menu.js` ovan). En `beforeunload`-guard varnar
vid stängning/reload — Steg 0 kör helt i RAM, ingen persistence överlever
ett refresh förutom det man just exporterat/sparat.

### index.html

De fem panelernas markup (med stabila `id`-attribut —
`inputPanel`/`fileManager`/`xmlEditor`/`preview`/`xmlCode` — som
`workstation-state.js` använder som JSON-nycklar; `inputPanel` kollapsad
som standard, precis som `xmlCode`). Headern har tre menyer
(`<wa-file-menu>`/`<wa-edit-menu>`/`<wa-view-menu>`) men ingen
spelkontroll längre — `<wa-bottom-bar>` sitter i stället som ett eget
element utanför `<main>`, och `<wa-library-view>`/`<wa-share-dialog>`
(båda `hidden` som standard) direkt i `<body>`, efter bottom bar. Laddar
JSZip (CDN) och `waxml.js` (lokal fil, med en no-op placeholder-
`data-source` som ersätts direkt via `updateFromString()`).
