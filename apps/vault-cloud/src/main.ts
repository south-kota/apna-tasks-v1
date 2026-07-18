// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createServer } from "node:http";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import { BlobStore, layerFs, layerS3 } from "./BlobStore.ts";
import { routesLayer, VaultCloudAuth } from "./router.ts";

/**
 * Storage selection is pure configuration:
 * - `S3_ENDPOINT` set → any S3-compatible bucket (Railway bucket today;
 *   Cloudflare R2 later by swapping endpoint/keys/url-style).
 * - otherwise → filesystem under `DATA_DIR` (Railway volume or local dev).
 */
const blobStoreLayer = Layer.unwrap(
  Effect.gen(function* () {
    const endpoint = yield* Config.option(Config.url("S3_ENDPOINT"));
    let layer: Layer.Layer<
      BlobStore,
      never,
      HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
    >;
    if (Option.isSome(endpoint)) {
      layer = layerS3({
        endpoint: endpoint.value,
        region: yield* Config.string("S3_REGION").pipe(Config.withDefault("auto")),
        bucket: yield* Config.string("S3_BUCKET"),
        accessKeyId: yield* Config.string("S3_ACCESS_KEY_ID"),
        secretAccessKey: yield* Config.redacted("S3_SECRET_ACCESS_KEY"),
        urlStyle: yield* Config.literals(["path", "virtual-host"], "S3_URL_STYLE").pipe(
          Config.withDefault("virtual-host" as const),
        ),
      });
    } else {
      const dataDir = yield* Config.string("DATA_DIR").pipe(Config.withDefault("./data"));
      layer = layerFs(dataDir);
    }
    return layer;
  }),
);

const serverLayer = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* Config.port("PORT").pipe(Config.withDefault(8080));
    yield* Effect.logInfo("vault-cloud listening", { port });
    return NodeHttpServer.layer(createServer, { port });
  }),
);

const mainLayer = HttpRouter.serve(routesLayer).pipe(
  Layer.provide(VaultCloudAuth.layerConfig),
  Layer.provide(blobStoreLayer),
  Layer.provide(serverLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(NodeServices.layer),
);

Layer.launch(mainLayer).pipe(NodeRuntime.runMain);
