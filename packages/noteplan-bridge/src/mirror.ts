/**
 * Bidirectional mirror engine between a vault directory and a NotePlan-layout
 * directory.
 *
 * Mapping (see notes/04-noteplan-bridge/notes.md for rationale):
 *
 * - `<vault>/<dailyFolder>/YYYY-MM-DD.md` <-> `<notePlan>/Calendar/YYYYMMDD.md`
 * - `<vault>/<folder>/**` (for each configured mirror folder)
 *   <-> `<notePlan>/Notes/<notesFolder>/<folder>/**` — vault notes live in
 *   their own NotePlan namespace so they can never collide with existing
 *   NotePlan notes.
 *
 * Safety properties:
 *
 * - Unmapped NotePlan files (weekly/monthly notes, `@Trash`, `@Archive`,
 *   `_Archived Items`, any note outside the bridge namespace) are never read
 *   as pairs, never written, never deleted.
 * - Deletions are never propagated in either direction; the ledger records a
 *   tombstone instead so deleted files are not resurrected by the next pass.
 * - Dual edits resolve last-write-wins by mtime; the losing content is kept
 *   as `<name>.conflict-<stamp>.md` next to the vault file.
 * - The hash ledger makes passes idempotent: a pass that follows a completed
 *   pass performs no writes, so the watcher never re-ingests its own output.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import {
  contentHash,
  decideSyncAction,
  emptyLedger,
  parseLedger,
  stringifyLedger,
  type Ledger,
  type LedgerEntry,
  type PairTransforms,
  type SyncAction,
} from "./ledger.ts";
import { notePlanToVault, vaultToNotePlan } from "./mapping.ts";
import { calendarFileNameFromIsoDate, isoDateFromCalendarFileName } from "./notePlanFormat.ts";

export interface MirrorConfig {
  /** Obsidian reads this folder directly — no adapter needed on that side. */
  readonly vaultDir: string;
  /** Root of a NotePlan data layout (contains `Calendar/` and `Notes/`). */
  readonly notePlanDir: string;
  /** Vault folder holding `YYYY-MM-DD.md` daily notes. */
  readonly dailyFolder: string;
  /** Namespace under NotePlan `Notes/` owned by the bridge. */
  readonly notesFolder: string;
  /** Vault folders (relative) mirrored into `Notes/<notesFolder>/`. */
  readonly mirrorFolders: ReadonlyArray<string>;
  readonly ledgerPath: string;
}

export interface MirrorPair {
  /** Stable ledger key, e.g. `daily/2026-07-18` or `note/Projects/foo.md`. */
  readonly key: string;
  readonly vaultPath: string;
  readonly notePlanPath: string;
  /** ISO date for daily pairs, null for project notes. */
  readonly noteDate: string | null;
}

export interface PairResult {
  readonly key: string;
  readonly action: SyncAction["_tag"];
  readonly detail: string;
}

export interface SyncPassResult {
  readonly results: ReadonlyArray<PairResult>;
  /** Number of pairs that required a write (or would, in dry-run). */
  readonly writes: number;
}

const ISO_DAILY_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

const isConflictCopy = (name: string) => /\.conflict-[^/]*\.md$/.test(name);

const isMarkdown = (name: string) => name.endsWith(".md");

/** NotePlan folders the bridge must never map: `@Trash`, `@Archive`, `@Templates`, `_Archived Items`, ... */
const isReservedSegment = (segment: string) =>
  segment.startsWith("@") || segment.startsWith("_") || segment.startsWith(".");

const transformsFor = (pair: MirrorPair): PairTransforms => ({
  toNotePlan: (vaultContent) => vaultToNotePlan(vaultContent, pair.noteDate),
  toVault: (notePlanContent, previousVaultContent) =>
    notePlanToVault(notePlanContent, { noteDate: pair.noteDate, previousVaultContent }),
});

const listMarkdownFiles = Effect.fn("listMarkdownFiles")(function* (
  dir: string,
  options: { recursive: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(dir);
  if (!exists) {
    return [] as Array<string>;
  }
  const entries = yield* fs.readDirectory(dir, { recursive: options.recursive });
  const files: Array<string> = [];
  for (const entry of entries) {
    const segments = entry.split("/");
    if (segments.some(isReservedSegment)) {
      continue;
    }
    if (!isMarkdown(entry) || isConflictCopy(entry)) {
      continue;
    }
    files.push(entry);
  }
  return files;
});

/** Enumerate every mapped pair (union of both sides; existence checked later). */
export const enumeratePairs = Effect.fn("enumeratePairs")(function* (config: MirrorConfig) {
  const path = yield* Path.Path;
  const pairs = new Map<string, MirrorPair>();

  const addDaily = (isoDate: string) => {
    const key = `daily/${isoDate}`;
    if (pairs.has(key)) {
      return;
    }
    const calendarName = calendarFileNameFromIsoDate(isoDate);
    if (calendarName === null) {
      return;
    }
    pairs.set(key, {
      key,
      vaultPath: path.join(config.vaultDir, config.dailyFolder, `${isoDate}.md`),
      notePlanPath: path.join(config.notePlanDir, "Calendar", calendarName),
      noteDate: isoDate,
    });
  };

  const addNote = (relative: string) => {
    const key = `note/${relative}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        key,
        vaultPath: path.join(config.vaultDir, relative),
        notePlanPath: path.join(config.notePlanDir, "Notes", config.notesFolder, relative),
        noteDate: null,
      });
    }
  };

  // Daily notes, vault side.
  const vaultDailyDir = path.join(config.vaultDir, config.dailyFolder);
  for (const name of yield* listMarkdownFiles(vaultDailyDir, { recursive: false })) {
    const match = ISO_DAILY_RE.exec(name);
    if (match !== null) {
      addDaily(match[1] as string);
    }
  }

  // Daily notes, NotePlan side. Weekly (`YYYY-Wnn.md`) and monthly
  // (`YYYY-MM.md`) files do not match the 8-digit daily pattern and are
  // therefore never mapped.
  const calendarDir = path.join(config.notePlanDir, "Calendar");
  for (const name of yield* listMarkdownFiles(calendarDir, { recursive: false })) {
    const isoDate = isoDateFromCalendarFileName(name);
    if (isoDate !== null) {
      addDaily(isoDate);
    }
  }

  // Project notes, vault side.
  for (const folder of config.mirrorFolders) {
    const dir = path.join(config.vaultDir, folder);
    for (const name of yield* listMarkdownFiles(dir, { recursive: true })) {
      addNote(`${folder}/${name}`);
    }
  }

  // Project notes, NotePlan side (only inside the bridge-owned namespace).
  const namespaceDir = path.join(config.notePlanDir, "Notes", config.notesFolder);
  for (const name of yield* listMarkdownFiles(namespaceDir, { recursive: true })) {
    addNote(name);
  }

  return Array.from(pairs.values()).sort((a, b) => (a.key < b.key ? -1 : 1));
});

const readOptional = Effect.fn("readOptional")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(filePath);
  if (!exists) {
    return { content: null, mtimeMs: 0 };
  }
  const content = yield* fs.readFileString(filePath);
  const info = yield* fs.stat(filePath);
  const mtimeMs = info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0;
  return { content, mtimeMs };
});

const writeFileEnsuringDir = Effect.fn("writeFileEnsuringDir")(function* (
  filePath: string,
  content: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, content);
});

export const loadLedger = Effect.fn("loadLedger")(function* (ledgerPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(ledgerPath);
  if (!exists) {
    return emptyLedger;
  }
  const json = yield* fs.readFileString(ledgerPath);
  return parseLedger(json);
});

export const saveLedger = Effect.fn("saveLedger")(function* (ledgerPath: string, ledger: Ledger) {
  yield* writeFileEnsuringDir(ledgerPath, stringifyLedger(ledger));
});

const conflictCopyPath = (path: Path.Path, vaultPath: string, now: DateTime.Utc): string => {
  const dir = path.dirname(vaultPath);
  const base = path.basename(vaultPath, ".md");
  const stamp = DateTime.formatIso(now).replace(/[:.]/g, "-");
  return path.join(dir, `${base}.conflict-${stamp}.md`);
};

/**
 * Run one sync pass over every mapped pair. Reads the ledger from disk,
 * executes the decided actions (unless `dryRun`), and persists the updated
 * ledger.
 */
export const syncPass = Effect.fn("syncPass")(function* (
  config: MirrorConfig,
  options?: { readonly dryRun?: boolean },
) {
  const path = yield* Path.Path;
  const dryRun = options?.dryRun ?? false;
  const ledger = yield* loadLedger(config.ledgerPath);
  const entries: Record<string, LedgerEntry> = { ...ledger.entries };
  const pairs = yield* enumeratePairs(config);
  const results: Array<PairResult> = [];
  let writes = 0;
  const now = yield* DateTime.now;
  const syncedAt = DateTime.formatIso(now);

  // Also visit ledgered pairs whose files disappeared on both sides.
  const pairKeys = new Set(pairs.map((pair) => pair.key));
  for (const key of Object.keys(entries)) {
    if (!pairKeys.has(key)) {
      delete entries[key];
    }
  }

  for (const pair of pairs) {
    const vault = yield* readOptional(pair.vaultPath);
    const notePlan = yield* readOptional(pair.notePlanPath);
    const action = decideSyncAction(
      {
        vaultContent: vault.content,
        notePlanContent: notePlan.content,
        vaultMtimeMs: vault.mtimeMs,
        notePlanMtimeMs: notePlan.mtimeMs,
        entry: entries[pair.key] ?? null,
      },
      transformsFor(pair),
    );

    const record = (vaultContent: string | null, notePlanContent: string | null) => {
      entries[pair.key] = {
        vaultHash: vaultContent === null ? null : contentHash(vaultContent),
        notePlanHash: notePlanContent === null ? null : contentHash(notePlanContent),
        syncedAt,
      };
    };

    switch (action._tag) {
      case "Noop": {
        break;
      }
      case "UpdateLedger": {
        record(vault.content, notePlan.content);
        break;
      }
      case "WriteNotePlan": {
        writes += 1;
        if (!dryRun) {
          yield* writeFileEnsuringDir(pair.notePlanPath, action.content);
          record(vault.content, action.content);
        }
        break;
      }
      case "WriteVault": {
        writes += 1;
        if (!dryRun) {
          yield* writeFileEnsuringDir(pair.vaultPath, action.content);
          record(action.content, notePlan.content);
        }
        break;
      }
      case "Conflict": {
        writes += 1;
        if (!dryRun) {
          yield* writeFileEnsuringDir(
            conflictCopyPath(path, pair.vaultPath, now),
            action.conflictCopy,
          );
          if (action.write.side === "vault") {
            yield* writeFileEnsuringDir(pair.vaultPath, action.write.content);
            record(action.write.content, notePlan.content);
          } else {
            yield* writeFileEnsuringDir(pair.notePlanPath, action.write.content);
            record(vault.content, action.write.content);
          }
        }
        break;
      }
      case "RecordVaultDeletion": {
        if (!dryRun) {
          record(null, notePlan.content);
        }
        break;
      }
      case "RecordNotePlanDeletion": {
        if (!dryRun) {
          record(vault.content, null);
        }
        break;
      }
      case "Forget": {
        if (!dryRun) {
          delete entries[pair.key];
        }
        break;
      }
    }

    if (action._tag !== "Noop") {
      results.push({
        key: pair.key,
        action: action._tag,
        detail: action._tag === "Conflict" ? `winner=${action.winner}` : "",
      });
    }
  }

  if (!dryRun) {
    yield* saveLedger(config.ledgerPath, { version: 1, entries });
  }

  return { results, writes } satisfies SyncPassResult;
});

/**
 * Watch mode: run an initial pass, then re-run a pass after changes settle in
 * either tree. The hash ledger guarantees the pass triggered by our own
 * writes is a no-op, so watching cannot loop.
 */
export const watchLoop = Effect.fn("watchLoop")(function* (
  config: MirrorConfig,
  options?: {
    readonly debounceMillis?: number;
    readonly onPass?: (result: SyncPassResult) => Effect.Effect<void>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const onPass = options?.onPass ?? (() => Effect.void);

  const runPass = Effect.gen(function* () {
    const result = yield* syncPass(config);
    yield* onPass(result);
  });

  yield* runPass;

  const roots = [
    path.join(config.vaultDir, config.dailyFolder),
    ...config.mirrorFolders.map((folder) => path.join(config.vaultDir, folder)),
    path.join(config.notePlanDir, "Calendar"),
    path.join(config.notePlanDir, "Notes", config.notesFolder),
  ];

  const streams: Array<Stream.Stream<FileSystem.WatchEvent, PlatformError.PlatformError>> = [];
  for (const root of roots) {
    if (yield* fs.exists(root)) {
      streams.push(fs.watch(root));
    }
  }

  yield* Stream.mergeAll(streams, { concurrency: "unbounded" }).pipe(
    Stream.debounce(options?.debounceMillis ?? 500),
    Stream.runForEach(() => runPass),
  );
});
