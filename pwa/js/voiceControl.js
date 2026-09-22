// voiceControl.js
//
// Optional hands-free "approve" / "deny" voice trigger, scoped to
// high-risk decisions only — the same scope as the camera presence check
// in presenceCheck.js. Voice never lowers the bar below the tap flow: for
// high-risk requests, saying "approve" runs the exact same code path as
// tapping the Approve button, which still routes through the presence
// check before anything is actually approved.
//
// Runs entirely in the browser via the Web Speech API. Unsupported
// browsers (no window.SpeechRecognition) simply don't get the mic option
// — same fail-to-manual-UI pattern as the rest of the app; nothing here
// ever blocks the tap-based flow.

const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition || null;

let recognizer = null;
let active = false;

export function isVoiceControlSupported() {
  return !!SpeechRecognitionClass;
}

/**
 * Starts listening for "approve" / "deny". Calls onStateChange('listening'
 * | 'error' | 'idle') so the caller can reflect mic state in the UI.
 * Automatically restarts itself when the browser auto-stops recognition
 * after silence, for as long as the caller hasn't called stop().
 */
export function startVoiceControl({ onApprove, onDeny, onStateChange }) {
  if (!SpeechRecognitionClass) return false;
  if (active) return true;

  active = true;
  recognizer = new SpeechRecognitionClass();
  recognizer.continuous = true;
  recognizer.interimResults = false;
  recognizer.lang = 'en-US';

  recognizer.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    if (!result.isFinal) return;

    const alt = result[0];
    const said = alt.transcript.trim().toLowerCase();
    console.debug('Guardian voice: heard "%s" (confidence %s)', said, alt.confidence);

    // Ignore longer, unrelated sentences that merely happen to contain the
    // word — a deliberate voice command is short. Without this, ambient
    // conversation containing "approve" (or "disapprove", "approval", etc,
    // which a plain substring match would also wrongly catch) could
    // silently trigger a real high-risk approval.
    //
    // Deliberately NOT gating on alt.confidence here: engines routinely
    // score isolated one-word utterances ("approve", "deny") lower than
    // they'd score the same word inside a full sentence, since there's
    // less context to disambiguate — a confidence cutoff tuned for noise
    // rejection ends up silently discarding the exact short commands this
    // feature exists to catch. The word-boundary regex + length cap below
    // are enough to filter ambient speech without that false-negative cost.
    const wordCount = said.split(/\s+/).filter(Boolean).length;
    if (wordCount > 4) return;

    if (/\bapprove\b/.test(said)) onApprove();
    else if (/\b(deny|denied|denies|reject|rejected|disapprove|disapproved)\b/.test(said)) onDeny();
  };

  let fatalReason = null;

  recognizer.onstart = () => {
    fatalReason = null;
    onStateChange && onStateChange('listening');
  };

  recognizer.onerror = (event) => {
    // 'no-speech' fires constantly during normal use (just means nothing
    // was said in that window) and 'aborted' fires on our own stop() calls
    // — neither is a real problem, onend's restart handles both silently.
    if (event.error === 'no-speech' || event.error === 'aborted') return;

    // These won't self-heal by restarting, so stop retrying and surface
    // exactly why, instead of silently going dead with no explanation:
    //  - not-allowed / service-not-allowed: mic permission denied, or the
    //    page isn't in a secure context (recognition requires https:// —
    //    or localhost — a plain http://<lan-ip> origin gets silently
    //    blocked by the browser before it ever prompts for permission)
    //  - audio-capture: no microphone hardware found
    //  - network: Chrome's recognizer sends audio to a cloud service, so
    //    this fires when the device has no internet reachable, even if
    //    the rest of the app works fully offline
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      fatalReason = 'denied';
      active = false;
    } else if (event.error === 'audio-capture') {
      fatalReason = 'no-mic';
      active = false;
    } else if (event.error === 'network') {
      fatalReason = 'network';
      active = false;
    } else {
      fatalReason = 'error';
    }
    onStateChange && onStateChange(fatalReason);
  };

  recognizer.onend = () => {
    if (fatalReason) return; // already reported above, don't overwrite it
    if (!active) {
      onStateChange && onStateChange('idle');
      return;
    }
    // Browsers auto-stop recognition after a pause in speech — restart
    // transparently so "listening" doesn't quietly go dead mid-review.
    try {
      recognizer.start();
    } catch (e) {
      // Already starting/stopping — the next onend will retry.
    }
  };

  try {
    recognizer.start();
  } catch (e) {
    active = false;
    // A synchronous throw here (rather than the async onerror above) is
    // what actually happens when the page is on an insecure origin — e.g.
    // http://<lan-ip>:8080 instead of https:// or localhost. The browser
    // refuses to even open the mic, no permission prompt ever appears, and
    // without this the caller had no idea why nothing happened.
    console.error('Guardian voice: recognizer.start() threw', e);
    onStateChange && onStateChange(e && e.name === 'SecurityError' ? 'denied' : 'error');
    return false;
  }
  return true;
}

export function stopVoiceControl() {
  active = false;
  if (recognizer) {
    try { recognizer.stop(); } catch (e) { /* already stopped */ }
    recognizer = null;
  }
}
