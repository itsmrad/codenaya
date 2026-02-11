import { Spinner } from "@/components/ui/spinner";

export const AuthLoadingView = () => {
  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <Spinner className="size-6 text-ring" />
    </div>
  );
};
