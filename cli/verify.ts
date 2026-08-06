import fs from "node:fs";
import path from "node:path";

import { verifyChain } from "../lib/register/chain";
import { ClaimsRegister } from "../lib/register/schema";

export interface VerifyReport {
  ok: boolean;
  messages: string[];
}

/**
 * Verifies a project directory's claims.json: schema validity plus hash-chain
 * gaplessness and closure. Depends only on schema and chain modules so it
 * works without the web application — the Git-independent verifiability the
 * file format promises recipients of an export bundle.
 */
export function runVerify(projectDir: string): VerifyReport {
  const claimsPath = path.join(projectDir, "claims.json");
  if (!fs.existsSync(claimsPath)) {
    return { ok: false, messages: [`no claims.json found in ${projectDir}`] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(claimsPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      messages: [`claims.json is not valid JSON: ${String(error)}`],
    };
  }

  const parsed = ClaimsRegister.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) =>
        `  schema violation at ${issue.path.join(".") || "<root>"}: ${issue.message}`,
    );
    return {
      ok: false,
      messages: ["claims.json violates the field schema:", ...issues],
    };
  }

  const result = verifyChain(parsed.data);
  if (!result.ok) {
    const errors = result.errors.map((error) => `  ${JSON.stringify(error)}`);
    return {
      ok: false,
      messages: [
        `hash chain INVALID (${result.entryCount} entries):`,
        ...errors,
      ],
    };
  }
  return {
    ok: true,
    messages: [
      `hash chain valid: ${result.entryCount} entries, gapless, closed to genesis`,
    ],
  };
}
