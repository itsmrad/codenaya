/**
 * Records one dictation with MediaRecorder for `/api/transcribe` (#301).
 * idle → starting (asking for the mic) → recording → stopping → idle.
 */

/** Recording stops by itself after this long, keeping uploads small. */
export const DICTATION_MAX_MS = 3 * 60_000;

/** ~720 KB for the longest dictation in Opus: speech needs no more. */
export const DICTATION_AUDIO_BITS_PER_SECOND = 32_000;

/** In order of preference: Chromium and Firefox record WebM, Safari MP4. */
export const DICTATION_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
] as const;

/** The first type the browser can record; "" lets it choose. */
export const pickDictationMimeType = (isTypeSupported: (type: string) => boolean): string =>
  DICTATION_MIME_TYPES.find((type) => isTypeSupported(type)) ?? "";

export const canRecordDictation = (): boolean =>
  typeof window !== "undefined" &&
  typeof MediaRecorder !== "undefined" &&
  Boolean(navigator.mediaDevices?.getUserMedia);

export type DictationRecorderState = "idle" | "starting" | "recording" | "stopping";

export interface DictationRecorder {
  readonly state: DictationRecorderState;
  start(): void;
  /** Ends the recording and hands it to `onRecorded`. */
  stop(): void;
  /** Ends it and drops the audio, e.g. on submit. */
  cancel(): void;
}

export function createDictationRecorder({
  maxMs = DICTATION_MAX_MS,
  onStateChange,
  onRecorded,
  onError,
}: {
  maxMs?: number;
  onStateChange: (state: DictationRecorderState) => void;
  onRecorded: (audio: Blob) => void;
  onError: (error: unknown) => void;
}): DictationRecorder {
  let state: DictationRecorderState = "idle";
  let recorder: MediaRecorder | null = null;
  let discard = false;
  let limit: ReturnType<typeof setTimeout> | undefined;

  const setState = (next: DictationRecorderState) => {
    state = next;
    onStateChange(next);
  };

  const begin = (stream: MediaStream) => {
    // Stopped or cancelled while the browser asked for the mic.
    if (state !== "starting") {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const mimeType = pickDictationMimeType((type) => MediaRecorder.isTypeSupported(type));
    let media: MediaRecorder;
    try {
      media = new MediaRecorder(stream, {
        ...(mimeType && { mimeType }),
        audioBitsPerSecond: DICTATION_AUDIO_BITS_PER_SECOND,
      });
      media.start();
    } catch (error) {
      // E.g. a type the browser claimed but can't record: free the mic and say so.
      stream.getTracks().forEach((track) => track.stop());
      setState("idle");
      onError(error);
      return;
    }
    const chunks: Blob[] = [];
    media.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    media.onstop = () => {
      clearTimeout(limit);
      stream.getTracks().forEach((track) => track.stop());
      recorder = null;
      setState("idle");
      if (!discard) onRecorded(new Blob(chunks, { type: media.mimeType || mimeType }));
    };
    recorder = media;
    limit = setTimeout(() => stop(), maxMs);
    setState("recording");
  };

  const start = () => {
    if (state !== "idle") return;
    discard = false;
    setState("starting");
    navigator.mediaDevices.getUserMedia({ audio: true }).then(begin, (error: unknown) => {
      if (state !== "starting") return;
      setState("idle");
      onError(error);
    });
  };

  function stop() {
    if (state === "starting") {
      // Nothing recorded yet; `begin` releases the mic when it arrives.
      setState("idle");
    } else if (state === "recording" && recorder) {
      setState("stopping");
      recorder.stop();
    }
  }

  return {
    get state() {
      return state;
    },
    start,
    stop,
    cancel() {
      discard = true;
      stop();
    },
  };
}
