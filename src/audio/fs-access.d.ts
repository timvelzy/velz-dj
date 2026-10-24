/**
 * Ambient declarations for the File System Access picker functions.
 *
 * TypeScript's DOM lib ships FileSystemWritableFileStream /
 * FileSystemFileHandle but not the Window picker methods (those live in
 * the WICG spec). Declare just the surface the recorder uses. This file
 * must NOT be imported — it's ambient.
 */

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
  excludeAcceptAllOption?: boolean;
}

interface Window {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
}
