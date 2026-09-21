import "./wa-webcam-input.js";

// The INPUT panel's own content (see index.html's "inputPanel" <wa-panel>) —
// a thin vertical stack of collapsible "input channel" sections. Per Hans
// (2026-09-22): this will grow to also host MIDI, OSC, and External
// JavaScript sections later, each driving WAXML <Var>s live the same way
// wa-webcam-input.js does (via playerStore.setVariable) — this file only
// ever owns the section-list *layout*; each section owns and persists its
// own state (see workstation-state.js's own registerLayoutExtras, which
// reaches straight into wa-webcam-input.js, one shadow-DOM hop from here).
//
// Only one section exists today: Web Camera.

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: block;
		}
		.section {
			border-bottom: 1px solid var(--waw-border, #2f2f2f);
		}
		.section-header {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			padding: 0.5rem 0.75rem;
			font: 600 0.78rem/1.2 system-ui, sans-serif;
			cursor: pointer;
			user-select: none;
		}
		.section-header:hover {
			background: rgba(255, 255, 255, 0.03);
		}
		.section-disclosure {
			flex: 0 0 auto;
			color: var(--waw-muted, #8a8a8a);
			font-size: 0.65rem;
			transition: transform 0.1s;
		}
		.section.collapsed .section-disclosure {
			transform: rotate(-90deg);
		}
		.section-body {
			border-top: 1px solid var(--waw-border, #2f2f2f);
		}
		.section.collapsed .section-body {
			display: none;
		}
	</style>
	<div class="section" data-section="webcam">
		<div class="section-header">
			<span class="section-disclosure">▾</span>
			<span class="section-title">Web Camera</span>
		</div>
		<div class="section-body">
			<wa-webcam-input></wa-webcam-input>
		</div>
	</div>
`;

export class WaInputPanel extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
	}

	connectedCallback() {
		this.shadowRoot.querySelectorAll(".section").forEach((section) => {
			section.querySelector(".section-header").addEventListener("click", () => {
				section.classList.toggle("collapsed");
			});
		});
	}
}

customElements.define("wa-input-panel", WaInputPanel);
