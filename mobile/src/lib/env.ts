import Constants from "expo-constants";

// The machine Metro serves from, e.g. "192.168.1.10" from "192.168.1.10:8081".
const devHost = __DEV__ ? Constants.expoConfig?.hostUri?.split(":")[0] : undefined;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

/**
 * In development, a URL on this machine follows Metro's host, so the app keeps
 * reaching the local Convex and website when the Wi-Fi IP changes. Hosted
 * URLs (codenaya.tech) are left alone.
 */
const local = (value: string) => {
  const url = new URL(value);
  if (devHost && LOCAL_HOST.test(url.hostname)) url.hostname = devHost;
  return url.toString().replace(/\/$/, "");
};

export const CONVEX_URL = local(process.env.EXPO_PUBLIC_CONVEX_URL!);
export const API_URL = local(process.env.EXPO_PUBLIC_API_URL!);
