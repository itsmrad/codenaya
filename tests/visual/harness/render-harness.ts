/**
 * Renders the file-explorer visual harness to a single self-contained HTML
 * string. No build step, no Tailwind compilation, no backend: the design tokens
 * and markup are copied 1:1 from the production components so a visual change
 * there is reproduced here and caught by Playwright screenshot diffs.
 *
 * Keep this in sync with:
 *   - src/app/globals.css                    (design tokens)
 *   - src/features/projects/components/file-explorer/*  (markup + classes)
 */

import {
	EXPLORER_STATES,
	getItemPadding,
	type ExplorerState,
	type TreeNode,
} from "./explorer-states";

// --- Design tokens (dark theme, from globals.css .dark block) ---------------
const TOKENS = {
	background: "#09090b",
	foreground: "#f0ece6",
	muted: "#1c1c20",
	mutedForeground: "#8a8580",
	accent: "#252529",
	border: "rgba(255, 255, 255, 0.08)",
	ring: "#e8824f",
	radius: "0.75rem",
};

const FONT_STACK =
	"ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const ROW_HEIGHT = "22px"; // h-5.5 = 1.375rem

// --- SVG icons (inline so there is no network or font dependency) -----------
const chevron = (rotated: boolean) => `
	<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
		stroke="${TOKENS.mutedForeground}" stroke-width="2"
		stroke-linecap="round" stroke-linejoin="round"
		style="flex:none;${rotated ? "transform:rotate(90deg);" : ""}">
		<path d="m9 18 6-6-6-6"/>
	</svg>`;

const folderIcon = `
	<svg viewBox="0 0 24 24" width="16" height="16" fill="#e8824f"
		style="flex:none;">
		<path d="M10 4H2v16h20V6H12l-2-2z"/>
	</svg>`;

const fileIcon = `
	<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
		stroke="${TOKENS.mutedForeground}" stroke-width="2"
		stroke-linecap="round" stroke-linejoin="round" style="flex:none;">
		<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
		<path d="M14 2v6h6"/>
	</svg>`;

const spinnerIcon = `
	<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
		stroke="${TOKENS.ring}" stroke-width="2" stroke-linecap="round"
		style="flex:none;margin-left:2px;">
		<path d="M21 12a9 9 0 1 1-6.219-8.56" />
	</svg>`;

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function renderRow(
	node: TreeNode,
	level: number,
	state: ExplorerState,
): string {
	const isFile = node.type === "file";
	const padding = getItemPadding(level, isFile);
	const isActive = isFile && state.activeFileName === node.name;
	const isFocused = state.focusedName === node.name;

	const bg = isActive ? `background:${TOKENS.accent}4d;` : "";
	const focusRing = isFocused
		? `box-shadow: inset 0 0 0 1px ${TOKENS.ring};`
		: "";

	const icon = isFile
		? fileIcon
		: `<span style="display:flex;align-items:center;gap:2px;">${chevron(
				(node.type === "folder" && node.open) || false,
			)}${folderIcon}</span>`;

	const row = `
		<div style="display:flex;align-items:center;gap:4px;width:100%;height:${ROW_HEIGHT};
			padding-left:${padding}px;color:${TOKENS.foreground};${bg}${focusRing}">
			${isFile ? icon : icon}
			<span style="font-size:14px;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
				${escapeHtml(node.name)}
			</span>
		</div>`;

	let childrenHtml = "";
	if (node.type === "folder" && node.open && node.children?.length) {
		childrenHtml = node.children
			.map((child) => renderRow(child, level + 1, state))
			.join("");
	}

	return row + childrenHtml;
}

function renderExplorer(state: ExplorerState): string {
	const headerButtons = `
		<div style="display:flex;align-items:center;gap:2px;flex:none;">
			${["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"]
				.map(
					() => `
				<span style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:6px;">
					${fileIcon}
				</span>`,
				)
				.join("")}
		</div>`;

	let body = "";
	if (state.loading) {
		body = `
			<div style="display:flex;align-items:center;height:${ROW_HEIGHT};
				padding-left:${getItemPadding(0, true)}px;color:${TOKENS.mutedForeground};">
				${spinnerIcon}
			</div>`;
	} else if (state.tree && state.tree.length > 0) {
		body = state.tree.map((node) => renderRow(node, 0, state)).join("");
	} else {
		body = ""; // empty project: nothing under the header
	}

	return `
		<div data-testid="file-explorer" style="width:280px;height:520px;display:flex;flex-direction:column;
			background:${TOKENS.background};border:1px solid ${TOKENS.border};border-radius:${TOKENS.radius};overflow:hidden;">
			<div style="padding:8px;flex:none;border-bottom:1px solid ${TOKENS.border};">
				<div style="display:flex;align-items:center;justify-content:space-between;padding:0 8px;height:40px;
					background:${TOKENS.muted}66;border:1px solid ${TOKENS.border};border-radius:8px;">
					<div style="display:flex;align-items:center;gap:6px;overflow:hidden;">
						${chevron(true)}
						<p style="font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;
							color:${TOKENS.foreground};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0;">
							${escapeHtml(state.projectName)}
						</p>
					</div>
					${headerButtons}
				</div>
			</div>
			<div style="flex:1;padding:8px 6px;overflow:auto;">
				${body}
			</div>
		</div>`;
}

export function renderHarness(): string {
	const cards = EXPLORER_STATES.map(
		(state) => `
		<section data-state-id="${state.id}" style="display:flex;flex-direction:column;gap:8px;">
			<h2 style="font-size:13px;color:${TOKENS.mutedForeground};margin:0;font-weight:500;">
				${escapeHtml(state.label)}
			</h2>
			${renderExplorer(state)}
		</section>`,
	).join("");

	return `<!doctype html>
<html class="dark" lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>File Explorer — Visual Harness</title>
	<style>
		* { box-sizing: border-box; }
		html, body { margin: 0; padding: 0; }
		body {
			background: ${TOKENS.background};
			color: ${TOKENS.foreground};
			font-family: ${FONT_STACK};
			padding: 24px;
		}
		.grid {
			display: flex;
			flex-wrap: wrap;
			gap: 32px;
			align-items: flex-start;
		}
	</style>
</head>
<body>
	<div class="grid">
		${cards}
	</div>
</body>
</html>`;
}

export { EXPLORER_STATES };
