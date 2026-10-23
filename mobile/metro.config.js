const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// The web app's chat helpers (agent-steps.ts) are plain TypeScript with only
// type imports, so the app bundles them directly instead of copying them.
config.watchFolders = [path.resolve(__dirname, "../src/features/conversations")];

module.exports = config;
