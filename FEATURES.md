# Features

What Codenaya does today, from reading the code at `main` (`src/app`, `src/features`,
`convex/`, API routes). Statuses come from code reading, not a live end-to-end run.

Status: **Works** (complete code path) · **Partially works** (known gap) · **Broken** ·
**Unverified** (code exists, not confirmed against live services) · **Missing**.

Base services for every flow: Clerk (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
`CLERK_SECRET_KEY`, `CLERK_JWT_ISSUER_DOMAIN` in Convex, `CLERK_WEBHOOK_SECRET` for the
user-sync webhook in `convex/http.ts`), Convex (`NEXT_PUBLIC_CONVEX_URL`,
`CONVEX_DEPLOYMENT`), and `CODENAYA_CONVEX_INTERNAL_KEY` set in both Next.js and Convex.

E2E: specs live in `e2e/`. Most signed-in specs skip themselves without the Clerk keys, and
CI (`.github/workflows/ci.yml`) runs tsc, lint, unit tests and build but no e2e. Coverage
gaps are tracked in #236.

## Known issues

Open bugs only. Gaps found in code without an issue are listed on the flow itself.

- #259: file/folder delete and checkpoint restore have no confirm or undo; the ⌘Backspace
  hint does nothing.
- #260: project "Copy link" copies an owner-only URL; there is no read-only share link.
- #261: integrations have no Reconnect for expired or revoked connections, Settings can't
  link a connection to a project, and last-used is never recorded.

## 1. Core user flows

**F1. Sign in / sign out**: Works
- Steps: signed-out `/` → landing page → Log in / Sign up (Clerk `<SignIn/>`, `<SignUp/>`) →
  land on the dashboard (or on `redirect_url`). Sign out from the user menu.
- Code: `src/app/page.tsx`, `src/app/(auth)/*`, `src/components/landing/*`,
  `src/components/user-menu.tsx`, `features/auth/*` (`ConvexAuthBoundary`,
  `useEnsureCurrentUser` → `users.ensureCurrent`), `convex/auth.ts` (`verifyAuth`),
  `convex/http.ts` (`/clerk-users-webhook`).
- E2E: `auth-routes.spec.ts`, `landing.spec.ts`, `marketing-navbar.spec.ts`.

**F2. Projects dashboard and command palette**: Works
- Steps: signed-in `/` → "What will you build?" composer → projects grid (search, sort by
  Last edited / Newest / Name) → starter templates → trending showcase rail. Cmd+K opens the
  project palette, Cmd+I opens GitHub import, Cmd+J opens New project.
- Code: `projects-view.tsx` (shortcuts), `prompt-composer.tsx`, `projects-grid.tsx`,
  `project-card.tsx`, `projects-command-dialog.tsx`, `showcase/components/community-rail.tsx`;
  `projects.get`, `showcase.getTrending`.
- E2E: `dashboard-composer.spec.ts`, `dashboard-responsive.spec.ts`.
- Gap: no e2e presses Cmd+I.

**F3. Create project from prompt**: Works
- Steps: dashboard composer or New project dialog (starter chips, Enhance, model picker) →
  project and conversation are created → redirect to the IDE while the agent starts
  generating. A signed-out landing prompt is saved and submitted after sign-up (#108).
- Code: `prompt-composer.tsx`, `new-project-dialog.tsx`, `use-create-project-from-prompt.ts`
  → `POST /api/projects/create-with-prompt` → `system.createProjectWithConversation`,
  `system.createMessage` → `dispatchProcessMessageOrFail` (`src/lib/message-processor.ts`).
  Landing: `landing/landing-prompt-composer.tsx` (`savePendingPrompt` /
  `takePendingPrompt`). Prompts containing credentials are rejected (422). Dispatch failure
  returns 502 and the project still opens.
- Env: Inngest (dev server or cloud), the active platform provider's key (`NEXT_PUBLIC_AI_PROVIDER`, default `openrouter`; ADR 0005), or a BYOK key (F17).
- E2E: `dashboard-composer.spec.ts`, `landing-prompt.spec.ts`.

**F4. Open project IDE**: Works
- Steps: `/projects/[projectId]` → navbar (project name and actions menu, save status, view
  tabs, Publish / Published, Integrations, Skills, Export, Help, user menu) → Code / Preview
  tabs with the chat as a side pane on desktop; Chat / Code / Preview tabs on tablet and phone
  (bottom bar on phone). `?view=preview` opens the preview.
- Code: `src/app/projects/[projectId]/page.tsx` (Suspense boundary), `error.tsx`,
  `project-id-layout.tsx`, `project-id-view.tsx`; `projects.getById`.
- E2E: `ide-shell.spec.ts`, `ide-polish.spec.ts`, `not-found.spec.ts`.

**F5. Chat → AI agent generates and edits files**: Works
- Steps: type a message in the chat sidebar (Enter sends, Shift+Enter new line, Esc stops) →
  the assistant message streams run steps → files are created, updated, renamed or deleted
  in real time. Users can cancel a run, retry a failed reply, reopen past conversations and
  pick the model. A new message cancels any run in progress. Before finishing, the agent must
  pass `checkBuild` after its last write.
- Code: `conversation-sidebar.tsx`, `past-conversations-dialog.tsx`, `agent-model-select.tsx`
  → `POST /api/messages`, `POST /api/messages/cancel` → Inngest `process-message`
  (AgentKit; at most 2 runs per owner). Tools in `features/conversations/inngest/tools/*`:
  list, read, create, update, rename, delete files, create folder, `scaffoldViteApp`,
  `checkBuild`, `scrapeUrls`, `setEnvVar`, `loadSkill`, plus MCP tools (F12). Finish gate in
  `inngest/build-check-gate.ts`; `checkBuild` runs `tsc --noEmit` and `vite build` in E2B for
  Vite projects (static checks only without `E2B_API_KEY`) → `convex/system.ts` writes.
  Platform models are the admin's selection in /admin for the active provider (ADR 0006), else
  its catalog (`ai-providers/platform.ts`); an unlisted id runs on its default (OpenRouter: `openai/gpt-5.6-luna`). Without the provider's key a
  send gets 503 `ai_not_configured`.
- Env: the active platform provider's key (`NEXT_PUBLIC_AI_PROVIDER`, default `openrouter`; ADR 0005), Inngest; optional `E2B_API_KEY` (build check), `FIRECRAWL_API_KEY` (URL
  scraping).
- E2E: `chat-panel.spec.ts`, `chat-run-block.spec.ts`, `chat-stalled-run.spec.ts`,
  `chat-dispatch-failure.spec.ts`, `chat-overflow.spec.ts`, `agent-model-select.spec.ts`,
  `agent-check-build.spec.ts`, `agent-vite-scaffold.spec.ts`.

**F6. File explorer and code editor**: Works
- Steps: browse the tree → create, rename or delete files and folders → edit in CodeMirror
  (language modes, minimap, breadcrumbs, tabs) → changes save to Convex.
- Code: `features/projects/components/file-explorer/*`, `features/editor/*`; `convex/files.ts`
  (`getFolderContents`, `createFile`, `createFolder`, `renameFile`, `deleteFile`, `updateFile`).
- E2E: `file-explorer.spec.ts`, `editor-theme.spec.ts`.

**F7. AI inline suggestions and Cmd+K quick edit**: Works
- Steps: type → a ghost-text suggestion appears → Tab accepts it. Select code → Cmd+K →
  instruction → the selection is replaced.
- Code: `editor/extensions/suggestion/*` → `POST /api/suggestion`;
  `editor/extensions/quick-edit/*`, `selection-tooltip.ts` → `POST /api/quick-edit` (scrapes
  URLs in the instruction through Firecrawl when `FIRECRAWL_API_KEY` is set; `src/lib/firecrawl.ts`
  returns `null` without it). Both go through `withEditorModel`
  (`ai-providers/server/editor-model.ts`): the user's default BYOK key if set, otherwise the
  platform provider's small model via `platformEditorModel()`
  (`ai-providers/server/platform-model.ts`; OpenRouter: `openai/gpt-5.4-mini`).
- Env: the active platform provider's key (`NEXT_PUBLIC_AI_PROVIDER`, default `openrouter`; ADR 0005) (503 JSON error without it and without a default BYOK key).
- E2E: `editor-ai.spec.ts`, `quick-edit.spec.ts`.

**F8. Live preview with terminal**: Works (E2B) / Unverified (WebContainer)
- Steps: Preview tab → sandbox boots as a four-step readout (Create sandbox, Write files,
  Install dependencies, Start dev server) with total and per-step elapsed time → iframe plus
  a collapsible terminal. Toolbar: restart, refresh, engine toggle, device toggle (Desktop /
  Tablet 768px / Mobile 375px), URL bar, open in a new tab, terminal, environment variables,
  install/start command settings. A new project's sandbox pre-warms during its first build.
  A project with only `index.html` (no `package.json`) is served as a static site.
  `?engine=webcontainer` switches to the in-browser engine; on a sandbox error the preview
  offers "Use in-browser preview" (no automatic fallback).
- Code: `preview-view.tsx`; `features/sandbox-preview/*` (`preview-boot-steps.tsx`,
  `preview-device-toggle.tsx`, `utils/boot-plan.ts`) → `POST /api/sandbox` (NDJSON stream;
  secrets are injected server-side and redacted from output; at most 3 live sandboxes per
  user), `/api/sandbox/[sandboxId]` (file sync, kill); `features/webcontainer-preview/*`
  (public env vars only); `projects.updateSettings`; COOP/COEP headers in `next.config.ts`
  (only with `?engine=webcontainer`).
- Env: `E2B_API_KEY`; `E2B_TEMPLATE=codenaya-node22` (built by `npm run e2b:template`).
- E2E: `preview-lazy.spec.ts`, `preview-boot-steps.spec.ts`, `preview-terminal.spec.ts`,
  `preview-open-tab.spec.ts`, `preview-device.spec.ts`, `preview-auto-open.spec.ts`,
  `preview-building.spec.ts`, `preview-e2b-prewarm.spec.ts`, `preview-e2b-hmr.spec.ts`,
  `preview-e2b-node.spec.ts`, `preview-e2b-references.spec.ts`. None for static preview or the
  WebContainer boot.

**F9. Import from GitHub**: Partially works
- Steps: dashboard → Import (or `/import?repo=`, F24) → paste repo URL → Inngest job downloads
  the repo as one tarball and copies files (binary files go to Convex storage) → import
  status is shown in the navbar. Public repos import without a linked GitHub account; private
  repos need GitHub linked in Clerk (`GITHUB_NOT_LINKED` otherwise).
- Code: `import-github-dialog.tsx` → `POST /api/github/import` (`isPublicGithubRepo` in
  `server/github-token.ts`) → Inngest `import-github-repo` (one per user at a time;
  `server/github-archive.ts`, max 5000 files / 100 MB) → `system.createFile`,
  `createBinaryFile`, `updateImportStatus`. Open to every signed-in user (asserted in
  `src/app/api/github/github-routes.test.ts`).
- Gap: a file that fails to save is only logged, and the import is still marked completed
  (`import-github-repo.ts`).
- E2E: `github-import.spec.ts` (not-linked prompt, deep-link prefill); no successful import.

**F10. Export to GitHub**: Works
- Steps: navbar Export → repo name, visibility, description → Inngest job creates a new repo
  and pushes files → status shown, with cancel, retry and "View on GitHub".
- Code: `export-popover.tsx` → `POST /api/github/export` (plus `/cancel`, `/reset`) → Inngest
  `export-to-github` → `system.updateExportStatus`. Requires a GitHub account linked in Clerk
  (`GITHUB_NOT_LINKED` otherwise). Always creates a new repo.
- E2E: none.

**F11. Showcase: publish, browse, vote, remix**: Works
- Steps: navbar Publish → title, description, category, tags, optional screenshot → listed in
  the showcase. Once published, the navbar shows a Published menu with "View in showcase" and
  "Unpublish" (confirm; votes are kept, the page stops working). Anyone can browse
  `/showcase` (search, New / Top / Popular, category and tag filters) and open the public
  `/showcase/[id]` page (OG metadata, view counted once per browser or user, never the
  owner's). Signed-in users vote and Remix into a new project; signed-out Remix goes through
  sign-up and finishes on return (#111).
- Code: `features/showcase/*` (`publish-dialog.tsx`, `published-menu.tsx`,
  `showcase-feed.tsx`, `showcase-detail.tsx`, `hooks/use-remix.ts`), `src/app/showcase/*`;
  `convex/showcase.ts` (`publish`, `unpublish`, `isProjectPublished`, `list`, `search`,
  `getById`, `getTrending`, `vote`, `incrementView`, `importToWorkspace`).
- Env: optional `SHOWCASE_UNLISTED_OWNER_IDS` (Convex).
- E2E: `showcase-feed.spec.ts`, `showcase-public.spec.ts`; none for a successful publish or
  Unpublish.

**F12. Integrations (API key, OAuth PKCE, MCP tools with approval)**: Unverified
- Steps: IDE navbar → Integrations dialog → choose a provider (Supabase, Neon, GitHub, Stripe,
  Context7, Prisma Postgres, Sentry, Cloudflare, Linear, or a custom MCP URL) → connect with
  an API key or an OAuth popup → link it to the project with a scope → the agent gets the MCP
  tools. Settings → Integrations lists and manages connections but can't link them to a
  project (#261). Tools in a provider's destructive list pause for approval in the chat
  (approve or deny).
- Code: `features/integrations/components/*`, `catalog.ts`, `server/{oauth,mcp,crypto}/*`;
  `/api/integrations/connect`, `/api/integrations/oauth/{start,callback}`;
  `convex/integrations.ts`, `convex/crons.ts` and `maintenance.ts` (pruning).
- Env: `CODENAYA_LOCAL_KEK` (or `CODENAYA_KEK_PROVIDER=gcp-kms` + `CODENAYA_GCP_KMS_KEY`),
  `INTEGRATIONS_REDIRECT_URI`. Unit-tested (crypto, OAuth, URL guards, approval); live
  providers not verified.
- Gap: custom MCP servers have no destructive-tool list, so none of their tools ask for
  approval (`server/mcp/resolve-servers.ts`).
- E2E: none for connect or approval (#236).

**F13. Project environment variables**: Works
- Steps: preview toolbar → Environment variables → list, add, edit or delete. Keys with a
  public prefix (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_` and others in `classifyEnvKey`) are stored
  as public; everything else is a sealed secret that can't be revealed. The agent can also
  call `setEnvVar`. Public vars reach WebContainer; all vars reach E2B. The preview shows how
  many secrets were withheld.
- Code: `env-vars-dialog.tsx`, `POST /api/env-vars` (secrets), `convex/envVars.ts`,
  `inngest/tools/set-env-var.ts`, `integrations/env-keys.ts`, `system.setSecretEnvVar`,
  `server/env/resolve-env.ts`.
- Env: the KEK vars from F12 for secrets.
- E2E: `env-vars.spec.ts` (public var only).

**F14. Project actions: rename, duplicate, delete**: Works
- Steps: dashboard card "…" menu (open in new tab, copy link, rename, duplicate, delete) or
  the IDE project actions menu (rename, duplicate, delete). Duplicate makes "<name> (copy)"
  with files, settings, project skills and public env vars; secrets, conversations and
  integrations are not copied. Delete hides the project at once and removes data in batches.
- Code: `project-actions.tsx`, `project-card.tsx`, `use-project-rename.ts`;
  `convex/projects.ts` (`rename`, `duplicate`, `remove`), `convex/projectCopy.ts`.
- E2E: `project-actions.spec.ts`.

**F15. Starter templates**: Works
- Steps: pick one of six templates (landing page, SaaS dashboard, portfolio, blog, e-commerce
  storefront, admin CRUD) on the dashboard or `/showcase` → a project is created from the
  template's prompt, seeded with the shared Vite starter, and the agent builds it. Signed-out
  picks go through sign-up first.
- Code: `features/templates/templates.ts`, `components/starter-templates.tsx`,
  `server/seed-template.ts`, `seed-files.ts` → `POST /api/projects/create-with-prompt`
  (`templateId`).
- E2E: `starter-templates.spec.ts`.

**F16. Settings**: Works
- Steps: user menu → Settings → tabs Account (Clerk profile with Profile / Security tabs and
  no Billing page, #144), AI providers (F17), Skills (F18), Integrations (F12), Appearance
  (System / Light / Dark).
- Code: `src/app/settings/*` (`account/[[...rest]]/page.tsx` hides Clerk's navbar and 404s
  its billing URL), `features/settings/nav.ts`, `components/settings-nav.tsx`,
  `account-tabs.tsx`, `integrations-settings.tsx`, `appearance-settings.tsx`.
- E2E: `settings.spec.ts`.

**F17. Bring your own key (BYOK) AI providers**: Works
- Steps: Settings → AI providers → add an OpenRouter, OpenAI, Anthropic, Groq or custom
  OpenAI-compatible key (tested before saving) → test or delete it → pick a default model.
  The chat model picker lists a group per active key; the agent, titles and editor AI then
  run on that key. A rejected key is marked invalid and the run ends with a pointer to
  Settings.
- Code: `features/ai-providers/*` (`registry.ts`, `components/ai-providers-settings.tsx`,
  `server/sealed-key.ts`, `server/base-url.ts`, `server/resolve-run-model.ts`) →
  `POST /api/ai-providers`, `/api/ai-providers/[id]/test`; `convex/aiProviders.ts`. Keys are
  sealed with the integrations KEK. Custom base URLs must be https and resolve to public IPs,
  checked on save and before every run.
- Env: the KEK vars from F12.
- E2E: `ai-providers.spec.ts`, `byok-agent-run.spec.ts`.
- Gap: Enhance prompt (F20) always uses the platform key.

**F18. Skills**: Works
- Steps: Settings → Skills → create, edit, delete or import (`SKILL.md` from a GitHub URL or
  skills.sh page) skills; duplicate the built-in `find-skills`. In the IDE, the Skills button
  enables library skills per project or creates project-only skills (all off until enabled).
  In chat, `/name` forces up to 3 enabled skills; otherwise the agent loads them on demand
  with `loadSkill`.
- Code: `features/skills/*` (`skills-gallery.tsx`, `project-skills-panel.tsx`,
  `skill-slash-menu.tsx`, `parse-slash.ts`, `server/github-source.ts`, `server/prompt.ts`) →
  `POST /api/skills/import`; `convex/skills.ts`.
- E2E: `settings-skills.spec.ts`, `skills-import.spec.ts`, `skills-panel.spec.ts`,
  `skills-agent.spec.ts`, `skills-slash.spec.ts`.

**F19. Plan mode**: Works
- Steps: chat composer → Plan toggle → send → the agent replies with a Markdown checklist
  without writing files → "Build this plan" sends it as a normal run.
- Code: `plan-mode-toggle.tsx`, `chat-message.tsx`, `features/conversations/plan-mode.ts`
  (`PLAN_MODE_TOOLS`: read-only tools only). Plan runs take no checkpoint.
- E2E: `plan-mode.spec.ts`.

**F20. Enhance prompt**: Works
- Steps: wand button in the dashboard or chat composer → the prompt is rewritten in place →
  Undo until the text is edited.
- Code: `use-enhance-prompt.ts` → `POST /api/enhance-prompt` (`platformEditorModel()`;
  credentials rejected with 422).
- Env: the active platform provider's key (`NEXT_PUBLIC_AI_PROVIDER`, default `openrouter`; ADR 0005).
- E2E: `enhance-prompt.spec.ts`.

**F21. Image input in chat**: Works
- Steps: attach, drop or paste up to 4 images (PNG, JPEG, WebP, GIF; 5 MB each) → send → the
  agent sees them. Send is disabled when the selected model has no vision.
- Code: `use-chat-images.ts`, `chat-images.ts` → `convex/chatImages.ts`
  (`generateUploadUrl`, `register`) → `/api/messages` `images` →
  `inngest/lib/image-prompt.ts`.
- E2E: `chat-images.spec.ts`.

**F22. Checkpoints and restore**: Works
- Steps: every non-plan agent run snapshots the project first (last 20 kept; projects over
  2000 files are skipped) → chat Version history, or "Restore to before this run" on an
  assistant message → confirm → files restored.
  Restore is refused while an agent is running.
- Code: `checkpoint-dialogs.tsx`; `system.createProjectCheckpoint`, `convex/checkpoints.ts`
  (`restore`).
- E2E: `checkpoints-restore.spec.ts`.
- Gap: see #259 (no undo after a restore).

**F23. Download project as ZIP**: Works
- Steps: navbar Export → Download ZIP → `<project-name>.zip` with folders, empty folders and
  binary files.
- Code: `download-zip-button.tsx`, `utils/download-zip.ts` (`jszip`, in the browser);
  `files.getFilesWithUrls`.
- E2E: `download-zip.spec.ts`.

**F24. Open in Codenaya deep link**: Works
- Steps: `/import?repo=owner/repo` (or a GitHub URL) → signed in: the dashboard opens the
  import dialog prefilled → Import (F9). Signed out: sign-up first, then the same dialog. A
  malformed repo shows "Can't open that repository".
- Code: `src/app/import/page.tsx`, `src/lib/pending-intent.ts`, `projects-view.tsx`.
- E2E: `github-import.spec.ts` (signed-in prefill, malformed link); none for signed out.

**F25. Marketing, docs, pricing and legal pages**: Works
- Steps: shared marketing navbar (Showcase, Pricing, Docs) on public pages → `/docs`
  (getting started through BYOK, Skills and shortcuts), `/pricing`, `/privacy`, `/terms`,
  and a themed 404.
- Code: `src/components/marketing-navbar.tsx`, `src/app/{docs,pricing,privacy,terms}/page.tsx`,
  `src/app/not-found.tsx`, `features/billing/plans.ts` (display only).
- E2E: `docs-help.spec.ts`, `pricing.spec.ts`, `footer-legal.spec.ts`,
  `marketing-navbar.spec.ts`, `not-found.spec.ts`, `branding.spec.ts`.

**F26. Keyboard shortcut sheet and Help menu**: Works
- Steps: `?` outside a text field, Cmd/Ctrl+/, Help → Keyboard shortcuts, or the command
  palette → grouped list (General, Dashboard, Chat, Editor). Help menu also links Docs and
  Report a bug.
- Code: `src/components/shortcuts-dialog.tsx`, `src/lib/shortcuts.ts`.
- E2E: `shortcuts-dialog.spec.ts`, `docs-help.spec.ts`.

**F27. First-run checklist**: Works
- Steps: dashboard "Get started with Codenaya" card with five steps (create an app, open the
  preview, connect GitHub, add an AI key or a skill, publish or export) → hides when done or
  dismissed.
- Code: `first-run-checklist.tsx`, `utils/first-run.ts`.
- E2E: `first-run-checklist.spec.ts`.

**F28. Credits and billing**: Partial (#105)
- `/pricing` shows Free and Pro plans, but Pro checkout is disabled ("Coming soon").
  Everyone is on Free.
- Codenaya AI (the platform key; never BYOK) is metered per user per UTC month in tokens
  and micro-USD at the admin's saved prices (a high fallback rate when none are saved). Each plan has a monthly USD and/or token cap,
  set in /admin → Usage & limits (default: the plan's credits, Free $3 / Pro $20). Reaching
  either cap blocks sends (402 `usage_limit`), editor AI and the next agent turn until the
  month rolls over. Users see "usage this month" on Settings → AI providers (ADR 0007).
- Code: `convex/aiUsage.ts`, `convex/planLimits.ts`, `features/ai-usage/*`,
  `features/admin/components/usage-tab.tsx`.
- E2E: none (`pricing.spec.ts` covers the page only).

## 2. Platform safeguards

- **Usage limits**: per-user, per-minute rate limits return 429 with `Retry-After` on
  messages (10), create-with-prompt (5), sandbox (10), GitHub import (5), enhance prompt
  (10), suggestion (120), quick edit (20), env vars (30), AI provider create (5) and test
  (10), skill import (10), integrations connect (10) and OAuth start (8). Prompt bodies are
  capped at 50,000 characters and code at 200,000 (400). Scraping is capped at 10 URLs of
  50,000 characters each. Code: `src/lib/rate-limit.ts` (in memory, per server instance),
  `src/lib/parse-json-body.ts`, `src/lib/scrape-limits.ts`.
- **Malformed request bodies** get 400 instead of 500 (`parseJsonBody`).
- **Security headers** on every route: `X-Frame-Options: DENY`,
  `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera,
  microphone, geolocation off); no `X-Powered-By` (`next.config.ts`).
- **Accessibility**: text meets WCAG AA contrast in both themes (`--brand-text` in
  `globals.css`, axe check in `text-contrast.spec.ts`); view switcher and settings nav use
  tablist / `aria-current` semantics; the editor, file tabs, explorer folders and run-step
  errors have accessible names and states (`project-id-view.tsx`, `settings-nav.tsx`,
  `code-editor.tsx`, `top-navigation.tsx`, `agent-run.tsx`).

## 3. Compared with v0 and Lovable

P1 = expected in a demo, simple to build. P2 = nice to have.

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| M1 | Version history and restore of agent edits | P1 | Done (#43), F22 |
| M2 | Download project as ZIP | P1 | Done (#44), F23 |
| M3 | Responsive device toggle in preview | P1 | Done (#45), F8 |
| M4 | Image or screenshot input in chat | P1 | Done (#46), F21 |
| M5 | Starter templates gallery | P2 | Done (#119), F15 |
| M6 | Share or preview link | P2 | Missing (#260). Showcase pages cover published projects. |
| M7 | One-click deploy to a live URL | P2 | Missing (#224). Needs hosting, build handling and republish. |
| M8 | Visual select-to-edit in preview | P2 | Missing (#227). Needs an injected inspector script and a source-mapping layer. |

## 4. Out of scope

- Scaling and performance: sandbox pooling, scaling Inngest workers, Convex index tuning and
  virtualised trees for very large repos, CDN, load tests.
- Multi-user real-time collaboration (shared cursors, presence).
- Shared (cross-instance) rate limiting and usage metering beyond the per-instance limits in
  section 2. Billing is tracked in #105.
- Multi-region deployment and production observability dashboards.
