/**
 * The log text to show after the user pressed Clear (#480): what arrived since
 * `cleared`, the output at the time of the clear. Output that no longer starts
 * with it is a new session (the preview restarted), so it shows in full.
 */
export const logsAfterClear = (output: string, cleared: string) =>
  cleared && output.startsWith(cleared) ? output.slice(cleared.length) : output;
