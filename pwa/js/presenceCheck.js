// presenceCheck.js
//
// A live "is a human actually looking at this screen right now" gate for
// critical-risk approvals. This module itself is deliberately NOT identity
// verification — just presence ("a face is detected in frame", not "this is
// a specific authorized person"). It's the fallback path for accounts with
// no captured reference face (guest mode, or camera declined at signup).
//
// Accounts that DO have a reference face use faceMatch.js instead (see
// app.js's beginPresenceCheck), which layers real identity matching on top
// via face-api.js — the live frame is compared against the descriptor
// captured at signup, not just checked for "any face present".
//
// Runs fully on-device via MediaPipe Tasks Vision (Google's own on-device
// model), loaded dynamically so a failed camera/model load degrades this
// one feature, not the whole app — same defensive pattern as riskModel.js.

// Raised from the model's already-loose default (0.5) — at 0.5, a hand or
// other skin-toned/rounded object can occasionally clear the bar. This is
// re-checked explicitly in checkPresence() rather than trusted to the
// model's internal filtering alone.
const MIN_DETECTION_CONFIDENCE = 0.75;

let FaceDetectorClass = null;
let detectorInstance = null;
let videoStream = null;

async function loadMediaPipe() {
  if (!FaceDetectorClass) {
    const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm');
    const { FaceDetector, FilesetResolver } = vision;
    const filesetResolver = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );
    detectorInstance = await FaceDetector.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      minDetectionConfidence: MIN_DETECTION_CONFIDENCE,
    });
    FaceDetectorClass = FaceDetector;
  }
  return detectorInstance;
}

/**
 * BlazeFace returns 6 keypoints per detection, in this fixed order:
 * [rightEye, leftEye, noseTip, mouthCenter, rightEarTragion, leftEarTragion]
 * (subject's right/left — mirrored on a selfie camera, but the geometry
 * check below only cares about relative position, not left/right semantics).
 *
 * A real face has eyes roughly level with each other and above the nose and
 * mouth. A hand, palm, or other object that clears the raw confidence score
 * on a lucky frame will not consistently satisfy this layout, so it's a
 * cheap second check on top of the confidence score alone.
 */
function looksLikeFace(detection) {
  const score = detection.categories?.[0]?.score ?? 0;
  if (score < MIN_DETECTION_CONFIDENCE) return false;

  const kp = detection.keypoints;
  if (!kp || kp.length < 6) return false;

  const [rightEye, leftEye, nose, mouth] = kp;
  const eyeDy = Math.abs(rightEye.y - leftEye.y);
  const eyeDx = Math.abs(rightEye.x - leftEye.x);

  // Eyes should be wider apart horizontally than they are offset vertically
  // from each other, and both should sit above the nose and mouth.
  if (eyeDx <= eyeDy) return false;
  const eyesY = (rightEye.y + leftEye.y) / 2;
  if (!(eyesY < nose.y && nose.y < mouth.y)) return false;

  return true;
}

/**
 * Starts the front camera and streams it into the given <video> element.
 * Returns the MediaStream so the caller can stop it later. Never throws
 * silently — rejects with a real Error the caller should catch and show
 * as "camera unavailable", not pretend-pass the presence check.
 */
export async function startCamera(videoEl) {
  videoStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: 320, height: 320 },
    audio: false,
  });
  videoEl.srcObject = videoStream;
  await videoEl.play();
  return videoStream;
}

export function stopCamera() {
  if (videoStream) {
    videoStream.getTracks().forEach((t) => t.stop());
    videoStream = null;
  }
}

/**
 * Runs one detection pass against the current video frame.
 * Returns true if at least one face is present with reasonable confidence.
 * Never throws — a detection error resolves to false (fail closed: no
 * confirmed presence means the gate stays locked), same fail-safe
 * philosophy as the relay's "no phone connected -> deny" behavior.
 */
export async function checkPresence(videoEl) {
  try {
    const detector = await loadMediaPipe();
    const result = detector.detectForVideo(videoEl, performance.now());
    return !!result.detections && result.detections.some(looksLikeFace);
  } catch (e) {
    console.error('Guardian: presence check failed', e);
    return false;
  }
}

/**
 * Polls checkPresence repeatedly until a face is detected or the caller
 * cancels. Calls onTick(detected) on every poll so the UI can show live
 * feedback, not just a final result.
 */
export function pollPresence(videoEl, onTick, intervalMs = 400) {
  let cancelled = false;
  const timer = setInterval(async () => {
    if (cancelled) return;
    const detected = await checkPresence(videoEl);
    onTick(detected);
  }, intervalMs);

  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}
