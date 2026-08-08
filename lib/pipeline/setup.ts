import fs from "node:fs";

import {
  getWorkspaceRoot,
  isIdentityConfigured,
  isValidActorKuerzel,
  writeIdentityConfig,
} from "../identity";
import { InvalidIdentityInputError } from "./errors";

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
 * Validates and persists the actor kuerzel and eagerly creates the
 * workspace root, so the first run leaves both configuration and workspace
 * behind (TMB-48 acceptance: "First-Run-Setup erzeugt Workspace und
 * Konfiguration").
 */
export function completeFirstRunSetup(input: { actorKuerzel: string }): void {
  const kuerzel = input.actorKuerzel.trim();
  if (!isValidActorKuerzel(kuerzel)) {
    throw new InvalidIdentityInputError(
      `Kürzel "${input.actorKuerzel}" ist ungültig – erlaubt sind ` +
        'Kleinbuchstaben, Ziffern, "_" und "-" (Beginn mit Buchstabe oder Ziffer).',
    );
  }
  writeIdentityConfig({ actorKuerzel: kuerzel });
  fs.mkdirSync(getWorkspaceRoot(), { recursive: true });
}
