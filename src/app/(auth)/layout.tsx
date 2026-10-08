import { AppNavbar } from "@/components/app-navbar";
import { GridPattern } from "@/components/landing/grid-pattern";

const AuthLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AppNavbar />
      <main className="relative flex-1 flex items-center justify-center overflow-hidden px-4 py-12">
        <GridPattern />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_40%,rgba(232,130,79,0.08),transparent_70%)] dark:bg-[radial-gradient(ellipse_60%_50%_at_50%_40%,rgba(232,130,79,0.12),transparent_70%)]" />
        <div className="relative z-10">{children}</div>
      </main>
    </div>
  );
};

export default AuthLayout;
