/**
 * Document identity/state for the embedded Mark editor (@mark/editor).
 *
 * The underlying CodeMirror surface treats `markdownSource` as mount-time
 * input only: after mount the editor owns the document, and swapping to a
 * different document requires a `documentId` change (which remounts the
 * view). These helpers track when the authoritative file contents changed
 * *outside* the editor — an external edit landing through the RPC file
 * query — so the surface can adopt the new contents by bumping the
 * document revision, while self-originated edits (echoed back through the
 * optimistic file atom) leave the live editor untouched.
 */
export interface MarkEditorDocumentState {
  /** Bumped whenever contents changed externally; part of the documentId. */
  readonly revision: number;
  /** Contents the editor was (re)mounted with. */
  readonly contents: string;
}

export const initialMarkEditorDocumentState = (contents: string): MarkEditorDocumentState => ({
  revision: 0,
  contents,
});

/**
 * Adopt externally-changed contents. Returns the same state when the
 * incoming contents already match what the editor was mounted with.
 */
export function adoptExternalMarkEditorContents(
  current: MarkEditorDocumentState,
  contents: string,
): MarkEditorDocumentState {
  if (contents === current.contents) return current;
  return { revision: current.revision + 1, contents };
}

export const markEditorDocumentId = (cwd: string, relativePath: string, revision: number): string =>
  `${cwd}\u0000${relativePath}\u0000${revision}`;
