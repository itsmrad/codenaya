import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerProjectCommands, useCommandPalette } from "./command-palette";

const commands = () => useCommandPalette.getState().commands;

describe("registerProjectCommands", () => {
  beforeEach(() => {
    useCommandPalette.setState({ commands: {} });
  });

  it("registers actions with a handler and hides null ones", () => {
    const skills = vi.fn();
    const handlers = { skills, publish: null };
    registerProjectCommands(handlers, () => handlers);

    expect(Object.keys(commands())).toEqual(["skills"]);
    commands().skills!();
    expect(skills).toHaveBeenCalledOnce();
  });

  it("runs the latest handler, not the one it registered with", () => {
    const first = vi.fn();
    const second = vi.fn();
    let latest = { skills: first };
    registerProjectCommands(latest, () => latest);

    latest = { skills: second };
    commands().skills!();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("removes its actions on cleanup, leaving other components' alone", () => {
    const sidebar = { "new-conversation": vi.fn() };
    const view = { skills: vi.fn() };
    const unregisterSidebar = registerProjectCommands(sidebar, () => sidebar);
    registerProjectCommands(view, () => view);

    unregisterSidebar();
    expect(Object.keys(commands())).toEqual(["skills"]);
  });

  it("keeps an id another component registered since", () => {
    const layout = { "toggle-chat": vi.fn() };
    const view = { "toggle-chat": vi.fn() };
    const unregisterLayout = registerProjectCommands(layout, () => layout);
    registerProjectCommands(view, () => view);

    unregisterLayout();
    commands()["toggle-chat"]!();
    expect(view["toggle-chat"]).toHaveBeenCalledOnce();
    expect(layout["toggle-chat"]).not.toHaveBeenCalled();
  });
});
