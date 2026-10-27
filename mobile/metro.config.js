const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Web app modules that are plain TypeScript with no web-only imports (chat
// helpers, model catalogs, slash-skill parsing, starter templates, first-run
// progress): the app bundles them directly instead of copying them.
config.watchFolders = ["conversations", "ai-providers", "integrations", "skills", "templates", "projects/utils"].map(
  (feature) => path.resolve(__dirname, "../src/features", feature),
);

// expo-router loads expo-symbols, and with it a 1 MB Material Symbols font, only
// for native tabs, which the app doesn't use. Its require sits in a try, so an
// empty module is safe.
config.resolver.resolveRequest = (context, moduleName, platform) =>
  moduleName === "expo-symbols" ? { type: "empty" } : context.resolveRequest(context, moduleName, platform);

module.exports = config;
