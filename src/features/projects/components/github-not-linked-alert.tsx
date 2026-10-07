import { FaGithub } from "react-icons/fa";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface GithubNotLinkedAlertProps {
  onConnect: () => void;
}

export const GithubNotLinkedAlert = ({ onConnect }: GithubNotLinkedAlertProps) => {
  return (
    <Alert>
      <FaGithub className="size-4" />
      <AlertTitle>GitHub account not connected</AlertTitle>
      <AlertDescription>
        <p>
          Connect your GitHub account in your account settings, then try again.
        </p>
        <Button type="button" size="sm" className="mt-2" onClick={onConnect}>
          Connect GitHub
        </Button>
      </AlertDescription>
    </Alert>
  );
};
