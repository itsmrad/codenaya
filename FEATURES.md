# Features

What Codenaya does today, from reading the code at `main` (`src/app`, `src/features`,
`convex/`, API routes). Statuses come from code reading, not a live end-to-end run.

Status: **Works** (complete code path) · **Partially works** (known gap) · **Broken** ·
**Unverified** (code exists, not confirmed against live services).

Base services for every flow: Clerk (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
`CLERK_SECRET_KEY`, `CLERK_JWT_ISSUER_DOMAIN` in Convex), Convex (`NEXT_PUBLIC_CONVEX_URL`,
`CONVEX_DEPLOYMENT`), and `CODENAYA_CONVEX_INTERNAL_KEY` set in both Next.js and Convex.

## Known issues

- `npm run build` fails without `FIRECRAWL_API_KEY`: `src/lib/firecrawl.ts` constructs the
  client at module load, and it is imported by `/api/quick-edit`, the agent `scrape-urls`
  tool and `src/inngest/functions.ts`.
- `/projects/[projectId]` raises "useSelectedLayoutSegments() in Client Component outside
  `<Suspense>`" (Next 16 cache components).
- Editor AI routes (`/api/suggestion`, `/api/quick-edit`) call `@ai-sdk/openai` directly, so
  they need `OPENAI_API_KEY`, which is not listed in `.env.example` (the agent uses OpenRouter).

## 1. Core user flows

**F1. Sign in / sign out**: Works
- Steps: open `/` → landing page → sign in with Clerk → land on the dashboard.
- Code: `src/app/page.tsx`, `src/components/landing/*`, `features/auth/*`, `convex/auth.ts`.

**F2. Projects dashboard and command palette**: Works
- Steps: signed-in `/` → list or search projects → Cmd+K command palette → open a project.
  Cmd+I opens GitHub import and Cmd+J opens New project. Trending showcase is on the same page.
- Code: `projects-view.tsx`, `projects-list.tsx`, `projects-command-dialog.tsx`; `projects.get`.

**F3. Create project from prompt**: Works
- Steps: New project dialog → enter prompt → project and conversation are created → redirect to
  the IDE while the agent starts generating.
- Code: `new-project-dialog.tsx` → `POST /api/projects/create-with-prompt` →
  `system.createProjectWithConversation`, `system.createMessage` → `dispatchProcessMessage`
  (`src/lib/message-processor.ts`). Prompts containing credentials are rejected (422).
- Env: Inngest (dev server or cloud), `OPENROUTER_API_KEY`.

**F4. Open project IDE**: Partially works
- Steps: `/projects/[projectId]` → navbar (rename, save status, integrations, publish,
  export) → Editor / Preview tabs, with the chat sidebar.
- Code: `src/app/projects/[projectId]/page.tsx`, `project-id-layout.tsx`, `project-id-view.tsx`;
  `projects.getById`, `projects.rename`.
- Gap: the Suspense / cache-components error above.

**F5. Chat → AI agent generates and edits files**: Works
- Steps: type a message in the chat sidebar → the assistant message streams status → files are
  created, updated, renamed or deleted in real time. Users can cancel a run and reopen past
  conversations. A new message cancels any run in progress.
- Code: `conversation-sidebar.tsx`, `past-conversations-dialog.tsx` → `POST /api/messages`,
  `POST /api/messages/cancel` → Inngest `process-message` (AgentKit, tools in
  `features/conversations/inngest/tools/*`: list, read, create, update, rename, delete files,
  create folder, scrape URLs, set env var) → `convex/system.ts` writes.
- Fallback: `MESSAGE_PROCESSOR=workflow` routes to the Vercel Workflow implementation
  (`features/conversations/workflow/*`, Google Vertex). It falls back to Inngest when Vertex
  env is missing. Fallback status: Unverified.
- Env: `OPENROUTER_API_KEY`, Inngest; optional `FIRECRAWL_API_KEY` (URL scraping); optional
  `GOOGLE_VERTEX_PROJECT`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`.

**F6. File explorer and code editor**: Works
- Steps: browse the tree → create, rename or delete files and folders → edit in CodeMirror
  (language modes, minimap, breadcrumbs, tabs) → changes save to Convex.
- Code: `features/projects/components/file-explorer/*`, `features/editor/*`; `convex/files.ts`
  (`getFolderContents`, `createFile`, `createFolder`, `renameFile`, `deleteFile`, `updateFile`).

**F7. AI inline suggestions and Cmd+K quick edit**: Partially works
- Steps: type → a ghost-text suggestion appears → Tab accepts it. Select code → Cmd+K →
  instruction → the selection is replaced.
- Code: `editor/extensions/suggestion/*` → `POST /api/suggestion` (gpt-4o-mini);
  `editor/extensions/quick-edit/*`, `selection-tooltip.ts` → `POST /api/quick-edit` (gpt-4o,
  scrapes URLs in the instruction through Firecrawl).
- Gap: needs the undocumented `OPENAI_API_KEY` and does not go through OpenRouter.

**F8. Live preview with terminal**: Works (E2B) / Unverified (WebContainer)
- Steps: Preview tab → sandbox boots, writes files, installs, starts the dev server → iframe plus
  streaming terminal; restart, open in a new tab, and edit install/dev commands in settings.
  `?engine=webcontainer` switches to the in-browser engine, with an automatic fallback.
- Code: `preview-view.tsx`; `features/sandbox-preview/*` → `POST /api/sandbox`,
  `/api/sandbox/[sandboxId]` (NDJSON stream; secrets are injected server-side and redacted from
  output); `features/webcontainer-preview/*` (public env vars only);
  `projects.updateSettings`; COOP/COEP headers in `next.config.ts`.
- Env: `E2B_API_KEY`.

**F9. Import from GitHub**: Partially works
- Steps: dashboard → Import → paste repo URL → Inngest job copies files (binary files go to
  Convex storage) → import status is shown in the navbar.
- Code: `import-github-dialog.tsx` → `POST /api/github/import` → Inngest `import-github-repo`
  → `system.createFile`, `createBinaryFile`, `updateImportStatus`.
- Gap: requires a Clerk `pro` plan (`has({ plan: "pro" })`) and a GitHub OAuth account linked
  in Clerk. It returns 403 unless Clerk Billing is configured.

**F10. Export to GitHub**: Partially works
- Steps: navbar Export → repo name → Inngest job creates the repo and pushes files → status
  shown, with cancel and reset.
- Code: `export-popover.tsx` → `POST /api/github/export` (plus `/cancel`, `/reset`) → Inngest
  `export-to-github` → `system.updateExportStatus`.
- Gap: the same `pro` plan and Clerk GitHub OAuth gating as F9.

**F11. Showcase: publish, browse, vote, remix**: Works
- Steps: navbar Publish → title, tags, screenshot → listed in the showcase. Others browse
  trending or search results, open the detail view (counts a view), upvote, or import it into
  their workspace.
- Code: `features/showcase/*`; `convex/showcase.ts` (`publish`, `search`, `getTrending`, `vote`,
  `incrementView`, `importToWorkspace`).

**F12. Integrations (API key, OAuth PKCE, MCP tools with approval)**: Unverified
- Steps: Integrations dialog → choose a provider (Supabase, Neon, GitHub MCP, and others) →
  connect with an API key or an OAuth popup → link it to the project with a scope → the agent
  gets the MCP tools. Write or destructive calls pause for approval in the chat (approve or deny).
- Code: `features/integrations/components/*`, `catalog.ts`, `server/{oauth,mcp,crypto}/*`;
  `/api/integrations/connect`, `/api/integrations/oauth/{start,callback}`;
  `convex/integrations.ts`, `convex/crons.ts` and `maintenance.ts` (pruning).
- Env: `CODENAYA_LOCAL_KEK` (or `CODENAYA_KEK_PROVIDER=gcp-kms` + `CODENAYA_GCP_KMS_KEY`),
  `INTEGRATIONS_REDIRECT_URI`. Unit-tested (crypto, OAuth, URL guards, approval); live
  providers not verified.

**F13. Project environment variables**: Partially works
- Steps: the agent calls `set-env-var`. `NEXT_PUBLIC_*` keys are stored as public, everything
  else as sealed secrets. Public vars reach WebContainer; all vars reach E2B. The preview shows
  how many secrets were withheld.
- Code: `inngest/tools/set-env-var.ts`, `convex/envVars.ts`, `system.setSecretEnvVar`,
  `server/env/resolve-env.ts`.
- Gap: there is no UI to view, add or delete env vars. `useEnvVars`, `useSetPublicEnvVar` and
  `useDeleteEnvVar` exist but nothing renders them.

## 2. Missing compared with v0 and Lovable

P1 = expected in a demo, simple to build. P2 = nice to have.

| # | Feature | Priority | Simple approach |
|---|---------|----------|-----------------|
| M1 | Version history and restore of agent edits | P1 | Before each agent run, snapshot the project's files into a `checkpoints` table keyed by message; "Restore" in the chat replaces the files with the snapshot. |
| M2 | Download project as ZIP | P1 | Client-side `jszip` over the project's files (binary files via storage URLs), as a button in the export popover. No Pro gate. |
| M3 | Responsive device toggle in preview | P1 | Desktop / tablet / mobile buttons that set the preview iframe width. |
| M4 | Image or screenshot input in chat | P1 | Upload to Convex storage, store the id on the message, and pass it as an image part to a vision-capable OpenRouter model. |
| M5 | Starter templates gallery | P2 | Seed a few showcase entries and reuse `importToWorkspace`. |
| M6 | Share or preview link | P2 | Read-only public route for a published project. Showcase covers part of this. |
| M7 | One-click deploy (Vercel or Netlify) | P2 | Needs the provider API, OAuth and build handling. |
| M8 | Visual select-to-edit in preview | P2 | Needs an injected inspector script and a source-mapping layer. |

## 3. Out of scope

- Scaling and performance: sandbox pooling and warm starts, concurrent-sandbox limits, scaling
  Inngest workers, Convex index tuning and virtualised trees for very large repos, CDN, load tests.
- Multi-user real-time collaboration (shared cursors, presence).
- Usage metering, quotas and billing beyond the existing Clerk `pro` check.
- Multi-region deployment and production observability dashboards.
