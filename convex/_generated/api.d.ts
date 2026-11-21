/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activationEvents from "../activationEvents.js";
import type * as admin from "../admin.js";
import type * as agentTasks from "../agentTasks.js";
import type * as aiProviders from "../aiProviders.js";
import type * as auth from "../auth.js";
import type * as billing from "../billing.js";
import type * as billingLifecycle from "../billingLifecycle.js";
import type * as billingCheckout from "../billingCheckout.js";
import type * as billingEntitlement from "../billingEntitlement.js";
import type * as billingEnv from "../billingEnv.js";
import type * as billingFulfill from "../billingFulfill.js";
import type * as billingGrants from "../billingGrants.js";
import type * as billingPoll from "../billingPoll.js";
import type * as billingQueue from "../billingQueue.js";
import type * as billingReconcile from "../billingReconcile.js";
import type * as billingReversals from "../billingReversals.js";
import type * as billingWebhook from "../billingWebhook.js";
import type * as chatImages from "../chatImages.js";
import type * as checkpointComparison from "../checkpointComparison.js";
import type * as checkpoints from "../checkpoints.js";
import type * as conversations from "../conversations.js";
import type * as credits from "../credits.js";
import type * as crons from "../crons.js";
import type * as envRefs from "../envRefs.js";
import type * as envVars from "../envVars.js";
import type * as errors from "../errors.js";
import type * as fileContents from "../fileContents.js";
import type * as files from "../files.js";
import type * as githubSync from "../githubSync.js";
import type * as http from "../http.js";
import type * as integrations from "../integrations.js";
import type * as internalKey from "../internalKey.js";
import type * as maintenance from "../maintenance.js";
import type * as messageSteps from "../messageSteps.js";
import type * as modelSpend from "../modelSpend.js";
import type * as platformCatalog from "../platformCatalog.js";
import type * as projectCascade from "../projectCascade.js";
import type * as projectCopy from "../projectCopy.js";
import type * as projectNotes from "../projectNotes.js";
import type * as publicPreviews from "../publicPreviews.js";
import type * as projects from "../projects.js";
import type * as promoClaims from "../promoClaims.js";
import type * as runtimeHandles from "../runtimeHandles.js";
import type * as showcase from "../showcase.js";
import type * as skills from "../skills.js";
import type * as stats from "../stats.js";
import type * as swarm from "../swarm.js";
import type * as system from "../system.js";
import type * as userPreferences from "../userPreferences.js";
import type * as users from "../users.js";
import type * as waitlist from "../waitlist.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activationEvents: typeof activationEvents;
  admin: typeof admin;
  agentTasks: typeof agentTasks;
  aiProviders: typeof aiProviders;
  auth: typeof auth;
  billing: typeof billing;
  billingLifecycle: typeof billingLifecycle;
  billingCheckout: typeof billingCheckout;
  billingEntitlement: typeof billingEntitlement;
  billingEnv: typeof billingEnv;
  billingFulfill: typeof billingFulfill;
  billingGrants: typeof billingGrants;
  billingPoll: typeof billingPoll;
  billingQueue: typeof billingQueue;
  billingReconcile: typeof billingReconcile;
  billingReversals: typeof billingReversals;
  billingWebhook: typeof billingWebhook;
  chatImages: typeof chatImages;
  checkpointComparison: typeof checkpointComparison;
  checkpoints: typeof checkpoints;
  conversations: typeof conversations;
  credits: typeof credits;
  crons: typeof crons;
  envRefs: typeof envRefs;
  envVars: typeof envVars;
  errors: typeof errors;
  fileContents: typeof fileContents;
  files: typeof files;
  githubSync: typeof githubSync;
  http: typeof http;
  integrations: typeof integrations;
  internalKey: typeof internalKey;
  maintenance: typeof maintenance;
  messageSteps: typeof messageSteps;
  modelSpend: typeof modelSpend;
  platformCatalog: typeof platformCatalog;
  projectCascade: typeof projectCascade;
  projectCopy: typeof projectCopy;
  projectNotes: typeof projectNotes;
  projects: typeof projects;
  publicPreviews: typeof publicPreviews;
  promoClaims: typeof promoClaims;
  runtimeHandles: typeof runtimeHandles;
  showcase: typeof showcase;
  skills: typeof skills;
  stats: typeof stats;
  swarm: typeof swarm;
  system: typeof system;
  userPreferences: typeof userPreferences;
  users: typeof users;
  waitlist: typeof waitlist;
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
