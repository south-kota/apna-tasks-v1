import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { canonicalUriForKey, EMPTY_PAYLOAD_SHA256, sha256HexOf, signV4 } from "./sigv4.ts";

export class BlobStoreError extends Schema.TaggedErrorClass<BlobStoreError>()("BlobStoreError", {
  operation: Schema.String,
  key: Schema.String,
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const status = this.status === undefined ? "" : ` (HTTP ${this.status})`;
    return `Blob store ${this.operation} failed for ${this.key}${status}`;
  }
}

/**
 * Key/value blob storage backing the vault API. Implementations: local
 * filesystem (Railway volume, tests) and any S3-compatible endpoint (Railway
 * bucket today, Cloudflare R2 later — switching is pure configuration).
 */
export class BlobStore extends Context.Service<
  BlobStore,
  {
    readonly get: (key: string) => Effect.Effect<Uint8Array | null, BlobStoreError>;
    readonly put: (
      key: string,
      bytes: Uint8Array,
      contentType: string,
    ) => Effect.Effect<void, BlobStoreError>;
    readonly head: (key: string) => Effect.Effect<boolean, BlobStoreError>;
  }
>()("@t3tools/vault-cloud/BlobStore") {}

const KEY_SEGMENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;

export function isValidBlobKey(key: string): boolean {
  if (key.length === 0 || key.length > 1_024) return false;
  return key.split("/").every((segment) => KEY_SEGMENT_PATTERN.test(segment));
}

const guardKey = (operation: string, key: string) =>
  isValidBlobKey(key)
    ? Effect.void
    : Effect.fail(new BlobStoreError({ operation, key, cause: "invalid blob key" }));

// --- Filesystem implementation -------------------------------------------

export const layerFs = (
  dataDir: string,
): Layer.Layer<BlobStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.resolve(dataDir);

      const locate = (key: string): string => path.join(root, ...key.split("/"));

      const mapError = (operation: string, key: string) => (cause: unknown) =>
        new BlobStoreError({ operation, key, cause });

      const get = Effect.fn("BlobStore.get")(function* (key: string) {
        yield* guardKey("get", key);
        const file = locate(key);
        if (!(yield* fs.exists(file).pipe(Effect.mapError(mapError("get", key))))) {
          return null;
        }
        return yield* fs.readFile(file).pipe(Effect.mapError(mapError("get", key)));
      });

      const put = Effect.fn("BlobStore.put")(function* (key: string, bytes: Uint8Array) {
        yield* guardKey("put", key);
        const destination = locate(key);
        const directory = path.dirname(destination);
        yield* Effect.gen(function* () {
          yield* fs.makeDirectory(directory, { recursive: true });
          const temporary = yield* fs.makeTempFile({ directory, prefix: "blob-", suffix: ".tmp" });
          yield* fs
            .writeFile(temporary, bytes)
            .pipe(
              Effect.andThen(fs.rename(temporary, destination)),
              Effect.ensuring(
                Effect.ignore(fs.remove(path.dirname(temporary), { force: true, recursive: true })),
              ),
            );
        }).pipe(Effect.mapError(mapError("put", key)));
      });

      const head = Effect.fn("BlobStore.head")(function* (key: string) {
        yield* guardKey("head", key);
        return yield* fs.exists(locate(key)).pipe(Effect.mapError(mapError("head", key)));
      });

      return BlobStore.of({ get, put, head });
    }),
  );

// --- S3-compatible implementation ----------------------------------------

export interface S3Settings {
  /** Base endpoint, e.g. `https://t3.storageapi.dev` or an R2 account endpoint. */
  readonly endpoint: URL;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
  readonly urlStyle: "path" | "virtual-host";
}

export const layerS3 = (
  settings: S3Settings,
): Layer.Layer<BlobStore, never, HttpClient.HttpClient> =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const endpointHost = settings.endpoint.host;
      const host =
        settings.urlStyle === "virtual-host" ? `${settings.bucket}.${endpointHost}` : endpointHost;
      const keyPrefix = settings.urlStyle === "virtual-host" ? "" : `${settings.bucket}/`;

      const request = Effect.fnUntraced(function* (
        operation: string,
        method: "GET" | "PUT" | "HEAD",
        key: string,
        body: Uint8Array | null,
        contentType?: string,
      ) {
        yield* guardKey(operation, key);
        const canonicalUri = canonicalUriForKey(keyPrefix, key);
        const url = `${settings.endpoint.protocol}//${host}${canonicalUri}`;
        const payloadHash = body === null ? EMPTY_PAYLOAD_SHA256 : sha256HexOf(body);
        const amzDate = DateTime.formatIso(yield* DateTime.now)
          .replace(/[-:]/gu, "")
          .replace(/\.\d{3}/u, "");
        const headers: Record<string, string> = {
          host,
          "x-amz-content-sha256": payloadHash,
          "x-amz-date": amzDate,
          ...(contentType === undefined ? {} : { "content-type": contentType }),
        };
        const signed = signV4({
          method,
          canonicalUri,
          canonicalQuery: "",
          headers,
          payloadHash,
          amzDate,
          region: settings.region,
          service: "s3",
          accessKeyId: settings.accessKeyId,
          secretAccessKey: Redacted.value(settings.secretAccessKey),
        });
        // `host` comes from the URL itself; fetch would reject it as a header.
        const sendHeaders: Record<string, string> = {
          "x-amz-content-sha256": payloadHash,
          "x-amz-date": amzDate,
          authorization: signed.authorization,
          ...(contentType === undefined ? {} : { "content-type": contentType }),
        };
        let clientRequest = HttpClientRequest.make(method)(url, { headers: sendHeaders });
        if (body !== null) {
          clientRequest = HttpClientRequest.bodyUint8Array(
            clientRequest,
            body,
            contentType ?? "application/octet-stream",
          );
        }
        return yield* httpClient
          .execute(clientRequest)
          .pipe(Effect.mapError((cause) => new BlobStoreError({ operation, key, cause })));
      });

      const failWith = Effect.fnUntraced(function* (
        operation: string,
        key: string,
        status: number,
      ) {
        return yield* new BlobStoreError({ operation, key, status });
      });

      const get = Effect.fn("BlobStore.get")(function* (key: string) {
        const response = yield* request("get", "GET", key, null);
        if (response.status === 404) return null;
        if (response.status !== 200) return yield* failWith("get", key, response.status);
        const buffer = yield* response.arrayBuffer.pipe(
          Effect.mapError((cause) => new BlobStoreError({ operation: "get", key, cause })),
        );
        return new Uint8Array(buffer);
      });

      const put = Effect.fn("BlobStore.put")(function* (
        key: string,
        bytes: Uint8Array,
        contentType: string,
      ) {
        const response = yield* request("put", "PUT", key, bytes, contentType);
        if (response.status !== 200 && response.status !== 201) {
          return yield* failWith("put", key, response.status);
        }
      });

      const head = Effect.fn("BlobStore.head")(function* (key: string) {
        const response = yield* request("head", "HEAD", key, null);
        if (response.status === 404) return false;
        if (response.status !== 200) return yield* failWith("head", key, response.status);
        return true;
      });

      return BlobStore.of({ get, put, head });
    }),
  );
