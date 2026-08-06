/**
 * Pure placeholder interpolation for prompt templates. Both directions are
 * strict: a placeholder without a variable and a variable without a
 * placeholder are errors — silent half-rendered prompts would surface as
 * confusing LLM output instead of a build-time failure.
 */
const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

export function substitute(
  template: string,
  vars: Record<string, string>,
): string {
  const placeholders = new Set(
    [...template.matchAll(PLACEHOLDER)].map((match) => match[1]),
  );
  const missing = [...placeholders].filter((name) => !(name in vars));
  if (missing.length > 0) {
    throw new Error(
      `template placeholders without variables: ${missing.join(", ")}`,
    );
  }
  const unused = Object.keys(vars).filter((name) => !placeholders.has(name));
  if (unused.length > 0) {
    throw new Error(
      `variables without template placeholders: ${unused.join(", ")}`,
    );
  }
  return template.replace(PLACEHOLDER, (_, name: string) => vars[name]);
}
