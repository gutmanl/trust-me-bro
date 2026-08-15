/**
 * First contact in a browser: the half hour an evaluator spends deciding
 * whether this tool is worth installing an agent CLI for.
 *
 * `tests/first-contact.test.ts` already covers the same session at use-case
 * and route level — typo'd ids, a briefing pasted twice, hand-probed API
 * URLs. What it cannot cover is the part the evaluator actually performs:
 * nobody calls `createProject()`, they land on a wizard they have never seen
 * and click. Every assertion here is on German copy the user reads, because
 * the copy IS the product at this stage.
 *
 * Serial and ordered on purpose. The suite walks one installation from
 * "nothing configured" to "example project exported", and each step is the
 * next step's precondition — the same sequence the README describes.
 */
import fs from "node:fs";

import { expect, test } from "@playwright/test";

import { COLD_CONFIG, COLD_WORKSPACE } from "./paths";

test.describe.configure({ mode: "serial" });

const HANDLE = "gutachter";

test.describe("before anything is configured", () => {
  test("sends every route to the setup wizard", async ({ page }) => {
    // The gate is the first thing that happens to a new installation, and it
    // has to hold for pages the evaluator might bookmark or type directly,
    // not just for the root.
    for (const target of ["/projects", "/settings", "/projects/new"]) {
      const response = await page.goto(target);
      expect(new URL(page.url()).pathname).toBe("/setup");
      expect(response?.ok()).toBe(true);
    }

    await expect(
      page.getByRole("heading", { level: 1, name: "Ersteinrichtung" }),
    ).toBeVisible();
    await expect(page.getByText("Willkommen bei TrustMeBro")).toBeVisible();
  });

  test("explains that only the handle is required", async ({ page }) => {
    await page.goto("/setup");
    // The promise that makes the wizard survivable: four of its five steps
    // can be skipped.
    await expect(
      page.getByText(/Alles Weitere ist optional und lässt sich überspringen/),
    ).toBeVisible();
  });
});

test.describe("the wizard", () => {
  test("refuses a handle with capitals or spaces, and says which characters are allowed", async ({
    page,
  }) => {
    await page.goto("/setup");
    // A first-time user types their name. "Jörg Müller" is a likelier first
    // attempt than "jm", and the refusal has to teach the rule.
    await page.getByLabel("Akteurskürzel").fill("Jörg Müller");
    await page.getByRole("button", { name: /Weiter|Speichere/ }).click();

    // One assertion on the banner itself: "Kleinbuchstaben" also appears in
    // the field's standing hint, and matching that instead would let a
    // missing error message pass.
    await expect(
      page.getByText(/ist ungültig – erlaubt sind Kleinbuchstaben/),
    ).toBeVisible();
    // Still on step 1, nothing persisted.
    expect(new URL(page.url()).pathname).toBe("/setup");
    expect(fs.existsSync(COLD_CONFIG)).toBe(false);
  });

  test("accepts a plain handle and moves to the workspace step", async ({
    page,
  }) => {
    await page.goto("/setup");
    await page.getByLabel("Akteurskürzel").fill(HANDLE);
    await page.getByRole("button", { name: /Weiter|Speichere/ }).click();

    await expect(page).toHaveURL(/step=2/);
    // The handle is what the gate keys on, so it must be on disk by now.
    expect(JSON.parse(fs.readFileSync(COLD_CONFIG, "utf8"))).toMatchObject({
      actor_handle: HANDLE,
    });
  });

  test("takes a workspace directory and says why it is settable only now", async ({
    page,
  }) => {
    await page.goto("/setup?step=2");
    await expect(page.getByText(/Nur jetzt änderbar/)).toBeVisible();

    // A path is typed rather than the suggestion kept, for two reasons: it
    // exercises the step's actual purpose, and the suggestion is the code
    // default `./workspace` — relative to the working directory, because a
    // dev-mode start has no launcher to point it at ~/.trustmebro/workspace.
    // Keeping it would drop this suite's projects into the repository.
    await page.getByLabel("Arbeitsverzeichnis").fill(COLD_WORKSPACE);
    await page.getByRole("button", { name: /Übernehmen und weiter/ }).click();

    await expect(page).toHaveURL(/step=3/);
    expect(JSON.parse(fs.readFileSync(COLD_CONFIG, "utf8"))).toMatchObject({
      workspace_root: COLD_WORKSPACE,
    });
  });

  test("diagnoses the backends and promises a way forward without one", async ({
    page,
  }) => {
    // Navigated rather than carried over from the previous test: each test
    // gets a fresh page, and the steps are addressable by URL once the
    // handle is stored (before that, the wizard forces every step back to 1).
    await page.goto("/setup?step=3");
    // Step 3 is the one that decides whether an evaluator with nothing
    // installed keeps going or closes the tab.
    await expect(
      page.getByText(/Ist keine CLI einsatzbereit, geht es trotzdem weiter/),
    ).toBeVisible();
    await expect(page.getByText(/Demo-Backend/).first()).toBeVisible();
    // With no agent CLI on PATH the diagnosis has to say so concretely,
    // naming the install command rather than "not available".
    await expect(
      page.getByText(/nicht im Suchpfad gefunden/).first(),
    ).toBeVisible();
    await expect(
      page.getByText(/npm install -g @anthropic-ai\/claude-code/),
    ).toBeVisible();

    await page.getByRole("link", { name: "Weiter" }).click();
    await expect(page).toHaveURL(/step=4/);
  });

  test("lets the optional Unpaywall address be skipped", async ({ page }) => {
    await page.goto("/setup?step=4");
    await expect(
      page.getByText(/ohne sie überspringt er diesen/),
    ).toBeVisible();
    await page.getByRole("link", { name: /Überspringen/ }).click();
    await expect(page).toHaveURL(/step=5/);
  });

  test("ends by offering the example project", async ({ page }) => {
    await page.goto("/setup?step=5");
    await expect(
      page.getByRole("link", { name: "Erstes Projekt anlegen" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Beispielprojekt anlegen" }),
    ).toBeVisible();
    await expect(page.getByText(/dauerhaft in der Hash-Kette/)).toBeVisible();
  });
});

test.describe("the example project", () => {
  test("is created by the button and opens as a filled-in register", async ({
    page,
  }) => {
    await page.goto("/setup?step=5");
    await page.getByRole("button", { name: "Beispielprojekt anlegen" }).click();

    await expect(page).toHaveURL(/\/projects\/proj_demo/);
    // Labelled as a demo wherever it is shown — the point being that no
    // canned judgement can be mistaken for a verification result.
    await expect(page.getByText(/Demo/).first()).toBeVisible();
    // A filled register: the briefing and its claims are on the page.
    await expect(page.getByText("clm_demo1")).toBeVisible();
    await expect(page.getByText(/Musterwerkzeug/).first()).toBeVisible();
  });

  test("offers the export an evaluator can verify outside the application", async ({
    page,
  }) => {
    await page.goto("/projects/proj_demo");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: /Bundle herunterladen/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^trustmebro-export_.*\.tmb$/);
  });

  test("appears in the project list once it exists", async ({ page }) => {
    await page.goto("/projects");
    await expect(
      page.getByRole("heading", { level: 1, name: "Projekte" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /proj_demo/ })).toBeVisible();
  });
});

test.describe("creating a project with no agent CLI installed", () => {
  /**
   * The trap this suite was written against.
   *
   * The wizard tells a user with nothing installed that the demo backend
   * needs neither installation nor account. The very next screen used to
   * default them to Claude Code anyway — it was the one action surface in
   * the application that rendered no backend diagnosis — so the natural path
   * of "accept the defaults" produced a project whose every model-backed
   * step is locked. Nothing crashed; the workbench explains it later. It was
   * simply the wrong screen to find out on.
   */
  test("says no CLI is ready and preselects the demo backend", async ({
    page,
  }) => {
    await page.goto("/projects/new");

    await expect(
      page.getByText(/Zurzeit ist keine Agenten-CLI einsatzbereit/),
    ).toBeVisible();
    await expect(page.getByLabel("Primäre Modellfamilie")).toHaveValue("mock");
    await expect(
      page.getByLabel("Zweite Modellfamilie (Divergenzregel)"),
    ).toHaveValue("");
    // The unusable options stay selectable — the diagnosis informs, it does
    // not decide — but each says what it is.
    await expect(
      page
        .getByLabel("Primäre Modellfamilie")
        .getByRole("option", { name: /Claude Code.*nicht einsatzbereit/ }),
    ).toBeAttached();
  });

  test("creates a working project when the defaults are accepted", async ({
    page,
  }) => {
    await page.goto("/projects/new");
    await page
      .getByLabel("Recherchefrage")
      .fill("Verbessert ein Prüfregister die Nachvollziehbarkeit?");
    // The id is minted from the question; take whatever it suggests, which
    // is what an evaluator does.
    const projectId = await page.getByLabel("Projekt-Id").inputValue();
    expect(projectId).toMatch(/^proj_/);

    await page.getByRole("button", { name: "Projekt anlegen" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}`));

    // It landed on disk under the id the form showed.
    expect(fs.existsSync(`${COLD_WORKSPACE}/${projectId}/claims.json`)).toBe(
      true,
    );
  });
});

test.describe("once the installation is configured", () => {
  test("the wizard stops intercepting and the project list is reachable", async ({
    page,
  }) => {
    // Second start of the application: "Later starts skip the wizard and go
    // straight to the project list."
    await page.goto("/projects");
    expect(new URL(page.url()).pathname).toBe("/projects");

    // A bare /setup no longer shows the wizard at all: it hands the
    // configured installation straight to its projects, so a bookmarked
    // wizard URL cannot strand a returning user on a form they already
    // completed.
    await page.goto("/setup");
    expect(new URL(page.url()).pathname).toBe("/projects");

    // The steps stay reachable when asked for explicitly, which is what the
    // settings page's "Einrichtungsassistent erneut öffnen" link relies on.
    await page.goto("/setup?step=1");
    await expect(
      page.getByRole("heading", { level: 1, name: "Ersteinrichtung" }),
    ).toBeVisible();
  });

  test("the settings page shows the handle that was configured", async ({
    page,
  }) => {
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { level: 1, name: "Einstellungen" }),
    ).toBeVisible();
    // In the editable field, not as prose: the settings page offers the
    // handle for change rather than merely displaying it.
    await expect(page.getByLabel("Akteurskürzel")).toHaveValue(HANDLE);
  });
});
