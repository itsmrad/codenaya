/** How many times a boot that ran out of server time continues on its sandbox (#492). */
export const MAX_BOOT_RESUMES = 2;

export const BOOT_OUT_OF_TIME =
  "The preview took too long to start. Retry to start it again.";

/**
 * What the preview does once a boot stream closes without an error. After
 * `ready` it keeps running (the server ends the stream before its time limit).
 * When the server ran out of time before `ready`, it boots again on the same
 * sandbox, up to MAX_BOOT_RESUMES times.
 */
export const afterBootStream = ({
  ready,
  resumeSandboxId,
  resumes,
}: {
  ready: boolean;
  resumeSandboxId?: string;
  resumes: number;
}): "done" | "resume" | "failed" => {
  if (ready || !resumeSandboxId) return "done";
  return resumes < MAX_BOOT_RESUMES ? "resume" : "failed";
};
