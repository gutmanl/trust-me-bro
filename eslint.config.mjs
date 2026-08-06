import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The domain core must stay usable without a web context (Grobentwurf:
    // it is also consumed by the standalone CLI), so it may not depend on
    // the Next.js route layer.
    files: ["lib/**/*.ts", "cli/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/app", "@/app/*", "**/app/*"],
              message:
                "The domain core (lib/, cli/) must not import from app/.",
            },
          ],
        },
      ],
    },
  },
  {
    // Actor identity and workspace root are encapsulated in lib/identity —
    // the designed seam for a later multi-user architecture. All other code
    // must go through its API instead of reading the environment.
    files: ["lib/**/*.ts", "cli/**/*.ts"],
    ignores: ["lib/identity/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message: "Read configuration via lib/identity, not process.env.",
        },
      ],
    },
  },
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "workspace/**",
    "coverage/**",
  ]),
]);

export default eslintConfig;
