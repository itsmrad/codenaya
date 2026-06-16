/**
 * Fixture data + render model for the file-explorer visual harness.
 *
 * The real <FileExplorer /> is tightly coupled to Convex (useFolderContents,
 * useEditor, Clerk auth, a live websocket). Booting the full Next.js app for
 * screenshots would require secrets and a running backend, which is not
 * headless-CI friendly and would make screenshots flaky.
 *
 * Instead we model the explorer's *visual* structure here and render it with a
 * tiny standalone renderer (see harness.html). The markup, padding math and
 * design tokens are copied 1:1 from the production components so a styling
 * regression in those components shows up as a diff once the harness is kept in
 * sync. Treat this file as the single source of truth for the states we guard.
 */

export type FileNode = {
	type: "file";
	name: string;
};

export type FolderNode = {
	type: "folder";
	name: string;
	open?: boolean;
	children?: TreeNode[];
};

export type TreeNode = FileNode | FolderNode;

export type ExplorerState = {
	/** URL slug used in screenshot file names. */
	id: string;
	/** Human readable description shown in the harness header. */
	label: string;
	/** Project name rendered in the explorer header. */
	projectName: string;
	/** Root level tree, or undefined to render the loading spinner. */
	tree?: TreeNode[];
	/** Render the active-tab highlight on the file with this name. */
	activeFileName?: string;
	/** Render the keyboard focus ring on the row with this name. */
	focusedName?: string;
	/** Render the loading spinner row instead of contents. */
	loading?: boolean;
};

/**
 * Mirrors getItemPadding() in
 * src/features/projects/components/file-explorer/constants.ts.
 * Kept in sync deliberately so padding regressions are caught.
 */
export const BASE_PADDING = 12;
export const LEVEL_PADDING = 12;

export function getItemPadding(level: number, isFile: boolean): number {
	const fileOffset = isFile ? 16 : 0;
	return BASE_PADDING + level * LEVEL_PADDING + fileOffset;
}

export const EXPLORER_STATES: ExplorerState[] = [
	{
		id: "empty",
		label: "Empty project (no files)",
		projectName: "empty-project",
		tree: [],
	},
	{
		id: "loading",
		label: "Loading (root contents pending)",
		projectName: "my-project",
		loading: true,
	},
	{
		id: "with-files",
		label: "With files and one open folder",
		projectName: "my-project",
		tree: [
			{
				type: "folder",
				name: "src",
				open: true,
				children: [
					{ type: "file", name: "index.ts" },
					{ type: "file", name: "app.tsx" },
					{ type: "file", name: "styles.css" },
				],
			},
			{ type: "folder", name: "public", open: false },
			{ type: "file", name: "package.json" },
			{ type: "file", name: "README.md" },
			{ type: "file", name: "tsconfig.json" },
		],
	},
	{
		id: "deep-nesting",
		label: "Deeply nested folders",
		projectName: "monorepo",
		tree: [
			{
				type: "folder",
				name: "apps",
				open: true,
				children: [
					{
						type: "folder",
						name: "web",
						open: true,
						children: [
							{
								type: "folder",
								name: "src",
								open: true,
								children: [
									{
										type: "folder",
										name: "features",
										open: true,
										children: [
											{
												type: "folder",
												name: "projects",
												open: true,
												children: [
													{ type: "file", name: "index.tsx" },
													{ type: "file", name: "deep-file.ts" },
												],
											},
										],
									},
								],
							},
						],
					},
				],
			},
		],
	},
	{
		id: "focused",
		label: "File explorer with a focused / active row",
		projectName: "my-project",
		activeFileName: "app.tsx",
		focusedName: "app.tsx",
		tree: [
			{
				type: "folder",
				name: "src",
				open: true,
				children: [
					{ type: "file", name: "index.ts" },
					{ type: "file", name: "app.tsx" },
					{ type: "file", name: "styles.css" },
				],
			},
			{ type: "file", name: "package.json" },
			{ type: "file", name: "README.md" },
		],
	},
];
