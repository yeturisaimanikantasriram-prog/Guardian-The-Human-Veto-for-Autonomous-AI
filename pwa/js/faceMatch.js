// faceMatch.js
//
// Real face-identity matching, layered on top of presenceCheck.js's "is a
// face present" gate. Uses face-api.js (TensorFlow.js-based, runs fully
// on-device) to compute a 128-number face descriptor for the current video
// frame and compares it against the descriptor captured at signup.
//
// Loaded dynamically, same lazy/degrade-gracefully pattern as
// presenceCheck.js and riskModel.js: a failed model/camera load degrades
// this one feature (falls back to presence-only, see app.js), not the
// whole app.

const MODEL_BASE_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model';

// face-api.js's own documented threshold for its 128-d descriptors (from
// its LFW benchmark): a Euclidean distance below this counts as the same
// person, above it counts as a different person.
export const MATCH_THRESHOLD = 0.6;

let faceapi = null;
let modelsLoaded = false;

async function loadFaceApi() {
  if (!faceapi) {
    faceapi = await import('https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/+esm');
  }
  if (!modelsLoaded) {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_BASE_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_BASE_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_BASE_URL),
    ]);
    modelsLoaded = true;
  }
  return faceapi;
}

/**
 * Computes a 128-number face descriptor from the current video frame.
 * Returns a plain number[] (JSON-safe, so it can go straight into a signup
 * message or localStorage) or null if no face was found. Never throws —
 * same fail-closed philosophy as presenceCheck.js: a computation error
 * means no descriptor, not a fake one.
 */
export async function computeDescriptor(videoEl) {
  try {
    const api = await loadFaceApi();
    const result = await api
      .detectSingleFace(videoEl, new api.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptor();
    return result ? Array.from(result.descriptor) : null;
  } catch (e) {
    console.error('Guardian: face descriptor computation failed', e);
    return null;
  }
}

/** Euclidean distance between two same-length descriptors — lower means more alike. */
function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** True if the two descriptors are close enough to count as the same person. */
export function isMatch(a, b) {
  return !!a && !!b && distance(a, b) < MATCH_THRESHOLD;
}

/**
 * Polls the video feed, comparing each frame's face descriptor against
 * referenceDescriptor. Calls onTick(state) on every poll with one of:
 *   'matched'   - a face was found and it matches the reference
 *   'no-match'  - a face was found but it does NOT match the reference
 *   'no-face'   - no face was found in this frame
 * Skips a tick if the previous detection pass is still running, since
 * face-api's detector is heavier than presenceCheck.js's BlazeFace pass.
 */
export function pollFaceMatch(videoEl, referenceDescriptor, onTick, intervalMs = 500) {
  let cancelled = false;
  let running = false;

  const timer = setInterval(async () => {
    if (cancelled || running) return;
    running = true;
    const descriptor = await computeDescriptor(videoEl);
    running = false;
    if (cancelled) return;

    if (!descriptor) onTick('no-face');
    else if (isMatch(descriptor, referenceDescriptor)) onTick('matched');
    else onTick('no-match');
  }, intervalMs);

  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}
