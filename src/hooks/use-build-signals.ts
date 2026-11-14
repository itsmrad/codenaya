"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export type BuildSignalStatus = "idle" | "building" | "done";

export interface ActiveRun {
  steps?: unknown[];
  status?: "processing" | "completed" | "cancelled" | string;
  _id?: string;
}

export const BUILD_SIGNAL_STORAGE_KEYS = {
  SOUND: "codenaya:build-sound-signal",
  NOTIFICATION: "codenaya:build-tab-notification",
} as const;

const PREFERENCES_CHANGE_EVENT = "codenaya:build-preferences-changed";

const notifyPreferencesChanged = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PREFERENCES_CHANGE_EVENT));
  }
};

/**
 * Format document.title according to active run signal status.
 */
export const formatBuildTitle = (
  baseTitle: string,
  status: BuildSignalStatus
): string => {
  if (status === "building") return `● Building · ${baseTitle}`;
  if (status === "done") return `✓ Done · ${baseTitle}`;
  return baseTitle;
};

/**
 * A live run always reads as building, so clearing "done" on focus can't hide
 * a run that is still going.
 */
export const getBuildStatus = (
  activeRun: ActiveRun | null | undefined,
  done: boolean
): BuildSignalStatus => {
  if (activeRun) return "building";
  return done ? "done" : "idle";
};

// ─── Web Audio API Synthesizer with User Gesture Unlock ───────────────

// Standard web audio practice for UI sound effects: keep a single lazily-initialized
// AudioContext across the session and let the browser manage origin lifecycle.
let sharedAudioContext: AudioContext | null = null;

export const getAudioContext = (): AudioContext | null => {
  if (typeof window === "undefined") return null;
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (AudioCtx) {
      sharedAudioContext = new AudioCtx();
    }
  }
  return sharedAudioContext;
};

/**
 * Plays a short, gentle two-tone synthesized chime (zero external audio files).
 */
export const playBuildDoneChime = () => {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const runSynthesis = () => {
      const now = ctx.currentTime;

      const playTone = (freq: number, start: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, start);

        // Soft attack & exponential decay
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(start);
        osc.stop(start + duration);
      };

      // Gentle ascending major third: E5 (659.25Hz) -> G#5 (830.61Hz)
      playTone(659.25, now, 0.22);
      playTone(830.61, now + 0.1, 0.32);
    };

    if (ctx.state === "suspended") {
      ctx.resume().then(runSynthesis).catch(() => {});
    } else {
      runSynthesis();
    }
  } catch {
    // Graceful no-op if blocked by browser policy
  }
};

// ─── Dynamic Canvas Favicon Badge with Race-Condition Guard ────────────

let originalFaviconHref: string | null = null;
let faviconRequestId = 0;

const getFaviconElement = (): HTMLLinkElement | null => {
  if (typeof document === "undefined") return null;
  return (
    document.querySelector("link[rel='icon']") ||
    document.querySelector("link[rel*='icon']")
  );
};

export const updateFaviconBadge = (status: BuildSignalStatus) => {
  if (typeof document === "undefined") return;
  const link = getFaviconElement();
  if (!link) return;

  if (!originalFaviconHref) {
    originalFaviconHref = link.href;
  }

  const currentRequestId = ++faviconRequestId;

  if (status === "idle") {
    if (originalFaviconHref) {
      link.href = originalFaviconHref;
    }
    return;
  }

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    // Discard if another update was triggered while loading
    if (currentRequestId !== faviconRequestId) return;

    try {
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Draw original icon
      ctx.drawImage(img, 0, 0, 32, 32);

      // Dot color: blue while building, green on done
      const dotColor = status === "building" ? "#3b82f6" : "#10b981";

      // Draw outer contrast ring
      ctx.beginPath();
      ctx.arc(23, 23, 6.5, 0, 2 * Math.PI);
      ctx.fillStyle = "#ffffff";
      ctx.fill();

      // Draw inner badge dot
      ctx.beginPath();
      ctx.arc(23, 23, 5, 0, 2 * Math.PI);
      ctx.fillStyle = dotColor;
      ctx.fill();

      if (currentRequestId === faviconRequestId) {
        link.href = canvas.toDataURL("image/png");
      }
    } catch {
      // Graceful fallback if canvas is tainted
    }
  };

  img.onerror = () => {
    if (currentRequestId === faviconRequestId && originalFaviconHref) {
      link.href = originalFaviconHref;
    }
  };

  img.src = originalFaviconHref;
};

// ─── Preferences Hook with Single Subscription & Snapshot Cache ────────

interface PreferencesSnapshot {
  soundEnabled: boolean;
  notifEnabled: boolean;
}

const DEFAULT_PREFERENCES: PreferencesSnapshot = {
  soundEnabled: false,
  notifEnabled: false,
};

let cachedPreferencesSnapshot = DEFAULT_PREFERENCES;

const subscribeToStorage = (callback: () => void) => {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  window.addEventListener(PREFERENCES_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(PREFERENCES_CHANGE_EVENT, callback);
  };
};

const getPreferencesSnapshot = (): PreferencesSnapshot => {
  if (typeof window === "undefined") return cachedPreferencesSnapshot;
  try {
    const sound = localStorage.getItem(BUILD_SIGNAL_STORAGE_KEYS.SOUND) === "true";
    const notif = localStorage.getItem(BUILD_SIGNAL_STORAGE_KEYS.NOTIFICATION) === "true";
    if (
      cachedPreferencesSnapshot.soundEnabled !== sound ||
      cachedPreferencesSnapshot.notifEnabled !== notif
    ) {
      cachedPreferencesSnapshot = { soundEnabled: sound, notifEnabled: notif };
    }
  } catch {
    // Ignore
  }
  return cachedPreferencesSnapshot;
};

export const useBuildSignalPreferences = () => {
  const { soundEnabled, notifEnabled } = useSyncExternalStore(
    subscribeToStorage,
    getPreferencesSnapshot,
    // The server never sees localStorage; hydrate with the defaults it rendered.
    () => DEFAULT_PREFERENCES
  );

  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >("default");

  useEffect(() => {
    const updatePermission = () => {
      const next: NotificationPermission | "unsupported" =
        typeof window !== "undefined" && "Notification" in window
          ? Notification.permission
          : "unsupported";
      setPermission((prev) => (prev === next ? prev : next));
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        updatePermission();
      }
    };

    updatePermission();
    window.addEventListener("focus", updatePermission);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", updatePermission);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const toggleSound = (enabled: boolean) => {
    try {
      localStorage.setItem(
        BUILD_SIGNAL_STORAGE_KEYS.SOUND,
        enabled ? "true" : "false"
      );
      notifyPreferencesChanged();
    } catch {
      // Ignore
    }
  };

  const toggleNotif = async (enabled: boolean) => {
    if (enabled && typeof window !== "undefined" && "Notification" in window) {
      if (Notification.permission === "default") {
        const res = await Notification.requestPermission();
        setPermission(res);
        if (res !== "granted") {
          try {
            localStorage.setItem(BUILD_SIGNAL_STORAGE_KEYS.NOTIFICATION, "false");
            notifyPreferencesChanged();
          } catch {
            // Ignore
          }
          return;
        }
      } else if (Notification.permission === "denied") {
        try {
          localStorage.setItem(BUILD_SIGNAL_STORAGE_KEYS.NOTIFICATION, "false");
          notifyPreferencesChanged();
        } catch {
          // Ignore
        }
        return;
      }
    }

    try {
      localStorage.setItem(
        BUILD_SIGNAL_STORAGE_KEYS.NOTIFICATION,
        enabled ? "true" : "false"
      );
      notifyPreferencesChanged();
    } catch {
      // Ignore
    }
  };

  return {
    soundEnabled,
    notifEnabled,
    permission,
    toggleSound,
    toggleNotif,
  };
};

// ─── Main Build Signals Hook ───────────────────────────────────────────

interface UseBuildSignalsProps {
  projectName?: string;
  activeRun?: ActiveRun | null;
  onOpenPreview?: () => void;
}

export const useBuildSignals = ({
  projectName,
  activeRun,
  onOpenPreview,
}: UseBuildSignalsProps) => {
  const { soundEnabled, notifEnabled } = useBuildSignalPreferences();
  const [hadRun, setHadRun] = useState(false);
  const [done, setDone] = useState(false);
  const [finishes, setFinishes] = useState(0);
  const handledFinishesRef = useRef(0);

  // Track run transitions during render, as ProjectIdView does for the first
  // build. `undefined` (still loading) is skipped; only `null` ends a run.
  if (activeRun && !hadRun) setHadRun(true);
  if (activeRun === null && hadRun) {
    setHadRun(false);
    setDone(true);
    setFinishes((count) => count + 1);
  }
  const status = getBuildStatus(activeRun, done);

  // Leaving the project page restores the title and favicon it found.
  useEffect(() => {
    const initialTitle = document.title;
    return () => {
      document.title = initialTitle;
      updateFaviconBadge("idle");
    };
  }, []);

  // Initialize AudioContext user gesture unlock with proper listener cleanup
  useEffect(() => {
    if (typeof window === "undefined") return;

    const cleanupListeners = () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };

    const unlock = () => {
      cleanupListeners();
      const ctx = getAudioContext();
      if (ctx && ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
    };

    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock, { passive: true });

    return cleanupListeners;
  }, []);

  // Compute and update base document title
  useEffect(() => {
    if (typeof document === "undefined") return;
    const projectTitle = projectName ? `${projectName} · Codenaya` : "Codenaya";
    document.title = formatBuildTitle(projectTitle, status);
  }, [projectName, status]);

  // Update favicon badge
  useEffect(() => {
    updateFaviconBadge(status);
  }, [status]);

  // Sound and notification for a run that ended while the tab was hidden
  useEffect(() => {
    if (finishes === handledFinishesRef.current) return;
    handledFinishesRef.current = finishes;
    if (document.visibilityState !== "hidden") return;

    if (soundEnabled) {
      playBuildDoneChime();
    }

    if (
      notifEnabled &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      try {
        const notif = new Notification("Your app is ready", {
          body: "Open preview to see your changes",
          icon: "/icon.svg",
        });

        notif.onclick = () => {
          window.focus();
          onOpenPreview?.();
          notif.close();
        };
      } catch {
        // Gracefully ignore notification dispatch errors
      }
    }
  }, [finishes, soundEnabled, notifEnabled, onOpenPreview]);

  // Clear the done signal when the tab regains focus or visibility
  useEffect(() => {
    if (typeof window === "undefined") return;

    const resetToIdle = () => {
      if (document.visibilityState === "visible") {
        setDone(false);
      }
    };

    window.addEventListener("focus", resetToIdle);
    document.addEventListener("visibilitychange", resetToIdle);

    return () => {
      window.removeEventListener("focus", resetToIdle);
      document.removeEventListener("visibilitychange", resetToIdle);
    };
  }, []);

  return { status };
};
