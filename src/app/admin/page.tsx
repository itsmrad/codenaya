import type { Metadata } from "next";
import { connection } from "next/server";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuditLogCard } from "@/features/admin/components/audit-log-card";
import { ModelsTab } from "@/features/admin/components/models-tab";
import { UsageTab } from "@/features/admin/components/usage-tab";
import { PLATFORM_PROVIDER_IDS, platformProviderId } from "@/features/ai-providers/platform";
import { AI_PROVIDERS } from "@/features/ai-providers/registry";
import { PLATFORM_KEY_ENV, platformKeyOrNull } from "@/features/ai-providers/server/platform-model";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };

// Blocks on the session in the admin layout; see `instant` there.
export const instant = false;

const AdminPage = async () => {
  // Read the env per request, not baked in at build.
  await connection();
  // Only whether each key is set reaches the browser, never the key.
  const providers = PLATFORM_PROVIDER_IDS.map((id) => ({
    id,
    label: AI_PROVIDERS[id].label,
    keyEnvVar: PLATFORM_KEY_ENV[id],
    keyConfigured: platformKeyOrNull(id) !== null,
  }));

  return (
    <>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-muted-foreground">
          The AI provider, models and usage limits behind the Codenaya key.
        </p>
      </header>

      <Tabs defaultValue="models" className="gap-6">
        <TabsList>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="usage">Usage &amp; limits</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        <TabsContent value="models" className="space-y-6">
          <ModelsTab providers={providers} fallbackProvider={platformProviderId()} />
        </TabsContent>
        <TabsContent value="usage" className="space-y-6">
          <UsageTab fallbackProvider={platformProviderId()} />
        </TabsContent>
        <TabsContent value="audit">
          <AuditLogCard />
        </TabsContent>
      </Tabs>
    </>
  );
};

export default AdminPage;
