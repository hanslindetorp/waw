import { assessmentStore } from "../project/assessment-store.js";
import { requiredReads, evaluate } from "./evaluate.js";
import { collectValues } from "./collect.js";

// Runs the assessment of one Stage view against the document as it is now:
// measures the values it asks about and evaluates them. Returns
// { viewId, assessment, values, result } — or null when the view has no
// assessment. This is what the viewer's Done button and the author's test
// run both call; `values` are what a server would be sent to re-evaluate.
export function runAssessment(viewId) {
	const assessment = assessmentStore.get(viewId);
	if (!assessment) return null;
	const values = collectValues(requiredReads(assessment));
	return { viewId, assessment, values, result: evaluate(assessment, values) };
}
