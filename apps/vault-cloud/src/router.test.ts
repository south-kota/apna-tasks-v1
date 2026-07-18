import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { makeVaultCloudClient, ManifestPreconditionError } from "@t3tools/vault-sync/client";
import { encodeManifestJson } from "@t3tools/vault-sync/manifest";
import { pullVault, pushVault } from "@t3tools/vault-sync/sync";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { layerFs } from "./BlobStore.ts";
import { routesLayer, VaultCloudAuth } from "./router.ts";

const TEST_TOKEN = "test-token-For-router-tests";
const BASE_URL = "http://vault-cloud.test";

const testLayer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

it.layer(testLayer)("vault-cloud router", (it) => {
  /** Boots the full HTTP app on a temp data dir and returns an in-memory fetch. */
  const makeTestCloud = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "vault-cloud-data-" });
    const { handler, dispose } = HttpRouter.toWebHandler(
      routesLayer.pipe(
        Layer.provideMerge(VaultCloudAuth.layer(TEST_TOKEN)),
        Layer.provideMerge(layerFs(dataDir)),
        Layer.provide(NodeServices.layer),
        Layer.provide(HttpServer.layerServices),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      handler(new Request(input, init))) as typeof globalThis.fetch;
    const httpClient = yield* HttpClient.HttpClient;
    const client = makeVaultCloudClient({
      baseUrl: BASE_URL,
      token: Redacted.make(TEST_TOKEN),
      httpClient,
    });
    /** Routes every HttpClient request of `effect` into the in-memory app. */
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.provideService(effect, FetchHttpClient.Fetch, fetchImpl);
    return { client, run, fetchImpl };
  });

  it.effect("serves health and the web shell without auth, rejects bad tokens on the API", () =>
    Effect.gen(function* () {
      const cloud = yield* makeTestCloud;
      const health = yield* Effect.promise(() => cloud.fetchImpl(`${BASE_URL}/health`));
      assert.equal(health.status, 200);

      const shell = yield* Effect.promise(() => cloud.fetchImpl(`${BASE_URL}/`));
      assert.equal(shell.status, 200);
      assert.include(yield* Effect.promise(() => shell.text()), "Apna Vault");

      const noToken = yield* Effect.promise(() =>
        cloud.fetchImpl(`${BASE_URL}/v1/vaults/demo/manifest`),
      );
      assert.equal(noToken.status, 401);

      const wrongToken = yield* Effect.promise(() =>
        cloud.fetchImpl(`${BASE_URL}/v1/vaults/demo/manifest`, {
          headers: { authorization: "Bearer wrong" },
        }),
      );
      assert.equal(wrongToken.status, 401);
    }),
  );

  it.effect(
    "pushes a vault, wipes, pulls byte-identically, and serves files over the web API",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cloud = yield* makeTestCloud;
        const source = yield* fs.makeTempDirectoryScoped({ prefix: "vault-src-" });
        const restore = yield* fs.makeTempDirectoryScoped({ prefix: "vault-restore-" });
        const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 250]);
        yield* fs.makeDirectory(path.join(source, "notes"), { recursive: true });
        yield* fs.writeFileString(path.join(source, "notes", "hello.md"), "# Hello\n\n*Synced!*\n");
        yield* fs.writeFileString(path.join(source, "tasks.json"), '{"open":2}\n');
        yield* fs.writeFile(path.join(source, "pixel.png"), image);

        const pushed = yield* cloud.run(
          pushVault({
            root: source,
            vaultId: "demo",
            revision: "rev-1",
            generatedAt: "2026-07-18T03:00:00.000Z",
            client: cloud.client,
          }),
        );
        assert.equal(pushed.uploaded, 3);

        const pulled = yield* cloud.run(
          pullVault({ root: restore, vaultId: "demo", client: cloud.client }),
        );
        assert.equal(pulled.result.created.length, 3);
        assert.equal(
          yield* fs.readFileString(path.join(restore, "notes", "hello.md")),
          "# Hello\n\n*Synced!*\n",
        );
        assert.deepEqual(yield* fs.readFile(path.join(restore, "pixel.png")), image);

        const file = yield* Effect.promise(() =>
          cloud.fetchImpl(`${BASE_URL}/v1/vaults/demo/files/notes/hello.md`, {
            headers: { authorization: `Bearer ${TEST_TOKEN}` },
          }),
        );
        assert.equal(file.status, 200);
        assert.equal(file.headers.get("content-type"), "text/markdown");
        assert.equal(yield* Effect.promise(() => file.text()), "# Hello\n\n*Synced!*\n");

        const missing = yield* Effect.promise(() =>
          cloud.fetchImpl(`${BASE_URL}/v1/vaults/demo/files/nope.md`, {
            headers: { authorization: `Bearer ${TEST_TOKEN}` },
          }),
        );
        assert.equal(missing.status, 404);
      }),
  );

  it.effect("enforces conditional manifest updates and object digest integrity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cloud = yield* makeTestCloud;
      const source = yield* fs.makeTempDirectoryScoped({ prefix: "vault-src-" });
      yield* fs.writeFileString(path.join(source, "a.md"), "one\n");
      const pushed = yield* cloud.run(
        pushVault({
          root: source,
          vaultId: "demo",
          revision: "rev-1",
          generatedAt: "2026-07-18T03:00:00.000Z",
          client: cloud.client,
        }),
      );

      // Stale CAS: wrong etag is rejected with 412 -> ManifestPreconditionError.
      const stale = yield* cloud
        .run(cloud.client.putManifest(pushed.manifest, '"deadbeef"'))
        .pipe(Effect.flip);
      assert.instanceOf(stale, ManifestPreconditionError);

      // Creating over an existing manifest with If-None-Match: * is rejected.
      const overwrite = yield* cloud
        .run(cloud.client.putManifest(pushed.manifest, null))
        .pipe(Effect.flip);
      assert.instanceOf(overwrite, ManifestPreconditionError);

      // Unconditional PUT of a valid manifest is rejected (428).
      const manifestBody = yield* encodeManifestJson(pushed.manifest);
      const unconditional = yield* Effect.promise(() =>
        cloud.fetchImpl(`${BASE_URL}/v1/vaults/demo/manifest`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            "content-type": "application/json",
          },
          body: manifestBody,
        }),
      );
      assert.equal(unconditional.status, 428);

      // Malformed manifests are rejected before any precondition handling.
      const malformed = yield* Effect.promise(() =>
        cloud.fetchImpl(`${BASE_URL}/v1/vaults/demo/manifest`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      assert.equal(malformed.status, 400);

      // Uploading bytes that do not match the digest is rejected.
      const mismatch = yield* cloud
        .run(
          cloud.client.uploadObject(
            "demo",
            "0".repeat(64),
            new TextEncoder().encode("liar"),
            "text/plain",
          ),
        )
        .pipe(Effect.flip);
      assert.equal(mismatch.status, 400);
    }),
  );

  it.effect("propagates conflict copies through the HTTP stack", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cloud = yield* makeTestCloud;
      const macA = yield* fs.makeTempDirectoryScoped({ prefix: "vault-a-" });
      const macB = yield* fs.makeTempDirectoryScoped({ prefix: "vault-b-" });
      const push = (root: string, revision: string) =>
        cloud.run(
          pushVault({
            root,
            vaultId: "demo",
            revision,
            generatedAt: "2026-07-18T04:00:00.000Z",
            client: cloud.client,
          }),
        );
      yield* fs.writeFileString(path.join(macA, "note.md"), "base\n");
      yield* push(macA, "rev-1");
      yield* cloud.run(pullVault({ root: macB, vaultId: "demo", client: cloud.client }));

      yield* fs.writeFileString(path.join(macA, "note.md"), "A wins\n");
      yield* fs.writeFileString(path.join(macB, "note.md"), "B loses\n");
      yield* push(macA, "rev-2");

      const pulled = yield* cloud.run(
        pullVault({ root: macB, vaultId: "demo", client: cloud.client }),
      );
      assert.equal(pulled.result.conflicts.length, 1);
      assert.equal(yield* fs.readFileString(path.join(macB, "note.md")), "A wins\n");
      const copyPath = pulled.result.conflicts[0]!.localCopyPath;
      assert.equal(yield* fs.readFileString(path.join(macB, ...copyPath.split("/"))), "B loses\n");
    }),
  );
});
