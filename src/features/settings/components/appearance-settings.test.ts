import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { AppearanceSettings } from "./appearance-settings";

let permission: NotificationPermission | "unsupported" = "default";

vi.mock("@/hooks/use-build-signals", () => ({
  useBuildSignalPreferences: () => ({
    soundEnabled: false,
    notifEnabled: false,
    permission,
    toggleSound: () => {},
    toggleNotif: () => {},
  }),
}));

// The notification switch is the one labelled "Browser notification".
const notificationSwitch = () => {
  const html = renderToStaticMarkup(createElement(AppearanceSettings));
  const tag = html.match(/<button[^>]*aria-label="Browser notification"[^>]*>/)?.[0] ?? "";
  return { html, disabled: /\sdisabled(=|\s|>)/.test(tag) };
};

it("disables the notification switch and says why when the browser has no notifications", () => {
  permission = "unsupported";
  const { html, disabled } = notificationSwitch();
  expect(disabled).toBe(true);
  expect(html).toContain("This browser doesn&#x27;t support notifications.");
});

it("keeps the switch disabled with the existing copy when permission is denied", () => {
  permission = "denied";
  const { html, disabled } = notificationSwitch();
  expect(disabled).toBe(true);
  expect(html).toContain("Notifications are blocked in your browser settings.");
});

it("leaves the switch enabled when notifications can be requested", () => {
  permission = "default";
  const { html, disabled } = notificationSwitch();
  expect(disabled).toBe(false);
  expect(html).toContain("Sends a system notification");
});
