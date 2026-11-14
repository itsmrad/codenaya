import { anyApi } from "convex/server";

import type { api as generatedApi } from "../../../convex/_generated/api";

// The web app's typed Convex API. The import is type-only, so Metro never
// bundles ../convex; at runtime `api` is the same proxy the generated file
// exports.
export const api = anyApi as unknown as typeof generatedApi;
