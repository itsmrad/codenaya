# Instant templates

Each folder is a finished app, written over the agent's Vite starter
(`src/features/conversations/inngest/vite-starter.ts`). Only the files that
differ from the starter live here; the seed adds the rest (#362).

Every template keeps the brand in one place each, so "Make it mine" is a small,
tested replacement (`src/features/templates/make-it-mine.ts`):

- `src/brand.ts`: `export const BRAND_NAME = "...";`
- `index.html` `<title>` and the `--primary` / `--ring` tokens in `src/index.css`
  (both come from the starter).

These folders are excluded from the Next tsconfig and lint.
