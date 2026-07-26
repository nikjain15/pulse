# CLAUDE.md

This repository's contributor and agent guidance lives in [AGENTS.md](AGENTS.md).
Read it for setup, testing, conventions, project structure, and PR rules.

## Notes for Claude Code

The rules and integration tests require the Firebase emulator, which needs Java 11+. Run `npm run gate` before proposing a merge; it covers typecheck, lint, and the emulator-backed suites. Never add a `NEXT_PUBLIC_` prefix to `ANTHROPIC_API_KEY` or `GITHUB_TOKEN`: they are server-only secrets.
