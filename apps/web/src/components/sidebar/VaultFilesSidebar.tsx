import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { RotateCw } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjectEntriesQuery } from "../files/projectFilesQueryState";
import { T3_PIERRE_ICONS } from "../../pierre-icons";
import { Button } from "../ui/button";
import { InputGroup, InputGroupInput } from "../ui/input-group";
import { SidebarContent } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";

/**
 * The vault whose tree the sidebar shows. Hard-coded to the Life folder until
 * the vault-selection UI exists; the server expands `~` against its own home.
 */
const VAULT_CWD = "~/Documents/Life";
const VAULT_LABEL = "Life";

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

export default function VaultFilesSidebar() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="gap-0">
        {environmentId === null ? (
          <div className="p-4 text-xs leading-relaxed text-muted-foreground">
            Connecting to the environment…
          </div>
        ) : (
          <VaultFileTree environmentId={environmentId} />
        )}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function VaultFileTree({ environmentId }: { environmentId: EnvironmentId }) {
  const { resolvedTheme } = useTheme();
  const entriesQuery = useProjectEntriesQuery(environmentId, VAULT_CWD);
  const entries = entriesQuery.data?.entries ?? [];
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const previousTreePathsRef = useRef<readonly string[]>([]);

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: T3_PIERRE_ICONS,
    paths: [],
    search: false,
    unsafeCSS: TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const handleSearchValueChange = (value: string) => {
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };

  useEffect(() => {
    if (previousTreePathsRef.current === treePaths) return;
    previousTreePathsRef.current = treePaths;
    model.resetPaths(treePaths);
  }, [model, treePaths]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-vault-files-sidebar={VAULT_CWD}>
      <div className="flex shrink-0 items-center gap-1 px-2 py-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Refresh ${VAULT_LABEL} vault files`}
                onClick={entriesQuery.refresh}
              />
            }
          >
            <RotateCw className={cn(entriesQuery.isPending && "animate-spin")} />
          </TooltipTrigger>
          <TooltipPopup>{entriesQuery.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
        </Tooltip>
        <InputGroup variant="ghost" className="h-7 min-w-0 flex-1 rounded-md">
          <InputGroupInput
            type="search"
            name="vault-files-search"
            size="sm"
            value={search.value}
            aria-label={`Search ${VAULT_LABEL} vault files`}
            placeholder={`Search ${VAULT_LABEL} files`}
            spellCheck={false}
            onChange={(event) => handleSearchValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              search.close();
              event.currentTarget.blur();
            }}
          />
        </InputGroup>
      </div>
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{entriesQuery.error}</div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${VAULT_LABEL} vault files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={{
            colorScheme: resolvedTheme,
            ["--trees-fg-override" as string]: "var(--sidebar-foreground)",
          }}
        />
      )}
    </div>
  );
}
