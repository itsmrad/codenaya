/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as envVars from "../envVars.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as integrations from "../integrations.js";
import type * as maintenance from "../maintenance.js";
import type * as projectCascade from "../projectCascade.js";
import type * as projects from "../projects.js";
import type * as showcase from "../showcase.js";
import type * as system from "../system.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  conversations: typeof conversations;
  crons: typeof crons;
  envVars: typeof envVars;
  files: typeof files;
  http: typeof http;
  integrations: typeof integrations;
  maintenance: typeof maintenance;
  projectCascade: typeof projectCascade;
  projects: typeof projects;
  showcase: typeof showcase;
  system: typeof system;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
