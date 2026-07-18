import { MarkEditor, type MarkEditorViewState } from "@mark/editor";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import "@mark/editor/styles.css";
import "./markFileEditor.css";

import {
  adoptExternalMarkEditorContents,
  initialMarkEditorDocumentState,
  markEditorDocumentId,
} from "./markFileEditorState";
import { setProjectFileQueryData } from "./projectFilesQueryState";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";

export interface MarkFileEditorSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  /** Authoritative file contents from the RPC file query (optimistic-aware). */
  readonly contents: string;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
}

/**
 * Markdown editing surface backed by Mark's live-preview editor.
 *
 * Persistence reuses the panel's existing plumbing: edits flow into the
 * optimistic project-file atom plus the debounced FileSaveCoordinator
 * (ProjectWriteFile RPC), identical to the code-editor surface. External
 * changes arriving through the file query remount the editor on a new
 * document revision while restoring cursor/scroll position.
 */
export default function MarkFileEditorSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  onPendingChange,
}: MarkFileEditorSurfaceProps) {
  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    onPendingChange,
  });
  const [documentState, setDocumentState] = useState(() =>
    initialMarkEditorDocumentState(contents),
  );
  // Last markdown the live editor produced (or was mounted with). When the
  // query contents diverge from it, the change happened outside this editor.
  const editorContentsRef = useRef(contents);
  const viewStateRef = useRef<MarkEditorViewState | null>(null);

  useEffect(() => {
    if (contents === editorContentsRef.current) return;
    editorContentsRef.current = contents;
    setDocumentState((current) => adoptExternalMarkEditorContents(current, contents));
  }, [contents]);

  const handleMarkdownChange = useCallback(
    (markdown: string) => {
      editorContentsRef.current = markdown;
      setProjectFileQueryData(environmentId, cwd, relativePath, markdown);
      saveCoordinator.change(markdown);
    },
    [cwd, environmentId, relativePath, saveCoordinator],
  );

  const handleViewStateChange = useCallback((viewState: MarkEditorViewState) => {
    viewStateRef.current = viewState;
  }, []);

  return (
    <div className="mark-file-editor min-h-0 min-w-0 flex-1 overflow-hidden">
      <MarkEditor
        documentId={markEditorDocumentId(cwd, relativePath, documentState.revision)}
        markdownSource={documentState.contents}
        initialViewState={viewStateRef.current}
        onMarkdownChange={handleMarkdownChange}
        onViewStateChange={handleViewStateChange}
      />
    </div>
  );
}
