import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type DictationRecorderState,
  createDictationRecorder,
  pickDictationMimeType,
} from "./dictation-recorder";

class FakeMediaRecorder {
  static supported = ["audio/webm;codecs=opus", "audio/webm"];
  static isTypeSupported = (type: string) => FakeMediaRecorder.supported.includes(type);
  static last: FakeMediaRecorder | null = null;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType: string;
  constructor(_stream: unknown, options: { mimeType?: string }) {
    this.mimeType = options.mimeType ?? "";
    FakeMediaRecorder.last = this;
  }
  start() {}
  stop() {
    this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const track = { stop: vi.fn() };
const stream = { getTracks: () => [track] };
const getUserMedia = vi.fn();

const setup = () => {
  const states: DictationRecorderState[] = [];
  const onRecorded = vi.fn();
  const onError = vi.fn();
  const recorder = createDictationRecorder({
    maxMs: 1_000,
    onStateChange: (state) => states.push(state),
    onRecorded,
    onError,
  });
  return { recorder, states, onRecorded, onError };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getUserMedia.mockResolvedValue(stream);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pickDictationMimeType", () => {
  it("prefers WebM Opus, then MP4 for Safari, else lets the browser choose", () => {
    expect(pickDictationMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickDictationMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
    expect(pickDictationMimeType(() => false)).toBe("");
  });
});

describe("createDictationRecorder", () => {
  it("records, then hands over the audio and releases the mic on stop", async () => {
    const { recorder, states, onRecorded } = setup();

    recorder.start();
    await vi.waitFor(() => expect(recorder.state).toBe("recording"));
    recorder.stop();

    expect(states).toEqual(["starting", "recording", "stopping", "idle"]);
    expect(onRecorded).toHaveBeenCalledOnce();
    expect(onRecorded.mock.calls[0]?.[0].type).toBe("audio/webm;codecs=opus");
    expect(track.stop).toHaveBeenCalled();
  });

  it("stops by itself at the length cap", async () => {
    const { recorder, onRecorded } = setup();

    recorder.start();
    await vi.waitFor(() => expect(recorder.state).toBe("recording"));
    vi.advanceTimersByTime(1_000);

    expect(recorder.state).toBe("idle");
    expect(onRecorded).toHaveBeenCalledOnce();
  });

  it("drops the audio on cancel", async () => {
    const { recorder, onRecorded } = setup();

    recorder.start();
    await vi.waitFor(() => expect(recorder.state).toBe("recording"));
    recorder.cancel();

    expect(recorder.state).toBe("idle");
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("releases a mic granted after the user already stopped", async () => {
    const { recorder, onRecorded } = setup();

    recorder.start();
    recorder.stop();
    await vi.waitFor(() => expect(track.stop).toHaveBeenCalled());

    expect(recorder.state).toBe("idle");
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("reports a refused mic and goes back to idle", async () => {
    getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const { recorder, onError } = setup();

    recorder.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(recorder.state).toBe("idle");
    expect(onError.mock.calls[0]?.[0].name).toBe("NotAllowedError");
  });
});
