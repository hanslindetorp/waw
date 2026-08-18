// Custom dataTransfer MIME type used when dragging a file row out of
// wa-file-manager, so drop targets (wa-xml-tree) can tell it apart from a
// real OS file drag ("Files") and from an internal XML-tree node reorder
// drag ("text/plain" holding an XmlNode id).
export const VFS_FILE_DRAG_TYPE = "application/x-waw-vfs-file";
