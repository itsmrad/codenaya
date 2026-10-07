import type { ITheme } from "@xterm/xterm";

// Transparent so the terminal sits on its panel's own background.
const darkTheme: ITheme = { background: "#00000000" };

// xterm's defaults are meant for a dark background (white text, pale ANSI
// colours); these stay readable on the light panel.
const lightTheme: ITheme = {
  background: "#00000000",
  foreground: "#383a42",
  cursor: "#383a42",
  cursorAccent: "#faf8f5",
  selectionBackground: "#dce5f5",
  black: "#383a42",
  red: "#b02f37",
  green: "#2f6f1c",
  yellow: "#7a5c00",
  blue: "#2c58bb",
  magenta: "#a0229e",
  cyan: "#0b6a83",
  white: "#5f626c",
  brightBlack: "#5f626c",
  brightRed: "#9c1c24",
  brightGreen: "#245a14",
  brightYellow: "#9c4800",
  brightBlue: "#1f4699",
  brightMagenta: "#841b82",
  brightCyan: "#08566b",
  brightWhite: "#383a42",
};

/** xterm colours matching the app theme (`resolvedTheme` from next-themes). */
export const getTerminalTheme = (resolvedTheme?: string): ITheme =>
  resolvedTheme === "light" ? lightTheme : darkTheme;
