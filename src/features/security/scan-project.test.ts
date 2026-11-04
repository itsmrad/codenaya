import { describe, expect, it } from "vitest";

import { detectCredential } from "@/features/integrations/credential-guard";

import { describeRule, fixRequestMessage, scanProject } from "./scan-project";

// Built from parts so the repo itself holds no scannable key literals.
const STRIPE_LIVE = ["sk", "live", "51HxQ2kLm9Np3Rt7Vw0Yz4Ab"].join("_");
const GITHUB = `ghp_${"aB3dE6gH9jK2mN5pQ8sT1vW4"}`;
const ANTHROPIC = ["sk", "ant", "api03", "Zx8Qw2Lp5Rt9Vb3Nm7Kc1Hj4"].join("-");
const PEM_HEADER = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
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
      "DATABASE_URL=postgres://postgres:postgres@localhost:5432/app",
    ].join("\n");

    expect(scanProject([{ path: ".env.example", content }], [])).toEqual([]);
    expect(scanProject([{ path: ".env.sample", content }], [])).toEqual([]);
  });

  it("treats key-shaped strings without digits as placeholders", () => {
    const content = 'const openai = new OpenAI({ apiKey: "sk-your-openai-api-key-here" });';

    expect(scanProject([{ path: "README.md", content }], [])).toEqual([]);
  });

  it("labels sk- keys neutrally, whichever provider issued them", () => {
    const findings = scanProject([{ path: "lib/ai.ts", content: `"${ANTHROPIC}"` }], []);

    expect(rulesOf(findings)).toEqual(["lib/ai.ts:1:sk-api-key"]);
    expect(describeRule("sk-api-key")).toBe("Hard-coded API key (sk-…)");
  });

  it("flags private keys", () => {
    const content = `${PEM_HEADER}\nMIIEpAIBAAKCAQEA`;

    expect(rulesOf(scanProject([{ path: "certs/server.pem", content }], []))).toEqual([
      "certs/server.pem:1:private-key",
    ]);
  });

  it("flags literal passwords in connection strings, not templated ones", () => {
    const content = [
      'const db = "postgres://admin:pass@db.example.com:5432/app";',
      "const url = `postgres://admin:${process.env.DB_PASSWORD}@host/app`;",
      'const tpl = "mysql://user:<password>@host/db";',
    ].join("\n");

    expect(rulesOf(scanProject([{ path: "server/db.ts", content }], []))).toEqual([
      "server/db.ts:1:dsn-password",
    ]);
  });

  it("flags .env files in the export but not example ones", () => {
    const findings = scanProject(
      [
        { path: ".env", content: "API_KEY=q9Zr2LwX7pN4vB8kT1mY6cH3" },
        { path: "apps/web/.env.local", content: "" },
        { path: ".env.example", content: "API_KEY=" },
        { path: ".env.sample", content: "API_KEY=" },
        { path: ".env.template", content: "API_KEY=" },
        { path: ".env.dist", content: "API_KEY=" },
        { path: "src/env.ts", content: "export {}" },
      ],
      [],
    );

    expect(rulesOf(findings)).toEqual([".env:null:env-file", "apps/web/.env.local:null:env-file"]);
  });

  it("rates a .env with only public-prefixed keys as medium", () => {
    const severityOf = (content: string) =>
      scanProject([{ path: ".env", content }], []).find((f) => f.rule === "env-file")?.severity;

    expect(
      severityOf("# public only\nVITE_API_URL=https://api.example.com\nexport NEXT_PUBLIC_SITE=x\nPUBLIC_NAME=y"),
    ).toBe("medium");
    expect(severityOf("VITE_API_URL=https://api.example.com\nDATABASE_URL=postgres://localhost/app")).toBe(
      "high",
    );
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

    expect(rulesOf(findings)).toEqual([".env:null:env-file", ".env:2:public-secret-name"]);
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
