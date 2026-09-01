import { xmlStore } from "../xml-editor/xml-store.js";
import { vfs, ROOT_ID } from "../vfs/VFS.js";
import { VFS_FILE_DRAG_TYPE, vfsDragState } from "../vfs/drag-types.js";
import { importZip } from "../vfs/zip-import.js";
import * as ops from "../xml-editor/xml-tree-ops.js";
import {
	readSectionInfo,
	getLayers,
	getSegments,
	getOptions,
	getStingers,
	readPos,
	readLength,
	readEffectiveLoopEnd,
	readStingerQuantizePosition,
	readStingerOffset,
	readUpbeatSeconds,
	secondsToQuantizeString,
	minimumTotalDuration,
	parsePosition,
	secondsToPosString,
	quantizeDroppedFileLength,
	secondsToLengthString,
	parseDivision
} from "../xml-editor/section-model.js";
import { findSrcAttribute, getSchemaSrcAttributeName, resolvePlayableUrl } from "../xml-editor/src-attribute.js";
import { decodeAudioBuffer, drawWaveform } from "../xml-editor/waveform.js";
import { WaxmlBridge } from "../waxml-integration/waxml-bridge.js";
import { playerStore } from "../waxml-integration/player-store.js";

// DAW-style "arrange window" for the <Section> element type: transport bar, a
// bars/beats ruler derived from the section's own tempo/timeSign, one lane per
// <Layer>, <Segment>/<Option> boxes with waveforms, and a playhead — plus
// direct editing: drag audio files from the File Manager to create/replace
// content, open a Segment to see/reorder its Options as real rows, drag
// Options around, multi-select + Delete/Backspace. Every edit goes through
// xmlStore, so the XML editor and XML code panels already stay in sync for
// free.
//
// Known limitation, called out here rather than silently faked: waxml.js has
// no seek/scrub API we could find (see chat) — Play always starts the engine
// from its own true beginning. Rewind/fast-forward are hidden for now since
// they'd have nothing real to do; Go-to-start stays visible since "stop and
// reset the visual cursor to 0" is meaningful on its own.

const bridge = new WaxmlBridge();

// The browser's own default HTML5 drag image is a rendered snapshot of the
// dragged element — which gets visibly corrupted (pulling in unrelated
// interface, per Hans, up to and including part of the XML editor) when
// that element is partway scrolled out of view inside a clipping ancestor
// (.layer-scroll's overflow:hidden), since the snapshot doesn't respect the
// clip the way normal painting does. We already show our own drag preview
// (.segment-ghost) during dragover, so the native one is both redundant and
// occasionally broken — suppressed everywhere via this shared 1x1
// transparent image instead of trying to work around the browser's own
// snapshot bug.
const TRANSPARENT_DRAG_IMAGE = new Image();
TRANSPARENT_DRAG_IMAGE.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

// Internal-only drag types for moving an <Option> or <Segment> box around
// within the Preview (reorder/move Options, reposition/move Segments) —
// distinct from VFS_FILE_DRAG_TYPE (a file dragged in from the File Manager)
// so drop handlers can tell them apart.
const OPTION_DRAG_TYPE = "application/x-waw-option-node";
const SEGMENT_DRAG_TYPE = "application/x-waw-segment-node";
// The browser's own type string for a native OS file drag (e.g. straight out
// of Finder) — present in dataTransfer.types before drop, but its actual
// FileList (dataTransfer.files) only becomes readable once the drop happens.
const NATIVE_FILE_DRAG_TYPE = "Files";

const MIN_PX_PER_SEC = 5;
const MAX_PX_PER_SEC = 400;
const DEFAULT_PX_PER_SEC = 40;
const MIN_ROW_HEIGHT = 32;
const MAX_ROW_HEIGHT = 160;
const DEFAULT_ROW_HEIGHT = 56;
const LABEL_WIDTH = 140;
const RULER_HEIGHT = 32;
const FALLBACK_BOX_BARS = 1;
const WAVEFORM_COLOR = "#4fa3ff";
const DROPZONE_HEIGHT = 10;
// Selectable grid resolutions (the little menu next to the zoom buttons) —
// straight subdivisions (1/4, 1/8, 1/16, 1/32) plus the two common triplet
// ones (1/12, 1/24), each expressed in *beats* since this engine always
// defines one beat as a quarter note (60/tempo) regardless of the meter's
// denominator (see readSectionInfo). "off" means no grid at all: beats still
// show on the ruler, but nothing snaps to anything (see _effectiveGridBeats).
const GRID_RESOLUTIONS = [
	{ label: "1/4", beats: 1 },
	{ label: "1/8", beats: 0.5 },
	{ label: "1/12", beats: 1 / 3 },
	{ label: "1/16", beats: 0.25 },
	{ label: "1/24", beats: 1 / 6 },
	{ label: "1/32", beats: 0.125 }
];
// Ticks/snap points closer together than this (in px) start reading as a
// solid smear rather than individual gridlines — the floor the zoom-adaptive
// resolution in _effectiveGridBeats won't go finer than.
const MIN_TICK_SPACING_PX = 6;
// A <Segment> can legitimately start before bar 1 (an upbeat/anacrusis for
// the whole Layer) — pos values like "0.4.1" or a negative bar number are
// valid per the position type. The timeline reserves a fixed pre-roll of
// this many bars so that content has somewhere to render; Hans's own
// suggested cap.
const PRE_ROLL_BARS = 2;

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			flex-direction: column;
			height: 100%;
			font: 0.8rem/1.3 system-ui, sans-serif;
			background: #101214;
			user-select: none;
		}
		.transport {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			padding: 0.4rem 0.6rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			flex: 0 0 auto;
			flex-wrap: wrap;
		}
		.tp-btn {
			background: #24272c;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			padding: 0.3rem 0.55rem;
			font-size: 0.85rem;
			line-height: 1;
			cursor: pointer;
			min-width: 2rem;
		}
		.tp-btn:hover {
			background: #2f333a;
		}
		.tp-btn.active {
			background: var(--waw-accent, #4fa3ff);
			border-color: var(--waw-accent, #4fa3ff);
			color: #06131f;
		}
		.tp-position {
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			color: var(--waw-fg, #e8e8e8);
			margin-left: 0.3rem;
			white-space: nowrap;
		}
		.tp-info {
			color: var(--waw-muted, #8a8a8a);
			white-space: nowrap;
		}
		/* Tempo/timeSign/id, each double-clickable in place (see
		   _renderTransportInfo/_startInfoFieldEdit) — cursor alone marks
		   them as interactive, no extra hover chrome (per Hans). */
		.tp-info-field {
			cursor: pointer;
		}
		.tp-info-input {
			font: inherit;
			font-family: inherit;
			background: #24272c;
			border: 1px solid var(--waw-accent, #4fa3ff);
			color: var(--waw-fg, #e8e8e8);
			border-radius: 3px;
			padding: 0 0.25rem;
			width: 4.5rem;
		}
		.zoom-controls {
			margin-left: auto;
			display: flex;
			align-items: center;
			gap: 0.25rem;
			color: var(--waw-muted, #8a8a8a);
		}
		.grid-select {
			background: #24272c;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			font-size: 0.75rem;
			padding: 0.15rem 0.3rem;
			cursor: pointer;
		}
		.zoom-btn {
			background: #24272c;
			border: 1px solid var(--waw-border, #2f2f2f);
			color: inherit;
			border-radius: 4px;
			width: 1.5rem;
			height: 1.5rem;
			line-height: 1;
			cursor: pointer;
		}
		.zoom-btn:hover {
			background: #2f333a;
		}

		.scroll-area {
			flex: 1 1 auto;
			overflow-y: auto;
			overflow-x: hidden;
			position: relative;
		}
		/* Layers and Stingers each get their own independent horizontal
		   scroll (nested inside .scroll-area's single shared vertical one) —
		   a Stinger isn't on the Section's own timeline (it can trigger at
		   any moment), so its row shouldn't be dragged sideways by the
		   Layer area's playhead-follow auto-scroll during playback. */
		.layer-scroll,
		.stinger-scroll {
			overflow-x: auto;
			/* Each area's own height is set explicitly by
			   _applyLayerStingerSplit — auto here (not hidden) so content
			   squeezed below its natural size (Stingers borrowing space
			   from Layers, or vice versa at the Layer-minimum floor) still
			   scrolls internally rather than just clipping. */
			overflow-y: auto;
		}
		.section-divider {
			padding: 0.35rem 0.5rem;
			font: 600 0.68rem/1.2 system-ui, sans-serif;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			color: var(--waw-muted, #8a8a8a);
			border-top: 2px solid var(--waw-border, #2f2f2f);
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			background: var(--waw-panel-bg, #1a1a1a);
		}
		/* The Stinger divider sits directly between the Layer and Stinger
		   scroll areas, so it doubles as the draggable handle between them
		   (see _onDividerResizeStart) — per Hans (2026-09-02), every panel
		   with two stacked areas gets a movable divider. The cursor alone
		   signals that (no extra hover color, per Hans). */
		.stinger-divider {
			cursor: row-resize;
			touch-action: none;
		}
		.empty-hint {
			color: var(--waw-muted, #8a8a8a);
			text-align: center;
			padding: 2rem 1rem;
		}
		.grid {
			position: relative;
			display: grid;
			grid-template-columns: ${LABEL_WIDTH}px 1fr;
			width: max-content;
			min-width: 100%;
		}
		.corner,
		.ruler,
		.layer-label {
			background: var(--waw-panel-bg, #1a1a1a);
		}
		.corner {
			position: sticky;
			top: 0;
			left: 0;
			z-index: 6;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			border-right: 1px solid var(--waw-border, #2f2f2f);
		}
		.ruler {
			position: sticky;
			top: 0;
			z-index: 5;
			width: 100%;
			height: ${RULER_HEIGHT}px;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			overflow: hidden;
		}
		.ruler-tick {
			position: absolute;
			top: 0;
			bottom: 0;
			border-left: 1px solid var(--waw-tree-connector, #3a3a3a);
		}
		.ruler-tick.bar {
			border-left-color: var(--waw-muted, #8a8a8a);
		}
		.ruler-tick.sub {
			opacity: 0.5;
		}
		.ruler-tick.sub.tier-2 {
			opacity: 0.32;
		}
		.ruler-tick.sub.tier-3 {
			opacity: 0.18;
		}
		.ruler-tick .tick-label {
			position: absolute;
			top: 2px;
			left: 3px;
			font-size: 0.65rem;
			color: var(--waw-muted, #8a8a8a);
			white-space: nowrap;
		}
		.layer-label {
			position: sticky;
			left: 0;
			z-index: 4;
			display: flex;
			align-items: center;
			gap: 0.3rem;
			padding: 0 0.5rem;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			border-right: 1px solid var(--waw-border, #2f2f2f);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			cursor: pointer;
		}
		.layer-label.selected {
			background: rgba(79, 163, 255, 0.18);
		}
		/* Same box as .layer-label, swapped in on double-click (see
		   _startAttributeEdit) — an actual <input> instead of a <div>, same
		   idea as wa-mixer-view.js's own channel-strip rename. */
		.inline-rename-input {
			box-sizing: border-box;
			height: 100%;
			width: 100%;
			font: inherit;
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			background: #24272c;
			border: 1px solid var(--waw-accent, #4fa3ff);
			color: inherit;
			border-radius: 3px;
			padding: 0 0.4rem;
		}
		.layer-lane {
			position: relative;
			width: 100%;
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
			background: repeating-linear-gradient(
				90deg,
				rgba(255, 255, 255, 0.02) 0,
				rgba(255, 255, 255, 0.02) 1px,
				transparent 1px,
				transparent 100%
			);
			overflow: hidden;
		}
		.layer-lane.drop-active {
			outline: 2px dashed var(--waw-accent, #4fa3ff);
			outline-offset: -2px;
		}
		.dropzone-filler {
			border-right: 1px solid var(--waw-border, #2f2f2f);
			display: flex;
			align-items: center;
			padding: 0 0.5rem;
			color: var(--waw-muted, #8a8a8a);
			font-family: var(--waw-mono-font, Menlo, Monaco, "Courier New", monospace);
			font-size: 0.75rem;
			font-style: italic;
			overflow: hidden;
			white-space: nowrap;
			opacity: 0;
			transition: opacity 0.08s ease-out;
		}
		.dropzone-filler.preview-layer {
			opacity: 0.65;
		}
		.dropzone {
			position: relative;
			height: ${DROPZONE_HEIGHT}px;
			transition: height 0.08s ease-out;
		}
		.dropzone.drop-active {
			background: var(--waw-accent, #4fa3ff);
		}
		.dropzone.preview-layer {
			background: rgba(255, 255, 255, 0.03);
			border-top: 1px dashed var(--waw-muted, #8a8a8a);
			border-bottom: 1px dashed var(--waw-muted, #8a8a8a);
		}
		.dropzone.preview-layer.drop-active {
			background: rgba(255, 255, 255, 0.03);
		}
		.segment-ghost {
			position: absolute;
			border: 2px dashed var(--waw-accent, #4fa3ff);
			background: rgba(79, 163, 255, 0.15);
			border-radius: 4px;
			pointer-events: none;
			z-index: 4;
			display: none;
		}
		.segment-handle {
			position: absolute;
			top: 2px;
			width: 9px;
			z-index: 3;
			cursor: grab;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 0.5rem;
			line-height: 1;
			color: var(--waw-fg, #e8e8e8);
			background: rgba(255, 255, 255, 0.14);
			border-radius: 3px 0 0 3px;
			opacity: 0.6;
		}
		.segment-handle:hover {
			opacity: 1;
		}
		.loop-repeat {
			opacity: 0.4;
		}
		/* A musical repeat sign (𝄇: dots, thin bar, thick bar, left to right)
		   rather than an arbitrary single line — per Hans (2026-09-02/03) —
		   white, not the accent blue, so it reads as a distinct kind of
		   marker from the Stinger anchor/selection/etc. colors used
		   everywhere else here. The box's own right edge is the thick bar's
		   right edge (width 15px, margin-left the same amount) — that's the
		   edge that has to land exactly on loopEnd's own px (see
		   marker.style.left in _buildLoopMarker), not the box's center: a
		   repeat sign's bars mark *where* the loop wraps, so the thick bar
		   (the actual boundary) has to be the one snapped there, with the
		   thin bar and dots trailing off to its left. */
		.loop-marker {
			position: absolute;
			top: 0;
			width: 15px;
			margin-left: -15px;
			z-index: 5;
			cursor: ew-resize;
			touch-action: none;
		}
		.loop-marker-bar {
			position: absolute;
			top: 0;
			bottom: 0;
			background: #fff;
		}
		.loop-marker-bar.thin {
			left: 8px;
			width: 1px;
		}
		.loop-marker-bar.thick {
			left: 12px;
			width: 3px;
		}
		/* Sized clearly bigger than the thick bar (diameter 5px vs. 3px) —
		   per Hans, dots that are barely bigger than the bars read as
		   another bar rather than a repeat sign's dots. .dot-top/.dot-bottom
		   (not :first-child/:last-child, which would've matched one of the
		   bars above instead of the second dot — the actual bug behind
		   "dots haven't changed") position the pair centered as a whole on
		   the marker's own vertical center. */
		.loop-marker-dot {
			position: absolute;
			left: 0;
			width: 5px;
			height: 5px;
			border-radius: 50%;
			background: #fff;
		}
		.loop-marker-dot.dot-top {
			top: calc(50% - 8.75px);
		}
		.loop-marker-dot.dot-bottom {
			top: calc(50% + 3.75px);
		}
		.stinger-anchor {
			position: absolute;
			top: 0;
			bottom: 0;
			width: 9px;
			margin-left: -4px;
			cursor: grab;
			z-index: 6;
			touch-action: none;
		}
		.stinger-anchor:active {
			cursor: grabbing;
		}
		/* The second, un-draggable anchor line shown inside a with-Options
		   Stinger's box (each Option's own pos is relative to it, but it
		   can't itself be dragged — see _buildStingerLane) — no grab cursor,
		   and pointer-events:none so it doesn't sit in the way of dragging
		   the nested Options underneath it. */
		.stinger-anchor.static {
			cursor: default;
			pointer-events: none;
		}
		.stinger-anchor::before {
			content: "";
			position: absolute;
			top: 0;
			bottom: 0;
			left: 50%;
			width: 2px;
			background: var(--waw-danger, #e5484d);
			transform: translateX(-50%);
		}
		/* Live preview guides shown across a Stinger's lane while its anchor
		   is being dragged — see _updateStingerQuantizeGuides. */
		.stinger-quantize-guide {
			position: absolute;
			top: 0;
			bottom: 0;
			width: 1px;
			background: rgba(229, 72, 77, 0.35);
			pointer-events: none;
			z-index: 2;
		}
		/* changeOnNext boundary marks — see _renderChangeOnNextMarks. Short
		   (33% of content height, from the top) and dark gray, distinct from
		   the anchor's red. */
		.change-on-next-mark {
			position: absolute;
			top: 0;
			height: 33%;
			width: 7px;
			margin-left: -3px;
			cursor: ew-resize;
			z-index: 3;
			touch-action: none;
		}
		.change-on-next-mark::before {
			content: "";
			position: absolute;
			top: 0;
			bottom: 0;
			left: 50%;
			width: 1px;
			background: #666;
			transform: translateX(-50%);
		}
		/* A triggered Stinger's own live position pointer — see
		   _handleStingerDoubleClick/_updateStingerPointers. Same look as the
		   main .playhead, scoped to just this Stinger's own row. */
		.stinger-pointer {
			position: absolute;
			top: 0;
			width: 0;
			border-left: 2px solid #ff5a5a;
			z-index: 7;
			pointer-events: none;
		}
		/* The rest of a Stinger's own box/content (and its nested Options)
		   drags to reposition relative to the anchor — gets the horizontal
		   double-arrow the anchor itself used to show, now that the anchor
		   has its own "grab" cursor instead. */
		.stinger-grid .timed-box,
		.stinger-grid .nested-option {
			cursor: ew-resize;
		}
		.timed-box {
			position: absolute;
			border-radius: 4px;
			border: 1px solid var(--waw-accent, #4fa3ff);
			background: rgba(79, 163, 255, 0.12);
			/* No overflow:hidden — a Segment/Option whose real decoded audio
			   runs past its own (possibly bar-quantized) length is meant to
			   show that as a visible tail past its own box, not get it clipped
			   away. Everything nested is already explicitly sized to its own
			   container, so nothing unwanted spills as a side effect. */
			cursor: pointer;
		}
		.timed-box.option-box {
			border-color: var(--waw-teal, #45b58c);
			background: rgba(69, 181, 140, 0.14);
		}
		.timed-box.selected {
			outline: 2px solid var(--waw-fg, #e8e8e8);
			outline-offset: -1px;
		}
		.timed-box.drop-active {
			outline: 2px dashed var(--waw-fg, #e8e8e8);
			outline-offset: -2px;
		}
		/* Drag to change a closed Segment's own length (see
		   _buildSegmentResizeHandle) — the cursor alone marks it as
		   draggable, no extra visible chrome (per Hans, 2026-09-02). */
		.segment-resize-handle {
			position: absolute;
			top: 0;
			bottom: 0;
			right: 0;
			width: 8px;
			cursor: ew-resize;
			touch-action: none;
			z-index: 2;
		}
		.timed-box canvas {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
		}
		.timed-box .box-label {
			position: absolute;
			top: 1px;
			left: 4px;
			font-size: 0.62rem;
			color: var(--waw-fg, #e8e8e8);
			opacity: 0.8;
			pointer-events: none;
			white-space: nowrap;
			z-index: 1;
		}
		/* Same spot as .box-label, swapped in on double-click (see
		   _startAttributeEdit) — a real input, so (unlike .box-label) it needs
		   its own pointer-events:auto rather than inheriting none. */
		.box-label-input {
			position: absolute;
			top: 1px;
			left: 4px;
			width: calc(100% - 8px);
			font-size: 0.62rem;
			font-family: inherit;
			background: #14181e;
			border: 1px solid var(--waw-accent, #4fa3ff);
			color: var(--waw-fg, #e8e8e8);
			border-radius: 2px;
			padding: 0 2px;
			z-index: 2;
		}
		/* One small tag per <Command> child of a Layer/Segment/Option/Stinger —
		   the only representation Command elements get in this view, per Hans
		   (previously none at all). Plain flex row by default (fits inline
		   into .layer-label's own flex row); absolutely positioned only when
		   nested inside a .timed-box, which is itself position:absolute. */
		.command-marks {
			display: flex;
			align-items: center;
			gap: 2px;
			flex: 0 0 auto;
		}
		.timed-box .command-marks {
			position: absolute;
			bottom: 1px;
			right: 2px;
			z-index: 2;
		}
		.command-mark {
			width: 7px;
			height: 7px;
			border-radius: 2px;
			background: #e8d34d;
			border: 1px solid #7a6a10;
			cursor: pointer;
			flex: 0 0 auto;
		}
		.command-mark:hover {
			border-color: var(--waw-accent, #4fa3ff);
		}
		.command-mark.selected {
			outline: 1px solid var(--waw-fg, #e8e8e8);
			outline-offset: 1px;
		}
		.nested-option {
			position: absolute;
			border-top: 1px solid rgba(69, 181, 140, 0.6);
			border-left: 1px solid rgba(69, 181, 140, 0.6);
			overflow: hidden;
			pointer-events: none;
		}
		.nested-option:first-child {
			border-top: none;
		}
		.nested-option canvas {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
		}
		.timed-box .disclosure {
			position: absolute;
			top: 1px;
			right: 2px;
			z-index: 2;
			background: none;
			border: none;
			color: var(--waw-fg, #e8e8e8);
			opacity: 0.8;
			cursor: pointer;
			font-size: 0.6rem;
			padding: 0 0.1rem;
			line-height: 1.2;
		}
		.playhead {
			position: absolute;
			top: 0;
			bottom: 0;
			width: 0;
			border-left: 2px solid #ff5a5a;
			z-index: 3;
			pointer-events: none;
		}
	</style>
	<div class="transport">
		<span class="tp-position">1.1.00</span>
		<span class="tp-info"></span>
		<div class="zoom-controls">
			<select class="grid-select" title="Grid resolution"></select>
			<span>H</span>
			<button class="zoom-btn" data-zoom="h-out">−</button>
			<button class="zoom-btn" data-zoom="h-in">+</button>
			<span>V</span>
			<button class="zoom-btn" data-zoom="v-out">−</button>
			<button class="zoom-btn" data-zoom="v-in">+</button>
		</div>
	</div>
	<div class="scroll-area">
		<div class="section-divider layers-divider">Layers</div>
		<div class="layer-scroll">
			<div class="grid" hidden>
				<div class="corner"></div>
				<div class="ruler"></div>
			</div>
		</div>
		<div class="section-divider stinger-divider">Stingers</div>
		<div class="stinger-scroll">
			<div class="grid stinger-grid"></div>
		</div>
		<div class="empty-hint">Select a &lt;Section&gt; element to see it here.</div>
	</div>
`;

export class WaSectionView extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));

		this._scrollArea = this.shadowRoot.querySelector(".scroll-area");
		this._layerScroll = this.shadowRoot.querySelector(".layer-scroll");
		this._grid = this.shadowRoot.querySelector(".layer-scroll .grid");
		this._ruler = this.shadowRoot.querySelector(".ruler");
		this._layersDivider = this.shadowRoot.querySelector(".layers-divider");
		this._stingerDivider = this.shadowRoot.querySelector(".stinger-divider");
		this._stingerScroll = this.shadowRoot.querySelector(".stinger-scroll");
		this._stingerGrid = this.shadowRoot.querySelector(".stinger-grid");
		this._emptyHint = this.shadowRoot.querySelector(".empty-hint");
		this._positionEl = this.shadowRoot.querySelector(".tp-position");
		this._infoEl = this.shadowRoot.querySelector(".tp-info");

		this._pxPerSecond = DEFAULT_PX_PER_SEC;
		this._rowHeight = DEFAULT_ROW_HEIGHT;
		// Share of the Layer/Stinger area's vertical space given to Layers
		// (Stingers gets the rest) — user-draggable via .stinger-divider (see
		// _onDividerResizeStart), 80/20 initially per Hans (2026-09-02).
		this._layerStingerRatio = 0.8;
		// The finest grid the zoom-adaptive resolution (_effectiveGridBeats) is
		// allowed to reach — "1/4" through "1/32", or "off" to disable
		// grid/snapping entirely. User-selectable via the grid-resolution menu.
		this._gridResolution = "1/16";
		this._cursorTime = 0;
		this._isPlaying = false;
		this._playStartAudioTime = 0;
		this._renderToken = 0;
		this._bufferCache = new Map(); // resolvedUrl -> Promise<AudioBuffer>
		this._resolvedBuffers = new Map(); // resolvedUrl -> AudioBuffer, once decode() actually settles (Promises can't be read synchronously, needed for a ghost's width during dragover)
		this._lastSectionId = null;
		this._maxDecodedEnd = 0; // seconds; grows monotonically as bare-layer srcs decode
		this._openSegmentIds = new Set();
		this._selectedIds = new Set(); // multi-select for bulk delete (Layer/Segment/Option ids)
		this._lastSelfSelectedId = null; // see _onStoreChange's external-selection sync
		this._dragState = null; // {kind, nodeId, grabOffsetSeconds} for an in-progress Option/Segment drag — set at dragstart since dataTransfer.getData() isn't readable until drop; grabOffsetSeconds is where within the box the drag started, so the box keeps that same offset from the cursor instead of snapping its left edge under it
		this._activeStingerTriggers = new Map(); // stingerId -> {triggerAudioTime, startOffsetSeconds, durationSeconds, el} — see _handleStingerDoubleClick

		this._onKeyDown = this._onKeyDown.bind(this);
		this._onPlayerStoreChange = this._onPlayerStoreChange.bind(this);
		this._onDividerResizeMove = this._onDividerResizeMove.bind(this);
		this._onDividerResizeEnd = this._onDividerResizeEnd.bind(this);
		// .scroll-area's clientHeight is 0 (or stale) the moment a Section
		// first becomes visible — e.g. right after wa-preview.js flips its
		// "section" state to display:block, that layout hasn't happened yet
		// in the same synchronous call as _renderSection's own measurement —
		// so the very first _applyLayerStingerSplit call used to under-size
		// Layers down to its one-row minimum until *something else* (like
		// dragging the divider) forced a re-measure, per Hans (2026-09-02).
		// Re-running the split whenever this area's real size changes (first
		// paint included) fixes that without having to guess the right delay.
		this._resizeObserver = new ResizeObserver(() => {
			if (this._lastLayersNaturalHeight !== undefined) {
				this._applyLayerStingerSplit(this._lastLayersNaturalHeight, this._lastStingersNaturalHeight);
			}
		});
	}

	connectedCallback() {
		this.shadowRoot.querySelectorAll(".zoom-btn").forEach((btn) => {
			btn.addEventListener("click", () => this._handleZoom(btn.dataset.zoom));
		});
		// Trackpad/Magic Trackpad pinch (browsers synthesize this as wheel +
		// ctrlKey) zooms this view's own content directly, per Hans
		// (2026-09-02) — added on `this` rather than some inner element so it
		// catches the gesture anywhere over the Section preview.
		this.addEventListener("wheel", (e) => this._onWheelZoom(e), { passive: false });
		this._stingerDivider.addEventListener("pointerdown", (e) => this._onDividerResizeStart(e));
		this._resizeObserver.observe(this._scrollArea);
		// Manually scrolling toward the current right edge needs to extend
		// the timeline too, not just playback's own autoscroll — see
		// _ensureTimelineCovers.
		this._layerScroll.addEventListener("scroll", () => {
			if (!this._lastRenderInfo) return;
			const rightEdgeSeconds = this._pxToTime(this._layerScroll.scrollLeft + this._layerScroll.clientWidth, this._lastRenderInfo);
			this._ensureTimelineCovers(rightEdgeSeconds);
		});

		const gridSelect = this.shadowRoot.querySelector(".grid-select");
		GRID_RESOLUTIONS.forEach((r) => {
			const opt = document.createElement("option");
			opt.value = r.label;
			opt.textContent = r.label;
			gridSelect.appendChild(opt);
		});
		const offOpt = document.createElement("option");
		offOpt.value = "off";
		offOpt.textContent = "Off";
		gridSelect.appendChild(offOpt);
		gridSelect.value = this._gridResolution;
		gridSelect.addEventListener("change", () => {
			this._gridResolution = gridSelect.value;
			const node = this._getActiveSectionNode();
			if (node) this._renderSection(node);
		});

		xmlStore.addEventListener("change", () => this._onStoreChange());
		document.addEventListener("keydown", this._onKeyDown);
		playerStore.addEventListener("change", this._onPlayerStoreChange);
		this._onStoreChange();
	}

	disconnectedCallback() {
		this._stopPositionLoop();
		this._resizeObserver.disconnect();
		document.removeEventListener("keydown", this._onKeyDown);
		playerStore.removeEventListener("change", this._onPlayerStoreChange);
	}

	// --- reacting to selection / edits ---

	// Which <Section> we're showing is "sticky": it only changes when the
	// user explicitly selects a *different* Section (from the XML tree, or
	// by picking a new one here). Clicking a Layer/Segment/Option box in
	// this view also updates xmlStore's global selection (so the Inspector
	// follows it), which would otherwise make getSelectedNode() stop being a
	// Section and tear this whole view down out from under the user — so we
	// track our own active section id instead of trusting "is the currently
	// selected node a Section" on every store change.
	_onStoreChange() {
		const selected = xmlStore.getSelectedNode();

		if (selected && selected.tagName === "Section" && selected.id !== this._lastSectionId) {
			this._teardownActive();
			this._cursorTime = 0;
			this._maxDecodedEnd = 0;
			this._extendedDuration = 0;
			this._openSegmentIds.clear();
			this._selectedIds.clear();
			this._lastSectionId = selected.id;
			this._lastSelfSelectedId = null;
			// Arming the global player's PLAY button to target this Section
			// (and, if already playing, immediately re-trig-ing it — browsing
			// to a different Section mid-playback previews it live without
			// stopping anything else, per Hans) is now handled centrally by
			// player-store.js's own selection listener — see
			// _maybeUpdateTriggerSelectorFromSelection there. Playback itself
			// is entirely global (see player-store.js) — this view only ever
			// *reads* whether it's the current target, in
			// _onPlayerStoreChange, never starts/stops anything itself.
		}

		if (!this._lastSectionId) return;

		const node = ops.findNodeById(xmlStore.root, this._lastSectionId);
		if (!node) {
			// The section we were showing got deleted.
			this._teardownActive();
			this._lastSectionId = null;
			this._grid.hidden = true;
			this._layersDivider.hidden = true;
			this._stingerDivider.hidden = true;
			this._stingerScroll.hidden = true;
			this._emptyHint.hidden = false;
			return;
		}

		// Keep this view's own box highlighting in sync with a selection made
		// *elsewhere* (the XML tree, the Code panel) — clicking a box *inside*
		// this view (_handleItemClick) pre-announces its own id via
		// _lastSelfSelectedId before calling xmlStore.selectNode, so this only
		// reacts to genuinely external selection changes, never collapsing a
		// ctrl/cmd multi-select the user just built up by clicking boxes here.
		const selectedId = selected ? selected.id : null;
		if (selectedId !== this._lastSelfSelectedId) {
			if (selected && this._isNodeWithinSection(selected, node)) {
				this._selectedIds = new Set([selected.id]);
			} else if (this._selectedIds.size) {
				this._selectedIds.clear();
			}
			this._lastSelfSelectedId = selectedId;
		}

		this._renderSection(node);
		this._updateSelectionHighlight();
	}

	// Walks up from `node` to see whether it's `sectionNode` itself or nested
	// somewhere inside it — used to decide whether an externally-made
	// selection (tree/Code panel) is something this view should highlight at
	// all, versus a node that belongs to a completely different part of the
	// document (e.g. a Mixer channel).
	_isNodeWithinSection(node, sectionNode) {
		if (!sectionNode) return false;
		let cur = node;
		while (cur) {
			if (cur.id === sectionNode.id) return true;
			if (!cur.parent) return false;
			cur = ops.findNodeById(xmlStore.root, cur.parent);
		}
		return false;
	}

	// Resets this view's own local playhead/visual state — does NOT touch
	// global playback (see class doc): switching which Section is being
	// *viewed* must never stop what's actually *playing*, per Hans.
	_teardownActive() {
		this._isPlaying = false;
		this._stopPositionLoop();
		this._activeStingerTriggers.forEach((entry) => entry.el?.remove());
		this._activeStingerTriggers.clear();
	}

	// The Section this view is actually showing (see _onStoreChange above) —
	// NOT xmlStore.getSelectedNode(), which is very often some Layer/Segment/
	// Option *inside* it instead (any box click here, or a tree click,
	// updates that same global selection). Transport/zoom code that checked
	// getSelectedNode().tagName === "Section" directly used to silently no-op
	// the moment the user selected anything other than the Section itself —
	// which in normal use is most of the time.
	_getActiveSectionNode() {
		if (!this._lastSectionId || !xmlStore.root) return null;
		return ops.findNodeById(xmlStore.root, this._lastSectionId);
	}

	// A Section's parent is always its <Composition> per the schema — used
	// wherever readSectionInfo/readEffectiveLoopEnd need it for Composition
	// -> Section/Layer attribute inheritance (see section-model.js).
	_getCompositionAncestor(sectionNode) {
		return sectionNode?.parent ? ops.findNodeById(xmlStore.root, sectionNode.parent) : null;
	}

	// --- playback (driven by the global player-store, not owned here) ---

	// Reacts to the shared player's Play/Stop/selector-target state — this
	// view's own playhead only animates while *this* Section is the one
	// actually being targeted, so navigating elsewhere in the player (or
	// switching which Section it targets) correctly stops this view's own
	// visualization without issuing any stop of its own.
	_onPlayerStoreChange() {
		const isThisSectionPlaying = playerStore.isPlaying && playerStore.activeSectionId === this._lastSectionId;
		if (isThisSectionPlaying === this._isPlaying) return;

		this._isPlaying = isThisSectionPlaying;
		if (this._isPlaying) {
			// No known seek API (see file header) — every trig starts the
			// engine from its true beginning, so the visual cursor resets too.
			this._cursorTime = 0;
			this._playStartAudioTime = playerStore.audioContext.currentTime;
			// A fresh play session should page forward from wherever the view
			// happens to be scrolled right now, not from a stale target left
			// over from a previous playback (see _updatePlayheadVisual).
			this._autoScrollTargetLeft = undefined;
			this._startPositionLoop();
		} else {
			this._stopPositionLoop();
			this._updatePlayheadVisual();
			this._activeStingerTriggers.forEach((entry) => entry.el?.remove());
			this._activeStingerTriggers.clear();
		}
	}

	_readEnginePosition() {
		const iMus = window.iMus;
		if (iMus && typeof iMus.getPosition === "function") {
			const pos = iMus.getPosition();
			if (pos && Number.isFinite(pos.time)) return pos.time;
		}
		return null;
	}

	_handleZoom(kind) {
		if (kind === "h-in") this._pxPerSecond = Math.min(MAX_PX_PER_SEC, this._pxPerSecond * 1.4);
		else if (kind === "h-out") this._pxPerSecond = Math.max(MIN_PX_PER_SEC, this._pxPerSecond / 1.4);
		else if (kind === "v-in") this._rowHeight = Math.min(MAX_ROW_HEIGHT, this._rowHeight * 1.25);
		else if (kind === "v-out") this._rowHeight = Math.max(MIN_ROW_HEIGHT, this._rowHeight / 1.25);

		const node = this._getActiveSectionNode();
		if (node) this._renderSection(node);
	}

	// A pinch gesture is one continuous scalar, unlike the H/V buttons'
	// discrete per-axis steps — scales pxPerSecond and rowHeight together
	// (both axes at once, matching how a pinch naturally reads) and smoothly
	// (proportional to the actual gesture magnitude) rather than reusing
	// _handleZoom's fixed 1.4x-per-click step, which would feel jumpy
	// applied on every wheel tick of a gesture that can fire dozens of them.
	// stopPropagation() (see connectedCallback) keeps wa-panel.js's own
	// generic CSS-transform zoom fallback from also firing for this same
	// gesture.
	_onWheelZoom(e) {
		if (!e.ctrlKey) return;
		e.preventDefault();
		e.stopPropagation();
		// Negative deltaY = pinch out/zoom in, matching native browser
		// page-zoom's own convention for this synthesized gesture.
		const factor = Math.exp(-e.deltaY * 0.01);
		this._pxPerSecond = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, this._pxPerSecond * factor));
		this._rowHeight = Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, this._rowHeight * factor));

		const node = this._getActiveSectionNode();
		if (node) this._renderSection(node);
	}

	// --- playhead animation ---

	_startPositionLoop() {
		this._stopPositionLoop();
		const step = () => {
			if (!this._isPlaying) return;
			// window.iMus.getPosition().time is already relative to this
			// section's musical start (0s) — fall back to our own wall-clock
			// tracking only if the engine function is ever unavailable.
			const enginePos = this._readEnginePosition();
			if (enginePos !== null) {
				this._cursorTime = Math.max(0, enginePos);
			} else {
				this._cursorTime = bridge.audioContext.currentTime - this._playStartAudioTime;
			}
			this._updatePlayheadVisual();
			this._updatePositionReadout();
			this._updateStingerPointers();
			this._rafId = requestAnimationFrame(step);
		};
		this._rafId = requestAnimationFrame(step);
	}

	_stopPositionLoop() {
		if (this._rafId) cancelAnimationFrame(this._rafId);
		this._rafId = null;
	}

	_updatePlayheadVisual() {
		const node = this._getActiveSectionNode();
		if (!node) return;
		const info = readSectionInfo(node, this._getCompositionAncestor(node));

		if (this._isPlaying && this._layerScroll) {
			// Keeps the rendered timeline ahead of the playhead — one
			// viewport of lookahead — so a long or looping Layer never runs
			// into blank space during playback (see _ensureTimelineCovers).
			this._ensureTimelineCovers(this._cursorTime + this._layerScroll.clientWidth / this._pxPerSecond);
		}

		const cursorPx = this._timeToPx(this._cursorTime, info);
		if (this._playheadEl) {
			this._playheadEl.style.left = `${LABEL_WIDTH + cursorPx}px`;
		}
		// .scroll-area only scrolls vertically now (Stinger rows get their
		// own independent horizontal scroll below it, see .layer-scroll/
		// .stinger-scroll in the template) — the Layer area's own horizontal
		// scroll, which the playhead should follow during playback, lives on
		// .layer-scroll instead. Once the playhead reaches the right edge of
		// what's currently visible, the view smoothly pages forward so the
		// playhead lands back at the far left — per Hans (2026-09-02), no
		// abrupt jump. _autoScrollTargetLeft (not the live scrollLeft, which
		// is still mid-animation while a smooth scroll is in flight) is what
		// this compares against, so an in-progress scroll isn't retriggered
		// every frame.
		if (this._isPlaying && this._layerScroll) {
			const viewportWidth = this._layerScroll.clientWidth;
			if (this._autoScrollTargetLeft === undefined) this._autoScrollTargetLeft = this._layerScroll.scrollLeft;
			if (cursorPx >= this._autoScrollTargetLeft + viewportWidth || cursorPx < this._autoScrollTargetLeft) {
				this._autoScrollTargetLeft = Math.max(0, cursorPx);
				this._layerScroll.scrollTo({ left: this._autoScrollTargetLeft, behavior: "smooth" });
			}
		}
	}

	// Extends the rendered timeline (see _renderSection's totalDuration) and
	// re-renders if `seconds` would fall outside what's currently drawn —
	// called while scrolling (see the .layer-scroll "scroll" listener in
	// connectedCallback) and during playback's autoscroll (_updatePlayheadVisual),
	// so a long or looping Layer keeps drawing further out instead of running
	// into blank space, per Hans (2026-09-02) — it used to stop dead at a
	// fixed 16 bars. Extends with a full viewport of extra headroom (not just
	// up to `seconds`) so this doesn't have to re-render on every single
	// scroll/frame tick near the edge.
	_ensureTimelineCovers(seconds) {
		if (this._lastTotalDuration !== undefined && seconds <= this._lastTotalDuration) return;
		const node = this._getActiveSectionNode();
		if (!node) return;
		const viewportSeconds = (this._layerScroll?.clientWidth || 0) / this._pxPerSecond;
		this._extendedDuration = Math.max(seconds + viewportSeconds, (this._lastTotalDuration || 0) * 1.5);
		this._renderSection(node);
	}

	_updatePositionReadout() {
		const node = this._getActiveSectionNode();
		if (!node) return;
		const info = readSectionInfo(node, this._getCompositionAncestor(node));
		const bar = Math.floor(this._cursorTime / info.barDuration) + 1;
		const beatInBar = Math.floor((this._cursorTime % info.barDuration) / info.beatDuration) + 1;
		const frac = Math.floor((this._cursorTime % info.beatDuration) / info.beatDuration * 100);
		this._positionEl.textContent = `${bar}.${beatInBar}.${String(frac).padStart(2, "0")}`;
	}

	// --- Stinger triggering & live position pointer ---

	// Double-click a Stinger (its label, or its own content/box) to trigger
	// it live during Section Preview playback — mirrors the "double-click to
	// preview a sound" gesture common in DAWs; single click stays reserved
	// for selection. Only meaningful while the Section is actually playing,
	// since there's no "current position" to compute against otherwise.
	//
	// waxml.js starts a triggered Stinger's own audio mid-sample — its
	// internal position pointer picks up at (elapsed Section time) mod (its
	// quantize duration), not from its own beginning — confirmed with Hans.
	// The pointer this animates mirrors that: it starts at the Stinger's own
	// resolved position (basePos, i.e. where its waveform is actually drawn)
	// plus that same remainder, then advances in real time from there.
	_handleStingerDoubleClick(stinger, info) {
		if (!this._isPlaying) return;
		const stingerNow = ops.findNodeById(xmlStore.root, stinger.id);
		if (!stingerNow || !stingerNow.attributes.id) return;

		bridge.trigNode(stingerNow.attributes.id);

		const quantizeDurationSeconds = parseDivision(stingerNow.attributes.quantize, info);
		const startOffsetSeconds = quantizeDurationSeconds > 0 ? this._cursorTime % quantizeDurationSeconds : 0;

		this._activeStingerTriggers.set(stinger.id, {
			triggerAudioTime: bridge.audioContext.currentTime,
			startOffsetSeconds,
			durationSeconds: this._estimateStingerDuration(stingerNow, info),
			el: null
		});

		const node = this._getActiveSectionNode();
		if (node) this._renderSection(node);
	}

	// Best-effort playback-duration estimate for a triggered Stinger, used
	// only to know when to stop animating its pointer — waxml.js doesn't
	// expose "how long will this actually play" from the outside. Uses
	// whatever's already decoded/cached for its own waveform (the first
	// Option's, for a with-Options Stinger, since which one the engine
	// actually picks isn't predictable from the XML alone), falling back to
	// its own quantize duration (or a bar) if nothing's decoded yet.
	_estimateStingerDuration(stinger, info) {
		const options = getOptions(stinger);
		const srcAttr = options.length > 0 ? findSrcAttribute(xmlStore.schema, options[0]) : findSrcAttribute(xmlStore.schema, stinger);
		const resolvedUrl = srcAttr ? resolvePlayableUrl(srcAttr.value) : null;
		const buffer = resolvedUrl ? this._resolvedBuffers.get(resolvedUrl) : null;
		if (buffer) return buffer.duration;
		const quantizeDurationSeconds = parseDivision(stinger.attributes.quantize, info);
		return quantizeDurationSeconds > 0 ? quantizeDurationSeconds : info.barDuration;
	}

	// Called every animation frame while playing (see _startPositionLoop) —
	// advances each actively-triggered Stinger's own pointer, removing it
	// once its estimated duration has elapsed. Only repositions an existing
	// element (built by _buildStingerLane, which owns creating/attaching it,
	// same split as the main playhead's own _playheadEl/_updatePlayheadVisual).
	_updateStingerPointers() {
		if (this._activeStingerTriggers.size === 0) return;
		const node = this._getActiveSectionNode();
		if (!node) return;
		const info = readSectionInfo(node, this._getCompositionAncestor(node));
		const nowAudioTime = bridge.audioContext.currentTime;

		for (const [stingerId, entry] of this._activeStingerTriggers) {
			const elapsedSinceTrigger = nowAudioTime - entry.triggerAudioTime;
			if (elapsedSinceTrigger >= entry.durationSeconds) {
				entry.el?.remove();
				this._activeStingerTriggers.delete(stingerId);
				continue;
			}
			const stinger = ops.findNodeById(xmlStore.root, stingerId);
			if (!stinger) {
				entry.el?.remove();
				this._activeStingerTriggers.delete(stingerId);
				continue;
			}
			if (!entry.el) continue; // its lane isn't currently rendered
			const basePos = readStingerQuantizePosition(stinger, info) + readStingerOffset(stinger, info);
			const pointerAbsSeconds = basePos + entry.startOffsetSeconds + elapsedSinceTrigger;
			entry.el.style.left = `${this._timeToPx(pointerAbsSeconds, info)}px`;
		}
	}

	// --- selection & deletion ---

	_handleItemClick(id, e) {
		if (e.metaKey || e.ctrlKey) {
			if (this._selectedIds.has(id)) this._selectedIds.delete(id);
			else this._selectedIds.add(id);
		} else {
			this._selectedIds = new Set([id]);
		}
		// Set before selectNode: xmlStore.selectNode dispatches its "change"
		// event synchronously, so _onStoreChange's external-selection sync
		// runs before this call returns — pre-announcing the id here is what
		// tells it "this change came from me, don't resync/collapse it".
		this._lastSelfSelectedId = id;
		xmlStore.selectNode(id);
		this._updateSelectionHighlight();
	}

	_updateSelectionHighlight() {
		this.shadowRoot.querySelectorAll("[data-node-id]").forEach((el) => {
			el.classList.toggle("selected", this._selectedIds.has(el.dataset.nodeId));
		});
	}

	_onKeyDown(e) {
		if (e.key !== "Delete" && e.key !== "Backspace") return;
		if (this._selectedIds.size === 0) return;
		if (this._isTextEditingFocused()) return;

		e.preventDefault();
		const ids = [...this._selectedIds];
		this._selectedIds.clear();
		ids.forEach((id) => xmlStore.removeNode(id));
	}

	// document.activeElement doesn't pierce shadow DOM — an input focused
	// inside another component's shadow root (e.g. the node inspector) would
	// otherwise report as that component's host tag, not "INPUT", and Delete/
	// Backspace meant for that field would get hijacked here instead.
	_isTextEditingFocused() {
		let el = document.activeElement;
		while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
		if (!el) return false;
		return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
	}

	// --- layout / rendering ---

	_renderSection(node) {
		this._renderToken += 1;
		const token = this._renderToken;

		this._emptyHint.hidden = true;
		this._grid.hidden = false;
		this._layersDivider.hidden = false;
		this._stingerDivider.hidden = false;
		this._stingerScroll.hidden = false;

		// loopEnd inherits Composition -> Section -> Layer (see
		// readEffectiveLoopEnd), and tempo/timeSign inherit Composition ->
		// Section (see readSectionInfo) — need the Composition ancestor on
		// hand for both.
		const compositionNode = this._getCompositionAncestor(node);
		const info = readSectionInfo(node, compositionNode);
		this._renderTransportInfo(node, info);

		const layers = getLayers(node);
		// Never draws less than one viewport's worth (so zooming out doesn't
		// run into blank space) or less than whatever _ensureTimelineCovers
		// already extended to (scrolling/playback autoscroll past the edge,
		// see there) — a looping Layer needs to keep tiling out that far too,
		// per Hans (2026-09-02): it used to stop dead at a fixed 16 bars.
		const viewportSeconds = (this._layerScroll?.clientWidth || 0) / this._pxPerSecond;
		const totalDuration = Math.max(
			minimumTotalDuration(info),
			this._estimateMaxEnd(layers, node, compositionNode, info),
			viewportSeconds + info.barDuration * PRE_ROLL_BARS,
			this._extendedDuration || 0
		);
		this._lastTotalDuration = totalDuration;
		this._lastRenderInfo = info;
		const totalWidth = this._timeToPx(totalDuration, info);
		const rowsPerLayer = layers.map((layer) => this._rowsNeededForLayer(layer));

		this._grid.innerHTML = "";
		const corner = document.createElement("div");
		corner.className = "corner";
		corner.style.height = `${RULER_HEIGHT}px`;
		this._grid.appendChild(corner);
		this._grid.appendChild(this._buildRuler(info, totalWidth, totalDuration));

		const firstFiller = this._buildDropZoneFiller();
		this._grid.appendChild(firstFiller);
		this._grid.appendChild(this._buildDropZone(node, layers, 0, info, totalWidth, firstFiller));

		layers.forEach((layer, idx) => {
			this._grid.appendChild(this._buildLayerLabel(layer, rowsPerLayer[idx]));
			this._grid.appendChild(this._buildLayerLane(layer, node, compositionNode, info, totalWidth, totalDuration, token, rowsPerLayer[idx]));
			const filler = this._buildDropZoneFiller();
			this._grid.appendChild(filler);
			this._grid.appendChild(this._buildDropZone(node, layers, idx + 1, info, totalWidth, filler));
		});

		const totalRowsHeight = rowsPerLayer.reduce((sum, n) => sum + n * this._rowHeight, 0);
		const dropZoneCount = layers.length + 1;
		// With no Layers at all, the section's only dropzone is a full-height
		// placeholder row (see _buildDropZone's isOnlyRow), not the usual
		// thin DROPZONE_HEIGHT sliver — the playhead needs to span that too,
		// or it ends up just a few pixels tall, per Hans.
		const emptyRowExtraHeight = layers.length === 0 ? this._rowHeight - DROPZONE_HEIGHT : 0;
		const layersNaturalHeight = RULER_HEIGHT + totalRowsHeight + dropZoneCount * DROPZONE_HEIGHT + emptyRowExtraHeight;
		const playhead = document.createElement("div");
		playhead.className = "playhead";
		playhead.style.height = `${layersNaturalHeight}px`;
		this._grid.appendChild(playhead);
		this._playheadEl = playhead;

		const stingersNaturalHeight = this._renderStingers(node, info, totalWidth, totalDuration, token);
		this._applyLayerStingerSplit(layersNaturalHeight, stingersNaturalHeight);

		this._updatePlayheadVisual();
		this._updatePositionReadout();
		this._updateSelectionHighlight();
	}

	// The Stinger area below the Layers: same bar/beat ruler (so the two
	// line up when scrolled to the same place) but its own independent
	// horizontal scroll (.stinger-scroll, see the CSS comment on it) — a
	// Stinger isn't part of the Section's own linear timeline the way a
	// Layer's content is; it can trigger at any moment, so its row has no
	// business being dragged sideways by the Layer area's playhead-follow
	// auto-scroll during playback.
	//
	// Always renders (even with zero Stingers) so the Section Preview
	// reserves vertical space for this area the same way the Layer area
	// always does — a trailing empty-state row (mirrors _buildDropZone's
	// "isLast" ghost hint) doubles as a drop target that creates the
	// Section's first Stinger, per Hans.
	_renderStingers(sectionNode, info, totalWidth, totalDuration, token) {
		const stingers = getStingers(sectionNode);

		this._stingerGrid.innerHTML = "";
		const corner = document.createElement("div");
		corner.className = "corner";
		corner.style.height = `${RULER_HEIGHT}px`;
		this._stingerGrid.appendChild(corner);
		this._stingerGrid.appendChild(this._buildRuler(info, totalWidth, totalDuration));

		stingers.forEach((stinger) => {
			this._stingerGrid.appendChild(this._buildStingerLabel(stinger));
			this._stingerGrid.appendChild(this._buildStingerLane(stinger, info, totalWidth, token));
		});

		const isOnlyRow = stingers.length === 0;
		const emptyLabel = this._buildDropZoneFiller();
		emptyLabel.textContent = "Stinger";
		if (isOnlyRow) emptyLabel.classList.add("preview-layer");
		this._stingerGrid.appendChild(emptyLabel);
		this._stingerGrid.appendChild(this._buildStingerEmptyDropzone(sectionNode, info, totalWidth, isOnlyRow));

		// Natural (unconstrained) content height — see _applyLayerStingerSplit,
		// which decides whether this area actually gets this much room.
		return RULER_HEIGHT + stingers.length * this._rowHeight + (isOnlyRow ? this._rowHeight : DROPZONE_HEIGHT);
	}

	// Vertical space split between the Layer and Stinger areas, per Hans
	// (2026-09-02):
	// - Starts at 80/20 (Layers/Stingers), user-adjustable by dragging
	//   .stinger-divider (see _onDividerResizeStart) — _layerStingerRatio is
	//   Layers' own share, Stingers gets the rest.
	// - Layers never shrinks below one row's worth of height (reserved even
	//   with zero Layers); Stingers never shrinks below one ruler's worth.
	// - If Layers' own content needs more than its current share, the whole
	//   Layer area grows instead (taller than the split gave it) — the outer
	//   .scroll-area's normal vertical scroll takes over from there; Stingers
	//   keeps whatever height it already had.
	// - Either area scrolls internally (see the .layer-scroll/.stinger-scroll
	//   overflow-y:auto) if squeezed below its own natural content height.
	_applyLayerStingerSplit(layersNaturalHeight, stingersNaturalHeight) {
		// Cached so a divider drag (see _onDividerResizeMove) can re-apply the
		// split immediately without waiting for a full _renderSection.
		this._lastLayersNaturalHeight = layersNaturalHeight;
		this._lastStingersNaturalHeight = stingersNaturalHeight;

		const dividerHeight = (this._layersDivider?.offsetHeight || 0) + (this._stingerDivider?.offsetHeight || 0);
		const available = Math.max(0, this._scrollArea.clientHeight - dividerHeight);
		const layersMin = RULER_HEIGHT + this._rowHeight;
		const stingersMin = RULER_HEIGHT;

		let stingersHeight = Math.max(stingersMin, available * (1 - this._layerStingerRatio));
		let layersHeight = Math.max(layersMin, available - stingersHeight);
		if (layersNaturalHeight > layersHeight) layersHeight = layersNaturalHeight;
		stingersHeight = Math.max(stingersMin, available - layersHeight);

		this._layerScroll.style.height = `${layersHeight}px`;
		this._stingerScroll.style.height = `${stingersHeight}px`;
	}

	_onDividerResizeStart(e) {
		e.preventDefault();
		try {
			this._stingerDivider.setPointerCapture(e.pointerId);
		} catch {}
		this._dividerStartY = e.clientY;
		this._dividerStartRatio = this._layerStingerRatio;
		window.addEventListener("pointermove", this._onDividerResizeMove);
		window.addEventListener("pointerup", this._onDividerResizeEnd);
	}

	_onDividerResizeMove(e) {
		const dividerHeight = (this._layersDivider?.offsetHeight || 0) + (this._stingerDivider?.offsetHeight || 0);
		const available = Math.max(1, this._scrollArea.clientHeight - dividerHeight);
		const deltaRatio = (e.clientY - this._dividerStartY) / available;
		this._layerStingerRatio = Math.min(0.9, Math.max(0.1, this._dividerStartRatio + deltaRatio));
		this._applyLayerStingerSplit(this._lastLayersNaturalHeight, this._lastStingersNaturalHeight);
	}

	_onDividerResizeEnd() {
		window.removeEventListener("pointermove", this._onDividerResizeMove);
		window.removeEventListener("pointerup", this._onDividerResizeEnd);
	}

	// Trailing drop target for the Stinger area, always present — a file or
	// dragged Option dropped here creates a brand-new <Stinger> (no quantize,
	// same as adding one via the "+" button) and puts the content directly
	// on it. Same idea as _buildDropZone's "isLast" Layer zone, simplified
	// since Stinger rows aren't ordered/inserted-between the way Layers are.
	_buildStingerEmptyDropzone(sectionNode, info, totalWidth, isOnlyRow) {
		const zone = document.createElement("div");
		zone.className = isOnlyRow ? "dropzone preview-layer" : "dropzone";
		zone.style.minWidth = `${totalWidth}px`;
		zone.style.height = `${isOnlyRow ? this._rowHeight : DROPZONE_HEIGHT}px`;

		const ghost = document.createElement("div");
		ghost.className = "segment-ghost";
		zone.appendChild(ghost);

		const isAcceptable = (types) => this._isFileDrag(types) || types.includes(OPTION_DRAG_TYPE);

		zone.addEventListener("dragover", (e) => {
			if (!isAcceptable(e.dataTransfer.types)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = this._isFileDrag(e.dataTransfer.types) ? "copy" : "move";
			zone.classList.add("drop-active");
			const anchorSeconds = this._stingerAnchorDropSeconds(e, zone, info);
			ghost.style.top = "2px";
			ghost.style.height = `${zone.clientHeight - 4}px`;
			ghost.style.left = `${this._timeToPx(anchorSeconds, info)}px`;
			ghost.style.width = `${Math.max(this._ghostWidthSeconds(info) * this._pxPerSecond, 4)}px`;
			ghost.style.display = "block";
		});
		zone.addEventListener("dragleave", (e) => {
			if (e.target !== zone) return;
			zone.classList.remove("drop-active");
			this._hideGhost(ghost);
		});
		zone.addEventListener("drop", async (e) => {
			const types = e.dataTransfer.types;
			if (!isAcceptable(types)) return;
			e.preventDefault();
			zone.classList.remove("drop-active");
			this._hideGhost(ghost);
			// A brand-new Stinger has no anchor yet — so unlike dropping onto
			// an *existing* Stinger's lane (which sets the new content's own
			// pos, leaving that Stinger's own anchor alone), here the anchor
			// itself is what should land at the drop point (its own
			// quantize), with no pos offset needed at all — "ljudfilen med
			// anchor ska hamna där man släpper", per Hans.
			const anchorSeconds = this._stingerAnchorDropSeconds(e, zone, info);
			const quantizeString = secondsToQuantizeString(anchorSeconds, info, this._effectiveGridBeats(info));

			if (this._isFileDrag(types)) {
				const fileId = await this._resolveDroppedFileId(e.dataTransfer);
				if (!fileId) return;
				const fileNode = vfs.getNode(fileId);
				if (!fileNode || fileNode.type !== "file") return;
				const stinger = xmlStore.insertNewChild(sectionNode.id, "Stinger", { quantize: quantizeString });
				xmlStore.insertNewChild(stinger.id, "Option", { src: vfs.getExportPath(fileNode.id) });
				return;
			}

			const draggedOptionId = e.dataTransfer.getData(OPTION_DRAG_TYPE);
			if (!draggedOptionId) return;
			const stinger = xmlStore.insertNewChild(sectionNode.id, "Stinger", { quantize: quantizeString });
			xmlStore.reparentNode(draggedOptionId, stinger.id);
			this._stripPos(draggedOptionId);
		});

		return zone;
	}

	// Grid-snapped, bar-0-floored absolute position for a Stinger's own
	// anchor at this cursor position — same snap+clamp rule
	// _wireStingerDrag's own onMove applies when dragging an *existing*
	// anchor, used here so dropping a file to create a brand-new Stinger
	// lands its anchor exactly where dropped (see _buildStingerEmptyDropzone).
	_stingerAnchorDropSeconds(e, referenceEl, info) {
		const rect = referenceEl.getBoundingClientRect();
		const rawSeconds = this._pxToTime(e.clientX - rect.left + referenceEl.scrollLeft, info);
		const gridBeats = this._effectiveGridBeats(info);
		const beatCount = gridBeats ? Math.round(rawSeconds / info.beatDuration / gridBeats) * gridBeats : rawSeconds / info.beatDuration;
		return Math.max(-info.barDuration, beatCount * info.beatDuration);
	}

	// A Stinger lane: a bare src renders like a bare Layer src (one
	// continuous waveform); Options render nested inside one box, same
	// visual treatment as a closed Segment.
	//
	// Every Stinger (and each of its Options) has an "anchor" — the point
	// its `quantize` locks to — shown as a draggable red line (see
	// _buildStingerAnchor). Grabbing the anchor line itself moves it and
	// rewrites `quantize`; the whole group (content + Options, since their
	// own offsets are relative to it) moves along with it automatically.
	// Grabbing the content elsewhere instead shifts it relative to the
	// (unmoved) anchor, rewriting `pos` (upbeat stays fixed) — pos=0 sits
	// exactly at the anchor, negative before it, positive after, per Hans.
	_buildStingerLane(stinger, info, totalWidth, token) {
		const lane = document.createElement("div");
		lane.className = "layer-lane";
		lane.style.height = `${this._rowHeight}px`;
		lane.style.minWidth = `${totalWidth}px`;

		const quantizePos = readStingerQuantizePosition(stinger, info);
		const stingerOffset = readStingerOffset(stinger, info);
		const basePos = quantizePos + stingerOffset;
		const options = getOptions(stinger);

		// Content is built first so it can ride along (as a drag "follower")
		// with the anchor when *that's* what gets dragged — see
		// _wireStingerDrag's followerEls.
		let content = null;
		if (options.length === 0) {
			// Shown exactly like a bare Layer src: just the waveform, no
			// separate selectable box on top of it — clicking this Stinger's
			// label (left column) is how you select it, same as a Layer.
			const srcAttr = findSrcAttribute(xmlStore.schema, stinger);
			if (srcAttr) {
				content = this._renderWaveformOnly(lane, srcAttr.value, this._rowHeight, totalWidth, token, info, basePos, false);
			}
		} else {
			content = this._renderTimedBox(stinger, info, token, "Stinger", basePos, { top: 2, height: this._rowHeight - 4 }, true);
			lane.appendChild(content);
		}

		const anchor = this._buildStingerAnchor(this._rowHeight);
		anchor.style.left = `${this._timeToPx(quantizePos, info)}px`;
		anchor.title = "Drag to change this Stinger's quantize";
		this._wireStingerDrag(
			anchor,
			info,
			quantizePos,
			(newQuantizePos) => {
				const stingerNow = ops.findNodeById(xmlStore.root, stinger.id);
				if (!stingerNow) return;
				xmlStore.updateAttributes(stinger.id, {
					...stingerNow.attributes,
					quantize: secondsToQuantizeString(newQuantizePos, info, this._effectiveGridBeats(info))
				});
			},
			content ? [content] : [],
			(committedSeconds) => this._updateStingerQuantizeGuides(lane, info, committedSeconds),
			-info.barDuration // a Stinger can't be dragged left of bar 0, per Hans
		);
		lane.appendChild(anchor);

		const ghost = document.createElement("div");
		ghost.className = "segment-ghost";
		lane.appendChild(ghost);
		this._wireStingerLaneDropTarget(lane, stinger, info, ghost, basePos);

		// Live position pointer for this Stinger, only present while it's
		// actually been triggered (double-click) during playback — see
		// _handleStingerDoubleClick/_updateStingerPointers. Rebuilt on every
		// render (like the main .playhead) so zoom/scroll changes don't
		// leave it stale; the animation loop just repositions it in place.
		const activeTrigger = this._activeStingerTriggers.get(stinger.id);
		if (activeTrigger) {
			const pointerEl = document.createElement("div");
			pointerEl.className = "stinger-pointer";
			pointerEl.style.height = `${this._rowHeight}px`;
			const elapsed = bridge.audioContext.currentTime - activeTrigger.triggerAudioTime;
			const pointerAbsSeconds = basePos + activeTrigger.startOffsetSeconds + elapsed;
			pointerEl.style.left = `${this._timeToPx(pointerAbsSeconds, info)}px`;
			lane.appendChild(pointerEl);
			activeTrigger.el = pointerEl;
		}

		if (options.length === 0) {
			if (content) {
				this._wireStingerContentDrag(content, stinger, info, quantizePos, basePos);
				// _renderTimedBox wires this internally for the with-Options
				// case (kind="Stinger" box below); a bare src's canvas needs
				// it added explicitly since _renderWaveformOnly is generic
				// (also used for a plain Layer, which doesn't want this).
				this._wireBoxDropTarget(content, stinger, "Stinger", info);
				// Marks append to `lane` (the canvas itself can't have DOM
				// children) using the same lane-absolute coordinates the
				// canvas and anchor already use.
				this._renderChangeOnNextMarks(lane, stinger, info, basePos, quantizePos, (s) => this._timeToPx(s, info));
				content.addEventListener("dblclick", (e) => {
					e.stopPropagation();
					this._handleStingerDoubleClick(stinger, info);
				});
			}
			return lane;
		}

		const box = content;
		this._wireStingerContentDrag(box, stinger, info, quantizePos, basePos);
		box.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			this._handleStingerDoubleClick(stinger, info);
		});

		// Each Option's own pos=0 sits at the *Stinger's* resolved position
		// (basePos), not the raw quantize point — its offset stacks on top
		// of the Stinger's own, confirmed with Hans — so this second anchor
		// line (always at the box's own local left edge, since that's
		// exactly where the box itself renders) is what an Option's own
		// drag is relative to.
		const optionsAnchor = this._buildStingerAnchor(this._rowHeight - 4, false);
		optionsAnchor.style.left = "0px";
		optionsAnchor.title = "Each Option's own pos is relative to this point";
		box.appendChild(optionsAnchor);

		const optionRowHeight = (this._rowHeight - 4) / options.length;
		options.forEach((option, idx) => {
			const optionOffset = readStingerOffset(option, info);
			const nested = this._renderNestedOption(
				box,
				option,
				info,
				token,
				optionOffset,
				{ top: idx * optionRowHeight, height: optionRowHeight },
				true
			);
			if (nested) {
				this._wireStingerContentDrag(nested, option, info, basePos, basePos + optionOffset);
				// Marks append inside `nested` itself, positioned relative to
				// its own left edge (basePos + optionOffset) the same way
				// _renderNestedOption itself positions it relative to `box`.
				const optionStartSeconds = basePos + optionOffset;
				this._renderChangeOnNextMarks(nested, option, info, optionStartSeconds, basePos, (s) => (s - optionStartSeconds) * this._pxPerSecond);
			}
		});
		lane.appendChild(box);
		return lane;
	}

	// A Stinger's lane background (not its own bare-src canvas or with-
	// Options box, both handled separately): a dropped file adds a new
	// <Option src="..."/> as a direct child — no <Segment> wrapper, since a
	// Stinger's schema doesn't have one — landing at whatever `pos` the
	// cursor's own (grid-snapped) horizontal position resolves to, relative
	// to the Stinger's own anchor (basePos) — same idea as a Layer's lane
	// drop, just anchor-relative instead of absolute (see
	// _stingerDropPositionString). A dragged Option gets reparented and its
	// own `pos` rewritten the same way.
	_wireStingerLaneDropTarget(lane, stinger, info, ghost, basePos) {
		const isAcceptable = (types) => this._isFileDrag(types) || types.includes(OPTION_DRAG_TYPE);

		lane.addEventListener("dragover", (e) => {
			const types = e.dataTransfer.types;
			if (!isAcceptable(types)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = this._isFileDrag(types) ? "copy" : "move";
			// No lane-wide drop-active outline here — the ghost below already
			// shows exactly where the drop will land, so a second dashed box
			// around the whole track on top of it was just noise, per Hans.
			if (ghost) {
				const posString = this._stingerDropPositionString(e, lane, basePos, info);
				const dropAbsSeconds = basePos + parsePosition(posString, info);
				ghost.style.top = "2px";
				ghost.style.height = `${lane.clientHeight - 4}px`;
				ghost.style.left = `${this._timeToPx(dropAbsSeconds, info)}px`;
				ghost.style.width = `${Math.max(this._ghostWidthSeconds(info) * this._pxPerSecond, 4)}px`;
				ghost.style.display = "block";
			}
		});
		lane.addEventListener("dragleave", (e) => {
			if (e.target !== lane) return;
			this._hideGhost(ghost);
		});
		lane.addEventListener("drop", async (e) => {
			const types = e.dataTransfer.types;
			if (!isAcceptable(types)) return;
			e.preventDefault();
			this._hideGhost(ghost);
			const posString = this._stingerDropPositionString(e, lane, basePos, info);

			if (this._isFileDrag(types)) {
				const fileId = await this._resolveDroppedFileId(e.dataTransfer);
				if (!fileId) return;
				const fileNode = vfs.getNode(fileId);
				if (!fileNode || fileNode.type !== "file") return;
				xmlStore.insertNewChild(stinger.id, "Option", { src: vfs.getExportPath(fileNode.id), pos: posString });
				return;
			}

			const draggedOptionId = e.dataTransfer.getData(OPTION_DRAG_TYPE);
			if (!draggedOptionId || draggedOptionId === stinger.id) return;
			xmlStore.reparentNode(draggedOptionId, stinger.id);
			const nodeNow = ops.findNodeById(xmlStore.root, draggedOptionId);
			if (nodeNow) xmlStore.updateAttributes(draggedOptionId, { ...nodeNow.attributes, pos: posString });
		});
	}

	_buildStingerAnchor(heightPx, draggable = true) {
		const anchor = document.createElement("div");
		anchor.className = draggable ? "stinger-anchor" : "stinger-anchor static";
		anchor.style.height = `${heightPx}px`;
		return anchor;
	}

	// Faint vertical guide lines across a Stinger's own lane, shown only
	// while its anchor is being dragged — one at every multiple of the
	// *live* quantize duration currently being previewed (so dragging to
	// quantize="1/4" shows a line every beat, quantize="1" every bar, etc,
	// per Hans), from the current scroll position out to the visible
	// viewport's right edge. committedSeconds === null (drag not active, or
	// just ended) clears them.
	//
	// A pointermove fires far more often than the grid-snapped
	// committedSeconds actually changes — most calls during a drag land on
	// the exact same quantize duration as the previous one. Rebuilding up to
	// MAX_GUIDES DOM nodes on every single one of those was the cause of the
	// sluggish anchor-drag response Hans reported; skipping the rebuild
	// whenever the duration hasn't actually changed fixes it without
	// changing what gets drawn.
	_updateStingerQuantizeGuides(lane, info, committedSeconds) {
		if (committedSeconds === null) {
			(lane._quantizeGuideEls || []).forEach((el) => el.remove());
			lane._quantizeGuideEls = [];
			lane._lastGuideQuantizeDuration = undefined;
			return;
		}

		const quantizeDurationSeconds = committedSeconds + info.barDuration;
		if (!(quantizeDurationSeconds > 0) || !Number.isFinite(quantizeDurationSeconds)) return;
		if (lane._lastGuideQuantizeDuration === quantizeDurationSeconds) return;
		lane._lastGuideQuantizeDuration = quantizeDurationSeconds;

		(lane._quantizeGuideEls || []).forEach((el) => el.remove());
		lane._quantizeGuideEls = [];

		const scrollLeftPx = this._stingerScroll ? this._stingerScroll.scrollLeft : 0;
		const viewportWidthPx = this._stingerScroll ? this._stingerScroll.clientWidth : lane.clientWidth;
		const viewportLeftSeconds = this._pxToTime(scrollLeftPx, info);
		const viewportRightSeconds = this._pxToTime(scrollLeftPx + viewportWidthPx, info);
		const startMultiple = Math.floor(viewportLeftSeconds / quantizeDurationSeconds) * quantizeDurationSeconds;

		const MAX_GUIDES = 300; // safety cap in case a tiny quantize duration would otherwise flood the DOM
		let t = startMultiple;
		for (let i = 0; i < MAX_GUIDES && t <= viewportRightSeconds; i++, t += quantizeDurationSeconds) {
			const guide = document.createElement("div");
			guide.className = "stinger-quantize-guide";
			guide.style.left = `${this._timeToPx(t, info)}px`;
			lane.appendChild(guide);
			lane._quantizeGuideEls.push(guide);
		}
	}

	// changeOnNext marks: when a Stinger's (or one of its Options') own
	// content is positioned to start *before* its anchor, waxml.js can start
	// playback mid-sample at trigger time — waiting for the next
	// changeOnNext-length boundary before actually starting, per Hans (the
	// engine side of this is his own to port from <leadin> to <Stinger>; this
	// is purely the Section Preview's visualization/editing of it). One thin
	// mark per changeOnNext-multiple, counting back from the anchor, for as
	// long as that stays within the content's own start — none at all if
	// changeOnNext isn't set, or if the content doesn't actually start
	// before its anchor.
	//
	// container: DOM element the marks are appended to as children — must
	// not be a <canvas> (it can't have children), so the bare-src case
	// passes `lane` itself rather than the canvas. toLeftPx: converts an
	// absolute (lane-timeline) seconds value into container's own `left`
	// coordinate system — lane-absolute (_timeToPx) for `lane`, or relative
	// to a nested Option's own left edge for one of its marks — matching
	// whatever convention that particular container already uses elsewhere.
	_renderChangeOnNextMarks(container, node, info, contentStartSeconds, anchorSeconds, toLeftPx) {
		const changeOnNextSeconds = parseDivision(node.attributes.changeOnNext, info);
		if (!(changeOnNextSeconds > 0) || !(anchorSeconds > contentStartSeconds)) return;

		const marks = [];
		let index = 1;
		for (let pos = anchorSeconds - changeOnNextSeconds; pos > contentStartSeconds + 1e-9; pos -= changeOnNextSeconds, index++) {
			const mark = document.createElement("div");
			mark.className = "change-on-next-mark";
			mark.style.left = `${toLeftPx(pos)}px`;
			container.appendChild(mark);
			marks.push({ el: mark, index, startAbsSeconds: pos });
		}

		marks.forEach(({ el, index: ownIndex, startAbsSeconds }) => {
			this._wireStingerDrag(
				el,
				info,
				startAbsSeconds,
				(newAbsSeconds) => {
					const nodeNow = ops.findNodeById(xmlStore.root, node.id);
					if (!nodeNow) return;
					const newDuration = Math.max(0.01, (anchorSeconds - newAbsSeconds) / ownIndex);
					xmlStore.updateAttributes(node.id, { ...nodeNow.attributes, changeOnNext: secondsToLengthString(newDuration) });
				},
				[],
				(committedSeconds) => {
					// This mark's own position is already kept current by
					// _wireStingerDrag itself; only the *other* marks need
					// live repositioning here, since dragging one rescales
					// the spacing between all of them (not a uniform shift,
					// so the generic followerEls delta wouldn't be correct).
					if (committedSeconds === null) return;
					const liveDuration = Math.max(0.01, (anchorSeconds - committedSeconds) / ownIndex);
					marks.forEach(({ el: otherEl, index: otherIndex }) => {
						if (otherIndex === ownIndex) return;
						const otherPos = anchorSeconds - otherIndex * liveDuration;
						const inRange = otherPos > contentStartSeconds && otherPos < anchorSeconds;
						otherEl.style.display = inRange ? "" : "none";
						if (inRange) otherEl.style.left = `${toLeftPx(otherPos)}px`;
					});
				}
			);
		});
	}

	// Shared pointer-drag-to-reposition: tracks a raw pixel delta from
	// pointerdown (coordinate-system-agnostic — el.style.left might be lane-
	// absolute, like a Stinger's own anchor/content, or relative to a parent
	// box, like a nested Option; a pixel delta works either way without
	// needing to know which). The *target* absolute position
	// (startAbsSeconds + delta) is snapped to the nearest beat live during
	// the drag, so what's shown matches what releasing right now would
	// actually write. Only commits if the pointer genuinely moved — a plain
	// click still reaches the ordinary click-to-select handler on the same
	// element untouched, since nothing here calls preventDefault() until a
	// drag is confirmed.
	//
	// followerEls (optional): other elements that should visually shift by
	// the exact same live delta as `el`, without driving the commit
	// themselves — used so dragging a Stinger's anchor visibly carries its
	// content along in real time too (the actual data doesn't need to
	// change, since the content's offset from the anchor stays fixed, but
	// the *display* needs to move together or a drag looks like nothing is
	// happening until you let go).
	//
	// onLiveMove (optional): called with the live committedSeconds on every
	// update once dragging starts, and with null once the drag ends — only
	// the Stinger's own anchor uses this (to draw the quantize guide lines
	// while its being dragged, see _buildStingerLane); a plain content drag
	// or an Option's own anchor-relative drag has no use for it.
	//
	// minAbsSeconds (optional): floors the live/committed position — used by
	// the Stinger's own anchor so it can't be dragged left of bar 0, per
	// Hans (content-relative-to-anchor drags don't get this floor, since
	// content legitimately starts before its own anchor, e.g. a leadin).
	_wireStingerDrag(el, info, startAbsSeconds, onCommit, followerEls = [], onLiveMove = null, minAbsSeconds = -Infinity) {
		el.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			// A nested Option's own drag target sits inside the Stinger's own
			// box, which is *also* wired for dragging (its own pointerdown
			// listener) — without this, the event bubbling up from the
			// Option would also fire the box's handler, moving both at once.
			e.stopPropagation();
			const startX = e.clientX;
			const startLeftPx = parseFloat(el.style.left) || 0;
			const followerStartLeftPx = followerEls.map((f) => parseFloat(f.style.left) || 0);
			let dragging = false;
			let committedSeconds = startAbsSeconds;

			const onMove = (moveEvt) => {
				const deltaPx = moveEvt.clientX - startX;
				if (!dragging) {
					if (Math.abs(deltaPx) < 3) return;
					dragging = true;
					// A failure here (e.g. the pointer was already released)
					// shouldn't abort the position update below — capture is
					// just a nicety (keeps tracking the pointer if it strays
					// outside the element), not required for the drag itself.
					try {
						el.setPointerCapture(e.pointerId);
					} catch {}
				}
				const rawSeconds = startAbsSeconds + deltaPx / this._pxPerSecond;
				const gridBeats = this._effectiveGridBeats(info);
				const beatCount = gridBeats ? Math.round(rawSeconds / info.beatDuration / gridBeats) * gridBeats : rawSeconds / info.beatDuration;
				committedSeconds = Math.max(minAbsSeconds, beatCount * info.beatDuration);
				const visualDeltaPx = (committedSeconds - startAbsSeconds) * this._pxPerSecond;
				el.style.left = `${startLeftPx + visualDeltaPx}px`;
				followerEls.forEach((f, i) => {
					f.style.left = `${followerStartLeftPx[i] + visualDeltaPx}px`;
				});
				if (onLiveMove) onLiveMove(committedSeconds);
			};
			const onUp = () => {
				el.removeEventListener("pointermove", onMove);
				el.removeEventListener("pointerup", onUp);
				if (dragging) onCommit(committedSeconds);
				if (onLiveMove) onLiveMove(null);
			};
			el.addEventListener("pointermove", onMove);
			el.addEventListener("pointerup", onUp);
		});
	}

	// Commits a content drag to the dragged node's own `pos` (upbeat stays
	// fixed — "pos changes, not upbeat", per Hans). anchorSeconds is this
	// element's own zero point: the Stinger's raw quantize position for the
	// Stinger's own content, or the Stinger's *resolved* position for one of
	// its Options (see _buildStingerLane).
	_wireStingerContentDrag(el, node, info, anchorSeconds, startAbsSeconds) {
		this._wireStingerDrag(el, info, startAbsSeconds, (newAbsSeconds) => {
			const nodeNow = ops.findNodeById(xmlStore.root, node.id);
			if (!nodeNow) return;
			const newPosSeconds = newAbsSeconds - anchorSeconds + readUpbeatSeconds(nodeNow, info);
			xmlStore.updateAttributes(node.id, { ...nodeNow.attributes, pos: secondsToPosString(newPosSeconds, info, this._effectiveGridBeats(info)) });
		});
	}

	// A layer normally occupies one row. If one or more of its segments are
	// "open" (see the disclosure triangle in _renderSegmentBox), it grows to
	// fit whichever open segment has the most Options — closed segments just
	// keep spanning the full (now possibly taller) lane as a single box.
	_rowsNeededForLayer(layer) {
		const openSegments = getSegments(layer).filter((s) => this._openSegmentIds.has(s.id));
		if (openSegments.length === 0) return 1;
		return Math.max(...openSegments.map((s) => Math.max(getOptions(s).length, 1)));
	}

	// Provisional total length from explicit pos/length attributes, plus
	// whatever bare-layer src durations have been decoded so far
	// (this._maxDecodedEnd, grown monotonically by _growTimelineTo below —
	// segment/option boxes always have an explicit or bar-fallback width up
	// front, so only bare layers need this deferred-width handling). An
	// Option inside a Segment has no `pos` of its own (see _renderSegmentBox)
	// — it occupies the same slot as its Segment, so only its length (not a
	// position) can push the estimate further out; a Layer's own *direct*
	// Options (no Segment involved) do use their own pos, same as ever.
	_estimateMaxEnd(layers, sectionNode, compositionNode, info, end = 0) {
		const measure = (lengthSeconds, absPos) => {
			end = Math.max(end, absPos + (lengthSeconds ?? info.barDuration * FALLBACK_BOX_BARS));
		};

		layers.forEach((layer) => {
			getOptions(layer).forEach((option) => measure(readLength(option, info), readPos(option, info)));

			// A looping layer's own content tiles to fill whatever duration
			// everything else already establishes (see _buildLayerLane) — it
			// must not drive the timeline outward itself, or a short loop on
			// a long-lived section would grow forever as more copies get
			// laid out. loopEnd is inheritance-aware (Composition ->
			// Section -> Layer), same as everywhere else it's used.
			if (readEffectiveLoopEnd(layer, sectionNode, compositionNode, info) !== null) return;

			getSegments(layer).forEach((segment) => {
				const segmentPos = readPos(segment, info);
				measure(readLength(segment, info), segmentPos);
				getOptions(segment).forEach((option) => measure(readLength(option, info), segmentPos));
			});
		});

		return Math.max(end, this._maxDecodedEnd);
	}

	// Called once a bare layer src finishes decoding. Only triggers a re-render
	// when it genuinely raises the known max (monotonic), so this can never
	// loop — each bare-layer src can cause at most one re-layout.
	_growTimelineTo(seconds) {
		if (seconds <= this._maxDecodedEnd) return;
		this._maxDecodedEnd = seconds;
		const node = this._getActiveSectionNode();
		if (node) this._renderSection(node);
	}

	// Absolute-time <-> pixel conversions, both shifted right by the fixed
	// pre-roll reserve so pos="1.1.00" (bar 1, time 0) doesn't have to be the
	// leftmost pixel — a Segment before bar 1 needs somewhere on-screen to
	// its left to actually render. Nothing else in this file multiplies/
	// divides by _pxPerSecond directly for an *absolute* position; box
	// widths and in-box-relative offsets (nested Options, drag-grab deltas)
	// are unaffected by the shift and don't go through these.
	_timeToPx(seconds, info) {
		return (seconds + info.barDuration * PRE_ROLL_BARS) * this._pxPerSecond;
	}

	_pxToTime(px, info) {
		return px / this._pxPerSecond - info.barDuration * PRE_ROLL_BARS;
	}

	// The grid granularity (in beats) that drag-quantization and the ruler's
	// sub-beat ticks should actually use right now: the finest of
	// GRID_RESOLUTIONS, up to whatever this._gridResolution caps it at, whose
	// on-screen spacing at the *current* zoom is still >= MIN_TICK_SPACING_PX
	// — "as dense as possible without being too dense", per Hans. Returns
	// null when the menu is set to "off" (no grid/snap at all, though bars/
	// beats still show on the ruler regardless — see _buildRuler).
	_effectiveGridBeats(info) {
		if (this._gridResolution === "off") return null;
		const capIndex = GRID_RESOLUTIONS.findIndex((r) => r.label === this._gridResolution);
		const cap = capIndex === -1 ? GRID_RESOLUTIONS.length - 1 : capIndex;
		let chosen = GRID_RESOLUTIONS[0].beats;
		for (let i = 0; i <= cap; i++) {
			const spacingPx = this._pxPerSecond * info.beatDuration * GRID_RESOLUTIONS[i].beats;
			if (spacingPx >= MIN_TICK_SPACING_PX) chosen = GRID_RESOLUTIONS[i].beats;
		}
		return chosen;
	}

	// Bars are numbered on the same 1-indexed convention pos uses (bar 1 =
	// time 0), so the pre-roll bars to its left are bar 0, bar -1, ... —
	// negative-position content on those correctly reads as "before bar 1".
	//
	// Sub-beat gridlines (below the always-shown bar/beat ticks) only appear
	// once _effectiveGridBeats resolves finer than a whole beat, and get
	// progressively fainter the finer they are ("tunnare och tunnare för
	// varje multipel av grid-värdet", per Hans — an actual sub-1px border
	// can't get visually thinner, so opacity stands in for thickness here).
	_buildRuler(info, totalWidth, totalDuration) {
		const ruler = document.createElement("div");
		ruler.className = "ruler";
		ruler.style.minWidth = `${totalWidth}px`;

		const gridBeats = this._effectiveGridBeats(info);
		const showBeatTicks = this._pxPerSecond * info.beatDuration > 18;
		const showSubBeatTicks = gridBeats && gridBeats < 1;

		const firstBar = 1 - PRE_ROLL_BARS;
		const barCount = Math.ceil(totalDuration / info.barDuration) + 1 + PRE_ROLL_BARS;
		for (let i = 0; i < barCount; i++) {
			const bar = firstBar + i;
			const barTime = (bar - 1) * info.barDuration;
			const tick = document.createElement("div");
			tick.className = "ruler-tick bar";
			tick.style.left = `${this._timeToPx(barTime, info)}px`;
			const label = document.createElement("span");
			label.className = "tick-label";
			label.textContent = String(bar);
			tick.appendChild(label);
			ruler.appendChild(tick);

			if (showBeatTicks) {
				for (let beat = 1; beat < info.timeSign.numerator; beat++) {
					const beatTick = document.createElement("div");
					beatTick.className = "ruler-tick";
					beatTick.style.left = `${this._timeToPx(barTime + beat * info.beatDuration, info)}px`;
					ruler.appendChild(beatTick);
				}
			}

			if (showSubBeatTicks) {
				for (let beatIdx = 0; beatIdx < info.timeSign.numerator; beatIdx++) {
					const beatStart = barTime + beatIdx * info.beatDuration;
					for (let frac = gridBeats; frac < 1 - 1e-9; frac += gridBeats) {
						const subTick = document.createElement("div");
						subTick.className = `ruler-tick sub tier-${this._subBeatTier(frac)}`;
						subTick.style.left = `${this._timeToPx(beatStart + frac * info.beatDuration, info)}px`;
						ruler.appendChild(subTick);
					}
				}
			}
		}

		this._ruler = ruler;
		return ruler;
	}

	// Classifies a sub-beat gridline's fractional-beat offset (0 < frac < 1)
	// into a thickness/faintness tier: 1 = an eighth-note position, 2 = a
	// sixteenth, 3 = a thirty-second or a triplet subdivision (neither of
	// which nests cleanly into the straight 1/2-1/4-1/8 ladder, so both just
	// get the thinnest/faintest tier).
	_subBeatTier(frac) {
		const EPS = 1e-6;
		const nearMultipleOf = (unit) => Math.abs(frac / unit - Math.round(frac / unit)) < EPS;
		if (nearMultipleOf(0.5)) return 1;
		if (nearMultipleOf(0.25)) return 2;
		return 3;
	}

	// What a Layer/Segment/Option box shows as its own name: its `label`
	// attribute first, then `id`, then its src/source value (schema-aware,
	// via findSrcAttribute — so a bare <Option src="kick.wav"/> at least
	// shows which file it is), and only the bare element name as a last
	// resort when none of those are set.
	_displayLabel(node, fallback) {
		if (node.attributes.label) return node.attributes.label;
		if (node.attributes.id) return node.attributes.id;
		const srcAttr = findSrcAttribute(xmlStore.schema, node);
		if (srcAttr && srcAttr.value) return srcAttr.value;
		return fallback;
	}

	_buildLayerLabel(layer, rowsNeeded) {
		const label = document.createElement("div");
		label.className = "layer-label";
		label.dataset.nodeId = layer.id;
		label.style.height = `${this._rowHeight * rowsNeeded}px`;
		label.textContent = this._displayLabel(layer, "Layer");
		const marks = this._buildCommandMarks(layer);
		if (marks) label.appendChild(marks);
		label.addEventListener("click", (e) => {
			e.stopPropagation();
			this._handleItemClick(layer.id, e);
		});
		label.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			this._startAttributeEdit(label, layer, "label", () => this._buildLayerLabel(layer, rowsNeeded), "inline-rename-input", layer.attributes.id || layer.tagName);
		});
		return label;
	}

	// A Stinger's own row-label — double-click renames it (see
	// _startAttributeEdit), same as a Layer's label. Triggering the Stinger
	// for live preview (formerly also on this same dblclick) is still
	// reachable via double-clicking its content/box in the lane instead
	// (_buildStingerLane), so nothing is lost by repurposing this one.
	_buildStingerLabel(stinger) {
		const label = document.createElement("div");
		label.className = "layer-label";
		label.dataset.nodeId = stinger.id;
		label.style.height = `${this._rowHeight}px`;
		label.textContent = this._displayLabel(stinger, "Stinger");
		label.addEventListener("click", (e) => {
			e.stopPropagation();
			this._handleItemClick(stinger.id, e);
		});
		label.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			this._startAttributeEdit(label, stinger, "label", () => this._buildStingerLabel(stinger), "inline-rename-input", stinger.attributes.id || stinger.tagName);
		});
		return label;
	}

	// Swaps `displayEl` for an inline text input editing `node`'s own
	// `attrName` attribute — Enter/blur commits (writing the actual typed
	// value, even for an attribute that was showing an *inherited* value,
	// like a Section's tempo/timeSign — same "typing gives this element its
	// own explicit override" convention _renderInheritedControl already
	// uses in wa-node-inspector.js), Escape reverts. `rebuild()` recreates
	// the original display element either way. Used for a Layer/Stinger's
	// row-label, a Segment's box (all three write `label` — same attribute,
	// and same interaction, as wa-mixer-view.js's channel-strip rename;
	// _displayLabel already prefers `label` over id/src everywhere a name is
	// shown in this view), and the transport bar's tempo/timeSign/id fields.
	_startAttributeEdit(displayEl, node, attrName, rebuild, inputClassName, placeholder) {
		const input = document.createElement("input");
		input.type = "text";
		input.className = inputClassName;
		input.value = node.attributes[attrName] || "";
		if (placeholder) input.placeholder = placeholder;
		displayEl.replaceWith(input);
		input.focus();
		input.select();

		let done = false;
		const commit = () => {
			if (done) return;
			done = true;
			const value = input.value.trim();
			if (value !== (node.attributes[attrName] || "")) {
				const nodeNow = ops.findNodeById(xmlStore.root, node.id);
				if (nodeNow) {
					const attrs = { ...nodeNow.attributes };
					if (value) attrs[attrName] = value;
					else delete attrs[attrName];
					xmlStore.updateAttributes(nodeNow.id, attrs);
					return; // the resulting re-render replaces this input for us
				}
			}
			input.replaceWith(rebuild());
		};
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				done = true;
				input.replaceWith(rebuild());
			}
		});
		input.addEventListener("blur", commit);
		input.addEventListener("click", (e) => e.stopPropagation());
	}

	// tempo/timeSign inherit Composition -> Section (see readSectionInfo);
	// id is never inherited, just possibly absent. All three are shown here
	// and double-click-editable via _startAttributeEdit, per Hans
	// (2026-09-03).
	_renderTransportInfo(sectionNode, info) {
		this._infoEl.innerHTML = "";
		this._infoEl.appendChild(this._buildInfoField(sectionNode, "tempo", String(info.tempo), "Double-click to change tempo"));
		this._infoEl.appendChild(document.createTextNode(" BPM · "));
		this._infoEl.appendChild(this._buildInfoField(sectionNode, "timeSign", info.timeSign.label, "Double-click to change time signature"));
		this._infoEl.appendChild(document.createTextNode(" · "));
		this._infoEl.appendChild(this._buildInfoField(sectionNode, "id", info.id, "Double-click to change this Section's id"));
	}

	_buildInfoField(sectionNode, attrName, displayValue, title) {
		const span = document.createElement("span");
		span.className = "tp-info-field";
		span.textContent = displayValue || "—";
		span.title = title;
		span.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			this._startAttributeEdit(span, sectionNode, attrName, () => this._buildInfoField(sectionNode, attrName, displayValue, title), "tp-info-input");
		});
		return span;
	}

	// Small clickable tags for a node's own <Command> children — the only
	// representation Command elements get anywhere in this view (they have no
	// timeline span of their own to render as a box). Selecting one here just
	// updates xmlStore's global selection like any other click; there's no
	// dedicated Command editor in this view, only the shared Inspector.
	_buildCommandMarks(node) {
		const commands = node.children.filter((c) => c.tagName === "Command");
		if (!commands.length) return null;
		const wrap = document.createElement("div");
		wrap.className = "command-marks";
		commands.forEach((cmd) => {
			const mark = document.createElement("span");
			mark.className = "command-mark";
			mark.dataset.nodeId = cmd.id;
			mark.title = this._displayLabel(cmd, "Command");
			mark.classList.toggle("selected", this._selectedIds.has(cmd.id));
			mark.addEventListener("click", (e) => {
				e.stopPropagation();
				this._handleItemClick(cmd.id, e);
			});
			wrap.appendChild(mark);
		});
		return wrap;
	}

	// Non-looping layers render their content once, at offset 0, and are
	// allowed to grow the overall timeline (a bare src's decoded duration is
	// the only source of length info we have for it up front). A layer with
	// a loopEnd instead tiles its WHOLE content (bare src, or its
	// segment/option children) every loopEnd seconds, only as many times
	// as needed to fill the timeline duration already established by
	// everything else — never open-ended. Later copies are appended later in
	// DOM order, so an audio tail past loopEnd or a segment with a
	// negative pos (an upbeat) naturally paints over the previous loop's
	// tail via normal stacking order, with no extra z-index bookkeeping.
	// Only the repeat tiles (i>=1) are dimmed (.loop-repeat) to mark them as
	// looped echoes — the i=0 original isn't, even where part of its own
	// content already extends past loopEnd: that content isn't itself a
	// loop repeat, it's just unreachable during looped playback, which is a
	// different thing worth seeing plainly rather than implying it repeats.
	_buildLayerLane(layer, sectionNode, compositionNode, info, totalWidth, totalDuration, token, rowsNeeded) {
		const lane = document.createElement("div");
		lane.className = "layer-lane";
		lane.style.height = `${this._rowHeight * rowsNeeded}px`;
		lane.style.minWidth = `${totalWidth}px`;

		const segments = getSegments(layer);
		const directOptions = getOptions(layer);
		const loopEnd = readEffectiveLoopEnd(layer, sectionNode, compositionNode, info);
		const laneHeight = this._rowHeight * rowsNeeded;

		const renderContentAt = (offsetSeconds, allowGrow, isRepeat) => {
			if (segments.length === 0 && directOptions.length === 0) {
				const srcAttr = findSrcAttribute(xmlStore.schema, layer);
				if (srcAttr) {
					this._renderWaveformOnly(lane, srcAttr.value, laneHeight, totalWidth, token, info, offsetSeconds, allowGrow, isRepeat);
				}
				return;
			}
			segments.forEach((segment) => this._renderSegmentBox(segment, lane, info, token, offsetSeconds, laneHeight, isRepeat));
			directOptions.forEach((option) =>
				lane.appendChild(
					this._renderTimedBox(option, info, token, "Option", offsetSeconds, { top: 2, height: laneHeight - 4 }, false, isRepeat)
				)
			);
		};

		if (loopEnd === null) {
			renderContentAt(0, true, false);
		} else {
			const repeatCount = Math.max(1, Math.ceil(totalDuration / loopEnd));
			for (let i = 0; i < repeatCount; i++) {
				renderContentAt(i * loopEnd, false, i > 0);
			}

			lane.appendChild(this._buildLoopMarker(layer, loopEnd, info, laneHeight, lane));
		}

		const ghost = document.createElement("div");
		ghost.className = "segment-ghost";
		ghost.style.top = "2px";
		ghost.style.height = `${laneHeight - 4}px`;
		lane.appendChild(ghost);

		this._wireLaneDropTarget(lane, layer, info, ghost);
		lane.addEventListener("click", (e) => {
			if (e.target === lane) this._clearSelection();
		});
		// Double-click sets this Layer's own loopEnd to the clicked position
		// (snapped to the same beat grid the loop marker's own drag uses),
		// per Hans (2026-09-02) — same write as dragging the marker itself,
		// just a faster way to place it at a specific spot.
		lane.addEventListener("dblclick", (e) => {
			const laneRect = lane.getBoundingClientRect();
			const rawSeconds = this._pxToTime(e.clientX - laneRect.left + lane.scrollLeft, info);
			const gridBeats = this._effectiveGridBeats(info) || 1;
			const beatCount = Math.max(1, Math.round(rawSeconds / info.beatDuration / gridBeats) * gridBeats);
			const seconds = beatCount * info.beatDuration;
			const layerNow = ops.findNodeById(xmlStore.root, layer.id);
			if (layerNow) {
				xmlStore.updateAttributes(layer.id, { ...layerNow.attributes, loopEnd: secondsToPosString(seconds, info, gridBeats) });
			}
		});

		return lane;
	}

	// The repeat-sign marker at a looping Layer's loop boundary — draggable
	// horizontally (pointer capture, not HTML5 DnD: this is a plain "drag
	// along one axis to change one number" interaction, not a drop onto
	// anything) to change that Layer's own loopEnd, snapped to the same
	// beat grid Segment dragging uses. Always writes an explicit loopEnd
	// onto this Layer, even if the value being displayed/dragged was
	// inherited from its Section/Composition — dragging is how you give one
	// specific Layer its own override. Written as a musical position
	// (bar.beat.offbeat, via secondsToPosString) rather than a length, per
	// Hans (2026-09-02) — matches loopEnd's own schema type.
	_buildLoopMarker(layer, loopEndSeconds, info, laneHeight, lane) {
		const marker = document.createElement("div");
		marker.className = "loop-marker";
		marker.title = "Drag to change this Layer's loop end";
		marker.style.left = `${this._timeToPx(loopEndSeconds, info)}px`;
		marker.style.height = `${laneHeight}px`;
		marker.appendChild(document.createElement("span")).className = "loop-marker-dot dot-top";
		marker.appendChild(document.createElement("span")).className = "loop-marker-dot dot-bottom";
		marker.appendChild(document.createElement("span")).className = "loop-marker-bar thin";
		marker.appendChild(document.createElement("span")).className = "loop-marker-bar thick";

		marker.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			try {
				marker.setPointerCapture(e.pointerId);
			} catch {}
			let pendingSeconds = loopEndSeconds;

			const onMove = (moveEvt) => {
				const laneRect = lane.getBoundingClientRect();
				const rawSeconds = this._pxToTime(moveEvt.clientX - laneRect.left + lane.scrollLeft, info);
				const gridBeats = this._effectiveGridBeats(info) || 1;
				const beatCount = Math.max(1, Math.round(rawSeconds / info.beatDuration / gridBeats) * gridBeats);
				pendingSeconds = beatCount * info.beatDuration;
				marker.style.left = `${this._timeToPx(pendingSeconds, info)}px`;
			};
			const onUp = () => {
				marker.removeEventListener("pointermove", onMove);
				marker.removeEventListener("pointerup", onUp);
				if (pendingSeconds === loopEndSeconds) return;
				const layerNow = ops.findNodeById(xmlStore.root, layer.id);
				if (layerNow) {
					const gridBeats = this._effectiveGridBeats(info);
					xmlStore.updateAttributes(layer.id, { ...layerNow.attributes, loopEnd: secondsToPosString(pendingSeconds, info, gridBeats) });
				}
			};
			marker.addEventListener("pointermove", onMove);
			marker.addEventListener("pointerup", onUp);
		});

		return marker;
	}

	// A bare layer src with no segments: one continuous waveform, as wide as
	// the decoded file actually is (schema gives layers no pos/length of
	// their own). offsetSeconds shifts a looped copy into place; allowGrow is
	// false for those copies since a looping layer must fill existing bounds
	// rather than extend them (only the first/non-looping placement can grow
	// the timeline).
	_renderWaveformOnly(lane, rawSrc, heightPx, laneWidth, token, info, offsetSeconds = 0, allowGrow = true, isRepeat = false) {
		const resolvedUrl = resolvePlayableUrl(rawSrc);
		if (!resolvedUrl) return null;

		const offsetPx = this._timeToPx(offsetSeconds, info);
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(laneWidth - offsetPx, 1);
		canvas.height = heightPx;
		canvas.style.position = "absolute";
		canvas.style.left = `${offsetPx}px`;
		canvas.style.top = "0";
		if (isRepeat) canvas.classList.add("loop-repeat");
		lane.appendChild(canvas);

		this._decode(resolvedUrl).then((buffer) => {
			if (token !== this._renderToken || !buffer) return;
			const durationPx = buffer.duration * this._pxPerSecond;
			canvas.width = Math.max(durationPx, 1);
			canvas.style.width = `${durationPx}px`;
			drawWaveform(canvas, buffer, WAVEFORM_COLOR);
			if (allowGrow) this._growTimelineTo(offsetSeconds + buffer.duration);
		});
		return canvas;
	}

	// A <Segment> is either a single compact box (closed, or nothing to open)
	// spanning the whole lane height, or — while "open" via its disclosure
	// triangle — expands into one full-width row per <Option> child, each
	// independently positioned/selectable/draggable. A closed Segment's box is
	// itself draggable (moves the whole Segment); an open Segment gets a
	// small grip handle instead, since there's no single box left to grab. A
	// segment box (or an open segment's first row) is still a valid file/
	// option drop target when it has no Options of its own (its own src gets
	// replaced, same as dropping onto an Option).
	//
	// A closed Segment isn't just a blank rectangle: its own waveform shows
	// if it has its own src (handled by _renderTimedBox already, same as any
	// other box), and each child Option renders nested inside it too — a
	// read-only preview (not separately selectable/draggable; that level of
	// detail is what opening the Segment is for) so you can see its actual
	// structure/content without having to open it first.
	_renderSegmentBox(segment, lane, info, token, extraOffsetSeconds, laneHeight, isRepeat = false) {
		const isOpen = this._openSegmentIds.has(segment.id);
		const options = getOptions(segment);

		if (!isOpen || options.length === 0) {
			const box = this._renderTimedBox(segment, info, token, "Segment", extraOffsetSeconds, { top: 2, height: laneHeight - 4 }, false, isRepeat);

			if (options.length > 0) {
				// A segment with no explicit length/src of its own only gets
				// the generic fallback-bar width from _renderTimedBox — grow
				// it to actually fit all its nested Options, or they'd render
				// past its right edge and get clipped away by overflow:hidden.
				if (segment.attributes.length === undefined) {
					const optionsEndSeconds = Math.max(...options.map((o) => readLength(o, info) ?? info.barDuration * FALLBACK_BOX_BARS));
					const currentWidthSeconds = parseFloat(box.style.width) / this._pxPerSecond;
					if (optionsEndSeconds > currentWidthSeconds) {
						box.style.width = `${optionsEndSeconds * this._pxPerSecond}px`;
					}
				}
				const rowHeight = (laneHeight - 4) / options.length;
				options.forEach((option, idx) => {
					this._renderNestedOption(box, option, info, token, 0, { top: idx * rowHeight, height: rowHeight });
				});
				box.appendChild(this._buildDisclosureButton(segment.id, true));
			}

			lane.appendChild(box);
			return;
		}

		// An <Option> inside a <Segment> has no `pos` of its own (unlike inside
		// a <Stinger>, where `upbeat` — not `pos` — does matter, per Hans: the
		// schema currently exposes `pos` for both but only the Stinger case
		// actually uses it, and he's tightening that up) — every Option here
		// plays at the same slot as its Segment, so all rows share that one x
		// position; only which row (i.e. which alternative) differs.
		options.forEach((option, idx) => {
			const box = this._renderTimedBox(
				option,
				info,
				token,
				"Option",
				extraOffsetSeconds + readPos(segment, info),
				{ top: idx * this._rowHeight + 2, height: this._rowHeight - 4 },
				true,
				isRepeat
			);
			if (idx === 0) box.appendChild(this._buildDisclosureButton(segment.id, false));
			lane.appendChild(box);
		});
		lane.appendChild(this._buildSegmentHandle(segment, info, extraOffsetSeconds, options.length));
	}

	// A read-only visual sub-box for one Option nested inside its Segment's
	// or Stinger's own (closed) box, sized/positioned relative to it (the
	// parent box, itself position:absolute, is the positioning context for
	// its children) rather than the lane's absolute timeline. pointer-
	// events:none so clicks/drags still land on the parent box itself,
	// keeping "closed Segment/Stinger = one draggable/selectable unit" true.
	// offsetSeconds is 0 for a Segment's Options (no pos of their own there,
	// see _renderSegmentBox) but real for a Stinger's (readStingerOffset —
	// upbeat/pos do apply per-Option there, additively with the Stinger's
	// own) — can legitimately go negative (an Option's own upbeat pulling it
	// earlier than its Stinger's base position), rendering left of the
	// parent box's own edge, which is fine now that .timed-box no longer
	// clips overflow (see the audio-tail fix).
	// layout ({top, height}) splits the parent box's vertical space between
	// however many Options it has — each gets an equal share (per Hans),
	// unlike an *open* Segment's rows, which are always the full row height
	// (that's a different, already-existing view — see _renderSegmentBox's
	// isOpen branch). interactive (Stinger only, per Hans — a Segment's
	// Options here stay a read-only preview) overrides the CSS default of
	// pointer-events:none so a drag on this element is actually reachable.
	_renderNestedOption(segmentBox, option, info, token, offsetSeconds, layout, interactive = false) {
		const explicitLength = readLength(option, info);
		const srcAttr = findSrcAttribute(xmlStore.schema, option);
		const resolvedUrl = srcAttr ? resolvePlayableUrl(srcAttr.value) : null;

		const nested = document.createElement("div");
		nested.className = "nested-option";
		nested.style.left = `${offsetSeconds * this._pxPerSecond}px`;
		nested.style.top = `${layout.top}px`;
		nested.style.height = `${layout.height}px`;
		if (interactive) nested.style.pointerEvents = "auto";

		const applyWidth = (seconds) => {
			nested.style.width = `${Math.max(seconds * this._pxPerSecond, 4)}px`;
		};
		applyWidth(explicitLength ?? info.barDuration * FALLBACK_BOX_BARS);
		segmentBox.appendChild(nested);

		if (!resolvedUrl) return nested;
		const canvas = document.createElement("canvas");
		nested.appendChild(canvas);
		this._decode(resolvedUrl).then((buffer) => {
			if (token !== this._renderToken || !buffer) return;
			// No explicit length -> this Option's box (and any audible tail
			// past its containing Segment's own quantized length) grows to
			// its real duration, same as a top-level box would.
			if (explicitLength === null) applyWidth(buffer.duration);
			canvas.width = Math.max(nested.offsetWidth, 1);
			canvas.height = Math.max(nested.offsetHeight, 1);
			drawWaveform(canvas, buffer, "#45b58c");
		});
		return nested;
	}

	// A thin grip at an open Segment's left edge, spanning all of its Option
	// rows — the only way to drag the whole Segment (with all its Options
	// together) once it's open, since the individual rows are their own drag
	// sources for reordering/moving single Options.
	_buildSegmentHandle(segment, info, extraOffsetSeconds, rowCount) {
		const pos = readPos(segment, info) + extraOffsetSeconds;
		const handle = document.createElement("div");
		handle.className = "segment-handle";
		handle.dataset.nodeId = segment.id;
		handle.title = "Drag to move this Segment";
		handle.textContent = "⋮⋮";
		handle.style.left = `${this._timeToPx(pos, info)}px`;
		handle.style.height = `${rowCount * this._rowHeight - 4}px`;
		handle.classList.toggle("selected", this._selectedIds.has(segment.id));
		handle.draggable = true;
		handle.addEventListener("dragstart", (e) => {
			e.stopPropagation();
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData(SEGMENT_DRAG_TYPE, segment.id);
			e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMAGE, 0, 0);
			const handleRect = handle.getBoundingClientRect();
			this._dragState = { kind: "Segment", nodeId: segment.id, grabOffsetSeconds: (e.clientX - handleRect.left) / this._pxPerSecond };
		});
		handle.addEventListener("dragend", () => {
			this._dragState = null;
		});
		handle.addEventListener("click", (e) => {
			e.stopPropagation();
			this._handleItemClick(segment.id, e);
		});
		return handle;
	}

	_buildDisclosureButton(segmentId, isCollapsed) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "disclosure";
		btn.title = "Show/hide this Segment's Options";
		btn.textContent = isCollapsed ? "▸" : "▾";
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (isCollapsed) this._openSegmentIds.add(segmentId);
			else this._openSegmentIds.delete(segmentId);
			const node = this._getActiveSectionNode();
			if (node) this._renderSection(node);
		});
		return btn;
	}

	// Renders one <Segment> or <Option> as a positioned box at an explicit
	// {top, height} within its container (the layer lane) — the caller
	// decides that layout (closed segment spans the full lane; an open
	// segment's options each get their own row; a layer's own direct option
	// spans the full lane). extraOffsetSeconds shifts a looped copy of the
	// containing layer into place. ignoreOwnPos is for an Option inside a
	// Segment (unlike a Layer's own *direct* Option): it has no `pos` of its
	// own there, so its box sits at exactly extraOffsetSeconds (its Segment's
	// own position) rather than adding a pos this element doesn't use.
	// isRepeat marks this as one of a looping Layer's repeat-tile echoes
	// (i>=1), dimmed to distinguish it from the original (i=0) content.
	_renderTimedBox(node, info, token, kind, extraOffsetSeconds, layout, ignoreOwnPos = false, isRepeat = false) {
		const pos = (ignoreOwnPos ? 0 : readPos(node, info)) + extraOffsetSeconds;
		const srcAttr = findSrcAttribute(xmlStore.schema, node);
		const resolvedUrl = srcAttr ? resolvePlayableUrl(srcAttr.value) : null;
		const explicitLength = readLength(node, info);

		const box = document.createElement("div");
		box.className = kind === "Option" ? "timed-box option-box" : "timed-box";
		if (isRepeat) box.classList.add("loop-repeat");
		box.dataset.nodeId = node.id;
		box.style.left = `${this._timeToPx(pos, info)}px`;
		box.style.top = `${layout.top}px`;
		box.style.height = `${layout.height}px`;
		box.classList.toggle("selected", this._selectedIds.has(node.id));

		const label = document.createElement("span");
		label.className = "box-label";
		label.textContent = this._displayLabel(node, kind);
		box.appendChild(label);

		const commandMarks = this._buildCommandMarks(node);
		if (commandMarks) box.appendChild(commandMarks);

		const applyWidth = (seconds) => {
			box.style.width = `${Math.max(seconds * this._pxPerSecond, 4)}px`;
		};
		applyWidth(explicitLength ?? info.barDuration * FALLBACK_BOX_BARS);

		if (resolvedUrl) {
			const canvas = document.createElement("canvas");
			box.appendChild(canvas);
			this._decode(resolvedUrl).then((buffer) => {
				if (token !== this._renderToken || !buffer) return;
				if (explicitLength === null) applyWidth(buffer.duration);
				canvas.width = Math.max(box.offsetWidth, 1);
				canvas.height = Math.max(box.offsetHeight, 1);
				drawWaveform(canvas, buffer, kind === "Option" ? "#45b58c" : WAVEFORM_COLOR);
			});
		}

		box.addEventListener("click", (e) => {
			e.stopPropagation();
			this._handleItemClick(node.id, e);
		});

		if (kind === "Option" || kind === "Segment") {
			const dragType = kind === "Option" ? OPTION_DRAG_TYPE : SEGMENT_DRAG_TYPE;
			box.draggable = true;
			box.addEventListener("dragstart", (e) => {
				e.stopPropagation();
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData(dragType, node.id);
				e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMAGE, 0, 0);
				const boxRect = box.getBoundingClientRect();
				this._dragState = { kind, nodeId: node.id, grabOffsetSeconds: (e.clientX - boxRect.left) / this._pxPerSecond };
			});
			box.addEventListener("dragend", () => {
				this._dragState = null;
			});
		}

		// A closed Segment's own length is resizable from its right edge, per
		// Hans (2026-09-02) — Options aren't (their box is either read-only
		// preview content inside an open Segment, or driven by the Segment's
		// own length when closed).
		if (kind === "Segment") {
			box.appendChild(this._buildSegmentResizeHandle(node, info, box));
			// Double-click renames the Segment (see _startAttributeEdit) — on
			// the box itself, not just .box-label, since that span is
			// pointer-events:none (see its CSS). stopPropagation keeps this
			// from also bubbling to the lane's own dblclick, which sets this
			// Layer's loopEnd (see _buildLayerLane) — per Hans (2026-09-03).
			box.addEventListener("dblclick", (e) => {
				e.stopPropagation();
				const labelEl = box.querySelector(".box-label");
				if (!labelEl) return;
				this._startAttributeEdit(labelEl, node, "label", () => {
					const rebuilt = document.createElement("span");
					rebuilt.className = "box-label";
					rebuilt.textContent = this._displayLabel(node, kind);
					return rebuilt;
				}, "box-label-input", node.attributes.id || node.tagName);
			});
		}

		this._wireBoxDropTarget(box, node, kind, info);

		return box;
	}

	// A grip at a closed Segment's right edge — drag to change its own
	// `length`, snapped to the same beat grid other drags use (see
	// _buildLoopMarker). Positioned via CSS right:0 so it tracks the box's
	// current width even when that width was grown after the fact to fit
	// nested Options (_renderSegmentBox's own post-hoc width bump).
	_buildSegmentResizeHandle(segment, info, box) {
		const handle = document.createElement("div");
		handle.className = "segment-resize-handle";
		handle.title = "Drag to change this Segment's length";
		// The parent box is itself draggable (native HTML5 DnD, for moving
		// the whole Segment) — without this, a mousedown here would be
		// picked up as the start of *that* drag instead of this one.
		handle.draggable = false;
		handle.addEventListener("click", (e) => e.stopPropagation());

		handle.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			try {
				handle.setPointerCapture(e.pointerId);
			} catch {}
			const gridBeats = this._effectiveGridBeats(info) || 1;
			let pendingSeconds = parseFloat(box.style.width) / this._pxPerSecond;

			const onMove = (moveEvt) => {
				const boxRect = box.getBoundingClientRect();
				const rawSeconds = (moveEvt.clientX - boxRect.left) / this._pxPerSecond;
				const beatCount = Math.max(1, Math.round(rawSeconds / info.beatDuration / gridBeats) * gridBeats);
				pendingSeconds = Math.max(info.beatDuration * gridBeats, beatCount * info.beatDuration);
				box.style.width = `${pendingSeconds * this._pxPerSecond}px`;
			};
			const onUp = () => {
				handle.removeEventListener("pointermove", onMove);
				handle.removeEventListener("pointerup", onUp);
				const segmentNow = ops.findNodeById(xmlStore.root, segment.id);
				if (segmentNow) {
					xmlStore.updateAttributes(segment.id, { ...segmentNow.attributes, length: secondsToLengthString(pendingSeconds) });
				}
			};
			handle.addEventListener("pointermove", onMove);
			handle.addEventListener("pointerup", onUp);
		});

		return handle;
	}

	// True for anything that resolves to a playable audio file on drop: a
	// file already in the VFS (dragged from File Manager), or a real OS-level
	// file drag (straight out of Finder) — see NATIVE_FILE_DRAG_TYPE.
	_isFileDrag(types) {
		return types.includes(VFS_FILE_DRAG_TYPE) || types.includes(NATIVE_FILE_DRAG_TYPE);
	}

	// Resolves a drop's dataTransfer to a VFS file id, only callable at drop
	// time (a native file drag's actual FileList isn't readable during
	// dragover). A file already in the VFS just returns its id; a real OS
	// file (or a batch of them, or a .zip) gets added to the VFS first —
	// exactly what dropping it directly onto File Manager would do — then
	// treated the same as if it had already been there. Returns the first
	// non-zip file's id (a .zip has no single "this is the dropped file" to
	// place in the Preview, so it's only imported, not used to create/replace
	// anything here).
	async _resolveDroppedFileId(dataTransfer) {
		const existingId = dataTransfer.getData(VFS_FILE_DRAG_TYPE);
		if (existingId) return existingId;

		let firstUploadedId = null;
		for (const file of dataTransfer.files) {
			if (file.name.toLowerCase().endsWith(".zip")) {
				await importZip(vfs, ROOT_ID, file);
				continue;
			}
			const node = vfs.uploadFile(ROOT_ID, file);
			if (!firstUploadedId) firstUploadedId = node.id;
		}
		return firstUploadedId;
	}

	// A Segment-without-options or an Option accepts a drop directly on it:
	// a file replaces its src; a dragged Option reparents alongside it
	// (same segment if `node` is an Option, or into `node` itself if it's a
	// bare Segment). stopPropagation keeps the lane's own "empty space"
	// handler (which creates a brand new Segment) from also firing. A
	// dragged Segment isn't handled here — it bubbles up to the lane, which
	// treats a drop anywhere on it (including on top of another box) as
	// "move to this x position".
	_wireBoxDropTarget(box, node, kind, info) {
		const isAcceptable = (types) => this._isFileDrag(types) || types.includes(OPTION_DRAG_TYPE);

		box.addEventListener("dragover", (e) => {
			const types = e.dataTransfer.types;
			if (!isAcceptable(types)) return;
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = this._isFileDrag(types) ? "copy" : "move";
			box.classList.add("drop-active");
		});
		box.addEventListener("dragleave", () => box.classList.remove("drop-active"));
		box.addEventListener("drop", async (e) => {
			const types = e.dataTransfer.types;
			if (!isAcceptable(types)) return;
			e.preventDefault();
			e.stopPropagation();
			box.classList.remove("drop-active");

			if (this._isFileDrag(types)) {
				const fileId = await this._resolveDroppedFileId(e.dataTransfer);
				if (!fileId) return;
				if (node.tagName === "Segment" || node.tagName === "Stinger") this._addOptionToContainer(node.id, fileId);
				else this._replaceBoxSrc(node.id, fileId);
				return;
			}

			const draggedOptionId = e.dataTransfer.getData(OPTION_DRAG_TYPE);
			if (!draggedOptionId || draggedOptionId === node.id) return;
			// Dropped on an Option -> insert just before it, in that Option's
			// Segment (this is what makes reordering within a Segment work,
			// not just moving an Option to a different one). Dropped on a
			// bare Segment (no Options) -> become its child.
			const targetParentId = kind === "Option" ? node.parent : node.id;
			const insertIndex = kind === "Option" ? this._insertIndexBefore(targetParentId, node.id, draggedOptionId) : undefined;
			xmlStore.reparentNode(draggedOptionId, targetParentId, insertIndex);
		});
	}

	// Index to pass to xmlStore.reparentNode so the dragged node lands
	// immediately before `targetId` within `parentId`'s children — accounting
	// for the fact that reparentNode removes the dragged node from the tree
	// (shifting later indices down by one) before reinserting it, which
	// matters when both nodes already share the same parent (a same-Segment
	// reorder).
	_insertIndexBefore(parentId, targetId, draggedId) {
		const parent = ops.findNodeById(xmlStore.root, parentId);
		if (!parent) return undefined;
		const rawIndex = parent.children.findIndex((c) => c.id === targetId);
		if (rawIndex === -1) return undefined;
		const draggedIndex = parent.children.findIndex((c) => c.id === draggedId);
		return draggedIndex !== -1 && draggedIndex < rawIndex ? rawIndex - 1 : rawIndex;
	}

	_replaceBoxSrc(nodeId, fileId) {
		const fileNode = vfs.getNode(fileId);
		if (!fileNode || fileNode.type !== "file") return;
		const exportPath = vfs.getExportPath(fileNode.id);
		const node = ops.findNodeById(xmlStore.root, nodeId);
		if (!node) return;
		const existing = findSrcAttribute(xmlStore.schema, node);
		const attrName = existing?.attrName || getSchemaSrcAttributeName(xmlStore.schema, node.tagName) || "src";
		xmlStore.updateAttributes(nodeId, { ...node.attributes, [attrName]: exportPath });
	}

	// Dropping a file onto a <Segment> or <Stinger> box adds it as a new
	// <Option> child instead of overwriting the container's own src
	// attribute — per Hans (2026-09-03). A container that already had its
	// own src (the "just one Option's worth of audio" shorthand) gets that
	// promoted to a real <Option> first, so the audio it already had isn't
	// silently discarded — it ends up as the earlier of the two Options, the
	// newly dropped file the later one. This is specific to the Section
	// preview: dropping a file on a <Segment> row in the XML editor's tree
	// (wa-xml-tree.js) stays a plain src set there, per Hans.
	_addOptionToContainer(containerId, fileId) {
		const fileNode = vfs.getNode(fileId);
		if (!fileNode || fileNode.type !== "file") return;
		const exportPath = vfs.getExportPath(fileNode.id);
		const containerNode = ops.findNodeById(xmlStore.root, containerId);
		if (!containerNode) return;
		const optionSrcAttr = getSchemaSrcAttributeName(xmlStore.schema, "Option") || "src";
		const containerSrcAttr = getSchemaSrcAttributeName(xmlStore.schema, containerNode.tagName) || "src";
		const existingSrc = containerNode.attributes[containerSrcAttr];
		if (existingSrc !== undefined) {
			const next = { ...containerNode.attributes };
			delete next[containerSrcAttr];
			xmlStore.updateAttributes(containerId, next);
			xmlStore.insertNewChild(containerId, "Option", { [optionSrcAttr]: existingSrc });
		}
		xmlStore.insertNewChild(containerId, "Option", { [optionSrcAttr]: exportPath });
	}

	// Layer background (not hitting an existing Segment/Option box): a
	// dropped file creates a brand-new <Segment><Option src="..."/></Segment>
	// at the (quantized) drop position; a dragged Option gets reparented into
	// a brand-new Segment there instead, losing its own old pos (position="0"
	// relative to the new segment, i.e. omitted, means "right at its start");
	// a dragged Segment is repositioned (dropped on its own Layer) or moved
	// here entirely (dropped on a different Layer) via _moveSegment. A ghost
	// frame previews where/how-wide the resulting Segment will be, live,
	// throughout the drag.
	_wireLaneDropTarget(lane, layer, info, ghost) {
		const isAcceptable = (types) => this._isFileDrag(types) || types.includes(OPTION_DRAG_TYPE) || types.includes(SEGMENT_DRAG_TYPE);

		lane.addEventListener("dragover", (e) => {
			const types = e.dataTransfer.types;
			if (!isAcceptable(types)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = this._isFileDrag(types) ? "copy" : "move";
			lane.classList.add("drop-active");
			this._showGhost(ghost, e, lane, info);
		});
		lane.addEventListener("dragleave", (e) => {
			if (e.target !== lane) return;
			lane.classList.remove("drop-active");
			this._hideGhost(ghost);
		});
		lane.addEventListener("drop", async (e) => {
			const types = e.dataTransfer.types;
			if (!isAcceptable(types)) return;
			e.preventDefault();
			lane.classList.remove("drop-active");
			this._hideGhost(ghost);

			const posString = this._dropPositionString(e, lane, info);

			const draggedSegmentId = e.dataTransfer.getData(SEGMENT_DRAG_TYPE);
			if (draggedSegmentId) {
				this._moveSegment(draggedSegmentId, layer.id, posString);
				return;
			}

			if (this._isFileDrag(types)) {
				const fileId = await this._resolveDroppedFileId(e.dataTransfer);
				if (fileId) await this._createSegmentWithOption(layer.id, posString, fileId, info);
				return;
			}

			const draggedOptionId = e.dataTransfer.getData(OPTION_DRAG_TYPE);
			if (!draggedOptionId) return;
			const segment = xmlStore.insertNewChild(layer.id, "Segment", { pos: posString });
			xmlStore.reparentNode(draggedOptionId, segment.id);
			this._stripPos(draggedOptionId);
		});
	}

	// Like _dropPositionString, but for a drop onto a Stinger's own row: the
	// resulting `pos` is relative to anchorSeconds (the Stinger's own
	// resolved position, e.g. basePos for an existing Stinger) rather than
	// an absolute Section-timeline position — matching how an Option's own
	// pos already stacks on top of its Stinger's anchor everywhere else in
	// this file. Unlike _dropPositionString there's no grab-offset case
	// (nothing is ever "re-grabbed" mid-drop here) and no pre-roll clamp —
	// a Stinger's own pos legitimately extends earlier than its anchor
	// (e.g. a leadin), so nothing here should cut that off.
	_stingerDropPositionString(e, referenceEl, anchorSeconds, info) {
		const rect = referenceEl.getBoundingClientRect();
		const rawSeconds = this._pxToTime(e.clientX - rect.left + referenceEl.scrollLeft, info);
		return secondsToPosString(rawSeconds - anchorSeconds, info, this._effectiveGridBeats(info));
	}

	_dropPositionString(e, referenceEl, info) {
		const rect = referenceEl.getBoundingClientRect();
		// Repositioning an existing Option/Segment (this._dragState set) keeps
		// the same offset from the cursor that existed when it was grabbed,
		// rather than snapping its left edge under the cursor — which is only
		// correct for creating a brand-new box (a file drag, or an Option
		// dropped somewhere new), where there's no prior grab point at all.
		const grabOffsetSeconds = this._dragState?.grabOffsetSeconds ?? 0;
		const rawSeconds = this._pxToTime(e.clientX - rect.left + referenceEl.scrollLeft, info) - grabOffsetSeconds;
		// A Segment can legitimately start before bar 1 (an upbeat for the
		// whole Layer) — clamp only to the pre-roll reserve, not to 0.
		const seconds = Math.max(-info.barDuration * PRE_ROLL_BARS, rawSeconds);
		return secondsToPosString(seconds, info, this._effectiveGridBeats(info));
	}

	// Width (in seconds) the ghost preview — and the real Segment that would
	// actually get created/moved right now — should show: an in-progress
	// Option/Segment drag keeps its own existing length (so the preview
	// matches what dropping it will really look like); a file dragged from
	// File Manager (vfsDragState, published by wa-file-manager since
	// dataTransfer's real data isn't readable until drop) uses that file's
	// actual decoded duration once available. A real OS/Finder file drag has
	// no way to know its duration before drop at all — browsers don't expose
	// dragged file content until then — so it (like anything not yet decoded)
	// falls back to the same default a brand-new Segment gets.
	_ghostWidthSeconds(info) {
		if (this._dragState) {
			const dragged = ops.findNodeById(xmlStore.root, this._dragState.nodeId);
			const len = dragged ? readLength(dragged, info) : null;
			if (len !== null) return len;
		} else if (vfsDragState.fileId) {
			const fileNode = vfs.getNode(vfsDragState.fileId);
			const url = fileNode && fileNode.type === "file" ? fileNode.sessionUrl : null;
			if (url) {
				this._decode(url); // ensures a decode is at least in flight/cached
				const resolved = this._resolvedBuffers.get(url);
				if (resolved) return resolved.duration;
			}
		}
		return info.barDuration * FALLBACK_BOX_BARS;
	}

	// Position the ghost using the exact same quantize-then-format-then-parse
	// round trip _dropPositionString/a real drop would use, so the preview
	// can never drift from where the Segment will actually land.
	_showGhost(ghost, e, referenceEl, info) {
		if (!ghost) return;
		const seconds = parsePosition(this._dropPositionString(e, referenceEl, info), info);
		ghost.style.left = `${this._timeToPx(seconds, info)}px`;
		ghost.style.width = `${Math.max(this._ghostWidthSeconds(info) * this._pxPerSecond, 4)}px`;
		ghost.style.display = "block";
	}

	_hideGhost(ghost) {
		if (ghost) ghost.style.display = "none";
	}

	// Repositions a Segment (horizontal drag) and/or moves it to a different
	// Layer (vertical drag) — both are just "set its pos, and its parent if
	// that changed", so one drop handler covers both per the same drag
	// gesture. A no-op drop (same Layer, same quantized position) skips the
	// edit entirely rather than firing a pointless "change".
	_moveSegment(segmentId, targetLayerId, posString) {
		const segment = ops.findNodeById(xmlStore.root, segmentId);
		if (!segment) return;
		if (segment.parent === targetLayerId && segment.attributes.pos === posString) return;
		if (segment.parent !== targetLayerId) {
			xmlStore.reparentNode(segmentId, targetLayerId);
		}
		xmlStore.updateAttributes(segmentId, { ...segment.attributes, pos: posString });
	}

	// The Option is left without its own explicit length, so it always plays/
	// renders at its real decoded duration — any part of that beyond the
	// Segment's own (quantized) length is what naturally shows as a tail past
	// the Segment's box (see _renderNestedOption/_renderTimedBox). The Segment
	// itself gets quantizeDroppedFileLength's rounded length once the file
	// has actually decoded; if decoding fails, it's left without an explicit
	// length too and just falls back to the usual 1-bar placeholder width.
	async _createSegmentWithOption(layerId, posString, fileId, info) {
		const fileNode = vfs.getNode(fileId);
		if (!fileNode || fileNode.type !== "file") return;
		const exportPath = vfs.getExportPath(fileNode.id);
		const segment = xmlStore.insertNewChild(layerId, "Segment", { pos: posString });
		xmlStore.insertNewChild(segment.id, "Option", { src: exportPath });

		const buffer = await this._decode(fileNode.sessionUrl);
		if (!buffer) return;
		const quantizedSeconds = quantizeDroppedFileLength(buffer.duration, info);
		const segmentNow = ops.findNodeById(xmlStore.root, segment.id);
		if (segmentNow) {
			xmlStore.updateAttributes(segment.id, { ...segmentNow.attributes, length: secondsToLengthString(quantizedSeconds) });
		}
	}

	_stripPos(nodeId) {
		const node = ops.findNodeById(xmlStore.root, nodeId);
		if (!node || node.attributes.pos === undefined) return;
		const next = { ...node.attributes };
		delete next.pos;
		xmlStore.updateAttributes(nodeId, next);
	}

	_clearSelection() {
		if (this._selectedIds.size === 0) return;
		this._selectedIds.clear();
		this._updateSelectionHighlight();
	}

	// Thin strips between (and above/below) layer rows — dropping a file, a
	// dragged Option, or a dragged Segment here creates a whole new <Layer>
	// at that vertical spot, with a new (or moved) Segment at the (quantized)
	// horizontal drop position. The strip below the very last real Layer is
	// special-cased ("isLast"): while something valid hovers over it, it
	// grows to a full row and gets a faint border + "Layer" label, previewing
	// the Layer that dropping now would create, instead of staying a
	// barely-visible sliver the way the above/between strips do.
	_buildDropZone(sectionNode, layers, zoneIndex, info, totalWidth, filler) {
		const isLast = zoneIndex === layers.length;
		// The section's very first (only) row reserves full row height
		// permanently, not just while something's being dragged over it —
		// same reserved-space rule as the Stinger area's own empty state
		// (see _buildStingerEmptyDropzone), per Hans.
		const isOnlyRow = isLast && layers.length === 0;
		const zone = document.createElement("div");
		zone.className = isOnlyRow ? "dropzone preview-layer" : "dropzone";
		zone.style.minWidth = `${totalWidth}px`;
		zone.style.height = `${isOnlyRow ? this._rowHeight : DROPZONE_HEIGHT}px`;

		const ghost = document.createElement("div");
		ghost.className = "segment-ghost";
		zone.appendChild(ghost);

		if (isLast) filler.textContent = "Layer";
		if (isOnlyRow) filler.classList.add("preview-layer");

		const isAcceptable = (types) => this._isFileDrag(types) || types.includes(OPTION_DRAG_TYPE) || types.includes(SEGMENT_DRAG_TYPE);

		const setPreviewLayerActive = (active) => {
			if (!isLast) return;
			const expanded = active || isOnlyRow;
			zone.classList.toggle("preview-layer", expanded);
			filler.classList.toggle("preview-layer", expanded);
			zone.style.height = `${expanded ? this._rowHeight : DROPZONE_HEIGHT}px`;
		};

		zone.addEventListener("dragover", (e) => {
			const types = e.dataTransfer.types;
			if (!isAcceptable(types)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = this._isFileDrag(types) ? "copy" : "move";
			zone.classList.add("drop-active");
			setPreviewLayerActive(true);
			ghost.style.top = "2px";
			ghost.style.height = `${zone.clientHeight - 4}px`;
			this._showGhost(ghost, e, zone, info);
		});
		zone.addEventListener("dragleave", (e) => {
			if (e.target !== zone) return;
			zone.classList.remove("drop-active");
			setPreviewLayerActive(false);
			this._hideGhost(ghost);
		});
		zone.addEventListener("drop", async (e) => {
			const types = e.dataTransfer.types;
			if (!isAcceptable(types)) return;
			e.preventDefault();
			zone.classList.remove("drop-active");
			setPreviewLayerActive(false);
			this._hideGhost(ghost);

			const posString = this._dropPositionString(e, zone, info);
			const insertIndex = this._layerInsertIndex(sectionNode, layers, zoneIndex);

			const draggedSegmentId = e.dataTransfer.getData(SEGMENT_DRAG_TYPE);
			const draggedOptionId = e.dataTransfer.getData(OPTION_DRAG_TYPE);
			const fileId = this._isFileDrag(types) ? await this._resolveDroppedFileId(e.dataTransfer) : null;
			if (!draggedSegmentId && !draggedOptionId && !fileId) return; // e.g. a zip-only native drop

			const newLayer = xmlStore.insertNewChild(sectionNode.id, "Layer", {}, insertIndex);
			if (draggedSegmentId) {
				this._moveSegment(draggedSegmentId, newLayer.id, posString);
				return;
			}
			if (fileId) {
				await this._createSegmentWithOption(newLayer.id, posString, fileId, info);
				return;
			}
			const segment = xmlStore.insertNewChild(newLayer.id, "Segment", { pos: posString });
			xmlStore.reparentNode(draggedOptionId, segment.id);
			this._stripPos(draggedOptionId);
		});

		return zone;
	}

	_buildDropZoneFiller() {
		const filler = document.createElement("div");
		filler.className = "dropzone-filler";
		return filler;
	}

	_layerInsertIndex(sectionNode, layers, zoneIndex) {
		if (layers.length === 0) return sectionNode.children.length;
		if (zoneIndex === 0) return sectionNode.children.findIndex((c) => c.id === layers[0].id);
		const prevLayer = layers[zoneIndex - 1];
		return sectionNode.children.findIndex((c) => c.id === prevLayer.id) + 1;
	}

	_decode(url) {
		if (!this._bufferCache.has(url)) {
			this._bufferCache.set(
				url,
				decodeAudioBuffer(url, bridge.audioContext)
					.then((buffer) => {
						this._resolvedBuffers.set(url, buffer);
						return buffer;
					})
					.catch((err) => {
						console.warn("Section view: could not decode", url, err);
						return null;
					})
			);
		}
		return this._bufferCache.get(url);
	}
}

customElements.define("wa-section-view", WaSectionView);
