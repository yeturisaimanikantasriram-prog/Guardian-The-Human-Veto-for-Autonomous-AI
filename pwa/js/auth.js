// auth.js
//
// Signup/login/history over the same relay WebSocket connection used for
// tool-call requests. Sessions are stored in localStorage as a token (the
// server issues it; this file never handles passwords after sending them
// once at login/signup).
//
// Guest mode: if no relay is reachable, login/signup can't work (there's
// no backend to talk to) — but rather than block the whole app, a
// "Continue without an account" option lets the demo still run in
// local-only mode, same resilience philosophy as relay.js's demo mode.

const SESSION_KEY = 'guardian_session';

let socket = null;
let listeners = { signupResult: [], loginResult: [], historyResult: [], saveResult: [] };

export function onSignupResult(fn) { listeners.signupResult.push(fn); }
export function onLoginResult(fn) { listeners.loginResult.push(fn); }
export function onHistoryResult(fn) { listeners.historyResult.push(fn); }
export function onSaveResult(fn) { listeners.saveResult.push(fn); }

/** Call once, passing the same WebSocket the relay module opens, so auth
 * messages share the one phone<->relay connection rather than opening a
 * second socket. */
export function attachSocket(ws) {
  socket = ws;
  if (!socket) return;
  socket.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (data.type === 'signup_result') listeners.signupResult.forEach((fn) => fn(data));
    else if (data.type === 'login_result') listeners.loginResult.forEach((fn) => fn(data));
    else if (data.type === 'history_result') listeners.historyResult.forEach((fn) => fn(data));
    else if (data.type === 'save_decision_result') listeners.saveResult.forEach((fn) => fn(data));
  });
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

export function signup(username, password, faceCaptured, faceDescriptor) {
  return send({ type: 'signup', username, password, faceCaptured, faceDescriptor: faceDescriptor || null });
}

export function login(username, password) {
  return send({ type: 'login', username, password });
}

export function requestHistory() {
  const session = getSession();
  if (!session) return false;
  return send({ type: 'get_history', token: session.token });
}

export function saveDecisionRemote(decisionData) {
  const session = getSession();
  if (!session) return false;
  return send({ type: 'save_decision', token: session.token, decision_data: decisionData });
}

// ---------- Local session storage ----------

export function saveSession(username, token, faceDescriptor) {
  // faceDescriptor (the 128-number reference from signup, if captured) is
  // cached here so the high-risk approval gate can compare against it
  // on-device without another round trip to the server.
  localStorage.setItem(SESSION_KEY, JSON.stringify({ username, token, faceDescriptor: faceDescriptor || null }));
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

export function isGuest() {
  return getSession() === null;
}

export function setGuestMode() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ username: 'Guest', token: null, guest: true }));
}
