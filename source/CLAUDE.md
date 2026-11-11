@AGENTS.md

# Working rules

## Project
- A-Border SEO: self-hosted SEO and GEO monitoring. Next.js 16 (App Router), TypeScript, Prisma 6 on PostgreSQL 16, Auth.js v5, Tailwind CSS v4, Vitest.
- UI text is bilingual: wrap visible strings with `t("English", "中文")` or the shared `ui(...)` table in `components/ui/ui-text.ts`.

## Database
- Migrations are explicit and applied in folder-name order (PGlite tests apply the same chain). Add a new migration for every schema change; never edit one that has shipped.
- The image never migrates on start. Compose runs `migrate deploy` before the app; the Windows kit backs up first.

## Boundaries
- Every external host in code must be listed in `outbound-hosts.json`, and every requested host in the README section "数据与外部连接". `lib/outbound-hosts.test.ts` enforces it.
- MCP and `/api/v1` are read-only: no tool or endpoint there writes, queues or triggers anything.
- The local content worker runs Codex read-only with no tools and never falls back to an API key.
- Custom deployment code goes in `extensions/index.ts` only.

## Verification
- `npx tsc --noEmit` and `npm test` before every commit. Limit workers in repeated runs: `npx vitest run --pool=forks --maxWorkers=1 <files>`.
- Stop every throwaway server, container or background loop you started.

## Standing rules
- Never print or commit secrets; use placeholder values for env vars in builds and tests.
- No em dashes in UI, docs or comments.
