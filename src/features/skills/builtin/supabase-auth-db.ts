import type { BuiltinSkill } from "../types";

/**
 * Built-in skill: supabase-auth-db (#228). Sign-up, sign-in and per-user data
 * for Vite and Next.js apps on Supabase, with RLS on from the first migration and the
 * secret key kept out of the app.
 */
const body = `# Supabase auth and database

Use this for apps that need accounts, login or saved per-user data in a Vite + React or Next.js App Router app. Supabase gives the app auth and a Postgres database; Row Level Security (RLS) is what keeps one user's rows away from another. Pick the client and routing pattern by the app's framework.

## Rules (never break these)

- The browser only ever gets the project URL and the **publishable key** (\`sb_publishable_...\`, or the legacy \`anon\` key). Both are safe in client code because RLS does the protecting.
- NEVER put the **secret key** (\`sb_secret_...\`) or the legacy **service_role key** in client code, in any \`VITE_\`/\`NEXT_PUBLIC_\` variable, or in any file. It bypasses RLS. Generated code must not reference it at all. If a feature truly needs it (admin jobs), it belongs in a Supabase Edge Function; tell the user instead of building it in the app.
- NEVER disable RLS. Every table you create in the \`public\` schema enables RLS in the same migration, with owner-only policies. Never write \`using (true)\` policies on user data, and never grant table access to \`anon\`.
- NEVER invent a Supabase URL or key, and never ask the user to paste one into chat. No mock auth, and no \`localStorage\` standing in for the database.

## 1. Env vars

Vite reads \`import.meta.env.VITE_SUPABASE_URL\` and \`import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY\`. Next.js reads \`process.env.NEXT_PUBLIC_SUPABASE_URL\` and \`process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY\`.

- If they are not set and the Supabase integration is connected (see "Connected integrations"), read the project URL and publishable key with its tools. They come back as public \`[env-ref:...]\` refs (one stands for the project URL); store each with \`setEnvVarFromRef\`.
- If they are still not set, build everything below anyway, and in Notes ask the user to open **Environment Variables** in the project and add the two values from their Supabase dashboard (the **Connect** dialog, or Project Settings → API Keys). Don't guess them.

For Vite only, type them in \`src/vite-env.d.ts\`:

\`\`\`ts
/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}
\`\`\`

## Next.js App Router (instead of Vite steps 2–4)

- Use \`@supabase/ssr\` with \`@supabase/supabase-js\`: \`createBrowserClient\` for client components and a separate, per-request \`createServerClient\` in \`src/lib/supabase/server.ts\` for route handlers (\`src/app/api/**/route.ts\`), server actions and Server Components. Both use the public URL and publishable key; RLS still applies.
- The server helper reads \`await cookies()\` from \`next/headers\` and supplies cookie \`getAll\`/\`setAll\` adapters. Refresh sessions in \`src/middleware.ts\` for Next.js 15, forwarding refreshed cookies to both the request and response. Follow the cookie setup in https://supabase.com/docs/guides/auth/server-side/nextjs for the installed versions.
- Protect server reads and writes with \`supabase.auth.getUser()\` and handle its error before querying data; never trust \`getSession()\` alone for server authorization. A client redirect is only UI, not access control.
- Keep interactive auth UI in \`"use client"\` components, using \`next/navigation\` and App Router pages such as \`src/app/login/page.tsx\`. Put any client provider in \`src/app/providers.tsx\` and mount it from \`src/app/layout.tsx\`. Show a setup notice naming the Next.js variables when missing; create the server client only when configured so a missing value does not break \`next build\`.
- For confirmation or magic links, use a callback route handler that exchanges the code with \`exchangeCodeForSession\` and writes the session cookies. Set \`emailRedirectTo\` to that callback URL rather than the origin in the Vite example below, and allow its URL in Supabase. Continue with the login, migration and query rules below; the React Router examples in steps 2–4 are Vite-only.

## 2. Vite client: src/lib/supabase.ts

Add \`"@supabase/supabase-js": "^2.49.0"\` to package.json dependencies.

\`\`\`ts
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const isSupabaseConfigured = Boolean(url && key);

// createClient throws on an empty URL; App shows a setup notice until both are set.
export const supabase = createClient(url || "http://localhost", key || "unset");
\`\`\`

In \`src/App.tsx\`, when \`isSupabaseConfigured\` is false render a short, styled notice naming the two variables instead of the routes, so the preview never goes blank.

## 3. Vite session: src/lib/auth.tsx

\`\`\`tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

const AuthContext = createContext<{ session: Session | null; loading: boolean }>({
  session: null,
  loading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fires INITIAL_SESSION right away, then on every sign-in, sign-out and refresh.
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setLoading(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return <AuthContext.Provider value={{ session, loading }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
\`\`\`

Keep the listener callback synchronous: only set state there. Don't \`await\` other Supabase calls inside it. supabase-js stores and refreshes the session itself; never copy tokens into \`localStorage\`.

## 4. Vite protected routes

\`\`\`tsx
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export function ProtectedRoute() {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="grid min-h-svh place-items-center">Loading…</div>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  return <Outlet />;
}
\`\`\`

In \`src/App.tsx\` wrap the routes in \`<AuthProvider>\` (the starter already mounts \`<BrowserRouter>\`; don't add another) and nest private pages under \`<Route element={<ProtectedRoute />}>\`. After sign-in, navigate to \`location.state?.from?.pathname ?? "/"\`.

## 5. Login page (email + password, and magic link)

\`\`\`ts
const redirect = window.location.origin;
await supabase.auth.signInWithPassword({ email, password });
await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirect } });
await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } }); // magic link
await supabase.auth.signOut();
\`\`\`

- Every call returns \`{ data, error }\`; show \`error.message\` next to the form, and disable the button while a request runs.
- With email confirmation on (the hosted default), \`signUp\` returns no session: show "Check your email to confirm your account" rather than redirecting.
- Tell the user in Notes to add the preview and published URLs under Authentication → URL Configuration (Redirect URLs), or confirmation and magic links fall back to the Site URL.
- Add a sign-out button wherever the signed-in user's email is shown.

## 6. Database: a migration with RLS

Write the schema to \`supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql\` (current UTC timestamp). Starter table, owner-only:

\`\`\`sql
create table public.todos (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 500),
  done boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.todos enable row level security;

-- Newer projects don't expose new tables to the API automatically.
grant select, insert, update, delete on table public.todos to authenticated;

create index todos_user_id_idx on public.todos (user_id);

create policy "Users can read their own todos" on public.todos
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can add their own todos" on public.todos
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update their own todos" on public.todos
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete their own todos" on public.todos
  for delete to authenticated using ((select auth.uid()) = user_id);
\`\`\`

Every new table follows the same shape: a \`user_id\` owner column, RLS enabled, grants to \`authenticated\` only, one policy per operation with \`to authenticated\`, and an index on \`user_id\`.

Writing the file does not change the database:
- Supabase integration connected: apply it with the integration's migration tool (the user approves it), then confirm with a read tool that the table exists with RLS enabled before saying it's done.
- Not connected: tell the user to paste the file into the Supabase dashboard's SQL Editor and run it.

## 7. Queries

\`\`\`ts
const { data, error } = await supabase.from("todos").select("id, title, done").order("created_at");
await supabase.from("todos").insert({ title }); // user_id defaults to auth.uid()
await supabase.from("todos").update({ done }).eq("id", id);
await supabase.from("todos").delete().eq("id", id);
\`\`\`

RLS already limits every query to the signed-in user's rows; never send \`user_id\` from a form field.

## Notes for the user

Always tell the user: which env vars to add (if not set), whether the SQL still has to be run, the redirect URLs to allow, and how to check isolation: sign up two accounts and confirm the second can't see the first one's data.
`;

export const supabaseAuthDb: BuiltinSkill = {
  name: "supabase-auth-db",
  description:
    "Supabase sign-up/sign-in and per-user data for Vite + React and Next.js App Router apps, with framework-specific clients, Row Level Security on every table and the secret key kept out of the app. Use when the request mentions login, accounts, users, or saving data to a database.",
  body,
};
