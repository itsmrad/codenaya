import type { Metadata } from "next";
import Link from "next/link";

import { LegalContact, LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service — Codenaya",
  description: "The terms for using the Codenaya browser IDE.",
};

const TermsPage = () => {
  return (
    <LegalPage title="Terms of Service" lastUpdated="October 7, 2026">
      <section>
        <p>
          These terms govern your use of Codenaya, a browser IDE with an AI agent, operated by
          Codenaya (&ldquo;we&rdquo;, &ldquo;us&rdquo;). By creating an account or using the
          service, you agree to them.
        </p>
      </section>

      <section>
        <h2>Your account</h2>
        <p>
          You are responsible for activity on your account and for keeping your sign-in details
          and any API keys you add secure.
        </p>
      </section>

      <section>
        <h2>Your content</h2>
        <p>
          You own the code, prompts and other content you create in Codenaya. You give us the
          rights needed to store and process it to run the service, including sending it to the
          AI and sandbox providers described in our <Link href="/privacy">Privacy Policy</Link>.
          Projects you publish to the showcase are visible to anyone.
        </p>
      </section>

      <section>
        <h2>Acceptable use</h2>
        <ul>
          <li>Do not use Codenaya to break the law or infringe the rights of others.</li>
          <li>Do not attack, overload or try to escape the sandboxes or the service.</li>
          <li>Do not use the service to build malware or to send spam.</li>
        </ul>
      </section>

      <section>
        <h2>AI output</h2>
        <p>
          AI-generated code can be wrong or insecure. Review it before you rely on it or deploy
          it.
        </p>
      </section>

      <section>
        <h2>Disclaimer and liability</h2>
        <p>
          The service is provided &ldquo;as is&rdquo;, without warranties of any kind. To the
          extent the law allows, we are not liable for indirect or consequential losses, or for
          loss of data.
        </p>
      </section>

      <section>
        <h2>Changes and termination</h2>
        <p>
          We may update these terms or suspend accounts that break them. If we make material
          changes, we will update the date at the top of this page.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about these terms: <LegalContact />.
        </p>
      </section>
    </LegalPage>
  );
};

export default TermsPage;
