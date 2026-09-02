# Codenaya - Building a Cursor AI Alternative

## What We're Building

Codenaya is a browser-based IDE inspired by Cursor AI, featuring:

- Real-time collaborative code editing
- AI-powered code suggestions and quick edit (Cmd+K)
- Conversation-based AI assistant
- In-browser code execution with WebContainer
- GitHub import/export integration
- Multi-file project management

## Tech Stack

| Category      | Technologies                                                |
| ------------- | ----------------------------------------------------------- |
| **Frontend**  | Next.js 16, React 19, TypeScript, Tailwind CSS 4            |
| **Editor**    | CodeMirror 6, Custom Extensions, One Dark Theme             |
| **Backend**   | Convex (Real-time DB), Inngest (Background Jobs)            |
| **AI**        | Claude Sonnet 4 (preferred) or Gemini 2.0 Flash (free tier) |
| **Auth**      | Clerk (with GitHub OAuth)                                   |
| **Execution** | WebContainer API, xterm.js                                  |
| **UI**        | shadcn/ui, Radix UI                                         |

## Part 1 Contents (Chapters 1-12)

### Phase 1: Foundation & Sponsor Technologies

- **Chapter 1:** Project Setup, UI Library & Theme
- **Chapter 2:** Clerk Authentication & Protected Routes
- **Chapter 3:** Convex Database & Real-time Setup
- **Chapter 4:** Inngest - Background Jobs & Non-Blocking UI
- **Chapter 5:** Firecrawl - Teaching AI with Live Documentation
- **Chapter 6:** Sentry - Error Tracking & LLM Monitoring
- **Chapter 7:** Projects Dashboard & Landing Page

### Phase 2: File System & Editor

- **Chapter 8:** Project IDE Layout & Resizable Panes
- **Chapter 9:** File Explorer - Full Implementation
- **Chapter 10:** Code Editor & State Management

### Phase 3: AI Features (Partial)

- **Chapter 11:** AI Suggestions & Quick Edit
- **Chapter 12:** Conversation System

## Part 2 Contents (Chapters 13-16) - Coming Soon

- **Chapter 13:** AI Agent & Tools (AgentKit, file management tools)
- **Chapter 14:** WebContainer, Terminal & Preview
- **Chapter 15:** GitHub Import & Export
- **Chapter 16:** AI Project Creation & Final Polish

## Getting Started

### Prerequisites

- Node.js 20.09+
- npm or pnpm
- Accounts needed:
  - [Clerk](https://clerk.com) - Authentication
  - [Convex](https://convex.dev) - Database
  - [Inngest](https://inngest.com) - Background jobs
  - [Anthropic](https://anthropic.com) or [Google AI Studio](https://aistudio.google.com) - AI API (one required)
  - [Firecrawl](https://firecrawl.dev) - Web scraping (optional)
  - [Sentry](https://sentry.io) - Error tracking (optional)

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/itsmrad/codenaya.git
   cd codenaya
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Set up environment variables:

   ```bash
   cp .env.example .env.local
   ```

4. Configure your `.env.local` with the required keys:

   ```env
   # Clerk
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
   CLERK_SECRET_KEY=

   # Convex
   NEXT_PUBLIC_CONVEX_URL=
   CONVEX_DEPLOYMENT=
   CODENAYA_CONVEX_INTERNAL_KEY=  # Generate a random string

   # AI Provider (choose one)
   ANTHROPIC_API_KEY=        # Preferred - Claude Sonnet 4
   GOOGLE_GENERATIVE_AI_API_KEY=  # Free alternative - Gemini 2.0 Flash

   # Firecrawl (optional)
   FIRECRAWL_API_KEY=

   # Sentry (optional)
   SENTRY_DSN=
   ```

5. Start the Convex development server:

   ```bash
   npx convex dev
   ```

6. In a new terminal, start the Next.js development server:

   ```bash
   npm run dev
   ```

7. In another terminal, start the Inngest dev server:

   ```bash
   npx inngest-cli@latest dev
   ```

8. Open [http://localhost:3000](http://localhost:3000)

## Project Structure

```
src/
├── app/                    # Next.js App Router
│   ├── api/               # API routes
│   │   ├── messages/      # Conversation API
│   │   ├── suggestion/    # AI suggestions
│   │   └── quick-edit/    # Cmd+K editing
│   └── projects/          # Project pages
├── components/            # Shared components
│   ├── ui/               # shadcn/ui components
│   └── ai-elements/      # AI conversation components
├── features/
│   ├── auth/             # Authentication
│   ├── conversations/    # AI chat system
│   ├── editor/           # CodeMirror setup
│   │   └── extensions/   # Custom extensions
│   ├── preview/          # WebContainer (Part 2)
│   └── projects/         # Project management
├── inngest/              # Inngest client
└── lib/                  # Utilities

convex/
├── schema.ts             # Database schema
├── projects.ts           # Project queries/mutations
├── files.ts              # File operations
├── conversations.ts      # Conversation operations
└── system.ts             # Internal API for Inngest
```

## Features Implemented (Part 1)

### Editor

- Syntax highlighting for JS, TS, CSS, HTML, JSON, Markdown, Python
- Line numbers and code folding
- Minimap overview
- Bracket matching and indentation guides
- Multi-cursor editing

### AI Features

- Real-time code suggestions with ghost text
- Quick edit with Cmd+K (select code + natural language instruction)
- Selection tooltip for quick actions
- Conversation sidebar with message history

### File Management

- File explorer with folder hierarchy
- Create, rename, delete files and folders
- VSCode-style file icons
- Tab-based file navigation
- Auto-save with debouncing

### Real-time

- Convex-powered instant updates
- Optimistic UI updates
- Background job processing with Inngest

## Current Limitations (Part 1)

These features are planned for Part 2:

- AI agent cannot yet modify files (mock response only)
- No message cancellation
- No past conversations dialog
- No code preview/execution
- No GitHub integration
- No AI project generation

## Scripts

```bash
npm run dev       # Start development server
npm run build     # Build for production
npm run start     # Start production server
npm run lint      # Run ESLint
```

## Project Links

- **Demo Video:** [Coming Soon]
- **Part 1:** Chapters 1-12
- **Part 2:** Chapters 13-16

## Sponsors

A huge thank you to the sponsors who made this tutorial possible. Consider checking them out - they offer generous free tiers perfect for learning!

### Authentication

**[Clerk](https://clerk.com)** - Add authentication to your app in minutes, not days.

### Database

**[Convex](https://convex.dev)** - The real-time database that makes building collaborative apps a breeze.

### Background Jobs

**[Inngest](https://inngest.com)** - Reliable background jobs and event-driven workflows.

### Web Scraping

**[Firecrawl](https://firecrawl.dev)** - Turn any website into LLM-ready data.

### Error Tracking

**[Sentry](https://sentry.io)** - See what's broken and fix it fast.

### Code Review

**[CodeRabbit](https://coderabbit.ai)** - AI-powered code reviews that catch bugs before your users do.

## MCP Integrations

Users can connect external services (Supabase, Neon, GitHub, Stripe, Context7,
Prisma, Sentry, Cloudflare, Linear, or any custom MCP server) and the coding agent
gains those services' tools. Credentials the agent provisions are stored encrypted
and injected into the preview, so generated apps can be genuinely full-stack.

### Required environment variables

```bash
# Master key for the credential store. REQUIRED before any connection can be made.
# Generate with: openssl rand -base64 32
CODENAYA_LOCAL_KEK=

# Absolute OAuth callback URL. Required for OAuth connections.
INTEGRATIONS_REDIRECT_URI=https://your-domain.com/api/integrations/oauth/callback
```

Use the **same `CODENAYA_LOCAL_KEK` in every environment**. A different value means
credentials sealed in one cannot be opened in another, and the failure surfaces as a
decryption error rather than a configuration one.

**If you lose the key, stored credentials are unrecoverable.** That is the point of
encryption — keep a copy in a password manager. Users would need to reconnect.

### Optional

```bash
# KEK provider. Defaults to "local".
CODENAYA_KEK_PROVIDER=local          # or "gcp-kms"

# Only for CODENAYA_KEK_PROVIDER=gcp-kms. Reuses GOOGLE_CLIENT_EMAIL /
# GOOGLE_PRIVATE_KEY, so no new credentials are needed.
CODENAYA_GCP_KMS_KEY=projects/p/locations/l/keyRings/r/cryptoKeys/k

# Comma-separated decrypt-only keys, for rotation. See below.
CODENAYA_LOCAL_KEK_RETIRED=

# Allows http:// MCP URLs. Ignored in production even if set.
CODENAYA_ALLOW_INSECURE_MCP_URLS=1
```

### How credentials are stored

Envelope encryption. Each secret gets its own random 256-bit data encryption key
(DEK); the secret is encrypted with AES-256-GCM under that DEK, and the DEK is
wrapped by the KEK. Only the wrapped DEK and the ciphertext are persisted — the KEK
never reaches the database.

Every ciphertext is bound to its own row via GCM additional authenticated data, so a
sealed value copied into a different row fails to decrypt rather than silently
working.

**The tradeoff:** with the `local` provider the KEK lives in an environment
variable, so an attacker holding *both* the environment and the database can decrypt
everything. A hosted KMS would make the database alone insufficient. This is
accepted deliberately to keep running costs at zero.

### Rotating the KEK

No downtime and no bulk migration needed:

```bash
CODENAYA_LOCAL_KEK=<new key>          # wraps all new DEKs
CODENAYA_LOCAL_KEK_RETIRED=<old key>  # decrypt-only
```

New credentials seal under the new key; existing rows still open with the retired
one. Keys are identified by a SHA-256 fingerprint stored per row, so ordering does
not matter. Drop the retired entry once everything has been re-wrapped.

### Moving to Google Cloud KMS

Because the KEK only ever wraps DEKs, this is a pass over one short column rather
than a re-encryption of every credential — `ciphertext`, `iv` and `authTag` are
copied through byte-identical (asserted by `rewrap.test.ts`).

1. Create a key ring and key in Cloud KMS.
2. Grant the existing service account `roles/cloudkms.cryptoKeyEncrypterDecrypter`.
3. Set `CODENAYA_GCP_KMS_KEY`.
4. Re-wrap existing rows using `rewrapSealedSecret`, which is idempotent and safe to
   re-run after an interruption.
5. Set `CODENAYA_KEK_PROVIDER=gcp-kms`.

Old and new rows stay readable throughout, because each row records the provider and
key that sealed it.

### Preview engines and secret visibility

| | Cloud Sandbox (E2B) | In-browser (WebContainer) |
| --- | --- | --- |
| Runs | Server-side | In the user's page |
| Public vars | ✅ | ✅ |
| Secret vars | ✅ | ❌ withheld |

WebContainer boots in the browser, so anything given to it is readable by the end
user and by anyone they share a preview with. Variables prefixed
`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `REACT_APP_`, `EXPO_PUBLIC_`, `GATSBY_` or
`NUXT_PUBLIC_` are treated as public — bundlers inline them into client JavaScript
regardless, so calling them secret would be a false promise. Everything else
defaults to secret.

### Operational notes

- **Read-only by default.** New project connections are read-only; enabling writes
  requires explicit confirmation. Five providers (Stripe, Context7, Prisma,
  Cloudflare, Sentry) cannot express read-only in their MCP endpoint, so for those it
  is enforced by the approval gate instead and the UI says so.
- **Destructive tools require approval.** The agent pauses and waits up to 15 minutes
  for a decision. With no approval mechanism available the call is refused, never
  silently executed.
- **Tool budget.** 40 tools per connection, 80 per project. Tool schemas are sent to
  the model on every request, so an unbounded set would evict the conversation from
  context.
- **Tool drift.** Definitions are fingerprinted at approval time. If a server later
  changes a tool's description or schema, that tool is withheld until reviewed — a
  description is instruction text the model obeys.
- **Cleanup crons** prune expired OAuth states, lapsed approvals, orphaned links and
  audit entries older than 30 days. See `convex/crons.ts`.

## Acknowledgments

- [Cursor](https://cursor.sh) - Inspiration for the project
- [Orchids](https://orchids.app) - Inspiration for the project
- [shadcn/ui](https://ui.shadcn.com) - UI components
- [CodeMirror](https://codemirror.net) - Code editor
