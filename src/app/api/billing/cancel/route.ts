import { subscriptionControlRoute } from "@/features/billing/server/subscription-route";

export const maxDuration = 60;
export const POST = (request: Request) => subscriptionControlRoute(request, "cancel");
