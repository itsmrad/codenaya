const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Web app modules that are plain TypeScript with no web-only imports (chat
// helpers, model catalogs, slash-skill parsing, starter templates, first-run
// progress): the app bundles them directly instead of copying them.
config.watchFolders = ["conversations", "ai-providers", "skills", "templates", "projects/utils"].map(
  (feature) => path.resolve(__dirname, "../src/features", feature),
);

module.exports = config;
