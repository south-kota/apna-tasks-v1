import {
  decodeManifestJson,
  isValidDigest,
  isValidVaultId,
  manifestKey,
  normalizeVaultPath,
  objectKey,
} from "@t3tools/vault-sync/manifest";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { BlobStore, type BlobStoreError } from "./BlobStore.ts";
import { sha256HexOf } from "./sigv4.ts";
import { WEB_APP_HTML } from "./web.ts";

export const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/** Bearer-token auth. Only a SHA-256 of the token is kept in memory; requests
 * are compared digest-to-digest, which is constant-time in practice. */
export class VaultCloudAuth extends Context.Service<
  VaultCloudAuth,
  { readonly tokenSha256: string }
>()("@t3tools/vault-cloud/router/VaultCloudAuth") {
  static readonly layerConfig = Layer.effect(
    VaultCloudAuth,
    Effect.gen(function* () {
      const token = yield* Config.redacted("VAULT_SYNC_TOKEN");
      return VaultCloudAuth.of({ tokenSha256: sha256HexOf(Redacted.value(token)) });
    }),
  );

  static layer(token: string): Layer.Layer<VaultCloudAuth> {
    return Layer.succeed(VaultCloudAuth, VaultCloudAuth.of({ tokenSha256: sha256HexOf(token) }));
  }
}

class UnauthorizedError extends Schema.TaggedErrorClass<UnauthorizedError>()(
  "UnauthorizedError",
  {},
) {}

class BadRequestError extends Schema.TaggedErrorClass<BadRequestError>()("BadRequestError", {
  detail: Schema.String,
}) {}

const authenticate = Effect.gen(function* () {
  const auth = yield* VaultCloudAuth;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const header = request.headers["authorization"];
  const token =
    header !== undefined && /^bearer /iu.test(header) ? header.slice("bearer ".length) : undefined;
  if (token === undefined || sha256HexOf(token.trim()) !== auth.tokenSha256) {
    return yield* new UnauthorizedError();
  }
});

const vaultIdParam = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  const vaultId = params["vaultId"];
  if (vaultId === undefined || !isValidVaultId(vaultId)) {
    return yield* new BadRequestError({ detail: "Invalid vault id." });
  }
  return vaultId;
});

const digestParam = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  const digest = params["digest"];
  if (digest === undefined || !isValidDigest(digest)) {
    return yield* new BadRequestError({ detail: "Invalid object digest." });
  }
  return digest;
});

const readBodyLimited = (limit: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const contentLength = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(contentLength) && contentLength > limit) {
      return yield* new BadRequestError({ detail: `Request body exceeds ${limit} bytes.` });
    }
    const buffer = yield* request.arrayBuffer.pipe(
      Effect.mapError(() => new BadRequestError({ detail: "Failed to read request body." })),
    );
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength > limit) {
      return yield* new BadRequestError({ detail: `Request body exceeds ${limit} bytes.` });
    }
    return bytes;
  });

/** Uniform error mapping for API routes. */
const respond = <R>(
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    UnauthorizedError | BadRequestError | BlobStoreError,
    R
  >,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.catchTags({
      UnauthorizedError: () =>
        Effect.succeed(
          HttpServerResponse.text("Unauthorized", {
            status: 401,
            headers: { "www-authenticate": "Bearer" },
          }),
        ),
      BadRequestError: (error) =>
        Effect.succeed(HttpServerResponse.text(error.detail, { status: 400 })),
      BlobStoreError: (error) =>
        Effect.logError("Blob store failure", { message: error.message }).pipe(
          Effect.as(HttpServerResponse.text("Storage unavailable", { status: 502 })),
        ),
    }),
  );

const quoteEtag = (digest: string): string => `"${digest}"`;

const manifestLock = Semaphore.makeUnsafe(1);

const healthRoute = HttpRouter.add("GET", "/health", Effect.succeed(HttpServerResponse.text("ok")));

const webAppRoute = HttpRouter.add(
  "GET",
  "/",
  Effect.succeed(HttpServerResponse.html(WEB_APP_HTML)),
);

const getManifestRoute = HttpRouter.add(
  "GET",
  "/v1/vaults/:vaultId/manifest",
  respond(
    Effect.gen(function* () {
      yield* authenticate;
      const vaultId = yield* vaultIdParam;
      const store = yield* BlobStore;
      const bytes = yield* store.get(manifestKey(vaultId));
      if (bytes === null) return HttpServerResponse.text("Not Found", { status: 404 });
      return HttpServerResponse.uint8Array(bytes, {
        contentType: "application/json",
        headers: { etag: quoteEtag(sha256HexOf(bytes)) },
      });
    }),
  ),
);

const putManifestRoute = HttpRouter.add(
  "PUT",
  "/v1/vaults/:vaultId/manifest",
  respond(
    Effect.gen(function* () {
      yield* authenticate;
      const vaultId = yield* vaultIdParam;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const store = yield* BlobStore;
      const bytes = yield* readBodyLimited(MAX_MANIFEST_BYTES);

      const manifest = yield* decodeManifestJson(new TextDecoder().decode(bytes)).pipe(
        Effect.mapError(() => new BadRequestError({ detail: "Invalid vault manifest." })),
      );
      if (manifest.vaultId !== vaultId) {
        return yield* new BadRequestError({ detail: "Manifest vaultId does not match the URL." });
      }

      const ifMatch = request.headers["if-match"];
      const ifNoneMatch = request.headers["if-none-match"];
      return yield* manifestLock.withPermit(
        Effect.gen(function* () {
          const current = yield* store.get(manifestKey(vaultId));
          const currentEtag = current === null ? null : quoteEtag(sha256HexOf(current));
          const preconditionOk =
            ifNoneMatch === "*"
              ? current === null
              : ifMatch !== undefined
                ? currentEtag !== null && ifMatch === currentEtag
                : false;
          if (!preconditionOk) {
            const status = ifMatch === undefined && ifNoneMatch === undefined ? 428 : 412;
            return HttpServerResponse.text(
              status === 428
                ? "Conditional headers required: send If-Match or If-None-Match: *."
                : "Manifest changed on the server.",
              { status },
            );
          }
          yield* store.put(manifestKey(vaultId), bytes, "application/json");
          return HttpServerResponse.empty({
            status: 200,
            headers: { etag: quoteEtag(sha256HexOf(bytes)) },
          });
        }),
      );
    }),
  ),
);

// HEAD requests fall back to the GET route (the router strips the body).
const getObjectRoute = HttpRouter.add(
  "GET",
  "/v1/vaults/:vaultId/objects/:digest",
  respond(
    Effect.gen(function* () {
      yield* authenticate;
      const vaultId = yield* vaultIdParam;
      const digest = yield* digestParam;
      const store = yield* BlobStore;
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.method === "HEAD") {
        const exists = yield* store.head(objectKey(vaultId, digest));
        return HttpServerResponse.empty({ status: exists ? 200 : 404 });
      }
      const bytes = yield* store.get(objectKey(vaultId, digest));
      if (bytes === null) return HttpServerResponse.text("Not Found", { status: 404 });
      return HttpServerResponse.uint8Array(bytes, {
        contentType: "application/octet-stream",
        headers: { "cache-control": "private, immutable, max-age=31536000" },
      });
    }),
  ),
);

const putObjectRoute = HttpRouter.add(
  "PUT",
  "/v1/vaults/:vaultId/objects/:digest",
  respond(
    Effect.gen(function* () {
      yield* authenticate;
      const vaultId = yield* vaultIdParam;
      const digest = yield* digestParam;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const store = yield* BlobStore;
      const bytes = yield* readBodyLimited(MAX_OBJECT_BYTES);
      if (sha256HexOf(bytes) !== digest) {
        return yield* new BadRequestError({
          detail: "Object body does not match the digest in the URL.",
        });
      }
      const key = objectKey(vaultId, digest);
      if (yield* store.head(key)) {
        // Objects are immutable and content-addressed: re-uploads are no-ops.
        return HttpServerResponse.empty({ status: 200 });
      }
      const contentType = request.headers["content-type"] ?? "application/octet-stream";
      yield* store.put(key, bytes, contentType);
      return HttpServerResponse.empty({ status: 201 });
    }),
  ),
);

const getFileRoute = HttpRouter.add(
  "GET",
  "/v1/vaults/:vaultId/files/*",
  respond(
    Effect.gen(function* () {
      yield* authenticate;
      const vaultId = yield* vaultIdParam;
      const params = yield* HttpRouter.params;
      const rawPath = params["*"];
      const decodedPath = yield* Effect.try({
        try: () => decodeURIComponent(rawPath ?? ""),
        catch: () => new BadRequestError({ detail: "Invalid file path encoding." }),
      });
      const filePath = normalizeVaultPath(decodedPath);
      if (filePath === null) {
        return yield* new BadRequestError({ detail: "Invalid file path." });
      }
      const store = yield* BlobStore;
      const manifestBytes = yield* store.get(manifestKey(vaultId));
      if (manifestBytes === null) return HttpServerResponse.text("Not Found", { status: 404 });
      const manifest = yield* decodeManifestJson(new TextDecoder().decode(manifestBytes)).pipe(
        Effect.mapError(() => new BadRequestError({ detail: "Stored manifest is invalid." })),
      );
      const entry = manifest.files.find((file) => file.path === filePath);
      if (entry === undefined) return HttpServerResponse.text("Not Found", { status: 404 });
      const bytes = yield* store.get(objectKey(vaultId, entry.sha256));
      if (bytes === null) return HttpServerResponse.text("Not Found", { status: 404 });
      return HttpServerResponse.uint8Array(bytes, { contentType: entry.mediaType });
    }),
  ),
);

/** All vault-cloud routes. Requires `BlobStore` and `VaultCloudAuth`. */
export const routesLayer = Layer.mergeAll(
  healthRoute,
  webAppRoute,
  getManifestRoute,
  putManifestRoute,
  getObjectRoute,
  putObjectRoute,
  getFileRoute,
);
