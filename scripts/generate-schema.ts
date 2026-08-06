/**
 * Regenerates schema/claims.schema.json from the zod model.
 * Run via `npm run generate:schema`; the test suite asserts the committed
 * artifact is up to date.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRegisterJsonSchema,
  serializeJsonSchema,
} from "../lib/register/schema/json-schema";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const target = path.join(repoRoot, "schema", "claims.schema.json");

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(
  target,
  serializeJsonSchema(buildRegisterJsonSchema()),
  "utf8",
);
console.log(`wrote ${path.relative(repoRoot, target)}`);
