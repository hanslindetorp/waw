// Placeholder for the "API" view (View menu) — Hans is describing the real
// design in a follow-up prompt; this just gives the View menu a real
// destination to switch to in the meantime, in the same shape (an always-
// mounted, hidden-until-selected element) the library view uses, so filling
// it in later is a drop-in job rather than new wiring.

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			display: flex;
			align-items: center;
			justify-content: center;
			flex: 1 1 auto;
			min-height: 0;
			background: var(--waw-bg, #121212);
		}
		:host([hidden]) {
			display: none;
		}
		.placeholder {
			text-align: center;
			color: var(--waw-muted, #8a8a8a);
			font: 0.9rem/1.5 system-ui, sans-serif;
		}
		.placeholder h2 {
			margin: 0 0 0.5rem;
			color: var(--waw-fg, #e8e8e8);
			font-size: 1.3rem;
		}
	</style>
	<div class="placeholder">
		<h2>API (DEMO)</h2>
		<p>Coming soon.</p>
	</div>
`;

export class WaApiView extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
	}
}

customElements.define("wa-api-view", WaApiView);
