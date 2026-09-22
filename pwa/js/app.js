import { initRiskModel, scoreRequest } from './riskModel.js';
import { connect, onRequest, onStatusChange, sendDecision, nextDemoRequest, getSocket } from './relay.js';
import { startCamera, stopCamera, pollPresence } from './presenceCheck.js';
import { computeDescriptor, pollFaceMatch } from './faceMatch.js';
import { isVoiceControlSupported, startVoiceControl, stopVoiceControl } from './voiceControl.js';
import * as auth from './auth.js';

// ---------- DOM refs ----------
const el = {
  // Auth screens
  screenLogin: document.getElementById('screenLogin'),
  screenSignup: document.getElementById('screenSignup'),
  screenFaceCapture: document.getElementById('screenFaceCapture'),
  mainApp: document.getElementById('mainApp'),

  loginUsername: document.getElementById('loginUsername'),
  loginPassword: document.getElementById('loginPassword'),
  loginError: document.getElementById('loginError'),
  btnLogin: document.getElementById('btnLogin'),
  goToSignup: document.getElementById('goToSignup'),
  continueAsGuest: document.getElementById('continueAsGuest'),

  signupUsername: document.getElementById('signupUsername'),
  signupPassword: document.getElementById('signupPassword'),
  signupError: document.getElementById('signupError'),
  btnContinueToFace: document.getElementById('btnContinueToFace'),
  goToLogin: document.getElementById('goToLogin'),

  signupVideo: document.getElementById('signupVideo'),
  signupRing: document.getElementById('signupRing'),
  signupFaceStatus: document.getElementById('signupFaceStatus'),
  cancelFaceCapture: document.getElementById('cancelFaceCapture'),

  // Top bar / history
  connectionStatus: document.getElementById('connectionStatus'),
  historyBtn: document.getElementById('historyBtn'),
  logoutBtn: document.getElementById('logoutBtn'),
  historyPanel: document.getElementById('historyPanel'),
  historyList: document.getElementById('historyList'),
  closeHistory: document.getElementById('closeHistory'),

  // Main states
  stateIdle: document.getElementById('stateIdle'),
  stateManual: document.getElementById('stateManual'),
  stateScoring: document.getElementById('stateScoring'),
  stateAutoApproved: document.getElementById('stateAutoApproved'),
  statePresence: document.getElementById('statePresence'),
  stateDecision: document.getElementById('stateDecision'),
  stateResolved: document.getElementById('stateResolved'),
  decisionBar: document.getElementById('decisionBar'),
  demoTrigger: document.getElementById('demoTrigger'),
  manualEntryTrigger: document.getElementById('manualEntryTrigger'),

  manualInput: document.getElementById('manualInput'),
  manualCancel: document.getElementById('manualCancel'),
  manualSubmit: document.getElementById('manualSubmit'),

  scoringToolName: document.getElementById('scoringToolName'),
  scoringAgentName: document.getElementById('scoringAgentName'),

  autoToolName: document.getElementById('autoToolName'),
  autoAgentName: document.getElementById('autoAgentName'),
  autoSummary: document.getElementById('autoSummary'),
  autoOverride: document.getElementById('autoOverride'),

  presenceToolName: document.getElementById('presenceToolName'),
  presenceAgentName: document.getElementById('presenceAgentName'),
  presenceVideo: document.getElementById('presenceVideo'),
  presenceRing: document.getElementById('presenceRing'),
  presenceStatus: document.getElementById('presenceStatus'),
  presenceCancel: document.getElementById('presenceCancel'),

  decisionToolName: document.getElementById('decisionToolName'),
  decisionAgentName: document.getElementById('decisionAgentName'),
  riskBadge: document.getElementById('riskBadge'),
  riskScore: document.getElementById('riskScore'),
  riskLabel: document.getElementById('riskLabel'),
  plainSummary: document.getElementById('plainSummary'),
  detailsToggle: document.getElementById('detailsToggle'),
  detailsBody: document.getElementById('detailsBody'),
  reasons: document.getElementById('reasons'),
  voiceStatus: document.getElementById('voiceStatus'),

  resolvedMark: document.getElementById('resolvedMark'),
  resolvedText: document.getElementById('resolvedText'),
  resolvedSub: document.getElementById('resolvedSub'),

  btnDeny: document.getElementById('btnDeny'),
  btnApprove: document.getElementById('btnApprove'),
  btnApproveLabel: document.getElementById('btnApproveLabel'),
};

const LEVEL_LABEL = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' };
const ALL_STATES = ['stateIdle', 'stateManual', 'stateScoring', 'stateAutoApproved', 'statePresence', 'stateDecision', 'stateResolved'];

let currentRequest = null;
let stopPresencePolling = null;
let autoApprovedTimer = null;
let pendingSignup = null; // { username, password } while face capture is in progress

// ================= AUTH SCREEN FLOW =================

function showAuthScreen(name) {
  ['screenLogin', 'screenSignup', 'screenFaceCapture'].forEach((key) => {
    el[key].hidden = key !== name;
  });
}

function showError(el_, message) {
  el_.textContent = message;
  el_.hidden = false;
}

el.goToSignup.addEventListener('click', () => showAuthScreen('screenSignup'));
el.goToLogin.addEventListener('click', () => showAuthScreen('screenLogin'));

el.continueAsGuest.addEventListener('click', () => {
  auth.setGuestMode();
  enterMainApp(/* autoScanFirst */ true);
});

el.btnLogin.addEventListener('click', () => {
  const username = el.loginUsername.value.trim();
  const password = el.loginPassword.value;
  el.loginError.hidden = true;

  if (!username || !password) {
    showError(el.loginError, 'Enter both username and password.');
    return;
  }

  if (!auth.login(username, password)) {
    // No relay connected — offer guest mode rather than hang on a dead request.
    showError(el.loginError, 'No connection to the server. Use "Continue as Guest" below, or check your relay connection.');
  }
});

el.btnContinueToFace.addEventListener('click', () => {
  const username = el.signupUsername.value.trim();
  const password = el.signupPassword.value;
  el.signupError.hidden = true;

  if (!username || !password) {
    showError(el.signupError, 'Enter both username and password.');
    return;
  }
  if (password.length < 6) {
    showError(el.signupError, 'Password must be at least 6 characters.');
    return;
  }

  pendingSignup = { username, password };
  showAuthScreen('screenFaceCapture');
  beginSignupFaceCapture();
});

el.cancelFaceCapture.addEventListener('click', () => {
  stopSignupFaceCapture();
  pendingSignup = null;
  showAuthScreen('screenSignup');
});

let stopSignupPolling = null;

async function beginSignupFaceCapture() {
  el.signupFaceStatus.textContent = 'Starting camera…';
  el.signupRing.dataset.state = 'waiting';

  try {
    await startCamera(el.signupVideo);
  } catch (e) {
    console.error('Guardian: camera unavailable for signup', e);
    el.signupFaceStatus.textContent = 'Camera unavailable. You can still create an account without a liveness capture — contact support to add one later.';
    el.signupRing.dataset.state = 'error';
    // Don't hard-block signup just because the camera failed — complete
    // the account without a face reference rather than losing the user
    // entirely. This is recorded honestly (faceCaptured: false).
    setTimeout(() => completeSignup(false), 2500);
    return;
  }

  el.signupFaceStatus.textContent = 'Look at the camera to complete signup';
  let consecutiveHits = 0;
  let finishing = false;
  const REQUIRED_CONSECUTIVE = 2;

  stopSignupPolling = pollPresence(el.signupVideo, (detected) => {
    if (finishing) return;
    el.signupRing.dataset.state = detected ? 'detected' : 'waiting';
    consecutiveHits = detected ? consecutiveHits + 1 : 0;
    if (consecutiveHits >= REQUIRED_CONSECUTIVE) {
      finishing = true;
      el.signupFaceStatus.textContent = 'Captured — creating account…';
      finishSignupCapture();
    }
  });
}

/**
 * Computes the reference face descriptor while the camera is still live —
 * needed once, here, so later high-risk approvals can match against it.
 * A failure here still lets signup complete (faceCaptured stays true,
 * faceDescriptor null); the approval gate then falls back to
 * presence-only, same as a guest account with no reference on file.
 */
async function finishSignupCapture() {
  const descriptor = await computeDescriptor(el.signupVideo);
  stopSignupFaceCapture();
  setTimeout(() => completeSignup(true, descriptor), 300);
}

function stopSignupFaceCapture() {
  if (stopSignupPolling) {
    stopSignupPolling();
    stopSignupPolling = null;
  }
  stopCamera();
}

function completeSignup(faceCaptured, faceDescriptor) {
  if (!pendingSignup) return;
  if (!auth.signup(pendingSignup.username, pendingSignup.password, faceCaptured, faceDescriptor)) {
    showAuthScreen('screenSignup');
    showError(el.signupError, 'No connection to the server — cannot create an account right now.');
    pendingSignup = null;
  }
}

auth.onSignupResult((result) => {
  if (result.ok) {
    // Signup succeeded — log straight in rather than making them re-type
    // credentials immediately after choosing them.
    auth.login(pendingSignup.username, pendingSignup.password);
  } else {
    showAuthScreen('screenSignup');
    showError(el.signupError, result.error || 'Signup failed.');
  }
  pendingSignup = null;
});

auth.onLoginResult((result) => {
  if (result.ok) {
    auth.saveSession(result.username, result.token, result.faceDescriptor);
    enterMainApp(/* autoScanFirst */ true);
  } else {
    showAuthScreen('screenLogin');
    showError(el.loginError, result.error || 'Login failed.');
  }
});

el.logoutBtn.addEventListener('click', () => {
  auth.clearSession();
  el.mainApp.hidden = true;
  el.loginUsername.value = '';
  el.loginPassword.value = '';
  showAuthScreen('screenLogin');
});

// ================= MAIN APP =================

function showState(name) {
  ALL_STATES.forEach((key) => {
    el[key].hidden = key !== name;
  });
  el.decisionBar.hidden = name !== 'stateDecision';

  if (name !== 'statePresence' && stopPresencePolling) {
    stopPresencePolling();
    stopPresencePolling = null;
    stopCamera();
  }

  // Voice control stays alive across the decision screen AND the
  // presence-check screen that a high-risk "approve" leads into, so
  // saying "deny" still works as an escape hatch even after that
  // transition (e.g. if "approve" was triggered by mistake) — matching
  // the fail-closed philosophy the rest of the app follows.
  if (name !== 'stateDecision' && name !== 'statePresence') {
    stopVoiceControl();
  }
}

function enterMainApp(autoScanFirst) {
  showAuthScreen(null); // hides all three auth screens
  el.mainApp.hidden = false;
  showState('stateIdle');

  if (autoScanFirst) {
    // "auto scans and shows score" immediately after login, before
    // settling into the idle screen with its two entry-point buttons.
    handleIncomingRequest(nextDemoRequest());
  }
}

async function handleIncomingRequest(req) {
  currentRequest = req;
  el.scoringToolName.textContent = req.tool;
  el.scoringAgentName.textContent = `from ${req.agent}`;
  showState('stateScoring');

  try {
    const result = await scoreRequest(req.description);
    currentRequest.result = result;
    routeByRiskLevel(req, result);
  } catch (e) {
    console.error('Scoring failed', e);
    currentRequest.result = { score: null, level: 'high', reasons: [] };
    renderDecision(req, currentRequest.result, /* modelUnavailable */ true);
  }
}

function routeByRiskLevel(req, result) {
  if (result.level === 'low') {
    renderAutoApproved(req, result);
  } else {
    renderDecision(req, result);
  }
}

function renderAutoApproved(req, result) {
  el.autoToolName.textContent = req.tool;
  el.autoAgentName.textContent = `from ${req.agent}`;
  el.autoSummary.textContent = req.description;
  showState('stateAutoApproved');

  logDecision(req, 'approved', result.score, /* auto */ true);
  sendDecision(req.id, 'approved');

  autoApprovedTimer = setTimeout(() => {
    if (!el.stateAutoApproved.hidden) showState('stateIdle');
  }, 1800);
}

function renderDecision(req, result, modelUnavailable = false) {
  if (autoApprovedTimer) {
    clearTimeout(autoApprovedTimer);
    autoApprovedTimer = null;
  }

  el.decisionToolName.textContent = req.tool;
  el.decisionAgentName.textContent = `from ${req.agent}`;

  el.riskBadge.dataset.level = result.level;
  el.riskScore.textContent = modelUnavailable ? '—' : result.score;
  el.riskLabel.textContent = modelUnavailable ? 'Unscored — review manually' : LEVEL_LABEL[result.level];

  el.plainSummary.textContent = req.description;

  el.detailsBody.textContent = JSON.stringify(req.payload || {}, null, 2);
  el.detailsBody.hidden = true;
  el.detailsToggle.setAttribute('aria-expanded', 'false');

  el.reasons.innerHTML = '';
  if (modelUnavailable) {
    const chip = document.createElement('div');
    chip.className = 'reason-chip';
    chip.textContent = 'On-device model unavailable — defaulting to high-risk so this gets manual review, not auto-approval.';
    el.reasons.appendChild(chip);
  } else {
    result.reasons.forEach((r) => {
      const chip = document.createElement('div');
      chip.className = 'reason-chip';
      chip.textContent = `Similar to a known ${r.level}-risk action: "${r.text}"`;
      el.reasons.appendChild(chip);
    });
  }

  const needsPresenceCheck = result.level === 'high';
  el.btnApproveLabel.textContent = needsPresenceCheck ? 'Approve (needs presence check)' : 'Approve';

  el.voiceStatus.hidden = true;
  showState('stateDecision');

  // Voice approve/deny is available on both medium- and high-risk decision
  // screens (low risk never reaches here — it auto-approves). It's an
  // alternative trigger for the same buttons, not a way around the
  // presence gate: on high-risk items, saying "approve" still routes
  // through beginPresenceCheck via handleApproveTap exactly like tapping
  // the button does. Only on medium does voice-approve resolve directly,
  // same as tapping Approve there does.
  if (result.level !== 'low') startDecisionVoiceControl();
}

const VOICE_STATE_MESSAGES = {
  listening: '🎤 Listening — say "approve" or "deny"',
  denied: '🎤🚫 Mic permission blocked — allow it in the browser\'s site settings, or use the buttons below. (Also check: voice needs https:// or localhost, not a plain http://<ip> address.)',
  'no-mic': '🎤🚫 No microphone found on this device — use the buttons below.',
  network: '🎤🚫 Voice recognition needs an internet connection (it runs in the cloud, not on-device) — use the buttons below.',
  error: '🎤🚫 Voice control hit an error — use the buttons below.',
};

function setVoiceStatus(state) {
  const message = VOICE_STATE_MESSAGES[state];
  if (message) {
    el.voiceStatus.hidden = false;
    el.voiceStatus.dataset.state = state === 'listening' ? 'listening' : 'error';
    el.voiceStatus.textContent = message;
  } else {
    el.voiceStatus.hidden = true;
  }
}

function startDecisionVoiceControl() {
  if (!isVoiceControlSupported()) {
    setVoiceStatus('error');
    el.voiceStatus.textContent = '🎤🚫 Voice control isn\'t supported in this browser — use the buttons below.';
    return;
  }
  // Don't force-hide the status on a false return here — startVoiceControl
  // now always calls onStateChange with the specific reason before
  // returning false, so setVoiceStatus below already shows it. Hiding it
  // again here was the bug: a synchronous start() failure (e.g. mic
  // blocked because the page isn't on https:// or localhost) produced
  // total silence — no message, no icon, nothing — which looked exactly
  // like "the mic isn't turning on" with no indication why.
  startVoiceControl({
    onApprove: handleApproveTap,
    onDeny: handleDenyTap,
    onStateChange: setVoiceStatus,
  });
}

// ---------- Presence check (high-risk approvals) ----------

async function beginPresenceCheck() {
  showState('statePresence');
  el.presenceToolName.textContent = currentRequest.tool;
  el.presenceAgentName.textContent = `from ${currentRequest.agent}`;
  el.presenceStatus.textContent = 'Starting camera…';
  el.presenceRing.dataset.state = 'waiting';

  try {
    await startCamera(el.presenceVideo);
  } catch (e) {
    console.error('Guardian: camera unavailable', e);
    el.presenceStatus.textContent = 'Camera unavailable — cannot verify presence. Use Cancel and try again.';
    el.presenceRing.dataset.state = 'error';
    return;
  }

  let consecutiveHits = 0;
  const REQUIRED_CONSECUTIVE = 2;

  const confirmAndApprove = (statusText) => {
    el.presenceStatus.textContent = statusText;
    if (stopPresencePolling) {
      stopPresencePolling();
      stopPresencePolling = null;
    }
    stopCamera();
    setTimeout(() => resolveRequest('approved'), 400);
  };

  // A signed-up user with a captured reference face gets matched against
  // it specifically ("is this the account owner"), not just "is any face
  // present" — see faceMatch.js. Guests and accounts without a captured
  // reference (e.g. signup without camera access) fall back to the older
  // presence-only gate, since there's nothing on file to match against.
  const session = auth.getSession();
  const referenceDescriptor = session && session.faceDescriptor;

  if (referenceDescriptor) {
    el.presenceStatus.textContent = 'Look at the camera to confirm it\'s you';
    stopPresencePolling = pollFaceMatch(el.presenceVideo, referenceDescriptor, (state) => {
      el.presenceRing.dataset.state = state === 'matched' ? 'detected' : (state === 'no-match' ? 'mismatch' : 'waiting');
      consecutiveHits = state === 'matched' ? consecutiveHits + 1 : 0;

      if (state === 'no-match') {
        el.presenceStatus.textContent = 'Face doesn\'t match the account on file';
      } else if (state === 'no-face') {
        el.presenceStatus.textContent = 'Look at the camera to confirm it\'s you';
      }

      if (consecutiveHits >= REQUIRED_CONSECUTIVE) {
        confirmAndApprove('Face matched — approving…');
      }
    });
  } else {
    el.presenceStatus.textContent = 'Look at the camera to unlock Approve';
    stopPresencePolling = pollPresence(el.presenceVideo, (detected) => {
      el.presenceRing.dataset.state = detected ? 'detected' : 'waiting';
      consecutiveHits = detected ? consecutiveHits + 1 : 0;

      if (consecutiveHits >= REQUIRED_CONSECUTIVE) {
        confirmAndApprove('Presence confirmed — approving…');
      }
    });
  }
}

el.presenceCancel.addEventListener('click', () => showState('stateDecision'));

// ---------- Manual entry (real, fresh scoring of typed text) ----------

el.manualEntryTrigger.addEventListener('click', () => {
  el.manualInput.value = '';
  showState('stateManual');
  el.manualInput.focus();
});

el.manualCancel.addEventListener('click', () => showState('stateIdle'));

el.manualSubmit.addEventListener('click', () => {
  const text = el.manualInput.value.trim();
  if (!text) {
    el.manualInput.focus();
    return;
  }
  handleIncomingRequest({
    id: `manual-${Date.now()}`,
    tool: 'manual.entry',
    agent: 'you (typed manually)',
    description: text,
    payload: { source: 'manual entry' },
  });
});

// ---------- Resolving requests ----------

function logDecision(req, decision, score, auto = false) {
  // Persist to the account's history if logged in with a real (non-guest)
  // session. Guests still get the full review experience, just without a
  // saved trail — consistent with relay.js's "always demoable" philosophy.
  const session = auth.getSession();
  if (session && !session.guest) {
    auth.saveDecisionRemote({
      tool: req.tool, agent: req.agent, description: req.description,
      score: score === undefined ? null : score, level: req.result?.level || 'unknown',
      decision, auto,
    });
  }
}

function resolveRequest(decision) {
  if (!currentRequest) return;

  sendDecision(currentRequest.id, decision);
  logDecision(currentRequest, decision, currentRequest.result?.score);

  el.resolvedMark.dataset.outcome = decision === 'approved' ? 'approved' : 'denied';
  el.resolvedText.textContent = decision === 'approved' ? 'Approved' : 'Denied';
  el.resolvedSub.textContent =
    decision === 'approved' ? 'Agent notified. Action proceeding.' : 'Agent notified. Action blocked.';

  showState('stateResolved');
  currentRequest = null;

  setTimeout(() => showState('stateIdle'), 1600);
}

// ---------- History panel (backend-backed, per account) ----------

function renderHistory(entries) {
  el.historyList.innerHTML = '';
  if (!entries || entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'log-row';
    empty.textContent = 'No decisions yet.';
    el.historyList.appendChild(empty);
    return;
  }
  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'log-row';
    const scoreLabel = entry.score === null || entry.score === undefined ? 'unscored' : entry.score;
    const autoTag = entry.auto ? ' (auto)' : '';
    const when = new Date(entry.created_at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    row.innerHTML = `
      <span class="log-tool">${entry.tool} <span class="log-when">${when}</span></span>
      <span class="log-outcome" data-outcome="${entry.decision}">${entry.decision === 'approved' ? 'Approved' : 'Denied'}${autoTag} · ${scoreLabel}</span>
    `;
    el.historyList.appendChild(row);
  });
}

el.historyBtn.addEventListener('click', () => {
  const session = auth.getSession();
  el.historyPanel.hidden = false;
  if (session && !session.guest) {
    el.historyList.innerHTML = '<p class="log-row">Loading…</p>';
    if (!auth.requestHistory()) {
      el.historyList.innerHTML = '<p class="log-row">Not connected to the server.</p>';
    }
  } else {
    el.historyList.innerHTML = '<p class="log-row">Sign in to see your saved history — guest sessions aren\'t saved.</p>';
  }
});

el.closeHistory.addEventListener('click', () => { el.historyPanel.hidden = true; });

auth.onHistoryResult((result) => {
  if (result.ok) renderHistory(result.history);
  else el.historyList.innerHTML = `<p class="log-row">${result.error || 'Could not load history.'}</p>`;
});

// ---------- Event wiring ----------

function handleDenyTap() {
  resolveRequest('denied');
}

function handleApproveTap() {
  const needsPresenceCheck = currentRequest?.result?.level === 'high';
  if (needsPresenceCheck) beginPresenceCheck();
  else resolveRequest('approved');
}

el.btnDeny.addEventListener('click', handleDenyTap);
el.btnApprove.addEventListener('click', handleApproveTap);

el.autoOverride.addEventListener('click', () => {
  if (autoApprovedTimer) {
    clearTimeout(autoApprovedTimer);
    autoApprovedTimer = null;
  }
  if (currentRequest && currentRequest.result) {
    renderDecision(currentRequest, currentRequest.result);
  }
});

el.detailsToggle.addEventListener('click', () => {
  const expanded = el.detailsToggle.getAttribute('aria-expanded') === 'true';
  el.detailsToggle.setAttribute('aria-expanded', String(!expanded));
  el.detailsBody.hidden = expanded;
});

el.demoTrigger.addEventListener('click', () => {
  handleIncomingRequest(nextDemoRequest());
});

onRequest((req) => handleIncomingRequest(req));

onStatusChange((state) => {
  el.connectionStatus.dataset.state = state === 'live' ? 'live' : 'connecting';
  el.connectionStatus.querySelector('.connection-label').textContent =
    state === 'live' ? 'Live' : state === 'demo' ? 'Demo mode' : 'Connecting…';
});

// ---------- Boot ----------

async function boot() {
  const RELAY_URL = window.GUARDIAN_RELAY_URL || null;
  connect(RELAY_URL);
  auth.attachSocket(getSocket());

  const session = auth.getSession();
  if (session) {
    enterMainApp(/* autoScanFirst */ false);
  } else {
    showAuthScreen('screenLogin');
  }

  try {
    await initRiskModel();
  } catch (e) {
    console.error('Risk model failed to load', e);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
}

boot();

// TEST-ONLY hook: exposes internal functions for automated testing when
// ?test=1 is in the URL. No effect whatsoever on normal app behavior.
if (window.location.search.includes('test=1')) {
  window.__test = {
    routeByRiskLevel, renderDecision, renderAutoApproved, showState, resolveRequest,
    enterMainApp, showAuthScreen,
    currentRequestRef: () => currentRequest,
    simulateRequest: (req, result) => { currentRequest = req; currentRequest.result = result; routeByRiskLevel(req, result); },
  };
}
