import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { sha256Hex, type VaultManifest } from "@t3tools/vault-sync/manifest";
import { readSyncStatus } from "@t3tools/vault-sync/syncStatus";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { resolveServerConfig } from "./cli/config.ts";
import * as ServerConfig from "./config.ts";
import { staticAndDevRouteLayer } from "./http.ts";
import * as VaultReplica from "./vaultReplica.ts";

const emptyFlags = {
  mode: Option.none(),
  port: Option.none(),
  host: Option.none(),
  baseDir: Option.none(),
  cwd: Option.none(),
  devUrl: Option.none(),
  noBrowser: Option.none(),
  bootstrapFd: Option.none(),
  autoBootstrapProjectFromCwd: Option.none(),
  logWebSocketEvents: Option.none(),
  tailscaleServeEnabled: Option.none(),
  tailscaleServePort: Option.none(),
} as const;

const eventually = Effect.fn("vaultReplicaTest.eventually")(function* <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
  predicate: (value: Value) => boolean,
  description: string,
) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = yield* effect;
    if (predicate(value)) return value;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(`Timed out waiting for ${description}.`);
});

it.effect("restarts the vault watch after a defect and stops on interruption", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const restarted = yield* Deferred.make<void>();
      const watch = () =>
        Effect.gen(function* () {
          const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
          if (attempt < 3) return yield* Effect.die(`watch defect ${attempt}`);
          yield* Deferred.succeed(restarted, undefined);
          return yield* Effect.never;
        });

      const supervisor = yield* VaultReplica.superviseVaultWatch(watch, 0).pipe(Effect.forkScoped);
      yield* Deferred.await(restarted);
      assert.equal(yield* Ref.get(attempts), 3);

      yield* Fiber.interrupt(supervisor);
      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(attempts), 3);
    }),
  ),
);

it.layer(NodeServices.layer)("headless vault replica boot", (it) => {
  const makeVaultCloudStub = Effect.fn("vaultReplicaTest.makeVaultCloudStub")(function* (
    contents: Uint8Array,
  ) {
    const digest = sha256Hex(contents);
    const manifest: VaultManifest = {
      schema: 1,
      vaultId: "life",
      revision: "stub-revision-1",
      generatedAt: "2026-07-19T00:00:00.000Z",
      files: [
        {
          path: "notes/from-cloud.md",
          sha256: digest,
          size: contents.byteLength,
          mediaType: "text/markdown",
        },
      ],
    };
    let requestCount = 0;
    const countRequest = () => {
      requestCount += 1;
    };
    const routes = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/v1/vaults/life/manifest",
        Effect.sync(() => {
          countRequest();
          return HttpServerResponse.jsonUnsafe(manifest, {
            headers: { etag: '"stub-etag-1"' },
          });
        }),
      ),
      HttpRouter.add(
        "GET",
        `/v1/vaults/life/objects/${digest}`,
        Effect.sync(() => {
          countRequest();
          return HttpServerResponse.uint8Array(contents, { contentType: "text/markdown" });
        }),
      ),
    ).pipe(Layer.provide(HttpServer.layerServices));
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
    const fetchImpl = ((
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      if (input instanceof Request) return handler(new Request(input, init));
      return handler(new Request(input.toString(), init));
    }) as typeof globalThis.fetch;
    return { fetchImpl, requestCount: () => requestCount };
  });

  const resolveHeadlessConfig = (
    baseDir: string,
    staticDir: string,
    vaultEnv: Readonly<Record<string, string>> = {},
  ) =>
    resolveServerConfig(emptyFlags, Option.none(), {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }).pipe(
      Effect.map((config) => ({ ...config, port: 0, staticDir })),
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_HOME: baseDir,
                T3CODE_MODE: "web",
                T3CODE_HOST: "127.0.0.1",
                T3CODE_PORT: "3773",
                ...vaultEnv,
              },
            }),
          ),
          NetService.layer,
        ),
      ),
    );

  const withHeadlessApp = <Value, Error, Requirements>(
    config: ServerConfig.ServerConfig["Service"],
    fetchImpl: typeof globalThis.fetch,
    use: (
      handler: (request: Request) => Promise<Response>,
    ) => Effect.Effect<Value, Error, Requirements>,
  ) => {
    const fetchLayer = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const testFileSystem = {
        ...fs,
        watch: () => Stream.never,
      } satisfies FileSystem.FileSystem;
      const appLayer = Layer.mergeAll(staticAndDevRouteLayer, VaultReplica.layer).pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(fetchLayer),
        Layer.provide(Layer.succeed(FileSystem.FileSystem, testFileSystem)),
        Layer.provide(NodeServices.layer),
        Layer.provide(HttpServer.layerServices),
      );
      const context = Context.make(ServerConfig.ServerConfig, ServerConfig.make(config)).pipe(
        Context.add(FileSystem.FileSystem, testFileSystem),
        Context.add(Path.Path, path),
      );
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(appLayer, { disableLogger: true })),
        (app) => use((request) => app.handler(request, context)),
        (app) => Effect.promise(() => app.dispose()),
      );
    });
  };

  it.effect("boots headless, pulls the replica, and stays inactive without vault env", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configuredHome = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-headless-vault-home-",
      });
      const configuredRoot = path.join(configuredHome, "vault-replica");
      const unconfiguredHome = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-headless-no-vault-home-",
      });
      const inactiveRoot = path.join(unconfiguredHome, "unused-vault-replica");
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-headless-static-" });
      yield* fs.writeFileString(path.join(staticDir, "index.html"), "headless-server-ok");
      const contents = new TextEncoder().encode("# Pulled from the cloud\n");
      const cloud = yield* makeVaultCloudStub(contents);

      const configured = yield* resolveHeadlessConfig(configuredHome, staticDir, {
        APNA_VAULT_ROOT: configuredRoot,
        APNA_VAULT_ID: "life",
        APNA_VAULT_URL: "http://vault-cloud.test",
        APNA_VAULT_TOKEN: "test-vault-token",
      });
      yield* withHeadlessApp(configured, cloud.fetchImpl, (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(new Request("http://headless-server.test/")),
          );
          assert.equal(response.status, 200);
          assert.equal(yield* Effect.promise(() => response.text()), "headless-server-ok");

          const status = yield* eventually(
            readSyncStatus(configuredRoot),
            (value) => value?.state === "clean",
            "the startup vault pull",
          );
          assert.equal(status?.state, "clean");
          assert.equal(
            yield* fs.readFileString(path.join(configuredRoot, "notes", "from-cloud.md")),
            "# Pulled from the cloud\n",
          );
        }),
      );

      const requestsAfterConfiguredBoot = cloud.requestCount();
      assert.isAbove(requestsAfterConfiguredBoot, 0);
      const unconfigured = yield* resolveHeadlessConfig(unconfiguredHome, staticDir);
      yield* withHeadlessApp(unconfigured, cloud.fetchImpl, (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(new Request("http://headless-server.test/")),
          );
          assert.equal(response.status, 200);
          yield* Effect.yieldNow;
        }),
      );

      assert.equal(cloud.requestCount(), requestsAfterConfiguredBoot);
      assert.isFalse(yield* fs.exists(inactiveRoot));
    }),
  );
});
