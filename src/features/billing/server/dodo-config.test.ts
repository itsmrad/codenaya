import { afterEach, describe, expect, it, vi } from "vitest";

import { readDodoConfig, type DodoDeployment } from "./dodo-config";

const nextEnv = {
  CODENAYA_BILLING_ENABLED: "true",
  CREDIT_LIMITS_ENFORCED: "true",
  DODO_PAYMENTS_ENVIRONMENT: "test_mode",
  DODO_PAYMENTS_BUSINESS_ID: "test-business",
  DODO_PAYMENTS_API_KEY: "synthetic-api-key",
  DODO_PAYMENTS_PRO_PRODUCT_ID: "test-pro",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  DODO_PAYMENTS_RETURN_URL: "http://localhost:3000/settings/billing/return",
};
const receiverEnv = {
  DODO_PAYMENTS_ENVIRONMENT: "test_mode",
  DODO_PAYMENTS_BUSINESS_ID: "test-business",
  DODO_PAYMENTS_WEBHOOK_KEY: "synthetic-signing-key",
};
const absent = [undefined, "", "  ", "PLACEHOLDER_REPLACE_ME", " placeholder_key "];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Dodo config", () => {
  it("separates Next credentials from receiver credentials", () => {
    const env = { ...nextEnv, ...receiverEnv, DODO_PAYMENTS_WEBHOOK_KEY_PREVIOUS: "old-key" };
    expect(readDodoConfig("next", "development", env)).toEqual({
      environment: "test_mode", businessId: "test-business", apiKey: "synthetic-api-key",
      proProductId: "test-pro", returnUrl: nextEnv.DODO_PAYMENTS_RETURN_URL,
      topUpsEnabled: false, brandId: undefined,
    });
    expect(readDodoConfig("convex-receiver", "development", env)).toEqual({
      environment: "test_mode", businessId: "test-business",
      webhookKey: "synthetic-signing-key", webhookKeyPrevious: "old-key",
    });
    expect(readDodoConfig("next", "development", nextEnv)).not.toBeNull();
    expect(readDodoConfig("convex-receiver", "development", receiverEnv)).toBeDefined();
  });

  for (const name of [
    "DODO_PAYMENTS_ENVIRONMENT", "DODO_PAYMENTS_BUSINESS_ID", "DODO_PAYMENTS_API_KEY",
    "DODO_PAYMENTS_PRO_PRODUCT_ID", "NEXT_PUBLIC_APP_URL", "DODO_PAYMENTS_RETURN_URL",
  ]) {
    it.each(absent)(`rejects absent Next ${name} (%s)`, (value) => {
      expect(() => readDodoConfig("next", "development", { ...nextEnv, [name]: value }))
        .toThrow(name);
    });
  }
  for (const name of [
    "DODO_PAYMENTS_ENVIRONMENT", "DODO_PAYMENTS_BUSINESS_ID", "DODO_PAYMENTS_WEBHOOK_KEY",
  ]) {
    it.each(absent)(`rejects absent receiver ${name} (%s)`, (value) => {
      expect(() => readDodoConfig("convex-receiver", "development", { ...receiverEnv, [name]: value }))
        .toThrow(name);
    });
  }

  it.each([undefined, "", "false", "TRUE", " true ", "1", "PLACEHOLDER_TRUE"])(
    "disables checkout unless the flag is exact true (%s)", (flag) => {
      expect(readDodoConfig("next", "development", { CODENAYA_BILLING_ENABLED: flag })).toBeNull();
      expect(readDodoConfig("convex-receiver", "development", {
        ...receiverEnv, CODENAYA_BILLING_ENABLED: flag,
      })).toBeDefined();
    },
  );
  it("fails closed with placeholders even when checkout is disabled", () => {
    const env = Object.fromEntries(Object.keys(nextEnv).map((key) => [key, "PLACEHOLDER_VALUE"]));
    expect(readDodoConfig("next", "development", env)).toBeNull();
    expect(() => readDodoConfig("convex-receiver", "development", env)).toThrow();
  });
  it.each([undefined, "false", "TRUE", " true "])("requires credit enforcement (%s)", (value) => {
    expect(() => readDodoConfig("next", "development", { ...nextEnv, CREDIT_LIMITS_ENFORCED: value }))
      .toThrow("CREDIT_LIMITS_ENFORCED");
  });

  it.each(absent)("requires the top-up product only when enabled (%s)", (value) => {
    const env = { ...nextEnv, DODO_PAYMENTS_TOP_UP_PRODUCT_ID: value };
    expect(readDodoConfig("next", "development", env)).toMatchObject({ topUpsEnabled: false });
    expect(() => readDodoConfig("next", "development", {
      ...env, CODENAYA_BILLING_TOP_UPS_ENABLED: "true",
    })).toThrow("DODO_PAYMENTS_TOP_UP_PRODUCT_ID");
  });
  it.each(["false", "TRUE", " true ", "1"])("requires exact true for top-ups (%s)", (value) => {
    expect(readDodoConfig("next", "development", {
      ...nextEnv, CODENAYA_BILLING_TOP_UPS_ENABLED: value,
    })).toMatchObject({ topUpsEnabled: false });
  });
  it("includes configured top-ups and brand, with optional signing-key rotation", () => {
    expect(readDodoConfig("next", "development", {
      ...nextEnv, CODENAYA_BILLING_TOP_UPS_ENABLED: "true",
      DODO_PAYMENTS_TOP_UP_PRODUCT_ID: "test-topup", DODO_PAYMENTS_BRAND_ID: "test-brand",
    })).toMatchObject({ topUpsEnabled: true, topUpProductId: "test-topup", brandId: "test-brand" });
    expect(readDodoConfig("convex-receiver", "development", receiverEnv))
      .toMatchObject({ webhookKeyPrevious: undefined });
  });
  it.each(absent)("treats optional placeholders as absent (%s)", (value) => {
    expect(readDodoConfig("next", "development", { ...nextEnv, DODO_PAYMENTS_BRAND_ID: value }))
      .toMatchObject({ brandId: undefined });
    expect(readDodoConfig("convex-receiver", "development", {
      ...receiverEnv, DODO_PAYMENTS_WEBHOOK_KEY_PREVIOUS: value,
    })).toMatchObject({ webhookKeyPrevious: undefined });
  });

  it.each(["development", "preview", "staging", "production"] as const)(
    "%s accepts only the deployment's mode for both consumers", (deployment) => {
      const environment = deployment === "production" ? "live_mode" : "test_mode";
      const origin = deployment === "production" ? "https://www.codenaya.tech" : "https://billing-dev.example.test";
      const env = { ...nextEnv, ...receiverEnv, DODO_PAYMENTS_ENVIRONMENT: environment,
        NEXT_PUBLIC_APP_URL: origin, DODO_PAYMENTS_RETURN_URL: `${origin}/settings/billing/return` };
      expect(readDodoConfig("next", deployment, env)).toMatchObject({ environment });
      expect(readDodoConfig("convex-receiver", deployment, env)).toMatchObject({ environment });
      for (const mode of [environment === "live_mode" ? "test_mode" : "live_mode", "test", "LIVE_MODE", " test_mode "]) {
        expect(() => readDodoConfig("next", deployment, { ...env, DODO_PAYMENTS_ENVIRONMENT: mode })).toThrow();
        expect(() => readDodoConfig("convex-receiver", deployment, { ...env, DODO_PAYMENTS_ENVIRONMENT: mode })).toThrow();
      }
    },
  );
  it("rejects unknown deployment and cannot infer it from NODE_ENV", () => {
    expect(() => readDodoConfig("next", "unknown" as DodoDeployment, nextEnv)).toThrow("deployment");
    expect(() => readDodoConfig("next", undefined as unknown as DodoDeployment, {
      ...nextEnv, NODE_ENV: "production",
    })).toThrow("deployment");
  });
  it.each(["DODO_PAYMENTS_BASE_URL", "DODO_PAYMENTS_API_BASE_URL"])("prohibits %s", (name) => {
    expect(() => readDodoConfig("next", "development", { ...nextEnv, [name]: "https://untrusted.test" })).toThrow("overrides");
    expect(() => readDodoConfig("convex-receiver", "development", { ...receiverEnv, [name]: "PLACEHOLDER_URL" })).toThrow("overrides");
  });

  it.each([
    "https://evil.test/settings/billing/return", "//localhost:3000/settings/billing/return",
    "http://localhost:3001/settings/billing/return", "http://localhost:3000/settings/usage",
    "http://localhost:3000/settings/billing/return?next=https://evil.test",
    "http://localhost:3000/settings/billing/return#paid", "not-a-url",
    "http://user:password@localhost:3000/settings/billing/return",
    "http://localhost:3000/settings/billing/return/",
  ])("rejects untrusted or nonfixed return %s", (returnUrl) => {
    expect(() => readDodoConfig("next", "development", { ...nextEnv, DODO_PAYMENTS_RETURN_URL: returnUrl })).toThrow();
  });
  it.each([
    "https://codenaya.tech", "https://www.codenaya.tech", "https://preview.codenaya.tech", "http://dev.example.test",
    "https://codenaya.tech.", "https://www.codenaya.tech.", "https://preview.codenaya.tech.",
    "https://dev.example.test/path", "https://user:password@dev.example.test", "file:///tmp",
  ])("rejects nonisolated or malformed test origin %s", (origin) => {
    expect(() => readDodoConfig("next", "preview", { ...nextEnv, NEXT_PUBLIC_APP_URL: origin,
      DODO_PAYMENTS_RETURN_URL: `${origin}/settings/billing/return` })).toThrow();
  });
  it.each(["http://127.0.0.1:3000", "http://[::1]:3000", "https://dev.example.test", "http://localhost:3100"])(
    "accepts isolated test origin %s", (origin) => {
      expect(readDodoConfig("next", "staging", { ...nextEnv, NEXT_PUBLIC_APP_URL: origin,
        DODO_PAYMENTS_RETURN_URL: `${origin}/settings/billing/return` })).not.toBeNull();
    },
  );
  it.each(["http://www.codenaya.tech", "https://codenaya.tech", "https://www.codenaya.tech:8443", "http://localhost:3000"])(
    "rejects noncanonical production origin %s", (origin) => {
      expect(() => readDodoConfig("next", "production", { ...nextEnv,
        DODO_PAYMENTS_ENVIRONMENT: "live_mode", NEXT_PUBLIC_APP_URL: origin,
        DODO_PAYMENTS_RETURN_URL: `${origin}/settings/billing/return` })).toThrow();
    },
  );

  it("imports with billing enabled and credentials absent", async () => {
    vi.resetModules();
    for (const key of Object.keys({ ...nextEnv, ...receiverEnv })) vi.stubEnv(key, undefined);
    vi.stubEnv("CODENAYA_BILLING_ENABLED", "true");
    const config = await import("./dodo-config");
    expect(config.readDodoConfig).toBeTypeOf("function");
  });
  it("reads env at call time", () => {
    for (const [key, value] of Object.entries(nextEnv)) vi.stubEnv(key, value);
    vi.stubEnv("CODENAYA_BILLING_ENABLED", "false");
    expect(readDodoConfig("next", "development")).toBeNull();
    vi.stubEnv("CODENAYA_BILLING_ENABLED", "true");
    vi.stubEnv("DODO_PAYMENTS_BASE_URL", undefined);
    vi.stubEnv("DODO_PAYMENTS_API_BASE_URL", undefined);
    expect(readDodoConfig("next", "development")).toMatchObject({ apiKey: "synthetic-api-key" });
    vi.stubEnv("DODO_PAYMENTS_API_KEY", "synthetic-rotated-key");
    expect(readDodoConfig("next", "development")).toMatchObject({ apiKey: "synthetic-rotated-key" });
  });
  it("never includes supplied values or causes in errors and never logs", () => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const errorLog = vi.spyOn(console, "error");
    let failure: unknown;
    try {
      readDodoConfig("next", "development", { ...nextEnv,
        NEXT_PUBLIC_APP_URL: "https://synthetic-user:synthetic-secret@evil.test",
        DODO_PAYMENTS_RETURN_URL: "synthetic-invalid-secret-url",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure) + (failure as Error).stack + JSON.stringify(failure)).not.toContain("synthetic-");
    expect(failure).not.toHaveProperty("cause");
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });
  it("refuses browser use for Next but not for the Convex receiver", () => {
    vi.stubGlobal("window", {});
    expect(() => readDodoConfig("next", "development", nextEnv)).toThrow("server-only");
    expect(readDodoConfig("convex-receiver", "development", receiverEnv)).toMatchObject({ webhookKey: "synthetic-signing-key" });
  });
});
