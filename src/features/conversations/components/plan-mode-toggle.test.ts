// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { type ComposerMode, PlanModeToggle } from "./plan-mode-toggle";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("selects Plan with ArrowRight from Build", async () => {
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  });
  const onModeChange = vi.fn();
  const Composer = () => {
    const [mode, setMode] = useState<ComposerMode>("build");
    return createElement(PlanModeToggle, {
      mode,
      onModeChange: (next) => {
        setMode(next);
        onModeChange(next);
      },
    });
  };
  const user = userEvent.setup();
  render(createElement(Composer));
  act(() => screen.getByRole("radio", { name: "Build" }).focus());

  await user.keyboard("{ArrowRight}");

  await waitFor(() => {
    const plan = screen.getByRole("radio", { name: "Plan" });
    expect(plan.getAttribute("aria-checked")).toBe("true");
    expect(plan.getAttribute("data-state")).toBe("checked");
    expect(onModeChange).toHaveBeenCalledWith("plan");
  });
});
