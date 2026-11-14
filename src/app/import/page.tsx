import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { MarketingNavbar } from "@/components/marketing-navbar";
import { NotFoundView } from "@/components/not-found-view";
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";
import { SignUpToImport } from "@/features/projects/components/sign-up-to-import";
import { parseGithubRepo } from "@/features/projects/utils/github-repo";

type ImportPageProps = {
  searchParams: Promise<{ repo?: string | string[] }>;
};

/**
 * "Open in Codenaya" deep link: /import?repo=owner/repo (or a full GitHub
 * URL). Signed-in users land on the dashboard with the import dialog
 * prefilled; signed-out visitors sign up first and come back here.
 */
const ImportContent = async ({ searchParams }: ImportPageProps) => {
  const { repo } = await searchParams;
  const slug = typeof repo === "string" ? parseGithubRepo(repo) : null;

  if (!slug) {
    return (
      <NotFoundView
        header={<MarketingNavbar />}
        label="Import"
        title="Can't open that repository"
        description="This link doesn't point to a GitHub repository. It should look like /import?repo=owner/repo."
      />
    );
  }

  const { userId } = await auth();
  if (userId) redirect(`/?import=${slug}`);

  return <SignUpToImport repo={slug} />;
};

const ImportPage = (props: ImportPageProps) => {
  return (
    <Suspense fallback={<AuthLoadingView />}>
      <ImportContent {...props} />
    </Suspense>
  );
};

export default ImportPage;
