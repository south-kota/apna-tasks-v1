import { sha256 as nobleSha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export const VAULT_MANIFEST_SCHEMA = 1 as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VAULT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const REVISION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,191}$/u;

const mediaTypes = new Map<string, string>([
  [".avif", "image/avif"],
  [".csv", "text/csv"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".markdown", "text/markdown"],
  [".md", "text/markdown"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
]);

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(nobleSha256(bytes));
}

export function isValidVaultId(vaultId: string): boolean {
  return VAULT_ID_PATTERN.test(vaultId);
}

export function isValidDigest(digest: string): boolean {
  return SHA256_PATTERN.test(digest);
}

/**
 * Normalizes a relative vault path to forward slashes, or returns `null` when
 * the path is empty, absolute, escapes the vault, or contains unsafe segments.
 */
export function normalizeVaultPath(input: string): string | null {
  if (input.length === 0 || input.length > 1_024 || input.includes("\0")) {
    return null;
  }
  const normalized = input.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }
  return segments.join("/");
}

export function mediaTypeForVaultPath(path: string): string | null {
  const normalized = normalizeVaultPath(path);
  if (normalized === null) return null;
  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex < 0) return null;
  return mediaTypes.get(normalized.slice(dotIndex).toLowerCase()) ?? null;
}

export function isSupportedVaultPath(path: string): boolean {
  return mediaTypeForVaultPath(path) !== null;
}

export const VaultId = Schema.String.check(Schema.isPattern(VAULT_ID_PATTERN));
export const Sha256Hex = Schema.String.check(Schema.isPattern(SHA256_PATTERN));

const vaultPathFilter = Schema.makeFilter(
  (path: string) =>
    normalizeVaultPath(path) === path || `Vault path must be normalized and safe: ${path}`,
);

const isoDateTimeFilter = Schema.makeFilter(
  (value: string) =>
    DateTime.make(value)._tag === "Some" || "generatedAt must be an ISO date-time string.",
);

export const VaultManifestEntry = Schema.Struct({
  path: Schema.String.check(vaultPathFilter),
  sha256: Sha256Hex,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  mediaType: Schema.String,
}).check(
  Schema.makeFilter(
    (entry: { readonly path: string; readonly mediaType: string }) =>
      mediaTypeForVaultPath(entry.path) === entry.mediaType ||
      `Manifest entry ${entry.path} has an unsupported path or mismatched media type.`,
  ),
);
export type VaultManifestEntry = typeof VaultManifestEntry.Type;

/** Deterministic, locale-independent path order shared by producers and validators. */
export function compareVaultPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const sortedUniquePathsFilter = Schema.makeFilter(
  (files: ReadonlyArray<{ readonly path: string }>) => {
    for (let index = 1; index < files.length; index += 1) {
      const previous = files[index - 1];
      const current = files[index];
      if (previous === undefined || current === undefined) continue;
      const order = compareVaultPaths(previous.path, current.path);
      if (order === 0) return `Duplicate manifest path: ${current.path}`;
      if (order > 0) return "Manifest files must be sorted by path.";
    }
    return true;
  },
);

export const VaultManifest = Schema.Struct({
  schema: Schema.Literal(VAULT_MANIFEST_SCHEMA),
  vaultId: VaultId,
  revision: Schema.String.check(Schema.isPattern(REVISION_PATTERN)),
  generatedAt: Schema.String.check(isoDateTimeFilter),
  files: Schema.Array(VaultManifestEntry).check(sortedUniquePathsFilter),
});
export type VaultManifest = typeof VaultManifest.Type;

/** JSON string codec for {@link VaultManifest} with stable pretty encoding. */
export const VaultManifestJson = fromJsonStringPretty(VaultManifest);

export const decodeManifestJson = Schema.decodeEffect(VaultManifestJson);
export const encodeManifestJson = Schema.encodeEffect(VaultManifestJson);
export const decodeManifestUnknown = Schema.decodeUnknownEffect(VaultManifest);

export function sameManifestContent(left: VaultManifest, right: VaultManifest): boolean {
  if (left.files.length !== right.files.length) return false;
  return left.files.every((entry, index) => {
    const other = right.files[index];
    return other !== undefined && other.path === entry.path && other.sha256 === entry.sha256;
  });
}

export function objectKey(vaultId: string, digest: string): string {
  if (!isValidVaultId(vaultId) || !isValidDigest(digest)) {
    throw new Error("Object key requires a valid vault id and lowercase SHA-256 digest.");
  }
  return `vaults/${vaultId}/objects/sha256/${digest.slice(0, 2)}/${digest}`;
}

export function manifestKey(vaultId: string): string {
  if (!isValidVaultId(vaultId)) {
    throw new Error("Manifest key requires a valid vault id.");
  }
  return `vaults/${vaultId}/manifest.json`;
}
