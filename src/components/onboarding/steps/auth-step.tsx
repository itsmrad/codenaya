"use client";

/**
 * Combined "log in or sign up" step, built on Clerk's headless hooks
 * (useSignIn / useSignUp) rather than Clerk's prebuilt <SignIn>/<SignUp>
 * components, since this needs to match the custom terminal design exactly.
 *
 * IMPORTANT: verify this against Clerk's current docs for your installed
 * @clerk/nextjs version (you're on ^7.2.7). Clerk's exact method names and
 * error-code strings for "user not found" have shifted across major
 * versions before, and this file is the one most likely to need a small
 * adjustment. The pattern itself (try sign-in, fall back to sign-up on a
 * missing account, verify with an emailed code) is Clerk's documented
 * approach for a combined login/signup field.
 */

import { useState } from "react";
import { useSignIn, useSignUp } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NavRow } from "../nav-row";
import type { AuthMethod } from "../types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AuthStep({
  onAuthed,
  onBack,
}: {
  onAuthed: (method: AuthMethod) => void;
  onBack: () => void;
}) {
  const { signIn, setActive: setActiveSignIn, isLoaded: signInLoaded } = useSignIn();
  const { signUp, setActive: setActiveSignUp, isLoaded: signUpLoaded } = useSignUp();

  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [emailTouched, setEmailTouched] = useState(false);
  const [code, setCode] = useState("");
  const [pendingFlow, setPendingFlow] = useState<"sign-in" | "sign-up" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const emailValid = EMAIL_RE.test(email.trim());

  async function handleGithub() {
    if (!signIn) return;
    await signIn.authenticateWithRedirect({
      strategy: "oauth_github",
      redirectUrl: "/onboarding/sso-callback",
      redirectUrlComplete: "/onboarding",
    });
  }

  async function handleEmailSubmit() {
    if (!emailValid || !signIn || !signUp) return;
    setSubmitting(true);
    setError(null);
    try {
      // Try sign-in first — this covers returning users.
      const attempt = await signIn.create({ identifier: email.trim() });
      const emailFactor = attempt.supportedFirstFactors?.find(
        (f) => f.strategy === "email_code"
      );
      if (emailFactor && "emailAddressId" in emailFactor) {
        await signIn.prepareFirstFactor({
          strategy: "email_code",
          emailAddressId: emailFactor.emailAddressId,
        });
        setPendingFlow("sign-in");
        setStage("code");
      }
    } catch (err: unknown) {
      // No account with this email — fall back to sign-up.
      const isNotFound =
        typeof err === "object" &&
        err !== null &&
        "errors" in err &&
        Array.isArray((err as { errors: unknown[] }).errors) &&
        (err as { errors: { code?: string }[] }).errors[0]?.code ===
          "form_identifier_not_found";

      if (isNotFound) {
        try {
          await signUp.create({ emailAddress: email.trim() });
          await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
          setPendingFlow("sign-up");
          setStage("code");
        } catch {
          setError("Something went wrong starting sign up. Try again.");
        }
      } else {
        setError("Something went wrong. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCodeSubmit() {
    if (!code || !pendingFlow) return;
    setSubmitting(true);
    setError(null);
    try {
      if (pendingFlow === "sign-in") {
        const result = await signIn!.attemptFirstFactor({
          strategy: "email_code",
          code,
        });
        if (result.status === "complete") {
          await setActiveSignIn!({ session: result.createdSessionId });
          onAuthed("email");
        }
      } else {
        const result = await signUp!.attemptEmailAddressVerification({ code });
        if (result.status === "complete") {
          await setActiveSignUp!({ session: result.createdSessionId });
          onAuthed("email");
        }
      }
    } catch {
      setError("That code didn't work. Check it and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const authReady = signInLoaded && signUpLoaded;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-7">
        <h1 className="text-4xl font-bold text-foreground">Log in or sign up</h1>

        {stage === "email" && (
          <>
            <p className="max-w-[420px] text-[15px] text-muted-foreground">
              Use GitHub for one-click access, or continue with email.
            </p>

            <button
              type="button"
              onClick={handleGithub}
              disabled={!authReady}
              className="flex max-w-[460px] items-center justify-center gap-2.5 rounded-lg bg-foreground py-3.5 text-sm font-semibold text-background hover:brightness-95 disabled:opacity-50"
            >
              <span aria-hidden className="size-4 rounded-full bg-background" />
              Continue with GitHub
            </button>

            <div className="flex max-w-[460px] items-center gap-3" role="separator">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <div className="flex max-w-[460px] flex-col gap-2">
              <label htmlFor="email-input" className="text-xs font-medium text-muted-foreground">
                Email
              </label>
              <input
                id="email-input"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setEmailTouched(true)}
                aria-invalid={emailTouched && email.length > 0 && !emailValid}
                className={cn(
                  "border-b border-border bg-transparent pb-2.5 font-mono text-[15px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-brand",
                  emailTouched && email.length > 0 && !emailValid && "border-destructive"
                )}
              />
              <p className="min-h-[15px] text-xs text-destructive">
                {emailTouched && email.length > 0 && !emailValid
                  ? "Enter a valid email address."
                  : error ?? ""}
              </p>
            </div>
          </>
        )}

        {stage === "code" && (
          <>
            <p className="max-w-[420px] text-[15px] text-muted-foreground">
              Enter the code we sent to {email}.
            </p>
            <div className="flex max-w-[460px] flex-col gap-2">
              <label htmlFor="code-input" className="text-xs font-medium text-muted-foreground">
                Verification code
              </label>
              <input
                id="code-input"
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="border-b border-border bg-transparent pb-2.5 font-mono text-[15px] text-foreground outline-none focus:border-brand"
              />
              <p className="min-h-[15px] text-xs text-destructive">{error ?? ""}</p>
            </div>
          </>
        )}
      </div>

      <NavRow onBack={stage === "code" ? () => setStage("email") : onBack}>
        <Button
          className="bg-brand text-brand-foreground hover:bg-brand/90"
          disabled={
            submitting ||
            (stage === "email" ? !emailValid : code.trim().length === 0)
          }
          onClick={stage === "email" ? handleEmailSubmit : handleCodeSubmit}
        >
          Continue
        </Button>
      </NavRow>
    </div>
  );
}
