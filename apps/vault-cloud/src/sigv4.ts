import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

/**
 * Minimal AWS Signature Version 4 signer, sufficient for S3-compatible object
 * stores (Railway buckets, Cloudflare R2, AWS S3). Pure functions, no
 * dependencies beyond @noble/hashes, verified against the published AWS
 * SigV4 test vectors.
 */

const encoder = new TextEncoder();

export function sha256HexOf(bytes: Uint8Array | string): string {
  return bytesToHex(sha256(typeof bytes === "string" ? encoder.encode(bytes) : bytes));
}

export const EMPTY_PAYLOAD_SHA256 = sha256HexOf("");

function hmacBytes(key: Uint8Array, message: string): Uint8Array {
  return hmac(sha256, key, encoder.encode(message));
}

/** RFC 3986 strict percent-encoding (encodeURIComponent plus `!'()*`). */
export function encodeRfc3986(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function canonicalUriForKey(prefix: string, key: string): string {
  const segments = `${prefix}${key}`.split("/").map(encodeRfc3986);
  return `/${segments.join("/")}`;
}

export interface SignV4Options {
  readonly method: string;
  /** Canonical URI (already percent-encoded, starting with `/`). */
  readonly canonicalUri: string;
  /** Sorted, already-encoded query string (empty string when none). */
  readonly canonicalQuery: string;
  /** Headers to sign. Must include `host`. Values are used as provided. */
  readonly headers: Readonly<Record<string, string>>;
  /** Lowercase hex SHA-256 of the request payload. */
  readonly payloadHash: string;
  /** ISO basic timestamp, e.g. `20260718T120000Z`. */
  readonly amzDate: string;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SignedRequest {
  readonly authorization: string;
  readonly signedHeaders: string;
}

export function signV4(options: SignV4Options): SignedRequest {
  const headerNames = Object.keys(options.headers)
    .map((name) => name.toLowerCase())
    .toSorted();
  const canonicalHeaders = headerNames
    .map((name) => {
      const value = Object.entries(options.headers).find(
        ([key]) => key.toLowerCase() === name,
      )?.[1];
      return `${name}:${(value ?? "").trim().replace(/\s+/gu, " ")}\n`;
    })
    .join("");
  const signedHeaders = headerNames.join(";");

  const canonicalRequest = [
    options.method.toUpperCase(),
    options.canonicalUri,
    options.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    options.payloadHash,
  ].join("\n");

  const dateStamp = options.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    options.amzDate,
    scope,
    sha256HexOf(canonicalRequest),
  ].join("\n");

  const kDate = hmacBytes(encoder.encode(`AWS4${options.secretAccessKey}`), dateStamp);
  const kRegion = hmacBytes(kDate, options.region);
  const kService = hmacBytes(kRegion, options.service);
  const kSigning = hmacBytes(kService, "aws4_request");
  const signature = bytesToHex(hmacBytes(kSigning, stringToSign));

  return {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
  };
}
