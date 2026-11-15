import { expect, test } from "@playwright/test";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { hasClerkCredentials, signIn } from "./clerk-auth";
import { collectConsoleErrors } from "./console-errors";
import { userConvexClient } from "./convex-client";
import { STUB_MODEL, startStubProvider } from "./stub-provider";

// Stub inference only; preview and checkBuild still use the real Vite starter.
const APP = `import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetTrigger, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { toast } from "sonner";

export default function App() {
  return <main className="container py-8">
    <Card><CardHeader><CardTitle>Starter components</CardTitle></CardHeader><CardContent className="flex flex-col gap-4">
      <Avatar><AvatarFallback>UI</AvatarFallback></Avatar><Badge>Ready</Badge>
      <Label htmlFor="name">Name</Label><Input id="name" /><Textarea aria-label="Notes" />
      <Select><SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger><SelectContent><SelectItem value="one">One</SelectItem></SelectContent></Select>
      <Tabs defaultValue="one"><TabsList><TabsTrigger value="one">Overview</TabsTrigger></TabsList><TabsContent value="one">All components installed</TabsContent></Tabs>
      <Separator /><Skeleton className="h-4 w-24" />
      <Dialog><DialogTrigger asChild><Button>Open dialog</Button></DialogTrigger><DialogContent><DialogTitle>Stock dialog</DialogTitle><DialogDescription>Accessible by default</DialogDescription></DialogContent></Dialog>
      <Sheet><SheetTrigger asChild><Button>Open sheet</Button></SheetTrigger><SheetContent><SheetTitle>Stock sheet</SheetTitle><SheetDescription>Navigation</SheetDescription></SheetContent></Sheet>
      <DropdownMenu><DropdownMenuTrigger asChild><Button>Menu</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>Item</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      <TooltipProvider><Tooltip><TooltipTrigger asChild><Button>Help</Button></TooltipTrigger><TooltipContent>Stock tooltip</TooltipContent></Tooltip></TooltipProvider>
      <Button onClick={() => toast.success("Saved successfully")}>Save</Button>
    </CardContent></Card>
  </main>;
}
`;

test.describe("agent Vite + React scaffold", () => {
  // Opt-in (#190): every run spends a real E2B sandbox.
  test.skip(
    !process.env.E2E_LIVE_AGENT ||
      !hasClerkCredentials() ||
      !process.env.E2B_API_KEY ||
      !process.env.E2B_TEMPLATE,
    "Opt-in run: needs E2E_LIVE_AGENT=1, Inngest dev, Clerk, E2B_API_KEY and E2B_TEMPLATE; inference uses a local stub",
  );

  test("ships all common components and boots without a Vite error overlay", async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const apiKey = `sk-e2e-starter-${Date.now()}-stub`;
    const label = `Starter stub ${Date.now()}`;
    const called = (messages: unknown, name: string) => JSON.stringify(messages).includes(`"name":"${name}"`);
    const stub = await startStubProvider(apiKey, {
      reply: "Starter components are ready.",
      toolCall: { name: "scaffoldViteApp", arguments: {} },
      followUp: ({ messages }) => {
        if (!called(messages, "writeFiles")) {
          return { name: "writeFiles", arguments: { files: [{ path: "src/App.tsx", content: APP }] } };
        }
        if (!called(messages, "checkBuild")) return { name: "checkBuild", arguments: {} };
      },
    });
    let user: Awaited<ReturnType<typeof userConvexClient>> | undefined;
    let keyId: Id<"aiProviderKeys"> | undefined;
    let projectId: Id<"projects"> | undefined;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      const errors = collectConsoleErrors(page);
      await signIn(page);
      user = await userConvexClient(page);
      projectId = await user.mutation(api.projects.create, { name: `e2e-vite-scaffold-${Date.now()}` });
      const response = await page.request.post("/api/ai-providers", {
        data: { provider: "custom", apiKey, label, baseUrl: stub.baseUrl, modelIds: [STUB_MODEL] },
      });
      expect(response.status()).toBe(200);
      keyId = (await response.json()).keyId;

      await page.goto(`/projects/${projectId}`);
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      await page.getByRole("button", { name: "New conversation" }).click();
      const trigger = page.getByRole("combobox", { name: "Agent model" });
      await trigger.click();
      await page.getByRole("group", { name: label }).getByRole("option", { name: STUB_MODEL }).click();
      await expect(trigger).toHaveText(STUB_MODEL);
      const input = page.getByPlaceholder("Describe a change or ask a question…");
      await input.fill("Build a Vite + React page using the starter components");
      await input.press("Enter");
      await expect(page.getByText("Starter components are ready.")).toBeVisible({ timeout: 5 * 60_000 });
      expect(stub.models.length).toBeGreaterThan(0);
      expect(new Set(stub.models)).toEqual(new Set([STUB_MODEL]));

      await page.getByRole("tab", { name: "Preview" }).click();
      const preview = page.frameLocator('iframe[title="Preview"]');
      await expect(preview.getByText("Starter components", { exact: true })).toBeVisible({ timeout: 4 * 60_000 });
      await expect(preview.locator("vite-error-overlay")).toHaveCount(0);
      await preview.getByRole("button", { name: "Open dialog" }).click();
      await expect(preview.getByRole("dialog", { name: "Stock dialog" })).toBeVisible();
      await page.keyboard.press("Escape");
      await preview.getByRole("button", { name: "Save", exact: true }).click();
      await expect(preview.getByText("Saved successfully")).toBeVisible();
      await test.info().attach("starter-components", { body: await page.screenshot(), contentType: "image/png" });
      expect(errors).toEqual([]);
    } finally {
      stub.server.close();
      await Promise.all([
        keyId && user?.mutation(api.aiProviders.remove, { keyId }),
        projectId && user?.mutation(api.projects.remove, { id: projectId }),
      ]);
    }
  });
});
