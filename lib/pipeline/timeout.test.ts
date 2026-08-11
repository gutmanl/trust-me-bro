import { describe, expect, it, vi } from "vitest";

import { raceTimeout } from "./timeout";

describe("raceTimeout", () => {
  it("resolves with the work's value when it settles before the deadline", async () => {
    const value = await raceTimeout(
      Promise.resolve("done"),
      1000,
      () => new Error("should not fire"),
    );
    expect(value).toBe("done");
  });

  it("propagates the work's rejection unchanged when it loses to nothing", async () => {
    await expect(
      raceTimeout(
        Promise.reject(new Error("boom")),
        1000,
        () => new Error("timeout"),
      ),
    ).rejects.toThrow("boom");
  });

  it("rejects with the onTimeout error when the deadline wins", async () => {
    const never = new Promise<string>(() => {});
    await expect(
      raceTimeout(never, 5, () => new Error("deadline exceeded")),
    ).rejects.toThrow("deadline exceeded");
  });

  it("clears the timer once the work settles (no dangling handle)", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await raceTimeout(Promise.resolve(1), 1000, () => new Error("x"));
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
