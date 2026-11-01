import { describe, expect, it } from "vitest";

import { detectCredential } from "@/features/integrations/credential-guard";

import { fixRequestMessage, scanProject } from "./scan-project";

// Built from parts so the repo itself holds no scannable key literals.
const STRIPE_LIVE = ["sk", "live", "51HxQ2kLm9Np3Rt7Vw0Yz4Ab"].join("_");
const GITHUB = `ghp_${"aB3dE6gH9jK2mN5pQ8sT1vW4"}`;
const jwt = (payload: object) =>
  [
    btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    btoa(JSON.stringify(payload)).replace(/=+$/, ""),
    "dGhpc2lzYXNpZ25hdHVyZXZhbHVl",
  ].join(".");

const rulesOf = (findings: ReturnType<typeof scanProject>) =>
  findings.map((f) => `${f.file}:${f.line}:${f.rule}`);

describe("scanProject", () => {
  it("flags each credential pattern with its file and line", () => {
    const findings = scanProject(
      [
        { path: "src/pay.ts", content: `const a = 1;\nconst key = "${STRIPE_LIVE}";` },
        { path: "server/gh.ts", content: `token: "${GITHUB}"` },
        { path: "src/aws.ts", content: "AKIAIOSFODNN7EXAMPLE" },
        { path: "lib/role.ts", content: `const k = "${jwt({ role: "service_role" })}";` },
      ],
      [],
    );

    expect(rulesOf(findings)).toEqual([
      "src/pay.ts:2:stripe",
      "server/gh.ts:1:github",
      "src/aws.ts:1:aws",
      "lib/role.ts:1:jwt",
    ]);
    expect(findings[0].severity).toBe("high");
  });

  it("allows Supabase anon JWTs, which are public by design", () => {
    const content = `createClient(url, "${jwt({ role: "anon", iss: "supabase" })}");`;

    expect(scanProject([{ path: "src/supabase.ts", content }], [])).toEqual([]);
  });

  it("ignores placeholder values such as those in .env.example", () => {
    const content = [
      `STRIPE_SECRET_KEY=${["sk", "live", "x".repeat(24)].join("_")}`,
      `OPENAI_API_KEY=sk-${"X".repeat(24)}`,
      "GITHUB_TOKEN=your-github-token",
    ].join("\n");

    expect(scanProject([{ path: ".env.example", content }], [])).toEqual([]);
  });

  it("finds stored secret values written into a file", () => {
    const findings = scanProject(
      [{ path: "lib/db.ts", content: "a\nb\nconnect('hunter2-password-123')" }],
      [
        { key: "DB_PASSWORD", value: "hunter2-password-123", visibility: "secret" },
        // Too short to match safely, and public values are not secrets.
        { key: "PORT", value: "3000", visibility: "secret" },
        { key: "VITE_APP_NAME", value: "connect", visibility: "public" },
      ],
    );

    expect(rulesOf(findings)).toEqual(["lib/db.ts:3:stored-secret"]);
  });

  it("flags public-prefixed env vars whose name or value looks secret", () => {
    const findings = scanProject(
      [],
      [
        { key: "VITE_STRIPE_SECRET", value: "abc", visibility: "public" },
        { key: "NEXT_PUBLIC_PAY_KEY", value: STRIPE_LIVE, visibility: "public" },
        { key: "VITE_SUPABASE_ANON_KEY", value: jwt({ role: "anon" }), visibility: "public" },
        { key: "VITE_API_URL", value: "https://api.example.com", visibility: "public" },
      ],
    );

    expect(rulesOf(findings)).toEqual([
      "env:VITE_STRIPE_SECRET:null:public-env-secret",
      "env:NEXT_PUBLIC_PAY_KEY:null:public-env-secret",
    ]);
  });

  it("flags secret-looking public env names in code, and service role only under src/", () => {
    const findings = scanProject(
      [
        { path: ".env", content: "VITE_PUBLIC_URL=x\nVITE_SUPABASE_SERVICE_ROLE_KEY=" },
        { path: "src/App.tsx", content: "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY" },
        { path: "supabase/functions/admin.ts", content: "Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')" },
      ],
      [],
    );

    expect(rulesOf(findings)).toEqual([".env:2:public-secret-name"]);
  });

  it("skips binary files", () => {
    expect(scanProject([{ path: "logo.png" }], [])).toEqual([]);
  });

  it("never includes a matched value in its findings", () => {
    const secret = "hunter2-password-123";
    const findings = scanProject(
      [{ path: "src/a.ts", content: `${STRIPE_LIVE} ${secret}` }],
      [
        { key: "DB_PASSWORD", value: secret, visibility: "secret" },
        { key: "VITE_KEY", value: STRIPE_LIVE, visibility: "public" },
      ],
    );

    expect(findings.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(findings) + fixRequestMessage(findings);
    expect(serialised).not.toContain(STRIPE_LIVE);
    expect(serialised).not.toContain(secret);
  });
});

describe("fixRequestMessage", () => {
  it("lists each finding once and passes the chat credential guard", () => {
    const message = fixRequestMessage([
      { file: "src/pay.ts", line: 2, rule: "stripe", severity: "high" },
      { file: "env:VITE_STRIPE_SECRET", line: null, rule: "public-env-secret", severity: "high" },
    ]);

    expect(message).toContain("- src/pay.ts:2 (stripe)");
    expect(message).toContain("- env:VITE_STRIPE_SECRET (public-env-secret)");
    expect(detectCredential(message).detected).toBe(false);
  });
});
