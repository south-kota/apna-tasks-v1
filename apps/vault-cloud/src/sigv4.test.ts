import { assert, describe, it } from "@effect/vitest";

import { canonicalUriForKey, EMPTY_PAYLOAD_SHA256, encodeRfc3986, signV4 } from "./sigv4.ts";

describe("sigv4", () => {
  it("matches the AWS get-vanilla test vector", () => {
    // From the published AWS Signature Version 4 test suite (get-vanilla).
    const signed = signV4({
      method: "GET",
      canonicalUri: "/",
      canonicalQuery: "",
      headers: {
        host: "example.amazonaws.com",
        "x-amz-date": "20150830T123600Z",
      },
      payloadHash: EMPTY_PAYLOAD_SHA256,
      amzDate: "20150830T123600Z",
      region: "us-east-1",
      service: "service",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    });
    assert.equal(
      signed.authorization,
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("hashes the empty payload to the canonical SHA-256", () => {
    assert.equal(
      EMPTY_PAYLOAD_SHA256,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("percent-encodes path segments per RFC 3986", () => {
    assert.equal(encodeRfc3986("a b"), "a%20b");
    assert.equal(encodeRfc3986("a*b'c(d)!"), "a%2Ab%27c%28d%29%21");
    assert.equal(encodeRfc3986("safe-key_1.json"), "safe-key_1.json");
  });

  it("builds canonical URIs for path-style and virtual-host-style keys", () => {
    assert.equal(
      canonicalUriForKey("bucket/", "vaults/v1/manifest.json"),
      "/bucket/vaults/v1/manifest.json",
    );
    assert.equal(canonicalUriForKey("", "vaults/v1/manifest.json"), "/vaults/v1/manifest.json");
  });
});
