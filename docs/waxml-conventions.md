# Conventions WAW has added on top of WAXML

*Draft for discussion — written 2026-10-12 from an audit of the WAW code base.*

WAXML is meant to be an open format that many applications can read and write.
WAW (Web Audio Workstation), the first editor built on it, has accumulated
conventions of its own while being built: naming schemes, ways of arranging
elements, and meanings it gives to ordinary elements. Some of them belong in
the specification. Some are WAW's private business and should not leak into
documents. A few are workarounds for engine bugs.

This document lists every one that was found, says where WAW does it and what
another application would see, and proposes where each should live. It is a
starting point for deciding, not a decision.

## How to read an entry

Each entry has:

- **What** — the convention.
- **Where** — what WAW writes into the document, or the file it lives in.
- **Interop** — what happens when another application opens or edits the file.
- **Proposal** — one of:
  - **SPEC** — should be written into the WAXML specification;
  - **APP** — WAW-private; should stay out of the document (or be clearly optional);
  - **ENGINE** — a workaround for a `waxml.js` issue; remove when the engine is fixed;
  - **FORMAT-OK** — already part of the format (schema/engine); listed so nobody mistakes it for a convention.

---

## 1. Round-trip fidelity (the most important one)

**What.** Every edit made in the tree/inspector regenerates the whole file from
an in-memory tree. WAW keeps elements, attributes (in source order; new ones
appended) and the *concatenated, trimmed* text of an element. It does **not**
keep:

- XML comments and processing instructions,
- CDATA sections as such,
- the order of text mixed with child elements,
- the original whitespace and layout.

The output is always `<?xml version="1.0" encoding="UTF-8"?>`, two-space
indentation, and self-closing ` />` for empty elements. (Text typed into the
code panel stays exactly as typed until the next tree edit.)

**Where.** `js/xml-editor/xml-tree-ops.js` (`parseXmlString`, `serializeXmlNode`).

**Interop.** A file annotated with comments by a human or another tool loses
them the first time WAW edits it.

**Proposal.** **APP — fix in WAW**: keep comments (and preferably layout) in
the tree so WAW is a lossless editor. The specification can then state that
conforming editors must preserve comments.

---

## 2. Identifiers WAW generates

`id` and `class` are addressing mechanisms (`#id`, `.class` selectors drive
triggers, Commands and Snapshots), so every generated value is effectively part
of the document.

| Generated value | When | Notes |
|---|---|---|
| `id="<Tag>-<N>"` (e.g. `GainNode-3`) | Any element without an `id`, except the root | `N` counts per tag and is not reused during a session; existing `Tag-N` ids raise the counter. |
| `id="Section-<letter>"` (`Section-A`, `Section-B`, … `Section-Z`, `Section-A1`, …) | Regular `<Section>` without an `id` | First free value in the sequence. |
| `class="<letter>"` (`A`, `B`, …) | New regular `<Section>` | Makes it addressable as a trigger target. Not set on transition Sections. |
| `id="Transition-<target><N>"` (e.g. `Transition-B1`) | Transition `<Section>` (has `from`/`to`) | `<target>` is the part after `Section-` in its `to` selector. |
| `id="Cmd-<N>"` | Root-level trigger `<Command>` made from the player bar | |
| `name="var<N>"` | New `<Var>` | `name` may only contain `a-zA-Z0-9_` (defined in the schema since 2026-10-09). |
| `id="Mix<M>-Ch<N>"` | A `<Chain>` added as a channel of a `<Mixer>` | |
| `id="<chainId>-mute"` | The mute `GainNode` of a channel strip | See section 3. |

Duplicating an element strips its ids (and they are regenerated), so ids stay
unique.

**Interop.** Harmless to other applications, but documents authored in WAW all
share these patterns, and selectors in Commands/Snapshots point at them.

**Proposal.** **APP** for the patterns themselves. **SPEC**: state that ids
should be unique within a document and that tools may generate them.

---

## 3. Mixers and channel strips

WAW draws a `<Mixer>`'s children as channel strips. Nothing in the format says
what a "mute" or a "volume" is; WAW infers it from structure and naming.

### 3.1 The channel templates
**What.** Three ways of creating a channel:

- **Full Channel Strip:** `<Chain>` containing, in order, a mute `GainNode`,
  three `BiquadFilterNode`s (`highshelf` 4000 Hz, `peaking` 400 Hz, `lowshelf`
  150 Hz), a `StereoPannerNode`, and a volume `GainNode`.
- **Pan, Volume, VU:** `<Chain>` of mute `GainNode`, `StereoPannerNode`, volume `GainNode`.
- **VU only:** a bare `GainNode` as a direct child of the `<Mixer>`.

On the first channel added, WAW also writes `blend="1"` and
`transitionTime="0"` on the `<Mixer>` if absent.

**Interop.** Valid WAXML; other applications just see a `Chain`.

**Proposal.** **SPEC** (as an informative appendix): "a conventional channel strip".

### 3.2 How a strip is read back
**What.** WAW assigns roles to the elements of a `<Chain>`:

| Role | Rule |
|---|---|
| Filters (EQ section) | every `BiquadFilterNode`, in document order, wherever it is |
| Pan | the first `StereoPannerNode` or `PannerNode` |
| Inserts | every `Wam` and `ConvolverNode` |
| Sends | every `Send`; *pre* if before the volume node, *post* if after |
| Mute | the `GainNode` whose id ends in `-mute`; otherwise (older/duplicated strips) the first `GainNode` when the chain has two or more |
| Volume | the last `GainNode` that is not the mute node |
| Source row | any element the schema declares with `output` but without `input` (today `AudioBufferSourceNode`, `MediaStreamAudioSourceNode`, `OscillatorNode`, `AmbientAudio`; `Var`, `Envelope`, `Snapshot`, `Layer`, `Stinger` are excluded) |

Direct children of a `<Mixer>` that get no strip: `Var`, `Send`, `Envelope`,
`Snapshot`, `AnalyserNode`. Every other child gets one; a bare `GainNode` is a
VU-only strip.

**Interop.** Another editor will not find the same mute/volume/EQ and will draw
the channel differently, or not as a strip at all.

**Proposal.** **SPEC**: the role rules, so any editor reconstructs the same
strip. The `-mute` id suffix is fragile (it is lost when an element is
duplicated; WAW falls back on position) — consider a dedicated attribute or a
reserved `class` instead.

### 3.3 Ordering inside a `<Chain>`
**What.** An element with no audio input (a generator) only works as the first
audio element of a `<Chain>`: the engine connects a chain's children one after
another. WAW warns when a generator is placed after something else or when two
generators sit in one chain. Dropping a sound file on a strip, or on/inside a
`<Chain>` in the tree, inserts an `AudioBufferSourceNode` first. `Var`,
`Envelope`, `Snapshot`, `Command` and `Parameter` are skipped when working out
what comes first.

**Interop.** This is engine behaviour, not WAW's.

**Proposal.** **SPEC**: state the rule. The "no audio input" definition is
already in the schema (`commonNodeAttributesNoInput`).

### 3.4 Labels
**What.** Every element WAW creates in a mixer gets a descriptive `label`:
`Mute`, `Volume`, `Pan`, `Send`, a filter's type name (`High shelf`,
`Peaking`, …), or the file name without extension for a dropped sound
file/impulse response. A filter's label follows its type when the label was
still the default for the old type. `label` is a display-only attribute.

**Proposal.** **APP**.

### 3.5 Explicit default values
**What.** New strips get every control written out as an attribute (mute
`gain="1"`, volume `gain="0dB"`, `pan="0"`, filters `gain="0"` `Q="1"`
`frequency="…"`, sends `gain="0dB"`), using Web Audio defaults. Reason: a
Snapshot only captures explicitly set attributes (section 4).

**Interop.** Valid WAXML; just more verbose.

**Proposal.** **APP**.

### 3.6 3D panning
**What.** The "3D" toggle swaps `StereoPannerNode` for `PannerNode` (same id)
with `positionX="0" positionY="0" positionZ="-1" panningModel="HRTF"`, and back
with `pan="0"`. The attributes of the side that is switched away from are kept
in `workstation-state.json`, not in the document.

**Proposal.** **APP**.

---

## 4. Snapshots

**What.** A `<Snapshot>` is a direct child of the `<Mixer>`, placed first among
its children in creation order. It contains one
`<Command type="set" selector="#id" variable="attribute" value="…"/>` for
every **explicitly set** attribute of the captured elements; `id`, `class` and
`label` are skipped (they name an element, they do not describe a state). The
captured elements are all children of each selected `<Chain>`, or only the
selected parts of a strip (a filter, the volume, a send, …); the `<Mixer>`'s
`solo` is added when Solo is selected; with nothing selected, WAW offers to
capture every channel.

Recall is currently done **in WAW**: it sets all the attributes in one edit and
glides them with the `transitionTime` inherited from the nearest ancestor
(milliseconds, exponential approach).

**Interop.** The *content* is standard `Command`s. The *recall* only happens
in WAW.

**Proposal.** **SPEC** for the content shape and for `transitionTime`
inheritance; **ENGINE** for recall (WAW's recall is a temporary stand-in for
an engine function and will be removed).

---

## 5. Variables and INPUT mapping

**What.** Mapping an INPUT entry (hand/pose/face tracking) onto a parameter
creates, in one step:

```xml
<Var name="var1" value="$input_var1" mapin="0,1" mapout="20,10000" default="0.042"/>
…
<OscillatorNode frequency="$var1"/>
```

- the `<Var>` is the first `<Var>` of the target element's *parent* (after any
  `<Var>`s already there; in the root itself if the target is the root);
- `mapout` comes from a per-parameter table (`frequency` 20–10000, `gain` 0–1,
  a filter's `gain` −40…40, `Q` 0.1–20, `pan` −1…1, …);
- `default` places the current value of the attribute on the 0–1 scale, so
  mapping does not make the parameter jump;
- `input_var1` is a hidden root-level variable that the INPUT entry sets with
  `waxml.set("input_var1", value)` — there is no visible root `<Var>` for it.

If the `<Var>`'s `name` changes, every `$old` reference in the document
becomes `$new` and a `value` of `$input_old` follows to `$input_new`; if
`value` is changed by hand, the INPUT link follows. Which tracked metric feeds
`input_var1` (entry, calibrated range, bypass) is stored in
`workstation-state.json`, **not** in the document.

**Interop.** Another application sees an ordinary `<Var>` waiting for an
external variable `input_var1` that nothing in the file sets.

**Proposal.** **SPEC**: reserve the `input_` prefix for "variables set from
outside the document" so any host can recognise them. **APP**: the metric
mapping and calibration (or define a portable "input binding" element later).

---

## 6. Roles WAW gives to ordinary elements

**What.**

- A root-level `<Command type="trig|stop|set" value="selector">` is shown as a
  shortcut button in the player bar; WAW creates them with ids `Cmd-<N>`.
- A root-level `<Var>` is shown as a knob in the Variables panel; a `<Var>` in
  the currently selected element's scope is shown in a local row.
- Selecting an element fills the trigger field with a selector for it: its
  first `class` as `.class`, otherwise `#id`.

**Interop.** Harmless; they remain valid elements.

**Proposal.** **SPEC** (informative): "editors may present root-level Commands
and Vars as controls". Otherwise **APP**.

---

## 7. Compositions

- **Tempo and time signature:** a new `<Section>` gets `tempo` and `timeSign`
  copied onto it from its `<Composition>` when the Composition sets them.
  **APP** (valid WAXML; makes sections self-contained).
- **Transition sections** are `<Section>`s with `from` and/or `to`. This is
  part of the schema (**FORMAT-OK**); WAW's arrange view pairs each with its
  target by resolving `to` against the regular Sections (first match in document
  order wins).

---

## 8. Engine workarounds

- **`<Layer active>`**: WAW forces `fadeTime="0"` in the same edit whenever
  `active` is changed, because the engine only honours `active` then, and shows
  a one-time notice. **ENGINE** — remove when `waxml.js` is fixed.
- **Gain on `<Layer>` and `<Stinger>`** may not contain `$variables` or
  expressions in the schema (`musicGain`), to be revisited when the music engine
  is rebuilt. **FORMAT-OK** (schema decision).

---

## 9. Project layout and application state

- The main document is `wa.xml` at the project root; audio lives under
  `audio/`; `src` paths are relative to `wa.xml`; a project exports as a zip
  with the same layout. (A project can also include other `.xml`/`.waxml`
  documents, opened one at a time.)
- `workstation-state.json` next to `wa.xml` holds **everything about how WAW
  is arranged**, none of it in the document: open panels and widths, selected
  element id, XML tree columns and collapsed rows, splitter positions, INPUT
  entries with their mappings/calibration/bypass, chain-view analyser modes,
  var-graph frames, and the mixer's stereo/3D panner caches.

**Proposal.** **SPEC** for "main document + relative `src`" if projects are to
be exchanged. **APP** for the state file — which is the right place for it;
keeping UI state out of the XML is what lets other tools open the document.

---

## 10. Notation that is format, not convention

Listed because it looks like a convention but is in the schema/engine:

- `gain` on gain-like nodes is a ratio (`0.5`) or an amplitude-dB string
  (`-6dB`); on a `BiquadFilterNode` it is a bare dB number. The engine does all
  conversion; WAW only writes the string.
- `Var` `mapin`/`mapout`/`curve`/`pattern`/`convert` semantics.

---

## Summary

| # | Convention | Proposal |
|---|---|---|
| 1 | Lossy round trip (comments, layout) | APP — fix |
| 2 | Generated ids, classes and var names | APP (+ SPEC: ids unique) |
| 3.1 | Channel templates | SPEC (informative) |
| 3.2 | Strip roles, `-mute` suffix | SPEC (and replace the suffix) |
| 3.3 | Generator first in a chain | SPEC |
| 3.4 | Auto labels | APP |
| 3.5 | Explicit default values | APP |
| 3.6 | 3D toggle and its cache | APP |
| 4 | Snapshot content | SPEC |
| 4 | Snapshot recall in the app | ENGINE |
| 5 | `$input_<name>` variables | SPEC (prefix) |
| 5 | Input mapping/calibration | APP |
| 6 | Root Commands/Vars as controls | SPEC (informative) |
| 7 | Tempo/timeSign copy | APP |
| 8 | `Layer active` workaround | ENGINE |
| 9 | `wa.xml` project layout | SPEC if exchanged |
| 9 | `workstation-state.json` | APP |

## Questions for the community

1. Mute: a dedicated attribute, a reserved class, or just "a gain node with
   `class="mute"`"?
2. Should the channel-strip roles (3.2) be normative or informative?
3. Do we want a portable "input binding" element so a mapping from an input
   device survives a move between applications?
4. What must a conforming editor preserve when saving (comments, ids,
   attribute order)?
5. Should projects (a main document plus files) be part of the format?
