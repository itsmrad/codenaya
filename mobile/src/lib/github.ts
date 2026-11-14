import * as WebBrowser from "expo-web-browser";

import { confirm } from "@/components/dialogs";

import { webUrl } from "./http";

/** The GitHub routes' error code for "no GitHub account linked" (projects/constants.ts). */
export const GITHUB_NOT_LINKED = "GITHUB_NOT_LINKED";

/**
 * Like the web's GithubNotLinkedAlert. Linking GitHub is a Clerk OAuth flow,
 * which (like Google sign-in) needs a dev build, so it happens on the website.
 */
export const alertGithubNotLinked = async (
  description = "Connect your GitHub account in your account settings, then try again.",
) => {
  if (await confirm({ title: "GitHub account not connected", message: description, confirmLabel: "Connect GitHub" })) {
    WebBrowser.openBrowserAsync(webUrl("/settings/account"));
  }
};
