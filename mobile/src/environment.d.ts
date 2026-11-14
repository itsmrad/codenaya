// Expo's global env index signature is `any`; shared Convex types need this string.
declare namespace NodeJS {
  interface ProcessEnv {
    SHOWCASE_UNLISTED_OWNER_IDS?: string;
  }
}
