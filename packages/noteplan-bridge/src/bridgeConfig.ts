/**
 * Bridge configuration. The bridge is DISABLED by default — Kota flips
 * `enabled: true` in `~/.apnatasks/noteplan-bridge.json` after reviewing a
 * dry run. Every path is configurable; the defaults match this machine.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type { MirrorConfig } from "./mirror.ts";

const home = (): string => process.env["HOME"] ?? "~";

export const defaultConfigPath = (): string => `${home()}/.apnatasks/noteplan-bridge.json`;

/**
 * Live NotePlan store on this machine (Setapp build; verified 2026-07-18).
 * The iCloud Drive folder only holds Backups/Logs here — the container is
 * authoritative.
 */
export const defaultNotePlanDir = (): string =>
  `${home()}/Library/Containers/co.noteplan.NotePlan-setapp/Data/Library/Application Support/co.noteplan.NotePlan-setapp`;

export class BridgeConfig extends Schema.Class<BridgeConfig>("BridgeConfig")({
  /** Master switch. The bridge refuses to write anything while false. */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.sync(() => false))),
  vaultDir: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.sync(() => `${home()}/Documents/Apna Vault`)),
  ),
  notePlanDir: Schema.String.pipe(Schema.withDecodingDefault(Effect.sync(defaultNotePlanDir))),
  dailyFolder: Schema.String.pipe(Schema.withDecodingDefault(Effect.sync(() => "Daily"))),
  notesFolder: Schema.String.pipe(Schema.withDecodingDefault(Effect.sync(() => "Apna"))),
  mirrorFolders: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => [])),
  ),
  ledgerPath: Schema.String.pipe(
    Schema.withDecodingDefault(
      Effect.sync(() => `${home()}/.apnatasks/noteplan-bridge/ledger.json`),
    ),
  ),
}) {}

export const toMirrorConfig = (config: BridgeConfig): MirrorConfig => ({
  vaultDir: config.vaultDir,
  notePlanDir: config.notePlanDir,
  dailyFolder: config.dailyFolder,
  notesFolder: config.notesFolder,
  mirrorFolders: config.mirrorFolders,
  ledgerPath: config.ledgerPath,
});

export const decodeBridgeConfig = Schema.decodeUnknownEffect(BridgeConfig);

const decodeBridgeConfigJson = Schema.decodeUnknownEffect(Schema.fromJsonString(BridgeConfig));

export const loadBridgeConfig = Effect.fn("loadBridgeConfig")(function* (configPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(configPath);
  if (!exists) {
    return yield* decodeBridgeConfig({});
  }
  const json = yield* fs.readFileString(configPath);
  return yield* decodeBridgeConfigJson(json);
});

/** Sample config written by `bridge init` — explicitly disabled. */
export const sampleConfigJson = (): string =>
  `${JSON.stringify(
    {
      enabled: false,
      vaultDir: `${home()}/Documents/Apna Vault`,
      notePlanDir: defaultNotePlanDir(),
      dailyFolder: "Daily",
      notesFolder: "Apna",
      mirrorFolders: [],
      ledgerPath: `${home()}/.apnatasks/noteplan-bridge/ledger.json`,
    },
    null,
    2,
  )}\n`;
