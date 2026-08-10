import fs from "node:fs";
import path from "node:path";

import {
  getUnpaywallSetting as identityGetUnpaywallSetting,
  getWorkspaceRoot,
  getWorkspaceRootSetting as identityGetWorkspaceRootSetting,
  isIdentityConfigured,
  isValidActorHandle,
  writeIdentityConfig,
  writeUnpaywallEmail,
  writeWorkspaceRoot,
} from "../identity";
import type { UnpaywallSetting } from "../identity";
import { InvalidIdentityInputError } from "./errors";

/** Simple shape check, not a full RFC 5322 validator — good enough to catch
 * typos before they are sent to Unpaywall with every lookup. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * First-run setup use-cases (TMB-47/48). Thin wrappers so the web layer
 * never imports lib/identity directly — the pinned app-boundary allowlist
 * stays "@/lib/pipeline only".
 */

/** Whether the setup gate (proxy.ts) should let requests through. */
export function isSetupComplete(): boolean {
  return isIdentityConfigured();
}

/**
 * Validates and persists the actor handle and eagerly creates the
 * workspace root, so the first run leaves both configuration and workspace
 * behind (TMB-48 acceptance: "First-Run-Setup erzeugt Workspace und
 * Konfiguration").
 */
export function completeFirstRunSetup(input: { actorHandle: string }): void {
  const handle = input.actorHandle.trim();
  if (!isValidActorHandle(handle)) {
    throw new InvalidIdentityInputError(
      `Kürzel "${input.actorHandle}" ist ungültig – erlaubt sind ` +
        'Kleinbuchstaben, Ziffern, "_" und "-" (Beginn mit Buchstabe oder Ziffer).',
    );
  }
  writeIdentityConfig({ actorHandle: handle });
  fs.mkdirSync(getWorkspaceRoot(), { recursive: true });
}

/**
 * The currently effective workspace root and where it comes from (TMB-54) —
 * the wizard's second step shows it and offers to change it.
 */
export function getWorkspaceRootSetting(): {
  root: string;
  source: "env" | "config" | "default";
} {
  return identityGetWorkspaceRootSetting();
}

/**
 * Persists the workspace root (TMB-54, D5). Deliberately a FIRST-RUN
 * capability: moving the root once projects exist would orphan them, and
 * migrating them is out of scope — so the use-case refuses rather than
 * relying on the wizard being the only caller. An env-provided root is
 * refused outright, mirroring setUnpaywallEmail.
 */
export function setWorkspaceRoot(root: string): void {
  if (identityGetWorkspaceRootSetting().source === "env") {
    throw new InvalidIdentityInputError(
      "Das Arbeitsverzeichnis ist über die Umgebungsvariable TMB_WORKSPACE " +
        "gesetzt und kann nicht über die Oberfläche geändert werden.",
    );
  }
  const trimmed = root.trim();
  if (trimmed.length === 0) {
    throw new InvalidIdentityInputError(
      "Das Arbeitsverzeichnis darf nicht leer sein.",
    );
  }
  const current = getWorkspaceRoot();
  if (fs.existsSync(current)) {
    const hasProjects = fs
      .readdirSync(current, { withFileTypes: true })
      .some(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(path.join(current, entry.name, "claims.json")),
      );
    if (hasProjects) {
      throw new InvalidIdentityInputError(
        "Das Arbeitsverzeichnis lässt sich nur vor dem ersten Projekt " +
          "festlegen – ein Wechsel würde die vorhandenen Projekte " +
          "zurücklassen. Verschieben Sie die Projektordner von Hand, wenn " +
          "ein anderer Ort nötig ist.",
      );
    }
  }
  writeWorkspaceRoot(trimmed);
  fs.mkdirSync(getWorkspaceRoot(), { recursive: true });
}

/**
 * The currently effective Unpaywall setting (reference auto-import, Task
 * 3b/4): thin wrapper so the web layer never imports lib/identity directly,
 * mirroring isSetupComplete()'s relationship to isIdentityConfigured(). The
 * reference-import panel and the /setup form both read this to decide
 * between the "configure" form and the read-only "provided by environment"
 * status.
 */
export function getUnpaywallSetting(): UnpaywallSetting {
  return identityGetUnpaywallSetting();
}

/**
 * Sets or clears the Unpaywall contact address (reference auto-import, Task
 * 3b/Amendment 2): installation-level configuration like the actor handle,
 * so it is stored in the same config file. `email` null or empty clears the
 * setting — the document-url derivation then simply skips the Unpaywall
 * step, no error. An env-provided address is never writable from here: the
 * UI renders read-only in that case, but this use-case also refuses the
 * write outright rather than trusting that convention alone.
 */
export async function setUnpaywallEmail(email: string | null): Promise<void> {
  if (identityGetUnpaywallSetting().source === "env") {
    throw new InvalidIdentityInputError(
      "Die Unpaywall-Adresse ist über die Umgebungsvariable " +
        "TMB_UNPAYWALL_EMAIL gesetzt und kann nicht über die Oberfläche " +
        "geändert werden.",
    );
  }
  const trimmed = email?.trim() || null;
  if (trimmed !== null && !EMAIL_PATTERN.test(trimmed)) {
    throw new InvalidIdentityInputError(
      `"${trimmed}" ist keine gültige E-Mail-Adresse.`,
    );
  }
  writeUnpaywallEmail(trimmed);
}
