// Where a published test lives, and the addresses to it. For now that is waxml.org (the viewer
// and the grading server of lti/ are uploaded there, the project zip goes in its public/
// folder — see lti/README.md); when the online service takes over, this is the one place
// that changes.

export const PUBLISH_BASE = "https://waxml.org/waw/";

// A project's file name as it may be used in an address (as Export for publishing requires).
export const isValidProjectName = (name) => /^[A-Za-z0-9._-]{1,120}$/.test(name);

// The address that opens a test (one Stage view of a published project) on its own.
export function testUrl(projectName, viewId) {
	return `${PUBLISH_BASE}viewer.html?project=${encodeURIComponent(`public/${projectName}.zip`)}&view=${encodeURIComponent(viewId)}`;
}

// The address to put in the learning platform's assignment (LTI launch): the platform signs
// the student in and the grading server judges the result.
export function launchUrl(projectName, viewId) {
	return `${PUBLISH_BASE}lti/launch.php?project=${encodeURIComponent(projectName)}&view=${encodeURIComponent(viewId)}`;
}
