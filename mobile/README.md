# Codenaya mobile

Expo app for Codenaya. It talks to the same Convex deployment, Clerk instance and
Next.js API as the web app; nothing runs on the phone except the UI.

## Run it

1. Start the web stack from the repo root: `npx convex dev`, `npm run dev` and, for chat
   runs, `npx inngest-cli dev`.
2. Copy `.env.example` to `.env.local` and fill it in:
   - `EXPO_PUBLIC_CONVEX_URL`: same value as `NEXT_PUBLIC_CONVEX_URL`; for a local
     Convex backend (`http://127.0.0.1:3210`) use your machine's LAN IP instead
   - `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`: same value as `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   - `EXPO_PUBLIC_API_URL`: the Next.js "Network" URL, e.g. `http://192.168.1.20:3000`
     (`localhost` on a phone is the phone)
3. `npm install`, then `npx expo start --go` and scan the QR code with Expo Go
   (`--go` because expo-dev-client is installed; drop it once you use a dev build).

`npm run typecheck` type-checks the app, including its calls into `../convex`.

## Installable builds (EAS)

`eas.json` has three profiles: `development` (a dev client APK, needed for Google
sign-in), `preview` (a standalone APK to share) and `production`. Run
`npx eas-cli login` once, then e.g. `npx eas-cli build --profile development --platform android`.

`.env.local` is not uploaded, so set the three `EXPO_PUBLIC_*` values for the build with
`npx eas-cli env:create`. A build used away from your Wi-Fi needs public URLs (a deployed
Convex and Next.js), not LAN IPs.
