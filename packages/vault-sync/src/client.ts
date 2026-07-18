import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  decodeManifestJson,
  encodeManifestJson,
  isValidDigest,
  type VaultManifest,
} from "./manifest.ts";

export interface RemoteManifest {
  readonly manifest: VaultManifest;
  readonly etag: string;
}

export class VaultCloudRequestError extends Schema.TaggedErrorClass<VaultCloudRequestError>()(
  "VaultCloudRequestError",
  {
    operation: Schema.String,
    status: Schema.optional(Schema.Number),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const status = this.status === undefined ? "" : ` (HTTP ${this.status})`;
    const detail = this.detail === undefined ? "" : `: ${this.detail}`;
    return `Vault cloud ${this.operation} failed${status}${detail}`;
  }
}

export class ManifestPreconditionError extends Schema.TaggedErrorClass<ManifestPreconditionError>()(
  "ManifestPreconditionError",
  { vaultId: Schema.String },
) {
  override get message(): string {
    return `Remote manifest for vault ${this.vaultId} changed since the last sync. Pull first, then push again.`;
  }
}

export interface VaultCloudClient {
  readonly getManifest: (
    vaultId: string,
  ) => Effect.Effect<RemoteManifest | null, VaultCloudRequestError>;
  readonly putManifest: (
    manifest: VaultManifest,
    expectedEtag: string | null,
  ) => Effect.Effect<string, VaultCloudRequestError | ManifestPreconditionError>;
  readonly objectExists: (
    vaultId: string,
    digest: string,
  ) => Effect.Effect<boolean, VaultCloudRequestError>;
  readonly uploadObject: (
    vaultId: string,
    digest: string,
    bytes: Uint8Array,
    mediaType: string,
  ) => Effect.Effect<void, VaultCloudRequestError>;
  readonly downloadObject: (
    vaultId: string,
    digest: string,
  ) => Effect.Effect<Uint8Array, VaultCloudRequestError>;
}

export interface VaultCloudClientOptions {
  readonly baseUrl: string;
  readonly token: Redacted.Redacted<string>;
  readonly httpClient: HttpClient.HttpClient;
}

export function makeVaultCloudClient(options: VaultCloudClientOptions): VaultCloudClient {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");

  const execute = Effect.fnUntraced(function* (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    return yield* options.httpClient
      .execute(HttpClientRequest.bearerToken(request, Redacted.value(options.token)))
      .pipe(Effect.mapError((cause) => new VaultCloudRequestError({ operation, cause })));
  });

  const failWithResponse = Effect.fnUntraced(function* (
    operation: string,
    response: HttpClientResponse.HttpClientResponse,
  ) {
    const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* new VaultCloudRequestError({
      operation,
      status: response.status,
      detail: detail.slice(0, 500).trim(),
    });
  });

  const objectUrl = (vaultId: string, digest: string): string => {
    if (!isValidDigest(digest)) {
      throw new Error(`Invalid object digest: ${digest}`);
    }
    return `${baseUrl}/v1/vaults/${encodeURIComponent(vaultId)}/objects/${digest}`;
  };

  const manifestUrl = (vaultId: string): string =>
    `${baseUrl}/v1/vaults/${encodeURIComponent(vaultId)}/manifest`;

  const getManifest = Effect.fn("VaultCloudClient.getManifest")(function* (
    vaultId: string,
  ): Effect.fn.Return<RemoteManifest | null, VaultCloudRequestError> {
    const operation = "get manifest";
    const response = yield* execute(operation, HttpClientRequest.get(manifestUrl(vaultId)));
    if (response.status === 404) return null;
    if (response.status !== 200) return yield* failWithResponse(operation, response);
    const etag = response.headers["etag"];
    if (etag === undefined) {
      return yield* new VaultCloudRequestError({
        operation,
        status: response.status,
        detail: "Response did not include an ETag header.",
      });
    }
    const body = yield* response.text.pipe(
      Effect.mapError((cause) => new VaultCloudRequestError({ operation, cause })),
    );
    const manifest = yield* decodeManifestJson(body).pipe(
      Effect.mapError((cause) => new VaultCloudRequestError({ operation, cause })),
    );
    return { manifest, etag };
  });

  const putManifest = Effect.fn("VaultCloudClient.putManifest")(function* (
    manifest: VaultManifest,
    expectedEtag: string | null,
  ): Effect.fn.Return<string, VaultCloudRequestError | ManifestPreconditionError> {
    const operation = "put manifest";
    const body = yield* encodeManifestJson(manifest).pipe(
      Effect.mapError((cause) => new VaultCloudRequestError({ operation, cause })),
    );
    const request = HttpClientRequest.put(manifestUrl(manifest.vaultId), {
      headers: {
        "content-type": "application/json",
        ...(expectedEtag === null ? { "if-none-match": "*" } : { "if-match": expectedEtag }),
      },
    }).pipe(HttpClientRequest.bodyText(body, "application/json"));
    const response = yield* execute(operation, request);
    if (response.status === 412) {
      return yield* new ManifestPreconditionError({ vaultId: manifest.vaultId });
    }
    if (response.status !== 200 && response.status !== 201) {
      return yield* failWithResponse(operation, response);
    }
    const etag = response.headers["etag"];
    if (etag === undefined) {
      return yield* new VaultCloudRequestError({
        operation,
        status: response.status,
        detail: "Response did not include an ETag header.",
      });
    }
    return etag;
  });

  const objectExists = Effect.fn("VaultCloudClient.objectExists")(function* (
    vaultId: string,
    digest: string,
  ): Effect.fn.Return<boolean, VaultCloudRequestError> {
    const operation = "check object";
    const response = yield* execute(operation, HttpClientRequest.head(objectUrl(vaultId, digest)));
    if (response.status === 404) return false;
    if (response.status !== 200) return yield* failWithResponse(operation, response);
    return true;
  });

  const uploadObject = Effect.fn("VaultCloudClient.uploadObject")(function* (
    vaultId: string,
    digest: string,
    bytes: Uint8Array,
    mediaType: string,
  ): Effect.fn.Return<void, VaultCloudRequestError> {
    const operation = "upload object";
    const request = HttpClientRequest.put(objectUrl(vaultId, digest)).pipe(
      HttpClientRequest.bodyUint8Array(bytes, mediaType),
    );
    const response = yield* execute(operation, request);
    if (response.status !== 200 && response.status !== 201) {
      return yield* failWithResponse(operation, response);
    }
  });

  const downloadObject = Effect.fn("VaultCloudClient.downloadObject")(function* (
    vaultId: string,
    digest: string,
  ): Effect.fn.Return<Uint8Array, VaultCloudRequestError> {
    const operation = "download object";
    const response = yield* execute(operation, HttpClientRequest.get(objectUrl(vaultId, digest)));
    if (response.status !== 200) return yield* failWithResponse(operation, response);
    const buffer = yield* response.arrayBuffer.pipe(
      Effect.mapError((cause) => new VaultCloudRequestError({ operation, cause })),
    );
    return new Uint8Array(buffer);
  });

  return { getManifest, putManifest, objectExists, uploadObject, downloadObject };
}
