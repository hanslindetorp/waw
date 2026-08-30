# Mixer/Solo — vad som saknas i waxml.js

Den här listan kom ur en genomgång av kod-kommentarerna i `wa-mixer-view.js`
(diskuterades muntligt när solo-funktionen introducerades, hamnade aldrig i
`docs/WAXML-Workstation-spec.md`) plus en koll av vad som faktiskt finns
byggt i `waxml.js` idag. GUI-sidan är klar och väntar på dessa.

Alla attribut nedan finns redan definierade i `schemas/waxml.xsd` (rad
~1448, `<xs:element name="Mixer">`) med rätt typer — det är bara
live-motorn i `waxml.js` som saknas.

## 1. `solo` är inte kopplat till ljudet

`<Mixer>` skapar redan `this.inputs[]` i `AudioObject`-konstruktorn
(en GainNode per barn, kopplade in i mixerns egen node,
`waxml.js` rad ~608) — men ingenting sätter deras `.gain` baserat på
solo-positionen.

- Schema-typ: `mix` — tal 0–1 (0 = första barnet, 1 = sista, jämnt
  fördelat däremellan).
- GUI:t skickar värdet på två sätt:
  - Live under drag, varje pointermove:
    `applyLiveProperty(mixerId, "solo", t)` → kräver en `set solo(val)`
    på Mixerns live-objekt.
  - Committat till XML som `<Mixer solo="0.42">`.
- Behövs: `set solo(val)` som crossfadear `inputs[]` i realtid.

## 2. `blend` är inte kopplat

- Schema-typ: `crossFadeRange` — tal 0–1. Styr hur brett crossfadet
  ska vara runt solo-positionen när den hamnar *mellan* två barn
  istället för exakt på ett.
- GUI:t skickar redan `applyLiveProperty(mixerId, "blend", value)`.
- Behövs: `set blend(val)` på Mixerns live-objekt.

## 3. `transitionTime` är inte kopplat på Mixer-nivå

- Schema-typ: `transitionTime` — ms, 0–2000.
- Ska styra hur snabbt/mjukt en solo/blend-ändring rampar in.
- GUI:t skickar redan `applyLiveProperty(mixerId, "transitionTime", value)`.
- Samma attributnamn finns redan på andra noder och funkar där via
  `setTargetAtTime` — troligen samma mönster passar här.

## 4. `getChannelGain(index)` saknas helt

GUI:t pollar denna varje animationsframe (när något spelas) för att
lysa upp rätt kanals Solo-lampa proportionellt mot hur mycket av den
kanalen som faktiskt hörs just nu (`wa-mixer-view.js`,
`_updateSoloButtonGains`).

- Ska returnera det *aktuella*, redan quantize/transitionTime-upplösta
  gain-värdet 0–1 för `inputs[index]`.
- Anropen är defensiva (`typeof ... === "function"`) så GUI:t kraschar
  inte — lamporna förblir bara släckta tills metoden finns.

## 5. `quantize` hanteras inte, och inget `"update"`-event skickas

- Schema-typ: `quantize` — sträng, t.ex. `off`, `bar`, `beat`, ett
  taktantal, en taktart (`3/4`), eller ett tidsvärde (`500ms`, `2s`).
- Ska fördröja en solo-ändring till nästa taktslag/etc. istället för
  att applicera direkt.
- GUI:t visar en blinkande "väntar"-indikator (både på den stora
  slidern och på den klickade Solo-knappen) tills Mixerns live-objekt
  skickar `dispatchEvent(new CustomEvent("update"))` — samma mönster
  `AudioObject` redan använder på andra håll (t.ex. `set mix`), eftersom
  den ärver `EventTarget`.
- Idag: ingen quantize-logik, inget update-event → "väntar"-indikatorn
  slutar aldrig blinka om `quantize` är satt.

## 6. Öppen fråga: vad händer live när `solo`-attributet tas bort helt?

När man klickar på en redan aktiv Solo-knapp tar GUI:t bort
`solo`-attributet helt (inte 0 — 0 är själva första kanalens position,
inte "av"). GUI:t gör inget live-anrop här eftersom det inte finns
någon bekräftad "clear solo"-API att gissa på.

Du behöver bestämma: ska ett borttaget `solo`-attribut göra att alla
kanaler hörs på lika volym igen live? Och i så fall — vilken metod ska
GUI:t kalla på (t.ex. `clearSolo()`)?

---

## Sidofynd (inte blockerande)

I `AudioObject`-konstruktorns switch (waxml.js) finns `case "mixer":`
två gånger (rad ~608 och ~621) — den andra är död kod eftersom JS
`switch` matchar första träffen i källkodsordning. Värt en snabb koll,
men stoppar inget just nu.
