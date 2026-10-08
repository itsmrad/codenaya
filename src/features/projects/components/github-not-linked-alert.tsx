import Link from "next/link";
import { FaGithub } from "react-icons/fa";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ACCOUNT_SETTINGS_URL } from "@/features/settings/nav";

export const GithubNotLinkedAlert = () => {
  return (
    <Alert>
      <FaGithub className="size-4" />
      <AlertTitle>GitHub account not connected</AlertTitle>
      <AlertDescription>
        <p>
          Connect your GitHub account in your account settings, then try again.
        </p>
        <Button asChild size="sm" className="mt-2">
          <Link href={ACCOUNT_SETTINGS_URL}>Connect GitHub</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
};
