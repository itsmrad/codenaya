/**
 * Builds the E2B template the cloud preview boots from (#178).
 *
 * The E2B `base` image ships Node 20.9, and Vite 7 needs ^20.19 || >=22.12
 * (it calls `crypto.hash`), so generated apps on Vite 7 crash at startup.
 * This template is the official Node 22 LTS image, which E2B turns into a
 * sandbox with the same `user` account and /home/user home the route expects.
 *
 * Usage (needs E2B_API_KEY; builds into that key's E2B team):
 *   npm run e2b:template
 * then set E2B_TEMPLATE=codenaya-node22 wherever the app runs.
 */
import { Template, defaultBuildLogger } from "e2b";

const TEMPLATE_NAME = "codenaya-node22";

const template = Template().fromNodeImage("22");

await Template.build(template, TEMPLATE_NAME, {
  onBuildLogs: defaultBuildLogger(),
});

console.log(`Built E2B template "${TEMPLATE_NAME}". Set E2B_TEMPLATE=${TEMPLATE_NAME}.`);
