import { permanentRedirect } from "next/navigation";
import { sharePath } from "@/features/share/utils";
import { Suspense } from "react";

const Redirect = async ({ params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params;
  permanentRedirect(sharePath(token));
};
export default function SharePage(props: { params: Promise<{ token: string }> }) {
  return <Suspense><Redirect {...props} /></Suspense>;
}
