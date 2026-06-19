# Repository Guidelines

## Project Structure & Module Organization

This is a private TypeScript/Vite React app for a local Ticketboard dashboard. Client code lives in `src/`: `App.tsx` contains the main UI, `main.tsx` mounts React, `types.ts` defines shared client-side shapes, and `styles.css` holds global styling. Server-side data collection and API routes live in `server/`, with `server/index.ts` starting Express plus Vite middleware and `server/collectors.ts` gathering GitHub, Linear, tmux, Codex, and worktree data. Browser verification lives in `scripts/verify-ui.mjs`. Build output is generated into `dist/` and should not be edited by hand.

## Build, Test, and Development Commands

- `pnpm install`: install dependencies from `pnpm-lock.yaml`.
- `pnpm dev`: run the local Express/Vite server, defaulting to `http://localhost:4317`.
- `pnpm build`: produce the production Vite bundle in `dist/`.
- `pnpm typecheck`: run `tsc --noEmit` with strict TypeScript settings.
- `pnpm lint`: run ESLint across the repository, excluding `dist` and `node_modules`.
- `TICKETBOARD_URL=http://localhost:4317 pnpm verify:ui`: run Playwright smoke checks against a running server.

Useful local overrides are documented in `README.md`, including `PHOEBE_REPO_PATH`, `TICKETBOARD_REPO`, and `PORT`.

## Coding Style & Naming Conventions

Use TypeScript modules and React function components. Follow the existing two-space indentation, single quotes, semicolons, and trailing commas for multiline imports, objects, and arrays. Prefer explicit domain types in `src/types.ts` and `server/types.ts` over untyped objects. Keep component and type names in `PascalCase`, functions and variables in `camelCase`, and constants in `UPPER_SNAKE_CASE` when they represent fixed configuration.

## Testing Guidelines

There is no unit test framework configured yet. For changes that affect behavior, run `pnpm typecheck` and `pnpm lint`. For UI or API contract changes, start `pnpm dev` and run `TICKETBOARD_URL=http://localhost:4317 pnpm verify:ui`; this script exercises dashboard API responses and captures desktop/mobile screenshots under `/tmp/`.

## Commit & Pull Request Guidelines

This directory does not currently include Git metadata, so no local commit history is available to infer a project-specific convention. Use concise, imperative commit subjects such as `Add PR detail panel` or `Fix worktree status parsing`. Pull requests should describe the user-visible change, list validation commands run, call out new environment variables, and include screenshots for meaningful UI changes.

## Security & Configuration Tips

Do not commit local tokens, absolute private paths beyond documented examples, or generated screenshots. Keep environment-specific settings in shell variables rather than source files.
