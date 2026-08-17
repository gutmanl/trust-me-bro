/**
 * Presentation regressions an evaluator meets before they read any claim.
 *
 * Each spec here pins a defect that `npm run check` cannot see, because each
 * one lives in rendered output rather than in a return value: a briefing
 * whose citation markup leaked through as literal text, browser tabs that all
 * read "TrustMeBro", a start button that vanished for the duration of the
 * call it started, and a project with no way back to the project list.
 *
 * The seeded workspace is the same one `review.spec.ts` drives — its briefing
 * carries real `[^n]` markers and a trailing definition block, so the footnote
 * assertions below are about the corpus's own citation style, not a fixture
 * written to make them pass.
 */
import { expect, test } from "@playwright/test";

import {
  BROWSER_PROJECT_ID,
  BROWSER_RESEARCH_QUESTION,
} from "./seed-workspace";

const projectUrl = `/projects/${BROWSER_PROJECT_ID}`;

test.describe("briefing rendering", () => {
  test("renders footnote markers as superscripts, not literal [^n]", async ({
    page,
  }) => {
    await page.goto(projectUrl);

    const briefing = page.getByRole("region", { name: "Briefing" });
    await expect(briefing).toBeVisible();

    // The marker is a real <sup>, and the source spelling is gone from the
    // rendered text — the second half is what regressed before.
    await expect(briefing.locator("sup").first()).toBeVisible();
    await expect(briefing).not.toContainText("[^1]");
    await expect(briefing).not.toContainText("[^2]");
  });

  test("renders the reference block as a list, not one run-on paragraph", async ({
    page,
  }) => {
    await page.goto(projectUrl);

    const briefing = page.getByRole("region", { name: "Briefing" });
    // Three definitions, three <dd>s. As a paragraph they were one node with
    // every reference concatenated into it.
    const definitions = briefing.locator("dd");
    await expect(definitions).toHaveCount(3);
    await expect(definitions.first()).toContainText("Audit Trails");
    await expect(briefing).not.toContainText("[^1]:");
  });
});

test.describe("page titles", () => {
  test("titles a project tab with its research question", async ({ page }) => {
    await page.goto(projectUrl);
    await expect(page).toHaveTitle(new RegExp(BROWSER_RESEARCH_QUESTION));
  });

  test("titles a side view with the view and the project", async ({ page }) => {
    await page.goto(`${projectUrl}/history`);
    await expect(page).toHaveTitle(/^Verlauf · /);
  });

  test("titles the project list distinctly from the app", async ({ page }) => {
    await page.goto("/projects");
    await expect(page).toHaveTitle("Projekte · TrustMeBro");
  });
});

test.describe("navigation out of a project", () => {
  test("offers a breadcrumb back to the project list", async ({ page }) => {
    await page.goto(projectUrl);

    await page
      .getByRole("navigation", { name: "Navigationspfad" })
      .getByRole("link", { name: "Projekte" })
      .click();

    await expect(
      page.getByRole("heading", { level: 1, name: "Projekte" }),
    ).toBeVisible();
  });

  test("links a side view straight to a sibling view", async ({ page }) => {
    await page.goto(`${projectUrl}/history`);

    // Without this the only route from Verlauf to Auswertung was back through
    // the workbench and down to its footer link list.
    await page
      .getByRole("navigation", { name: "Weitere Sichten" })
      .getByRole("link", { name: "Auswertung" })
      .click();

    await expect(
      page.getByRole("heading", { level: 1, name: /Auswertung/ }),
    ).toBeVisible();
  });

  test("marks the current view as position rather than link", async ({
    page,
  }) => {
    await page.goto(`${projectUrl}/metrics`);
    const views = page.getByRole("navigation", { name: "Weitere Sichten" });
    await expect(
      views.getByText("Auswertung", { exact: true }),
    ).toHaveAttribute("aria-current", "page");
  });
});

/*
 * Deliberately NOT covered here: the Research/Relevance panels keeping their
 * start button mounted and disabled while the action is in flight. Asserting
 * it means clicking the button, and that button spawns a real agent CLI — the
 * one thing this suite's seeding goes out of its way to keep out of the
 * browser (see `seed-workspace.ts`). The seeded project also has no adopted
 * claims, so the relevance button is not offered at all and the spec could
 * only ever skip.
 */
