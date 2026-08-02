const defaultMimeTypes = Object.freeze([
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm"
]);

export function selectSupportedVoiceMimeType(MediaRecorderClass, mimeTypes = defaultMimeTypes) {
  if (!MediaRecorderClass) return null;
  if (typeof MediaRecorderClass.isTypeSupported !== "function") return "";
  return mimeTypes.find((mimeType) => MediaRecorderClass.isTypeSupported(mimeType)) ?? "";
}

function extensionForMimeType(mimeType) {
  if (mimeType.startsWith("audio/mp4")) return "m4a";
  if (mimeType.startsWith("audio/ogg")) return "ogg";
  return "webm";
}

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() ?? []) track.stop();
}

export class VoiceNoteRecorder {
  constructor({
    mediaDevices = globalThis.navigator?.mediaDevices,
    MediaRecorderClass = globalThis.MediaRecorder,
    now = () => Date.now(),
    audioBitsPerSecond = 24_000,
    mimeTypes = defaultMimeTypes
  } = {}) {
    this.mediaDevices = mediaDevices;
    this.MediaRecorderClass = MediaRecorderClass;
    this.now = now;
    this.audioBitsPerSecond = audioBitsPerSecond;
    this.mimeTypes = mimeTypes;
    this.session = null;
  }

  get isSupported() {
    return Boolean(this.mediaDevices?.getUserMedia && this.MediaRecorderClass);
  }

  get isRecording() {
    return this.session?.recorder?.state === "recording";
  }

  async start() {
    if (!this.isSupported) throw new Error("L’enregistrement audio n’est pas disponible sur ce PC");
    if (this.session) throw new Error("Un enregistrement audio est déjà en cours");

    const stream = await this.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16_000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    try {
      const requestedMimeType = selectSupportedVoiceMimeType(this.MediaRecorderClass, this.mimeTypes);
      const options = { audioBitsPerSecond: this.audioBitsPerSecond };
      if (requestedMimeType) options.mimeType = requestedMimeType;
      const recorder = new this.MediaRecorderClass(stream, options);
      const session = {
        chunks: [],
        recorder,
        requestedMimeType,
        startedAt: this.now(),
        stream,
        stopPromise: null
      };
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) session.chunks.push(event.data);
      });
      this.session = session;
      recorder.start(250);
    } catch (error) {
      stopTracks(stream);
      throw error;
    }
  }

  async stop() {
    return this.#finish(false);
  }

  async cancel() {
    await this.#finish(true);
  }

  async #finish(discard) {
    const session = this.session;
    if (!session) return null;
    if (!session.stopPromise) {
      let resolveStopped;
      session.stopPromise = new Promise((resolve, reject) => {
        resolveStopped = resolve;
        session.recorder.addEventListener("stop", resolve, { once: true });
        session.recorder.addEventListener("error", (event) => {
          reject(event.error ?? new Error("L’enregistrement audio a échoué"));
        }, { once: true });
      });
      if (session.recorder.state !== "inactive") {
        session.recorder.requestData?.();
        session.recorder.stop();
      } else {
        resolveStopped();
      }
    }

    try {
      await session.stopPromise;
      if (discard) return null;
      const mimeType = session.recorder.mimeType
        || session.requestedMimeType
        || session.chunks.find((chunk) => chunk.type)?.type
        || "audio/webm";
      const blob = new Blob(session.chunks, { type: mimeType });
      const durationSeconds = Math.max(1, Math.round((this.now() - session.startedAt) / 1000));
      return {
        blob,
        durationSeconds,
        fileName: `voice-${session.startedAt}.${extensionForMimeType(mimeType)}`,
        mimeType
      };
    } finally {
      stopTracks(session.stream);
      if (this.session === session) this.session = null;
    }
  }
}
