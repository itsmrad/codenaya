import * as WebBrowser from "expo-web-browser";
import { Alert } from "react-native";

import { webUrl } from "./http";

/** The GitHub routes' error code for "no GitHub account linked" (projects/constants.ts). */
export const GITHUB_NOT_LINKED = "GITHUB_NOT_LINKED";

/**
 * Like the web's GithubNotLinkedAlert. Linking GitHub is a Clerk OAuth flow,
 * which (like Google sign-in) needs a dev build, so it happens on the website.
 */
export const alertGithubNotLinked = (
  description = "Connect your GitHub account in your account settings, then try again.",
) =>
  Alert.alert("GitHub account not connected", description, [
    { text: "Cancel", style: "cancel" },
    { text: "Connect GitHub", onPress: () => WebBrowser.openBrowserAsync(webUrl("/settings/account")) },
  ]);
