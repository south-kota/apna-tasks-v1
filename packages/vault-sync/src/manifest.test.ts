import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  decodeManifestJson,
  encodeManifestJson,
  manifestKey,
  mediaTypeForVaultPath,
  normalizeVaultPath,
  objectKey,
  sameManifestContent,
  sha256Hex,
  VAULT_MANIFEST_SCHEMA,
  VaultManifest,
  type VaultManifestEntry,
} from "./manifest.ts";

const decodeManifest = Schema.decodeUnknownEffect(VaultManifest);

const entry = (path: string, digest: string): VaultManifestEntry => ({
  path,
  sha256: digest,
  size: 1,
  mediaType: mediaTypeForVaultPath(path) ?? "text/markdown",
});

const base = {
  schema: VAULT_MANIFEST_SCHEMA,
  vaultId: "test-vault",
  revision: "revision-1",
  generatedAt: "2026-07-18T00:00:00.000Z",
} as const;

describe("manifest", () => {
  it("normalizes safe paths and rejects unsafe ones", () => {
    assert.equal(normalizeVaultPath("notes\\daily\\a.md"), "notes/daily/a.md");
    assert.equal(normalizeVaultPath("a.md"), "a.md");
    assert.isNull(normalizeVaultPath("../escape.md"));
    assert.isNull(normalizeVaultPath("/absolute.md"));
    assert.isNull(normalizeVaultPath("nested/../up.md"));
    assert.isNull(normalizeVaultPath("nul\0.md"));
    assert.isNull(normalizeVaultPath(""));
  });

  it("maps media types from extensions and rejects unknown extensions", () => {
    assert.equal(mediaTypeForVaultPath("a.md"), "text/markdown");
    assert.equal(mediaTypeForVaultPath("a.JSON"), "application/json");
    assert.equal(mediaTypeForVaultPath("img/a.png"), "image/png");
    assert.equal(mediaTypeForVaultPath("a.yaml"), "application/yaml");
    assert.isNull(mediaTypeForVaultPath("a.exe"));
    assert.isNull(mediaTypeForVaultPath("noextension"));
  });

  it.effect("rejects traversal, duplicates, unsorted files, and bad hashes", () =>
    Effect.gen(function* () {
      const digest = "a".repeat(64);
      const cases: Array<unknown> = [
        { ...base, files: [entry("../secret.md", digest)] },
        { ...base, files: [{ path: "a.md", sha256: "bad", size: 1, mediaType: "text/markdown" }] },
        { ...base, files: [{ path: "a.exe", sha256: digest, size: 1, mediaType: "text/plain" }] },
        { ...base, files: [entry("a.md", digest), entry("a.md", "b".repeat(64))] },
        { ...base, files: [entry("b.md", digest), entry("a.md", digest)] },
        { ...base, vaultId: "../nope", files: [] },
        { ...base, generatedAt: "not-a-date", files: [] },
      ];
      for (const value of cases) {
        const exit = yield* decodeManifest(value).pipe(Effect.exit);
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it.effect("round-trips a valid manifest through pretty JSON", () =>
    Effect.gen(function* () {
      const digest = sha256Hex(new TextEncoder().encode("hello"));
      const manifest = yield* decodeManifest({
        ...base,
        files: [entry("a.md", digest), entry("b/c.json", digest)],
      });
      const encoded = yield* encodeManifestJson(manifest);
      assert.include(encoded, "\n");
      const decoded = yield* decodeManifestJson(encoded);
      assert.deepEqual(decoded, manifest);
      assert.isTrue(sameManifestContent(manifest, decoded));
    }),
  );

  it("builds namespaced object and manifest keys", () => {
    const digest = "ab".padEnd(64, "0");
    assert.equal(objectKey("v1", digest), `vaults/v1/objects/sha256/ab/${digest}`);
    assert.equal(manifestKey("v1"), "vaults/v1/manifest.json");
    assert.throws(() => objectKey("../v1", digest));
    assert.throws(() => objectKey("v1", "short"));
    assert.throws(() => manifestKey("bad/id"));
  });
});
