import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/sign-up" }));

import { PendingStartNote } from "./pending-start-note";

describe("PendingStartNote (#252)", () => {
  it("renders nothing on the server, where storage can't be read", () => {
    expect(renderToStaticMarkup(createElement(PendingStartNote))).toBe("");
  });
});
