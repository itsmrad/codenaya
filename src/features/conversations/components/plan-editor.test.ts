/**
 * The plan editor (#527), without a DOM: the element tree is walked to find
 * its buttons and call their handlers, and the markup is rendered on the server.
 */

import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";

import { buildPlanMessage } from "../plan-mode";
import { PlanEditor } from "./plan-editor";

type Props = { children?: ReactNode; disabled?: boolean; onClick?: () => void };

const elements = (node: ReactNode): ReactElement<Props>[] =>
  Children.toArray(node).flatMap((child) =>
    isValidElement<Props>(child) ? [child, ...elements(child.props.children)] : [],
  );

const text = (node: ReactNode): string =>
  Children.toArray(node)
    .map((child) => (isValidElement<Props>(child) ? text(child.props.children) : String(child)))
    .join("");

const PLAN = "### Steps\n- [ ] Add a footer";

const editor = (value: string) => {
  const props = { value, onChange: vi.fn(), onBuild: vi.fn(), onCancel: vi.fn() };
  const button = (label: string) =>
    elements(PlanEditor(props)).find(
      (element) => element.type === Button && text(element.props.children).includes(label),
    )!;
  return { props, button };
};

describe("PlanEditor", () => {
  it("shows the plan's Markdown in a text area", () => {
    const html = renderToStaticMarkup(
      createElement(PlanEditor, { value: PLAN, onChange: () => {}, onBuild: () => {}, onCancel: () => {} }),
    );
    expect(html).toContain('aria-label="Edit plan"');
    expect(html).toContain("- [ ] Add a footer</textarea>");
  });

  it("builds the edited plan as a build message", () => {
    const { props, button } = editor(`${PLAN}\n- [ ] Add a header\n`);
    button("Build edited plan").props.onClick!();
    expect(props.onBuild).toHaveBeenCalledWith(buildPlanMessage(`${PLAN}\n- [ ] Add a header`));
  });

  it("cancels without building", () => {
    const { props, button } = editor("an edit to throw away");
    button("Cancel").props.onClick!();
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onBuild).not.toHaveBeenCalled();
  });

  it("cannot build an empty plan", () => {
    const { props, button } = editor("  \n");
    expect(button("Build edited plan").props.disabled).toBe(true);
    button("Build edited plan").props.onClick!();
    expect(props.onBuild).not.toHaveBeenCalled();
  });
});
