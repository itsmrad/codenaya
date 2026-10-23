const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("expo/config-plugins");

// Android has no light/dark app icon setting like iOS's icon.dark. The adaptive
// icon's layers are ordinary resources, though, so dark copies in a `night`
// folder show while the system is in dark mode. Android ranks the night
// qualifier above density, so one nodpi image per layer wins over Expo's
// per-density light ones; the launcher scales it to the layer's size.
module.exports = (config, { foregroundImage, backgroundImage }) =>
  withDangerousMod(config, [
    "android",
    async (config) => {
      const { projectRoot, platformProjectRoot } = config.modRequest;
      const dir = path.join(platformProjectRoot, "app/src/main/res/mipmap-night-nodpi");
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.copyFile(path.join(projectRoot, foregroundImage), path.join(dir, "ic_launcher_foreground.png"));
      await fs.promises.copyFile(path.join(projectRoot, backgroundImage), path.join(dir, "ic_launcher_background.png"));
      return config;
    },
  ]);
