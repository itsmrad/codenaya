"use client";

import { useState, type FormEvent } from "react";
import { useUser } from "@clerk/nextjs";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Status = "idle" | "open" | "sending" | "joined" | "error";

/**
 * "Notify me when Pro launches" (#250): a button that opens an inline email
 * form, prefilled for signed-in users, posting to /api/waitlist.
 */
export const ProWaitlist = () => {
  const { user } = useUser();
  const [status, setStatus] = useState<Status>("idle");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");

  if (status === "joined") {
    return (
      <p role="status" className="flex w-full items-center justify-center gap-2 text-sm text-foreground">
        <Check className="size-4 text-brand" aria-hidden />
        We&apos;ll email you when Pro is available.
      </p>
    );
  }

  if (status === "idle") {
    return (
      <Button
        className="w-full"
        variant="outline"
        onClick={() => {
          setEmail(user?.primaryEmailAddress?.emailAddress ?? "");
          setStatus("open");
        }}
      >
        Notify me when Pro launches
      </Button>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("sending");
    const response = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => null);
    if (response?.ok) return setStatus("joined");
    setError(
      response?.status === 400
        ? "Enter a valid email address."
        : response?.status === 429
          ? "Too many tries. Please wait a few minutes."
          : "Couldn't save your email. Please try again.",
    );
    setStatus("error");
  };

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-2">
      <div className="flex gap-2">
        <Input
          type="email"
          required
          autoFocus
          autoComplete="email"
          aria-label="Email address"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={status === "error"}
          aria-describedby={status === "error" ? "pro-waitlist-error" : undefined}
        />
        <Button type="submit" disabled={status === "sending"}>
          {status === "sending" ? "Saving…" : "Notify me"}
        </Button>
      </div>
      {status === "error" && (
        <p id="pro-waitlist-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
};
