// Custom dataTransfer MIME type used when dragging a file row out of
// wa-file-manager, so drop targets (wa-xml-tree) can tell it apart from a
// real OS file drag ("Files") and from an internal XML-tree node reorder
// drag ("text/plain" holding an XmlNode id).
export const VFS_FILE_DRAG_TYPE = "application/x-waw-vfs-file";

// dataTransfer.getData() only returns real values at "drop" — browsers keep
// drag data in a "protected mode" during dragenter/dragover for security, so
// a VFS_FILE_DRAG_TYPE drop target can't look up *which* file is hovering
// over it that way. wa-file-manager (the only source of this drag type)
// publishes the dragged file's id here for the duration of the drag, so a
// drop target's own dragover handler can still look it up eagerly — e.g. to
// preview a file's real decoded duration before it's actually dropped.
export const vfsDragState = { fileId: null };
