// Android release builds refuse plain http. A build pointed at a local dev
// server (http://192.168.x.x) needs it allowed; an https build stays locked down.
module.exports = ({ config }) => {
  const urls = [process.env.EXPO_PUBLIC_CONVEX_URL, process.env.EXPO_PUBLIC_API_URL];
  if (!urls.some((url) => url?.startsWith("http:"))) return config;
  return {
    ...config,
    plugins: [...config.plugins, ["expo-build-properties", { android: { usesCleartextTraffic: true } }]],
  };
};
