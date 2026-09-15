import { redirect } from "next/navigation";
import { currentUser } from "@clerk/nextjs/server";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";

export default async function OnboardingPage() {
  const user = await currentUser();

  // Already finished setup — don't show onboarding again on re-login.
  if (user?.publicMetadata?.hasCompletedOnboarding) {
    redirect("/");
  }

  return <OnboardingWizard />;
}
