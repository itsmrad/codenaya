import * as SecureStore from "expo-secure-store";
import { useState } from "react";
import { Appearance } from "react-native";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "codenaya.theme";

// Missing on web, including the server render a release export runs.
const apply = (choice: ThemeChoice) =>
  Appearance.setColorScheme?.(choice === "system" ? "unspecified" : choice);

const stored = (): ThemeChoice => {
  try {
    const value = SecureStore.getItem(KEY);
    return value === "system" || value === "light" ? value : "dark";
  } catch {
    return "dark";
  }
};

/**
 * Applies the saved theme before the first screen renders. Dark is the
 * default, as on the website (defaultTheme="dark").
 */
export const applySavedTheme = () => apply(stored());

/** The Appearance setting: System follows the device; the choice stays on it. */
export const useThemeChoice = () => {
  const [choice, setChoice] = useState(stored);
  const update = (next: ThemeChoice) => {
    setChoice(next);
    apply(next);
    SecureStore.setItemAsync(KEY, next).catch(() => undefined);
  };
  return [choice, update] as const;
};
