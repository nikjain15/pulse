# Pulse

The board that updates itself: it senses the work from GitHub, banks how each problem got solved, and hands that to the next person who gets stuck.

## Project overview

Pulse is an AI-first task board for a developer cohort. Instead of asking people to type status updates, it reads their public commits and pull requests and writes each week in plain English, then extracts reusable solutions and connects members who are stuck with peers who already solved the same thing. It is built for the Hult Cohort Developer Program pilot, where roughly 65 people run coding agents against public repositories, so their status is already legible and nobody should have to type it in.

## Tech stack

- Next.js 16 (App Router) with TypeScript.
- React 19 and Tailwind CSS 4.
- Firebase Auth (GitHub OAuth plus email/password) and Cloud Firestore, realtime via `onSnapshot`.
- Firebase Admin SDK and the Firebase emulator suite for server paths and tests.
- Anthropic Claude (`@anthropic-ai/sdk`), called only from server-side route handlers, for narration.
- Vitest for unit, rules, and integration tests; Playwright for end-to-end.
- Vercel for deployment; Vercel Analytics for metrics.

## Setup

Requires Node 20.9+ (the Next 16 floor). Java 11+ is needed only for the Firebase emulator, not for the app itself.

```bash
npm install
cp .env.example .env.local
npm run dev                 # http://localhost:3000
```

Fill `.env.local` with the six `NEXT_PUBLIC_FIREBASE_*` values from a Firebase web app. `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` are server-side only and optional; without them the board, projects, and feed all work, and only narration and the logged-out pre-index are skipped.

To run the whole app locally with no Firebase console access or account, use the emulator:

```bash
npm run emulator            # terminal 1: Firestore + Auth on 8080 / 9099
npm run dev:emulator        # terminal 2: app pointed at the emulator
```

## Build

```bash
npm run build               # next build (production build)
npm run start               # next start (serve the production build)
```

## Testing

Every command below is part of the regression suite. Run `npm run gate` before opening a pull request.

```bash
npm run typecheck           # tsc --noEmit
npm run lint                # eslint
npm run test:unit           # vitest, unit project: pure logic, no network
npm run test:rules          # vitest, rules project: firestore.rules against the emulator
npm run test:integration    # vitest, integration project: real lib functions against the emulator
npm run test:e2e            # Playwright full project against the emulator
npm run test:e2e:managed    # Playwright full project against an already-running server
npm run test:e2e:smoke      # Playwright smoke project against the deployed URL
npm run test:drift          # contract-drift audit (scripts/audit/contract-drift.mjs)
npm run test:cross-app      # contract-drift plus shared-context and cross-app regression tests
npm run test:scale          # scale run against the emulator (scripts/scale/run.mjs)
npm run gate                # typecheck, lint, test:unit, test:rules, test:integration, test:e2e:smoke
```

The rules tests are the highest-value tests here: `firestore.rules` encodes the product's ethical promises, and every attack is asserted denied. The integration and e2e suites run against the emulator, never production, because test fixtures are not product seed data.

## Code style and conventions

- TypeScript in strict mode (`tsconfig.json`), targeting ES2017 with the bundler module resolution.
- Linting via ESLint 9 using `eslint-config-next` (core-web-vitals plus TypeScript rules). Fix all lint and type errors before committing.
- Import alias `@/*` maps to the repo root; use `@/lib/...` rather than long relative paths. Vitest mirrors this alias in `vitest.config.ts`.
- Pure, testable logic is split out from modules that need live Firebase config so unit tests can load it without credentials (for example `recipe-index.ts` beside `recipes.ts`).
- User-facing strings follow `VOICE.md`; the design system lives in `DESIGN-SPEC.md`.
- Secrets are read only inside route handlers; nothing secret is ever prefixed with `NEXT_PUBLIC_`.

## Project structure

```
app/            Next.js App Router pages and API routes.
  signin/       GitHub OAuth plus email/password.
  board/        Three columns; builds itself from GitHub.
  projects/     Project list and archive toggle; [id] is a project's own board.
  recipes/      Banked solutions indexed by problem; [id] is one recipe.
  connect/      GitHub connection flow.
  settings/, how/, approach/, opt-out/, recipes/, api/  Supporting pages and endpoints.
  api/          Server-side route handlers: sense, narrate, ask-pulse, brief, broker,
                connections, context, extract-recipe, opt-out. These hold the secrets.
components/      React UI: AppShell, Board, Home, Landing, TaskCard, TaskModal,
                ProjectModal, RecipeModal, AskPulse, and shared primitives in ui.tsx.
lib/            Domain logic. types.ts is authoritative for the data model
                (Member, Project, Task, PulseEvent, Recipe, Introduction, and more).
                pulse.ts, data.ts, sync.ts, sense.ts, recipes.ts, narrate.ts,
                broker.ts, and the firebase/auth wiring live here.
tests/          unit/, rules/, integration/ (Vitest) and e2e/ (Playwright).
scripts/        audit/ (contract-drift) and scale/ (load runs).
evals/          Runnable, production-safe eval for the prompt-injection guard.
docs/           PRD, ARCHITECTURE, EVALS, TECHNICAL_NOTES, FDE_JOURNEY.
firestore.rules Firestore security rules: the product's promises, enforced.
```

## Commit and PR guidelines

- Branch off `main` for each change; keep branches focused.
- Write clear, imperative commit messages describing the change.
- All checks must pass before merge: run `npm run gate` locally and ensure typecheck, lint, and the test suites are green.
- Keep pull requests scoped to one concern, and describe the rationale for any security-relevant or model-facing change.

## Security and secrets

- Public config: the six `NEXT_PUBLIC_FIREBASE_*` values ship in the client bundle by design. Access is controlled by `firestore.rules`, not by hiding them.
- Secret config: `ANTHROPIC_API_KEY` (server-side narration) and `GITHUB_TOKEN` (reading the public cohort repo for the logged-out pre-index) are read only from route handlers. Never prefix either with `NEXT_PUBLIC_`, which would inline them into the bundle and serve them to every visitor.
- Feature flag: `PEER_INDEX_ENABLED` gates pre-indexing public cohort members before they sign up.
- Prompt injection is treated as live: commit messages, PR titles, and branch names are attacker-controllable, so every generated field is validated (a narrative may only describe its own actor) and never rendered as raw HTML before it publishes.
- Configure secrets in `.env.local` for local work and in the Vercel project settings for deploys. See `.env.example` for the full list and the reasoning behind each variable.
