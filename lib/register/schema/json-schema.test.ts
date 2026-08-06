import fs from "node:fs";
import path from "node:path";

import { Ajv2020 } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  buildEvidenceJsonSchema,
  buildJudgmentJsonSchema,
  buildRegisterJsonSchema,
  serializeJsonSchema,
} from "./json-schema";
import exampleProject from "./__fixtures__/example-project.json";

const committedSchemaPath = path.resolve(
  __dirname,
  "../../../schema/claims.schema.json",
);

describe("JSON Schema export", () => {
  it("is deterministic: two builds serialize byte-identically", () => {
    expect(serializeJsonSchema(buildRegisterJsonSchema())).toBe(
      serializeJsonSchema(buildRegisterJsonSchema()),
    );
  });

  it("matches the committed schema/claims.schema.json (run npm run generate:schema after model changes)", () => {
    const committed = fs.readFileSync(committedSchemaPath, "utf8");
    expect(committed).toBe(serializeJsonSchema(buildRegisterJsonSchema()));
  });

  it("accepts the example project via ajv (no drift between zod and JSON Schema)", () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(buildRegisterJsonSchema());
    const valid = validate(exampleProject);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it("exports evidence and judgment sub-schemas standalone", () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    expect(
      ajv.compile(buildEvidenceJsonSchema())(
        exampleProject.claims[0].evidence[0],
      ),
    ).toBe(true);
    expect(
      ajv.compile(buildJudgmentJsonSchema())(
        exampleProject.claims[0].evidence[0].judgments[0],
      ),
    ).toBe(true);
  });
});
