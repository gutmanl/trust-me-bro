import { describe, expect, it } from "vitest";

import exampleProject from "../register/schema/__fixtures__/example-project.json";
import type { ClaimsRegister } from "../register";
import { collectBlobPaths } from "./blob-refs";

function baseRegister(): ClaimsRegister {
  return structuredClone(exampleProject) as unknown as ClaimsRegister;
}

describe("collectBlobPaths", () => {
  it("collects the briefing and every current snapshot blob", () => {
    const register = baseRegister();
    const paths = collectBlobPaths(register);
    expect(paths).toContain(register.project.briefing_import?.blob_path);
    const snapshot = register.sources[0].custom.snapshot;
    expect(paths).toContain(snapshot?.blob_path);
    expect(paths).toContain(snapshot?.text_blob_path);
  });

  it("collects superseded snapshot blobs of revised sources (TMB-44)", () => {
    const register = baseRegister();
    const oldBlob = `blobs/aa/${"a".repeat(64)}.pdf`;
    const oldText = `blobs/bb/${"b".repeat(64)}.txt`;
    register.sources[0].custom.previous_snapshots = [
      {
        retrieved_at: "2026-07-01T08:00:00Z",
        sha256: "a".repeat(64),
        blob_path: oldBlob,
        text_blob_path: oldText,
        revision: 1,
      },
    ];
    const paths = collectBlobPaths(register);
    // Old revisions stay referenced: export bundles and `tmb verify` must
    // carry and check them — a revision never makes blobs unreachable.
    expect(paths).toContain(oldBlob);
    expect(paths).toContain(oldText);
  });
});
