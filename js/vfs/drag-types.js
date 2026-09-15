// Custom dataTransfer MIME type used when dragging a file row out of
// wa-file-manager, so drop targets (wa-xml-tree) can tell it apart from a
// real OS file drag ("Files") and from an internal XML-tree node reorder
// drag ("text/plain" holding an XmlNode id).
export const VFS_FILE_DRAG_TYPE = "application/x-waw-vfs-file";

// The value under VFS_FILE_DRAG_TYPE is always a JSON-encoded array of VFS
// node ids now (per Hans, 2026-09-15: dragging a multi-selection of files out
// of wa-file-manager carries all of them, not just one) — getDraggedFileIds
// is the one place that decodes it, so every drop target (wa-file-manager's
// own folder-move, wa-xml-tree, wa-section-view) stays in sync automatically.
// Falls back to treating the raw string as a single bare id if it isn't
// valid JSON, in case anything ever sets this data type by hand instead of
// through wa-file-manager's own drag source.
export function getDraggedFileIds(dataTransfer) {
	const raw = dataTransfer.getData(VFS_FILE_DRAG_TYPE);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter(Boolean) : [raw];
	} catch {
		return [raw];
	}
}

// dataTransfer.getData() only returns real values at "drop" — browsers keep
// drag data in a "protected mode" during dragenter/dragover for security, so
// a VFS_FILE_DRAG_TYPE drop target can't look up *which* file(s) are
// hovering over it that way. wa-file-manager (the only source of this drag
// type) publishes the dragged file id(s) here for the duration of the drag,
// so a drop target's own dragover handler can still look them up eagerly —
// e.g. to preview a file's real decoded duration before it's actually
// dropped. `fileId` is always fileIds[0] (or null) — kept alongside for
// every existing single-file call site that only ever previewed the first
// one anyway.
export const vfsDragState = { fileId: null, fileIds: [] };
