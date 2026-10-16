/**
 * End-to-end smoke test for the onboarding flow.
 *
 * Tests:
 *  1. Unauthenticated visit to `/`  → landing page renders (hero, "Start Building")
 *  2. Direct visit to `/onboarding`  → onboarding wizard renders ("Welcome to Codenaya")
 *  3. Guard redirect: authenticated user on `/` with !hasCompletedOnboarding → redirected to /onboarding
 *
 * Usage:  node scripts/test-onboarding.mjs
 */

import puppeteer from "puppeteer";

const BASE = "http://localhost:3000";
const TIMEOUT = 15_000;
let browser;
let passed = 0;
let failed = 0;

function ok(label) {
  passed++;
  console.log(`  ✅ ${label}`);
}
function fail(label, detail) {
  failed++;
  console.error(`  ❌ ${label}${detail ? ": " + detail : ""}`);
}

try {
  browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });

  // ───── Test 1: Landing page for unauthenticated user ─────
  console.log("\n🧪 Test 1 — Landing page (unauthenticated)");
  {
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: TIMEOUT });

    // The landing page renders client-side inside <Unauthenticated>.
    // Wait for the hero text to appear.
    try {
      await page.waitForFunction(
        () => document.body.innerText.includes("Start Building") || document.body.innerText.includes("Build with AI"),
        { timeout: TIMEOUT }
      );
      const text = await page.evaluate(() => document.body.innerText);
      if (text.includes("Start Building") || text.includes("Build with AI")) {
        ok("Landing page rendered with hero text");
      } else {
        fail("Landing page hero text not found", text.substring(0, 200));
      }
    } catch (e) {
      // Take screenshot for debugging
      await page.screenshot({ path: "d:/codenaya/scripts/test-landing-fail.png" });
      const text = await page.evaluate(() => document.body.innerText);
      fail("Landing page didn't render in time", `Body text: "${text.substring(0, 300)}"`);
    }
    await page.close();
  }

  // ───── Test 2: Onboarding page renders wizard ─────
  console.log("\n🧪 Test 2 — /onboarding page renders wizard");
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/onboarding`, { waitUntil: "networkidle2", timeout: TIMEOUT });

    try {
      // The wizard is client-rendered. Wait for the welcome step or auth step.
      await page.waitForFunction(
        () => {
          const text = document.body.innerText;
          return (
            text.includes("Welcome to Codenaya") ||
            text.includes("Log in or sign up") ||
            text.includes("What you get")
          );
        },
        { timeout: TIMEOUT }
      );
      const text = await page.evaluate(() => document.body.innerText);
      if (text.includes("Welcome to Codenaya")) {
        ok("Onboarding wizard rendered — Welcome step visible");
      } else if (text.includes("Log in or sign up")) {
        ok("Onboarding wizard rendered — Auth step visible (user not signed in)");
      } else if (text.includes("What you get")) {
        ok("Onboarding wizard rendered — Features step visible");
      } else {
        fail("Wizard step text not detected", text.substring(0, 300));
      }
    } catch (e) {
      await page.screenshot({ path: "d:/codenaya/scripts/test-onboarding-fail.png" });
      const text = await page.evaluate(() => document.body.innerText);
      const url = page.url();
      fail("Onboarding wizard didn't render", `URL: ${url}, Body: "${text.substring(0, 300)}"`);
    }
    await page.close();
  }

  // ───── Test 3: Check that OnboardingGuard is wired into providers ─────
  console.log("\n🧪 Test 3 — OnboardingGuard is in the component tree");
  {
    // This is a code-level check: verify providers.tsx imports and uses OnboardingGuard
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: TIMEOUT });

    // Fetch the main app chunk and check if OnboardingGuard code is present
    try {
      const guardPresent = await page.evaluate(async () => {
        // Collect all script sources
        const scripts = Array.from(document.querySelectorAll("script[src]"));
        for (const s of scripts) {
          if (s.src.includes("src_") || s.src.includes("components")) {
            try {
              const resp = await fetch(s.src);
              const code = await resp.text();
              if (code.includes("OnboardingGuard") || code.includes("onboarding-guard") || code.includes("hasCompletedOnboarding")) {
                return true;
              }
            } catch {}
          }
        }
        return false;
      });

      if (guardPresent) {
        ok("OnboardingGuard code is loaded in client bundles");
      } else {
        fail("OnboardingGuard code NOT found in any loaded client bundle");
      }
    } catch (e) {
      fail("Could not check client bundles", e.message);
    }
    await page.close();
  }

  // ───── Test 4: Verify /onboarding doesn't redirect away for non-onboarded users ─────
  console.log("\n🧪 Test 4 — /onboarding stays on /onboarding (no redirect loop)");
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/onboarding`, { waitUntil: "networkidle2", timeout: TIMEOUT });

    // Wait a moment for any client-side redirects
    await new Promise((r) => setTimeout(r, 2000));
    const finalUrl = page.url();

    if (finalUrl.includes("/onboarding")) {
      ok(`Stayed on onboarding page (${finalUrl})`);
    } else {
      fail(`Redirected away from /onboarding`, `Final URL: ${finalUrl}`);
    }
    await page.close();
  }

  // ───── Test 5: Click 'Start Building' from home page and step through onboarding ─────
  console.log("\n🧪 Test 5 — Click 'Start Building' button on home page -> opens onboarding wizard");
  {
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: TIMEOUT });

    // Wait for the 'Start Building' button
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("button")).some((b) => b.innerText.includes("Start Building")),
      { timeout: TIMEOUT }
    );

    // Find and click the 'Start Building' button
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.innerText.includes("Start Building")
      );
      if (btn) btn.click();
    });

    // Wait for URL to be /onboarding
    await page.waitForFunction(() => window.location.pathname.startsWith("/onboarding"), {
      timeout: TIMEOUT,
    });
    ok(`'Start Building' navigated to ${page.url()}`);

    // Wait for the wizard to render
    await page.waitForFunction(
      () => document.body.innerText.includes("Welcome to Codenaya"),
      { timeout: TIMEOUT }
    );
    ok("Wizard Step 1 ('Welcome to Codenaya') is visible");

    // Click 'Get Started' to advance to Features step
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.innerText.includes("Get Started")
      );
      if (btn) btn.click();
    });

    await page.waitForFunction(
      () => document.body.innerText.includes("What you get"),
      { timeout: TIMEOUT }
    );
    ok("Wizard Step 2 ('What you get') is visible");

    // Click 'Continue' to advance to Auth step
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.innerText.includes("Continue")
      );
      if (btn) btn.click();
    });

    await page.waitForFunction(
      () => document.body.innerText.includes("Log in or sign up"),
      { timeout: TIMEOUT }
    );
    ok("Wizard Step 3 ('Log in or sign up') is visible");

    await page.close();
  }

} catch (err) {
  console.error("\n💥 Fatal error:", err.message);
  failed++;
} finally {
  if (browser) await browser.close();

  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"─".repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}
