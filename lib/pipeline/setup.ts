import fs from "node:fs";

import {
  getWorkspaceRoot,
  isIdentityConfigured,
  isValidActorHandle,
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
