import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { normalizeVaultPath } from "./manifest.ts";

export const VAULT_IGNORE_FILE = ".vaultignore";
/** Vault-local state directory. Holds sync state and conflict copies. */
export const VAULT_STATE_DIRECTORY = ".apnatasks";

const excludedDirectoryNames: ReadonlySet<string> = new Set([
  VAULT_STATE_DIRECTORY,
  ".cache",
  ".git",
  ".obsidian",
  ".vite-plus",
  "build",
  "dist",
  "node_modules",
]);

export interface VaultIgnoreRules {
  /** Entries without a slash, matched against any complete path segment. */
  readonly names: ReadonlySet<string>;
  /** Entries with a slash, matched as root-relative path prefixes. */
  readonly prefixes: ReadonlySet<string>;
}

const emptyVaultIgnoreRules: VaultIgnoreRules = {
  names: new Set(),
  prefixes: new Set(),
};

/** Parses the intentionally minimal line-oriented `.vaultignore` format. */
export function parseVaultIgnore(content: string): VaultIgnoreRules {
  const names = new Set<string>();
  const prefixes = new Set<string>();
  for (const line of content.split(/\r?\n/u)) {
    const entry = line.trim();
    if (entry.length === 0 || entry.startsWith("#")) continue;
    if (entry.includes("/")) prefixes.add(entry);
    else names.add(entry);
  }
  return { names, prefixes };
}

/** Reads the root ignore file. A missing file contributes no extra rules. */
export const loadVaultIgnore = Effect.fn("loadVaultIgnore")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ignorePath = path.join(root, VAULT_IGNORE_FILE);
  if (!(yield* fs.exists(ignorePath).pipe(Effect.orElseSucceed(() => false)))) {
    return emptyVaultIgnoreRules;
  }
  return parseVaultIgnore(yield* fs.readFileString(ignorePath));
});

function matchesNormalizedVaultIgnore(normalized: string, rules: VaultIgnoreRules): boolean {
  const segments = normalized.split("/");
  if (segments.some((segment) => rules.names.has(segment))) return true;
  for (const prefix of rules.prefixes) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/** Matches file-provided ignore rules only. */
export function matchesVaultIgnore(input: string, rules: VaultIgnoreRules): boolean {
  const normalized = normalizeVaultPath(input);
  return normalized !== null && matchesNormalizedVaultIgnore(normalized, rules);
}

/** Matches unsafe paths, built-in excluded directory names, and `.vaultignore` rules. */
export function isIgnoredVaultPath(
  input: string,
  rules: VaultIgnoreRules = emptyVaultIgnoreRules,
): boolean {
  const normalized = normalizeVaultPath(input);
  return (
    normalized === null ||
    normalized.split("/").some((segment) => excludedDirectoryNames.has(segment)) ||
    matchesNormalizedVaultIgnore(normalized, rules)
  );
}
