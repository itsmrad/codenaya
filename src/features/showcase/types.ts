import type { FunctionReturnType } from "convex/server";

import type { api } from "../../../convex/_generated/api";

/** A published showcase entry as the public queries return it: no project or owner id. */
export type ShowcaseProject = NonNullable<
  FunctionReturnType<typeof api.showcase.getById>
>;
