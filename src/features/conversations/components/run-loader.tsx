// Adapted from Beautiful UI (beautifului.dev), MIT © 2026 Shane Levine — see THIRD_PARTY_NOTICES.md

/**
 * Per-cell delays (ms) of a 3×3 grid: a chevron wavefront driving right. The
 * 650ms cycle is shorter than the sweep, so two fronts are always in flight.
 */
const CHEVRON = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

/**
 * Pixel-grid loader for a live agent run ("Drive" in Beautiful UI). Reduced
 * motion freezes it to a dim grid with the centre cell lit.
 */
export const LoaderGrid = () => (
  <span
    aria-hidden
    data-slot="run-loader"
    className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]"
  >
    {CHEVRON.map((delay, index) => (
      <span
        key={index}
        className={`size-1 animate-pixel-on rounded-[1px] bg-brand opacity-15 motion-reduce:animate-none ${index === 4 ? "motion-reduce:opacity-100" : ""}`}
        style={{ animationDelay: `${delay}ms` }}
      />
    ))}
  </span>
);
