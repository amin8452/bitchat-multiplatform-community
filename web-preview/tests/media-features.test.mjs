import assert from "node:assert/strict";
import test from "node:test";
import { optimizeImageForTransfer } from "../src/features/media/image-transfer-optimizer.js";
import {
  VoiceNoteRecorder,
  selectSupportedVoiceMimeType
} from "../src/features/media/voice-note-recorder.js";

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(mimeType) {
    return mimeType.startsWith("audio/mp4");
  }

  constructor(stream, options) {
    super();
    this.stream = stream;
    this.mimeType = options.mimeType;
    this.state = "inactive";
  }

  start() {
    this.state = "recording";
  }

  requestData() {
    const event = new Event("dataavailable");
    Object.defineProperty(event, "data", {
      value: new Blob(["voice-data"], { type: this.mimeType })
    });
    this.dispatchEvent(event);
  }

  stop() {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
}

test("voice note recorder captures a bounded interoperable media file and releases the microphone", async () => {
  let now = 1_000;
  let stopped = false;
  const recorder = new VoiceNoteRecorder({
    MediaRecorderClass: FakeMediaRecorder,
    mediaDevices: {
      async getUserMedia() {
        return { getTracks: () => [{ stop: () => { stopped = true; } }] };
      }
    },
    now: () => now
  });

  assert.equal(selectSupportedVoiceMimeType(FakeMediaRecorder), "audio/mp4;codecs=mp4a.40.2");
  await recorder.start();
  assert.equal(recorder.isRecording, true);
  now = 3_100;
  const voice = await recorder.stop();

  assert.equal(voice.mimeType, "audio/mp4;codecs=mp4a.40.2");
  assert.equal(voice.fileName, "voice-1000.m4a");
  assert.equal(voice.durationSeconds, 2);
  assert.equal(await voice.blob.text(), "voice-data");
  assert.equal(stopped, true);
  assert.equal(recorder.isRecording, false);
});

test("image optimizer keeps small files and bounds large photos for the BLE contract", async () => {
  const small = { name: "small.jpg", type: "image/jpeg", size: 32_000 };
  assert.deepEqual(await optimizeImageForTransfer(small, { maximumBytes: 524_288 }), {
    blob: small,
    fileName: "small.jpg",
    mimeType: "image/jpeg",
    optimized: false
  });

  const outputSizes = [250_000, 150_000];
  let closed = false;
  const large = { name: "camera.png", type: "image/png", size: 800_000 };
  const optimized = await optimizeImageForTransfer(large, {
    maximumBytes: 524_288,
    createBitmap: async () => ({
      width: 4_000,
      height: 3_000,
      close: () => { closed = true; }
    }),
    createCanvas: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
      toBlob: (callback) => callback(new Blob([
        new Uint8Array(outputSizes.shift())
      ], { type: "image/webp" }))
    })
  });

  assert.equal(optimized.fileName, "camera.webp");
  assert.equal(optimized.mimeType, "image/webp");
  assert.equal(optimized.blob.size, 150_000);
  assert.equal(optimized.optimized, true);
  assert.equal(closed, true);
});
