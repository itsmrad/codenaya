import type { Metadata } from "next";
import { connection } from "next/server";

import { ModelsTab } from "@/features/admin/components/models-tab";
import { PLATFORM_PROVIDER_IDS, platformProviderId } from "@/features/ai-providers/platform";
import { AI_PROVIDERS } from "@/features/ai-providers/registry";
import { platformKeyOrNull } from "@/features/ai-providers/server/platform-model";

export const metadata: Metadata = { title: "Models · Admin", robots: { index: false } };

// Blocks on the session in the admin layout; see `instant` there.
export const instant = false;

const AdminModelsPage = async () => {
  // Read the env per request, not baked in at build.
  await connection();
  // Only whether each key is set reaches the browser, never the key.
  const providers = PLATFORM_PROVIDER_IDS.map((id) => ({
    id,
    label: AI_PROVIDERS[id].label,
    keyConfigured: platformKeyOrNull(id) !== null,
  }));

  return (
    <>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Models</h1>
        <p className="text-sm text-muted-foreground">What users can pick on the Codenaya key, the provider that serves each, and what it costs us.</p>
      </header>
      <ModelsTab providers={providers} fallbackProviderLabel={AI_PROVIDERS[platformProviderId()].label} />
    </>
  );
};

export default AdminModelsPage;
