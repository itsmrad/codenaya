import type { Metadata } from "next";

import { LegalContact, LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy — Codenaya",
  description: "What data Codenaya stores, which services process it, and how to reach us.",
};

// Public: Google OAuth consent and Clerk production need a reachable privacy URL.
const PrivacyPage = () => {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="October 7, 2026">
      <section>
        <p>
          This policy explains what Codenaya (&ldquo;we&rdquo;, &ldquo;us&rdquo;) collects when you
          use the Codenaya browser IDE, why, and who processes it on our behalf.
        </p>
      </section>

      <section>
        <h2>Data we store</h2>
        <ul>
          <li>
            <strong>Account details</strong> — your name, email address and avatar, managed by our
            authentication provider, Clerk. If you sign in with a provider such as Google, we receive the
            basic profile those providers share.
          </li>
          <li>
            <strong>Projects and conversations</strong> — your project files, chat messages with
            the AI agent, skills, settings and showcase entries, stored in our database on Convex.
          </li>
          <li>
            <strong>Secrets</strong> — environment variables marked secret and integration tokens
            are encrypted before they are stored.
          </li>
        </ul>
      </section>

      <section>
        <h2>AI providers</h2>
        <p>
          Prompts, chat history and the project files the agent needs are sent to OpenRouter, which
          routes them to the model you choose. If you bring your own API key (BYOK), the key is
          encrypted at rest and only decrypted on the server to call that provider for you.
        </p>
      </section>

      <section>
        <h2>Sandboxes</h2>
        <p>
          Live previews and the terminal run your project code in isolated sandboxes hosted by
          E2B. Sandboxes are temporary and are shut down when they are no longer in use.
        </p>
      </section>

      <section>
        <h2>Other service providers</h2>
        <ul>
          <li>Sentry, to record errors so we can fix them.</li>
          <li>GitHub, only when you import from or export to a repository.</li>
        </ul>
        <p className="mt-3">We do not sell your personal data.</p>
      </section>

      <section>
        <h2>Your choices</h2>
        <p>
          You can delete projects and stored keys from the app at any time. To delete your account
          or request a copy of your data, contact us at <LegalContact />.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about this policy: <LegalContact />.
        </p>
      </section>
    </LegalPage>
  );
};

export default PrivacyPage;
