# Vendored Claude Code assets

`commands/feature-dev.md` and `agents/{code-explorer,code-architect,code-reviewer}.md`
are copied verbatim from Anthropic's official `feature-dev` plugin
(marketplace `claude-plugins-official`). They are vendored here because
locally installed plugins do not travel to cloud sessions — a cloud checkout
of this repo only sees what lives under `.claude/`, and without these files
`/feature-dev` and its three agents were unavailable there.

The names lose the plugin prefix on purpose: installed as project assets
they are addressed as `/feature-dev` and plain `code-explorer` /
`code-architect` / `code-reviewer`. Locally the plugin may be installed in
parallel; the duplication is harmless.

To update: re-copy from the plugin cache
(`~/.claude/plugins/cache/claude-plugins-official/feature-dev/`).
