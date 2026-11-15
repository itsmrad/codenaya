import { NextResponse } from "next/server";

import { convex } from "@/lib/convex-client";

import { api } from "../../../../convex/_generated/api";
import { type MessageMode, SWARM_MODE } from "../plan-mode";

export const SWARM_OFF_ERROR = "Swarm mode is turned off right now. Use Build mode.";

/** The kill switch's refusal (ADR 0013) of a swarm-mode send, before anything is created. */
export const swarmOffResponse = async (mode?: MessageMode) =>
  mode === SWARM_MODE && !(await convex.query(api.swarm.isEnabled, {}))
    ? NextResponse.json({ error: SWARM_OFF_ERROR, code: "swarm_disabled" }, { status: 403 })
    : undefined;
