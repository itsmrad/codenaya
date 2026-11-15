"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { SIGN_UP_URL } from "@/features/auth/constants";
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";
import { authRedirectUrl } from "@/features/showcase/hooks/use-remix";
import { importPath } from "../utils/github-repo";
import { savePendingImport } from "../utils/pending-import";

/** Keeps the repo across sign-up, then sends the visitor to sign up. */
export const SignUpToImport = ({ repo }: { repo: string }) => {
  const router = useRouter();

  useEffect(() => {
    savePendingImport(repo);
    router.replace(authRedirectUrl(SIGN_UP_URL, importPath(repo)));
  }, [repo, router]);

  return <AuthLoadingView />;
};
