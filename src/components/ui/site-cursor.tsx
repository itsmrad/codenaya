"use client";

import { BracketCursor } from "./bracket-cursor";
import { CustomCursor } from "./custom-cursor";

/**
 * The site's cursor. `classic` is the original ring-and-dot cursor, kept as
 * it was: set CURSOR to "classic" to roll back.
 */
const CURSOR = "brackets" as "brackets" | "classic";

export const SiteCursor = () => (CURSOR === "classic" ? <CustomCursor /> : <BracketCursor />);
