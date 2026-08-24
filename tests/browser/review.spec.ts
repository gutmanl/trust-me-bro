/**
 * The review workflow in a real browser.
 *
 * The software review recorded that no browser suite existed and that the
 * thesis says the React components are untested. These specs close the part
 * of that gap which matters most for the product's claim: a human being able
 * to see WHY a claim is open, decide it, and have the decision land in the
 * append-only register.
 *
 * The workspace is seeded by `global-setup.ts` from the same corpus the
 * vitest end-to-end specs use, so the two claims below are open for real
 * reasons — one quote was proved against the frozen PDF, the other was not.
 */
import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

import {
  BROWSER_PROJECT_ID,
  BROWSER_RESEARCH_QUESTION,
  seedBrowserWorkspace,
} from "./seed-workspace";

const projectUrl = `/projects/${BROWSER_PROJECT_ID}`;

/**
 * Expands a claim card and waits until it really is expanded.
 *
 * The retry is not defensive padding: the claim list is a client component,
 * and a click dispatched between first paint and hydration is swallowed
 * silently — the page looks right, the handler does not exist yet, and the
 * failure surfaces later as "the button is missing". Asserting on
 * `aria-expanded` and re-clicking until it flips makes the wait explicit and
 * ties it to the state the UI actually exposes.
 */
async function openClaim(page: Page, claimId: string): Promise<void> {
  const card = page.getByRole("button", { name: new RegExp(claimId) }).first();
  await expect(card).toBeVisible();
  await expect(async () => {
    await card.click();
    await expect(card).toHaveAttribute("aria-expanded", "true", {
      timeout: 1_000,
    });
  }).toPass({ timeout: 15_000 });
}

test.describe("project list", () => {
  test("shows the seeded project and links into it", async ({ page }) => {
    await page.goto("/projects");
    await expect(
      page.getByRole("heading", { level: 1, name: "Projekte" }),
    ).toBeVisible();

    await page
      .getByRole("link", { name: new RegExp(BROWSER_PROJECT_ID) })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: BROWSER_RESEARCH_QUESTION }),
    ).toBeVisible();
  });
});

test.describe("the workbench", () => {
  test("renders the frozen briefing and both claims with their status", async ({
    page,
  }) => {
    await page.goto(projectUrl);

    // The briefing is the frozen original, rendered through the projection —
    // its heading comes from the Markdown the corpus scenario froze.
    await expect(
      page.getByRole("heading", {
        name: "Prüfbarkeit LLM-recherchierter Briefings",
      }),
    ).toBeVisible();

    // Both claims, each carrying the German label of its English enum value.
    await expect(page.getByText("clm_0001")).toBeVisible();
    await expect(page.getByText("clm_0002")).toBeVisible();
    await expect(page.getByText("Zitate geprüft").first()).toBeVisible();
    await expect(
      page.getByText("zur manuellen Überprüfung").first(),
    ).toBeVisible();

    // The captured source, under the identity the resolver returned.
    // Exact match: the title also appears inside the briefing's footnote
    // line, and the assertion is about the source rail entry.
    await expect(
      page.getByText(
        "Audit Trails for Accountability in Large Language Models",
        {
          exact: true,
        },
      ),
    ).toBeVisible();
  });

  test("hydrates without a script error or a failed asset", async ({
    page,
  }) => {
    // Two separate signals, because they fail differently and both have bitten
    // this suite. An uncaught exception means the component tree broke; a 4xx
    // on a chunk means the page server-rendered and never hydrated, which
    // looks identical to a working page until something is clicked.
    const scriptErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("pageerror", (error) => scriptErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) {
        failedRequests.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.goto(projectUrl);
    await expect(page.getByText("clm_0001")).toBeVisible();

    expect(scriptErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
});

test.describe("adjudication", () => {
  // Each case decides the same claim, and a decision is append-only — so the
  // workspace is rebuilt per test rather than letting the first one leave the
  // second without an open claim to act on. The server reads the register
  // from disk on every request, so reseeding underneath it is safe.
  test.beforeEach(async () => {
    await seedBrowserWorkspace();
  });

  test("a human confirmation is written to the register and shown back", async ({
    page,
  }) => {
    await page.goto(projectUrl);

    // The claim stage 1 could not prove — open because its quoted wording is
    // not in the frozen document, and the card says so.
    await openClaim(page, "clm_0002");
    await expect(
      page.getByText("Zitatprüfung nicht bestanden").first(),
    ).toBeVisible();

    const confirm = page.getByRole("button", { name: "Bestätigen" });
    await expect(confirm).toBeVisible();
    await confirm.click();

    // The decision is a chain entry, so the status the page shows afterwards
    // is read back from disk rather than from client state. "bestätigt" is
    // the German label of the `confirmed` enum value — the display tier
    // translates, the register stores the English literal.
    await expect(
      page.getByRole("button", { name: /clm_0002.*bestätigt/ }).first(),
    ).toBeVisible();

    // And it is in the append-only history, attributed to the configured
    // actor rather than to a system token.
    await page.goto(`${projectUrl}/history`);
    await expect(page.getByText("human:lg").first()).toBeVisible();
  });

  test("the complaint dialog offers the reasons a claim can be wrong", async ({
    page,
  }) => {
    await page.goto(projectUrl);
    await openClaim(page, "clm_0002");

    await page.getByRole("button", { name: /Etwas stimmt nicht/ }).click();
    await expect(page.getByText("Warum stimmt etwas nicht?")).toBeVisible();
    // The complaint categories are the vocabulary the register persists, in
    // their German display form.
    await expect(
      page.getByText("Wortlaut so nicht in Quelle enthalten"),
    ).toBeVisible();
  });
});

test.describe("export", () => {
  test("hands over a bundle the standalone verifier can read", async ({
    page,
  }) => {
    await page.goto(projectUrl);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: /Bundle herunterladen/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^trustmebro-export_.*\.tmb$/);
  });
});

/**
 * The sweep's confirmation (RERUN-02) and the exclusion of the claim the
 * reviewer has open (RERUN-04).
 *
 * These three assertions are here rather than in an SSR test because none
 * of them exists until a browser runs the component. The forcing step is
 * three interactions; the exclusion lives entirely in client state that
 * `lib/` cannot see; and „the submit is reachable without scrolling" is a
 * layout fact `renderToStaticMarkup` has no viewport for.
 */
test.describe("the re-verification sweep", () => {
  // A sweep moves claims into recheck_required, and the register is
  // append-only — so the workspace is rebuilt per test rather than letting
  // the first one leave the second with nothing to sweep.
  test.beforeEach(async () => {
    await seedBrowserWorkspace();
  });

  /**
   * Opens the sweep dialog, retrying through the hydration race for the
   * same reason `openClaim` does: the bar is a client component, and a
   * click dispatched between first paint and hydration is swallowed
   * silently.
   */
  async function openSweep(page: Page): Promise<void> {
    const trigger = page.getByRole("button", {
      name: /Mehrere Aussagen erneut prüfen/,
    });
    await expect(trigger).toBeVisible();
    await expect(async () => {
      await trigger.click();
      await expect(
        page.getByRole("heading", { name: "Mehrere Aussagen erneut prüfen" }),
      ).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
  }

  /** The narrowest rung's displayed count, read off its own radio label. */
  async function staleRungTotal(page: Page): Promise<number> {
    const label = await page
      .getByText(/Nur veraltete Vorprüfungen \(\d+\)/)
      .innerText();
    const match = /\((\d+)\)/.exec(label);
    expect(match).not.toBeNull();
    return Number((match as RegExpExecArray)[1]);
  }

  test("the typed number blocks the submit until it is right", async ({
    page,
  }) => {
    await page.goto(projectUrl);
    await openSweep(page);

    const submit = page.getByRole("button", { name: /^Erneut prüfen \(/ });
    // 1 — nothing typed yet.
    await expect(submit).toBeDisabled();

    // The seeded project has exactly one claim awaiting adjudication (the
    // one whose quote stage 1 could not prove), so the forcing step asks
    // for the queued count and that count is 1.
    await expect(
      page.getByText(
        "Zur Bestätigung: Wie viele der betroffenen Aussagen stehen in " +
          "der Warteschlange zur manuellen Überprüfung?",
      ),
    ).toBeVisible();

    const field = page.getByLabel(/Zur Bestätigung/);

    // 2 — a wrong number. Still blocked, and the hint appears in slate
    // rather than red: a wrong number here is the mechanism working.
    await field.fill("7");
    await expect(submit).toBeDisabled();
    const hint = page.getByText(
      "Die Zahl stimmt nicht mit der Aufstellung überein.",
    );
    await expect(hint).toBeVisible();
    await expect(hint).toHaveClass(/text-slate-500/);

    // 3 — the number the itemisation actually named.
    await field.fill("1");
    await expect(submit).toBeEnabled();
    await expect(hint).not.toBeVisible();
  });

  test("the claim the reviewer has open is left out (RERUN-04)", async ({
    page,
  }) => {
    await page.goto(projectUrl);

    // Both numbers are read from the same page in the same run, so the
    // assertion cannot drift with the seeded corpus.
    await openSweep(page);
    const withNothingOpen = await staleRungTotal(page);
    expect(withNothingOpen).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Abbrechen" }).click();

    // clm_0002 is the claim awaiting adjudication — expanding it is exactly
    // the state D-05 excludes: the effort timer is running on it and a
    // complaint draft can only exist inside it.
    await openClaim(page, "clm_0002");
    await openSweep(page);

    expect(await staleRungTotal(page)).toBe(withNothingOpen - 1);
    await expect(
      page.getByText(/Nicht einbezogen:.*gerade geöffnet/),
    ).toBeVisible();
  });

  test("the submit is above the fold at the widest rung", async ({ page }) => {
    await page.goto(projectUrl);
    await openSweep(page);

    // The rung that selects the most claims is the one whose itemisation is
    // longest, so it is the one that could push the forcing field and the
    // submit out of the modal's scroll area. Counts and groups only —
    // never a claim-id list — is what prevents that.
    await page.getByText("Auch bestätigte Aussagen").click();

    const submit = page.getByRole("button", { name: /^Erneut prüfen \(/ });
    await expect(submit).toBeVisible();
    await expect(submit).toBeInViewport();
  });
});
