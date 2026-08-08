import { describe, expect, it } from "vitest";

import type { ClaimsRegister } from "../../register";
import { buildAdjudicationQueue } from "./queue";

function registerWith(
  claims: {
    id: string;
    status: string;
    history: {
      to_status: string;
      at: string;
      routing?: string;
    }[];
  }[],
): ClaimsRegister {
  return {
    claims: claims.map((entry) => ({
      id: entry.id,
      status: entry.status,
      history: entry.history,
    })),
  } as unknown as ClaimsRegister;
}

describe("buildAdjudicationQueue", () => {
  it("lists only claims awaiting adjudication, oldest first", () => {
    const queue = buildAdjudicationQueue(
      registerWith([
        {
          id: "clm_0002",
          status: "zur_adjudikation",
          history: [
            { to_status: "erfasst", at: "2026-08-08T09:00:00Z" },
            {
              to_status: "zur_adjudikation",
              at: "2026-08-08T11:00:00Z",
              routing: "divergenz",
            },
          ],
        },
        {
          id: "clm_0001",
          status: "zur_adjudikation",
          history: [
            {
              to_status: "zur_adjudikation",
              at: "2026-08-08T10:00:00Z",
              routing: "ohne_beleg",
            },
          ],
        },
        {
          id: "clm_0003",
          status: "bestaetigt",
          history: [{ to_status: "bestaetigt", at: "2026-08-08T08:00:00Z" }],
        },
      ]),
    );
    expect(queue.map((entry) => entry.claim.id)).toEqual([
      "clm_0001",
      "clm_0002",
    ]);
    expect(queue.map((entry) => entry.routing)).toEqual([
      "ohne_beleg",
      "divergenz",
    ]);
  });

  it("uses the LATEST routing entry and falls back to null", () => {
    const queue = buildAdjudicationQueue(
      registerWith([
        {
          id: "clm_0001",
          status: "zur_adjudikation",
          history: [
            {
              to_status: "zur_adjudikation",
              at: "2026-08-08T09:00:00Z",
              routing: "existenz_nicht_bestanden",
            },
            { to_status: "beanstandet", at: "2026-08-08T10:00:00Z" },
            { to_status: "ueberarbeitet", at: "2026-08-08T11:00:00Z" },
            {
              to_status: "zur_adjudikation",
              at: "2026-08-08T12:00:00Z",
              routing: "eskaliert",
            },
          ],
        },
        {
          id: "clm_0002",
          status: "zur_adjudikation",
          // Pre-extension entry without routing field.
          history: [
            { to_status: "zur_adjudikation", at: "2026-08-08T09:30:00Z" },
          ],
        },
      ]),
    );
    const escalated = queue.find((entry) => entry.claim.id === "clm_0001");
    const preExtension = queue.find((entry) => entry.claim.id === "clm_0002");
    expect(escalated?.routing).toBe("eskaliert");
    expect(escalated?.queuedAt).toBe("2026-08-08T12:00:00Z");
    expect(preExtension?.routing).toBeNull();
  });
});
