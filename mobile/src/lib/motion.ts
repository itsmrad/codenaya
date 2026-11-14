import { Easing, Keyframe, cubicBezier } from "react-native-reanimated";

// The web's motion (globals.css and the motion/react calls), for Reanimated.
// Layout animations follow the system's reduce-motion setting by default;
// looping ones check useReducedMotion themselves.

const EASE_OUT_QUINT = Easing.bezier(0.23, 1, 0.32, 1);

/**
 * The web's `animate-fade-up`: rises `rise` px while fading in. The defaults
 * are the chat's; the dashboard entry uses 12px over 500ms.
 */
export const fadeUp = ({ delay = 0, rise = 6, duration = 300 } = {}) =>
  new Keyframe({
    0: { opacity: 0, transform: [{ translateY: rise }] },
    100: { opacity: 1, transform: [{ translateY: 0 }], easing: EASE_OUT_QUINT },
  })
    .duration(duration)
    .delay(delay);

/** The web dialog's `fade-in zoom-in-95`. */
export const zoomIn = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.95 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: Easing.out(Easing.ease) },
}).duration(150);

/** Delay of the nth row in a batch, capped like the web's staggerDelay. */
export const staggerDelay = (index: number, step: number) => Math.min(index, 5) * step;

/** Tailwind's `animate-pulse`, as a Reanimated CSS animation. */
export const PULSE = {
  animationName: { "0%": { opacity: 1 }, "50%": { opacity: 0.5 }, "100%": { opacity: 1 } },
  animationDuration: "2s",
  animationIterationCount: "infinite",
  animationTimingFunction: cubicBezier(0.4, 0, 0.6, 1),
} as const;
