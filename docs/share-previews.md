# Website-only share previews

A share link exposes a running website and authenticated Remix. It must not expose the owner's editor, identity, source file API, chat or private environment. The public metadata query returns only the project name, and the retired file endpoint returns null for every caller. `/s/<token>` redirects to `/preview/<token>`; middleware checks availability before streaming to preserve actual 404 status codes.

Keep the existing share token on `projects`. Add optional version mode, pinned checkpoint, chosen keep-live duration/deadline and a sandbox reservation. Reuse checkpoint content, blob-reference checks, project/account purge and existing copy limits. Replacing a snapshot explicitly releases its old checkpoint; disabling retains its slug and pinned version for re-enabling. Existing links default to the latest saved files. The owner UI defaults new links to a snapshot.

A server-only Convex mutation serializes claims across instances and counts active reservations per owner. Only its lease holder may attach or update a sandbox; changed versions retire the old sandbox before booting the replacement. Updates arriving before the provider returns its sandbox id are remembered and retire after attachment. Deleting project tombstones retain reservations until their provider timeout, so delete/create cannot bypass the two-preview cap. Unknown create outcomes also retain the reservation until timeout.

Use the existing SandboxProvider interface. Fixed production build/start commands run in a fresh sandbox with only public `VITE_`/`NEXT_PUBLIC_` variables; credential files are omitted. Next browser/server maps are disabled; published maps and source TypeScript/JSX files are removed, and inline sourcemaps fail closed. Start's default `dist/server/server.js` fetch handler uses a small Node HTTP adapter serving only `dist/client`; Nitro output uses its existing production entrypoint when present. No private environment resolver runs here. Apps needing private backend credentials are unsupported in public previews.

A lightweight heartbeat refreshes one provider timeout to the later of ten minutes from now or the keep-live deadline. With no heartbeat, the provider kills the sandbox. No cleanup cron is needed, and the share token itself never expires. Initial visitor POSTs read and hash the current shared inputs before attaching to an active preview. Unchanged content attaches without consuming IP boot allowance; changed content passes the limiter before retirement/rebuild and reuses the preloaded inputs. Latest mode sees ordinary saved-file changes; snapshot mode keeps its pinned files. Periodic GET heartbeats stay light and do not compute a manifest. Start requests reuse the existing process-local per-IP limiter; cross-instance enforcement inherits its documented limitation.

Verification: Convex tests cover cap/reuse/leases, updates during boot, tombstones, deadlines, snapshot replacement/Remix and secret filtering. Server tests cover framework commands and build failures. Playwright seeds a Vite site, visits signed out, checks `/s` redirection and disabled-link 404, and captures public-page/popover screenshots at 1440 and 390. Run through CI/BUILDGATE only. This feature remains HOLD-FOR-USER until dev verification.

Before the first link, the toggle is hidden and Generate link is enabled. After generation, the toggle disables/re-enables access using the same slug. Share options are drafts until Generate link / Update link is clicked. One authenticated
request saves them and warms the sandbox only for keep-live or an already running site.
Updates preserve the slug and reuse the production build when its content is unchanged.
The public shell embeds the production site through its sandbox's port-4000 proxy,
which permits framing by the app origin and removes upstream X-Frame-Options.
The address bar stays on `/preview/<slug>`; the sandbox host is still visible in
DevTools. A full same-origin proxy is a later option if needed.


## Frame-origin configuration

`CODENAYA_PUBLIC_PREVIEW_ORIGINS` is a comma-separated list of exact origins, for
example `http://localhost:3100,https://codenaya.tech`. When unset, the default is
`http://localhost:3100`, `https://codenaya.tech`, `https://www.codenaya.tech`
(production serves from www; the apex redirects there) and the origin of
`NEXT_PUBLIC_APP_URL` when it is set and valid (otherwise it is ignored). An
explicit list replaces the default. HTTP is accepted only for loopback hosts;
credentials, paths, query strings, fragments and wildcard/CSP expressions are
rejected. Include
the isolated gate's origin explicitly (for example `http://localhost:3216`) in its
frontend process environment. Never derive this policy from request URLs, Host,
Origin or forwarding headers. The public proxy replaces upstream `frame-ancestors`
and strips `X-Frame-Options`; other CSP directives remain intact. Runtime/origin
configuration participates in the saved-input hash, so older broken warm proxies
are replaced on the next visitor POST without doing expensive work in GET.

Public shares always have their own production sandbox. Reusing an owner's IDE
sandbox is out of scope and belongs to the separate owner-only preview route.

DEV header reproduction (grant 249): the existing sandbox listened on 3000/4000
and returned 200 but permitted only `http://0.0.0.0:3100`. A controlled dedicated
sandbox using the current serialized proxy returned 200, no XFO, both configured
frame origins and the expected HTML through E2B's public edge. That one new
sandbox was killed by ID and confirmed absent; no user sandbox/server was changed.
