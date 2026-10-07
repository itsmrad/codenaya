/**
 * Built-in skill: find-skills.
 *
 * Source: https://github.com/vercel-labs/skills/blob/48dc9e8eb8aa19040e91cb90ba0b642c9cbad57e/skills/find-skills/SKILL.md
 * Listed at: https://skills.sh/vercel-labs/skills/find-skills
 * Commit: 48dc9e8eb8aa19040e91cb90ba0b642c9cbad57e (vercel-labs/skills main, last
 * change to this file in 773fb2c7bbf16781670a3520affc4abd0c6151ae)
 *
 * Adapted for Codenaya: the original tells the agent to run the `skills` CLI
 * (`npx skills find`, `npx skills add`, `npx skills init`). The Codenaya agent
 * has no shell, so those steps are replaced with suggesting skills by name and
 * skills.sh URL and pointing the user to Settings → Skills to import them. The
 * name, description, structure, quality checks and categories are unchanged.
 *
 * License: MIT
 *
 * Copyright (c) 2026 Vercel, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { BuiltinSkill, BuiltinSkillAttribution } from "../types";

const body = `# Find Skills

This skill helps you discover skills from the open agent skills ecosystem and suggest ones the user can add to Codenaya.

## When to Use This Skill

Use this skill when the user:

- Asks "how do I do X" where X might be a common task with an existing skill
- Says "find a skill for X" or "is there a skill for X"
- Asks "can you do X" where X is a specialized capability
- Expresses interest in extending agent capabilities
- Wants to search for tools, templates, or workflows
- Mentions they wish they had help with a specific domain (design, testing, deployment, etc.)

## What are Agent Skills?

Skills are modular packages that extend agent capabilities with specialized knowledge and workflows. Each skill is a \`SKILL.md\` file (a name, a description and markdown instructions) published on GitHub and listed on skills.sh.

You cannot run commands or install anything yourself. Instead, suggest skills by name and link, and the user imports them in **Settings → Skills**, then enables them for this project.

**Browse skills at:** https://skills.sh/

## How to Help Users Find Skills

### Step 1: Understand What They Need

When a user asks for help with something, identify:

1. The domain (e.g., React, testing, design, deployment)
2. The specific task (e.g., writing tests, creating animations, reviewing PRs)
3. Whether this is a common enough task that a skill likely exists

### Step 2: Check the Leaderboard First

Check the [skills.sh leaderboard](https://skills.sh/) to see if a well-known skill already exists for the domain. The leaderboard ranks skills by total installs, surfacing the most popular and battle-tested options. If you have a tool that reads web pages, you may use it on skills.sh pages; otherwise suggest from well-known sources.

For example, top skills for web development include:
- \`vercel-labs/agent-skills\` — React, Next.js, web design (100K+ installs each)
- \`anthropics/skills\` — Frontend design, document processing (100K+ installs)

### Step 3: Search for Skills

If the leaderboard doesn't cover the user's need, think of specific search keywords and suggest the user search skills.sh for them.

For example:

- User asks "how do I make my React app faster?" → search "react performance"
- User asks "can you help me with PR reviews?" → search "pr review"
- User asks "I need to create a changelog" → search "changelog"

### Step 4: Verify Quality Before Recommending

**Do not recommend a skill based solely on search results.** Always verify:

1. **Install count** — Prefer skills with 1K+ installs. Be cautious with anything under 100.
2. **Source reputation** — Official sources (\`vercel-labs\`, \`anthropics\`, \`microsoft\`) are more trustworthy than unknown authors.
3. **GitHub stars** — Check the source repository. A skill from a repo with <100 stars should be treated with skepticism.

If you could not verify a skill, say so rather than guessing its install count.

### Step 5: Present Options to the User

When you find relevant skills, present them to the user with:

1. The skill name and what it does
2. The install count and source
3. The skills.sh link, which they can import from **Settings → Skills**

Example response:

\`\`\`
I found a skill that might help! The "react-best-practices" skill provides
React and Next.js performance optimization guidelines from Vercel Engineering.
(185K installs)

To add it, import this link in Settings → Skills, then enable it for this project:
https://skills.sh/vercel-labs/agent-skills/react-best-practices
\`\`\`

### Step 6: After the User Adds It

You cannot install skills yourself. Once the user has imported and enabled the skill, it appears in your available skills on their next message.

## Common Skill Categories

When searching, consider these common categories:

| Category        | Example Queries                          |
| --------------- | ---------------------------------------- |
| Web Development | react, nextjs, typescript, css, tailwind |
| Testing         | testing, jest, playwright, e2e           |
| DevOps          | deploy, docker, kubernetes, ci-cd        |
| Documentation   | docs, readme, changelog, api-docs        |
| Code Quality    | review, lint, refactor, best-practices   |
| Design          | ui, ux, design-system, accessibility     |
| Productivity    | workflow, automation, git                |

## Tips for Effective Searches

1. **Use specific keywords**: "react testing" is better than just "testing"
2. **Try alternative terms**: If "deploy" doesn't work, try "deployment" or "ci-cd"
3. **Check popular sources**: Many skills come from \`vercel-labs/agent-skills\` or \`ComposioHQ/awesome-claude-skills\`

## When No Skills Are Found

If no relevant skills exist:

1. Acknowledge that no existing skill was found
2. Offer to help with the task directly using your general capabilities
3. Suggest the user could create their own skill in **Settings → Skills**

Example:

\`\`\`
I didn't find an existing skill for "xyz".
I can still help you with this task directly! Would you like me to proceed?

If this is something you do often, you could create your own skill
in Settings → Skills.
\`\`\`
`;

export const findSkills: BuiltinSkill = {
  name: "find-skills",
  description:
    'Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill.',
  body,
};

export const findSkillsAttribution: BuiltinSkillAttribution = {
  label: "vercel-labs/skills",
  url: "https://skills.sh/vercel-labs/skills/find-skills",
  license: "MIT",
};
