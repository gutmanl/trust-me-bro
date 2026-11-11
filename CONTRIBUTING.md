# Contributing to TrustMeBro

Thanks for your interest. TrustMeBro is maintained by a single author; issues
and pull requests are welcome.

## Getting set up

```sh
cp .env.example .env
npm install
npm run dev
```

Node.js 20.9 or newer is required. No agent CLI and no account are needed to
work on most of the code: choose the demonstration backend in the setup
wizard, and the test suites replay recorded responses instead of calling the
network.

## Before you open a pull request

`npm run check` must pass. It runs lint, the format check, the strict
typecheck and the tests with coverage thresholds — the same steps CI runs on
Ubuntu and Windows. While iterating, `npx vitest run <path>` is faster.

A few rules are worth knowing up front, because they are enforced rather than
merely recommended:

- **Code is English, the user-facing display tier is German.** Identifiers,
  enum values, comments and docs are English; UI copy, user-facing error
  messages and the generated `briefing.md` are German on purpose. Do not
  translate either tier into the other.
- **`tests/architecture.test.ts` is binding.** It pins the layer boundaries,
  the public surface of each `lib/*` barrel and the claim status transition
  table. If your change makes it fail, change the design, or change code and
  test deliberately together — do not weaken the test to get green.
- **`schema/claims.schema.json` is generated.** Run `npm run generate:schema`
  instead of editing it by hand.
- **Prompt templates are versioned files and never edited in place.** A
  changed prompt is a new version under `lib/adapters/prompts/<kind>/`.
- **The register is append-only and hash-chained.** All writes go through
  `store.transaction(...)`; network and model calls happen before the
  transaction, never inside it.
- **Coverage thresholds are a ratchet.** Raise them as coverage grows, never
  lower them to make a change pass.

[ARCHITECTURE.md](ARCHITECTURE.md) describes the layering and the reasons
behind it.

## Do not commit

Credentials, `.env` files, anything from your `workspace/` directory, or
third-party documents. Test data that derives from real runs must contain no
actor handles and no personal data.

## Licence

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
