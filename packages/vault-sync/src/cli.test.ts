import { assert, describe, it } from "@effect/vitest";

import {
  DEFAULT_WATCH_POLL_INTERVAL_SECONDS,
  SyncCliUsageError,
  watchPollIntervalSeconds,
} from "./cli.ts";

describe("vault sync CLI", () => {
  it("uses the default watch poll interval", () => {
    assert.equal(
      watchPollIntervalSeconds(["watch", "/vault"]),
      DEFAULT_WATCH_POLL_INTERVAL_SECONDS,
    );
  });

  it("accepts zero and positive poll intervals", () => {
    assert.equal(watchPollIntervalSeconds(["--poll-interval", "0"]), 0);
    assert.equal(watchPollIntervalSeconds(["--poll-interval", "2.5"]), 2.5);
  });

  it("rejects missing, negative, and non-numeric poll intervals", () => {
    assert.isNull(watchPollIntervalSeconds(["--poll-interval"]));
    assert.isNull(watchPollIntervalSeconds(["--poll-interval", ""]));
    assert.isNull(watchPollIntervalSeconds(["--poll-interval", "-1"]));
    assert.isNull(watchPollIntervalSeconds(["--poll-interval", "soon"]));
  });

  it("documents the poll interval flag in usage", () => {
    assert.include(new SyncCliUsageError().message, "--poll-interval <seconds>");
  });
});
