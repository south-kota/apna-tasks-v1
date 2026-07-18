/**
 * Hash ledger and the pure per-pair sync decision.
 *
 * The ledger records, per mapped file pair, the content hash of each side as
 * of the last completed sync. This is the bridge's loop protection: a file
 * whose hash still matches the ledger was last written (or last seen) by the
 * bridge itself, so the watcher never re-ingests its own output. A `null`
 * hash is a tombstone — the side is known deleted, and the surviving side is
 * not re-imported unless it changes again afterwards (deletions are never
 * propagated; NotePlan data is never deleted).
 */
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

export function contentHash(content: string): string {
  return NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export const LedgerEntrySchema = Schema.Struct({
  /** sha256 of the vault-side file at last sync; null = known deleted. */
  vaultHash: Schema.NullOr(Schema.String),
  /** sha256 of the NotePlan-side file at last sync; null = known deleted. */
  notePlanHash: Schema.NullOr(Schema.String),
  syncedAt: Schema.String,
});

export const LedgerSchema = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Record(Schema.String, LedgerEntrySchema),
});

/** Codec between the on-disk JSON string and the ledger value. */
export const LedgerFromJson = Schema.fromJsonString(LedgerSchema);

export type LedgerEntry = typeof LedgerEntrySchema.Type;
export type Ledger = typeof LedgerSchema.Type;

export const emptyLedger: Ledger = { version: 1, entries: {} };

const decodeLedgerJson = Schema.decodeUnknownSync(LedgerFromJson);
const encodeLedgerJson = Schema.encodeSync(LedgerFromJson);

export function parseLedger(json: string): Ledger {
  try {
    return decodeLedgerJson(json);
  } catch {
    // A corrupt ledger degrades to "never synced": the next pass re-derives
    // state from file contents without deleting anything.
    return emptyLedger;
  }
}

export function stringifyLedger(ledger: Ledger): string {
  return `${encodeLedgerJson(ledger)}\n`;
}

export interface PairTransforms {
  readonly toNotePlan: (vaultContent: string) => string;
  readonly toVault: (notePlanContent: string, previousVaultContent: string | null) => string;
}

export interface PairSnapshot {
  readonly vaultContent: string | null;
  readonly notePlanContent: string | null;
  readonly vaultMtimeMs: number;
  readonly notePlanMtimeMs: number;
  readonly entry: LedgerEntry | null;
}

export type SyncAction =
  | { readonly _tag: "Noop" }
  /** Both sides already consistent; just record hashes. */
  | { readonly _tag: "UpdateLedger" }
  | { readonly _tag: "WriteNotePlan"; readonly content: string }
  | { readonly _tag: "WriteVault"; readonly content: string }
  | {
      readonly _tag: "Conflict";
      readonly winner: "vault" | "notePlan";
      /** Losing content, already mapped to vault form, to save as a conflict copy in the vault. */
      readonly conflictCopy: string;
      /** Winner propagated to the other side. */
      readonly write: { readonly side: "vault" | "notePlan"; readonly content: string };
    }
  | { readonly _tag: "RecordVaultDeletion" }
  | { readonly _tag: "RecordNotePlanDeletion" }
  /** Both sides gone; drop the ledger entry. */
  | { readonly _tag: "Forget" };

/**
 * Decide what a sync pass must do for one mapped pair. Pure — all IO happens
 * in the mirror engine.
 */
export function decideSyncAction(snapshot: PairSnapshot, transforms: PairTransforms): SyncAction {
  const { entry, notePlanContent, vaultContent } = snapshot;
  const vaultHash = vaultContent === null ? null : contentHash(vaultContent);
  const notePlanHash = notePlanContent === null ? null : contentHash(notePlanContent);

  if (vaultContent === null && notePlanContent === null) {
    return entry === null ? { _tag: "Noop" } : { _tag: "Forget" };
  }

  const vaultChanged = entry === null ? vaultHash !== null : vaultHash !== entry.vaultHash;
  const notePlanChanged =
    entry === null ? notePlanHash !== null : notePlanHash !== entry.notePlanHash;

  if (!vaultChanged && !notePlanChanged) {
    return { _tag: "Noop" };
  }

  if (vaultChanged && !notePlanChanged) {
    if (vaultContent === null) {
      // Vault deletion: never delete NotePlan data; tombstone the vault side.
      return { _tag: "RecordVaultDeletion" };
    }
    const expected = transforms.toNotePlan(vaultContent);
    return expected === notePlanContent
      ? { _tag: "UpdateLedger" }
      : { _tag: "WriteNotePlan", content: expected };
  }

  if (notePlanChanged && !vaultChanged) {
    if (notePlanContent === null) {
      // NotePlan deletion: deletions are never propagated; tombstone it.
      return { _tag: "RecordNotePlanDeletion" };
    }
    const expected = transforms.toVault(notePlanContent, vaultContent);
    return expected === vaultContent
      ? { _tag: "UpdateLedger" }
      : { _tag: "WriteVault", content: expected };
  }

  // Both sides changed since the last sync.
  if (vaultContent === null) {
    // Vault deleted but NotePlan edited afterwards: the edit wins, revive in vault.
    return { _tag: "WriteVault", content: transforms.toVault(notePlanContent as string, null) };
  }
  if (notePlanContent === null) {
    // NotePlan deleted but vault edited afterwards: the edit wins, revive in NotePlan.
    return { _tag: "WriteNotePlan", content: transforms.toNotePlan(vaultContent) };
  }

  if (transforms.toNotePlan(vaultContent) === notePlanContent) {
    // Dual edit converged to consistent contents (e.g. first sync of an
    // already-mirrored pair): nothing to write.
    return { _tag: "UpdateLedger" };
  }

  // True dual-edit conflict: last write wins, loser is preserved as a
  // conflict copy in the vault (never inside NotePlan).
  if (snapshot.notePlanMtimeMs > snapshot.vaultMtimeMs) {
    return {
      _tag: "Conflict",
      winner: "notePlan",
      conflictCopy: vaultContent,
      write: { side: "vault", content: transforms.toVault(notePlanContent, vaultContent) },
    };
  }
  return {
    _tag: "Conflict",
    winner: "vault",
    conflictCopy: transforms.toVault(notePlanContent, vaultContent),
    write: { side: "notePlan", content: transforms.toNotePlan(vaultContent) },
  };
}
