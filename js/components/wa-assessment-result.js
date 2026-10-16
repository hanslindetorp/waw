// Shows the outcome of an assessment (see assessment/evaluate.js's result):
// the points, whether it counted as passed, the overall comment and one line
// per criterion. A modal over whatever page it is in — the viewer after
// Done, the editor after a test run. Closing it (or Escape) returns to the
// page.

const template = document.createElement("template");
template.innerHTML = `
	<style>
		:host {
			position: fixed;
			inset: 0;
			z-index: 200;
			display: flex;
			align-items: center;
			justify-content: center;
			background: rgba(0, 0, 0, 0.6);
			font: 0.9rem/1.45 system-ui, sans-serif;
			color: var(--waw-fg, #e8e8e8);
		}
		.card {
			width: min(30rem, 92vw);
			max-height: 86vh;
			overflow: auto;
			background: var(--waw-panel-bg, #1a1a1a);
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 10px;
			padding: 1.2rem 1.4rem;
			box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
		}
		.score {
			font-size: 2rem;
			font-weight: 700;
		}
		.score small {
			font-size: 1rem;
			font-weight: 400;
			color: var(--waw-muted, #8a8a8a);
		}
		.status {
			display: inline-block;
			margin-left: 0.6rem;
			padding: 0.1rem 0.5rem;
			border-radius: 4px;
			font-size: 0.78rem;
			font-weight: 600;
			vertical-align: middle;
		}
		.status.pass {
			background: rgba(69, 181, 140, 0.2);
			color: var(--waw-teal, #45b58c);
		}
		.status.fail {
			background: rgba(229, 72, 77, 0.2);
			color: var(--waw-danger, #e5484d);
		}
		.comment {
			margin: 0.7rem 0 1rem;
		}
		.criterion {
			margin: 0.45rem 0;
			font-size: 0.8rem;
		}
		.bar {
			height: 6px;
			margin-top: 0.2rem;
			background: #101010;
			border-radius: 3px;
			overflow: hidden;
		}
		.bar > div {
			height: 100%;
			background: var(--waw-accent, #4fa3ff);
		}
		.actions {
			margin-top: 1.1rem;
			text-align: right;
		}
		button {
			font: inherit;
			background: #2a2a2a;
			color: inherit;
			border: 1px solid var(--waw-border, #2f2f2f);
			border-radius: 5px;
			padding: 0.3rem 0.9rem;
			cursor: pointer;
		}
		button:hover {
			border-color: var(--waw-accent, #4fa3ff);
		}
	</style>
	<div class="card"></div>
`;

export class WaAssessmentResult extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.appendChild(template.content.cloneNode(true));
		this._card = this.shadowRoot.querySelector(".card");
		this._onKeyDown = (e) => {
			if (e.key === "Escape") this.close();
		};
	}

	connectedCallback() {
		document.addEventListener("keydown", this._onKeyDown);
		this.addEventListener("click", (e) => {
			if (e.target === this) this.close();
		});
	}

	disconnectedCallback() {
		document.removeEventListener("keydown", this._onKeyDown);
	}

	// `assessment` is only needed to know whether a pass level exists.
	show(result, assessment) {
		const card = this._card;
		card.innerHTML = "";
		const score = document.createElement("div");
		score.className = "score";
		score.textContent = String(result.score);
		const max = document.createElement("small");
		max.textContent = ` / ${result.max}`;
		score.appendChild(max);
		if (assessment && Number.isFinite(assessment.pass)) {
			const status = document.createElement("span");
			status.className = `status ${result.passed ? "pass" : "fail"}`;
			status.textContent = result.passed ? "Passed" : "Not passed";
			score.appendChild(status);
		}
		card.appendChild(score);
		if (result.comment) {
			const comment = document.createElement("div");
			comment.className = "comment";
			comment.textContent = result.comment;
			card.appendChild(comment);
		}
		const detail = result.criteria.filter((c) => c.text);
		detail.forEach((c) => {
			const row = document.createElement("div");
			row.className = "criterion";
			const label = document.createElement("div");
			label.textContent = c.text;
			const bar = document.createElement("div");
			bar.className = "bar";
			const fill = document.createElement("div");
			fill.style.width = `${Math.round(c.score * 100)}%`;
			bar.appendChild(fill);
			row.append(label, bar);
			card.appendChild(row);
		});
		const actions = document.createElement("div");
		actions.className = "actions";
		const close = document.createElement("button");
		close.type = "button";
		close.textContent = "Close";
		close.addEventListener("click", () => this.close());
		actions.appendChild(close);
		card.appendChild(actions);
		if (!this.isConnected) document.body.appendChild(this);
		close.focus();
	}

	close() {
		this.remove();
	}
}

customElements.define("wa-assessment-result", WaAssessmentResult);

export function showAssessmentResult(result, assessment) {
	const el = document.createElement("wa-assessment-result");
	document.body.appendChild(el);
	el.show(result, assessment);
}
