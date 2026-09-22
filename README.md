# Guardian — on-device approval for AI agent tool calls

Phone-first human-in-the-loop review for risky AI agent actions. An agent
tries to call a sensitive tool (delete records, send a payment, run a shell
command); the call pauses, your phone scores the risk **on-device** and asks
you to approve or deny, and the agent only proceeds if you say yes.

## The 3-tier behavior

The risk score doesn't just change a badge color — it changes what actually
happens next:

| Risk level | What happens |
|---|---|
| **Low** | Auto-approved automatically, no tap required. Still logged (marked "auto" in the decisions list), but doesn't interrupt anyone. |
| **Medium** | Standard Approve/Deny buttons |
| **High** | Approve/Deny buttons, but **Approve requires a live presence check first** — the front camera must detect a face in frame before the action can go through |

This matters because if every action required the same manual tap, the risk
score wouldn't actually be doing anything — it'd just be decoration. Tiering
the actual friction, not just the badge, is what makes this a real triage
system.

## Accounts and per-account history

Login/signup, backed by a real SQLite database (`relay/auth_store.py`) —
not just in-memory state that resets on reload. Passwords are hashed with
PBKDF2-HMAC-SHA256 (salted, 200,000 iterations), never stored in plaintext.

**Honest scope note on the face capture at signup**: this is a
**liveness/presence check** (proving a live human set up the account), not
identity-matching biometric authentication. True face-ID (comparing
embeddings against a stored identity with real spoofing resistance) is a
meaningfully bigger, riskier technical claim than what's built here —
password + presence is the actual auth mechanism; the face capture is a
trust signal layered on top, not a replacement for it. Be precise about
this distinction if asked, rather than calling it "biometric login."

**Guest mode**: if no relay is reachable, or you just want to skip
account creation, "Continue as Guest" enters the app in local-only mode —
same resilience philosophy as the rest of this build: never let one
dependency (here, having a backend running) block the whole demo. Guest
sessions aren't saved to history, and the app tells the user that plainly
rather than pretending to save something it didn't.

## Real, dynamic scoring — not just canned demos

Two ways to bring in a request from the idle screen:
- **Auto Detect** — cycles through 4 pre-written example scenarios (the
  original demo mode, useful for a fast, repeatable walkthrough)
- **Manual Entry** — type ANY action description and get it scored fresh,
  on-device, in real time. This is the one to use if you want to prove to
  a judge that the model is actually reasoning about the text, not
  replaying a fixed script.

## What's in here

```
pwa/            The phone app itself (installable PWA)
relay/          WebSocket server + SQLite store (accounts, history)
interceptor/    Wraps a real tool call so it pauses for phone approval
```

## What's been tested, and how

Built and tested in a sandboxed environment with **no internet access at
all** — so testing split into what could and couldn't be verified there:

**Verified working**, via a real headless-browser test (Playwright) that
loaded the actual page and clicked through the actual UI:
- State transitions (idle → scoring → decision → resolved → back to idle)
- The approve/deny buttons and the resulting log entry
- Graceful degradation: if the on-device model can't load (network issue,
  CDN blocked, offline), the app does NOT freeze or silently misbehave —
  it defaults every unscored request to high-risk and says so plainly,
  rather than guessing or auto-approving. This was a real bug I caught and
  fixed during testing, not a designed-in feature I'm just describing after
  the fact — worth mentioning if a judge asks about your failure modes.
- A separate, more serious bug the same testing caught: the CDN import for
  the on-device model was originally a static top-level `import`, which
  would have taken the ENTIRE app down (not just the AI feature) if that
  one CDN request ever failed. Fixed by switching to a dynamic `import()`
  scoped inside model loading, so a network hiccup only degrades scoring,
  never the whole UI.
- The full 3-tier flow (low auto-approves, medium/high show Approve/Deny,
  high additionally requires the presence-check gate) — confirmed by
  directly simulating all three tiers with forced mock results, after
  fixing a test-harness bug where the first attempt bypassed the function
  that sets which request is "current" (silent no-op on Approve, traced
  and fixed).
- **The relay handshake bug**: `relay.js` was never actually sending the
  `{"type": "hello", "role": "phone"}` message the server expects to
  register a connection as "the phone" — meaning the whole relay
  connection would never have worked in a live demo. Found while wiring
  up auth (which depends on this same connection), fixed.
- The full accounts + history flow: guest mode entry, auto-scan on login,
  Manual Entry with arbitrary typed text (confirmed the exact typed text
  flows through to the decision screen, not a canned response), the
  history panel correctly explaining guest sessions aren't saved, and
  logout returning cleanly to the login screen.
- The SQLite backend (`auth_store.py`) independently, with real function
  calls: signup, duplicate-username rejection, short-password rejection,
  login with correct/incorrect password, session token → user lookup, and
  decision history save + retrieval (ordered newest-first). All passed.

**NOT yet tested** (needs real internet, a real camera, and `pip install
websockets` — do this before you rely on any of it):
- Whether `Xenova/all-MiniLM-L6-v2` actually loads and runs correctly via
  Transformers.js in a real browser with real network access
- Actual on-device inference latency on the iQOO 15's hardware specifically
- **The presence-check's and signup face-capture's actual success path.**
  This sandbox has no camera hardware at all, so I could only verify the
  FAILURE path (camera unavailable → fails safe → Cancel/fallback works)
  for both the high-risk approval gate and the signup liveness capture.
  The success path (MediaPipe's `FaceDetector` actually detecting a face)
  uses a real, documented Google on-device model — the code follows their
  standard API — but has never run against a real camera. Test this
  first, on the actual iQOO 15, before demo day.
- The relay server (`relay/server.py`), its new auth/history message
  handlers, and the interceptor (`interceptor/guardian_interceptor.py`)
  — all need `pip install websockets`, which this sandbox couldn't do.
  Syntax-checked, not execution-tested as a live server. The SQLite logic
  underneath them was tested directly (see above); the WebSocket plumbing
  connecting it to the phone has not been. Run a real end-to-end test
  (interceptor → relay → phone → decision → back to interceptor, and
  signup/login over the same connection) before demo day.
- Push notifications when the app is backgrounded (currently the demo
  relies on the app being open; real "phone buzzes while I'm on stage"
  behavior needs the Notifications API wired in and tested on-device)
- PWA installability end-to-end (icons are placeholder-simple — swap for
  real brand art if you have time)

## Running it locally

```bash
# 1. Serve the PWA
cd pwa
python3 -m http.server 8080
# open http://localhost:8080 on your phone (same network) or in a browser

# 2. Run the relay (separate terminal, needs: pip install websockets)
# Creates relay/guardian.db (SQLite) automatically on first run — no
# separate setup step needed.
cd relay
python3 server.py

# 3. Point the PWA at your relay
# window.GUARDIAN_RELAY_URL is already set (to null) near the top of
# index.html — change that one line to your relay's address:
#   window.GUARDIAN_RELAY_URL = "ws://<your-laptop-ip>:8765";

# 4. Try the interceptor (separate terminal, needs: pip install websockets)
cd interceptor
python3 -c "
import asyncio
from guardian_interceptor import request_approval

async def demo():
    result = await asyncio.wait_for(
        request_approval(
            tool='db.deleteRecords',
            agent='test-agent',
            description='Delete all records older than 2023',
            payload={'table': 'customers', 'row_count': 1204},
        ),
        timeout=30,
    )
    print('Approved!' if result.approved else 'Denied.')

asyncio.run(demo())
"
```

## The honest failure-mode answer, if asked

*"What happens if the phone is unreachable?"* — the interceptor fails
closed: no relay connection, no phone response, or a timeout all resolve to
**denied**, never approved. A reviewer being unreachable is not consent.
This is implemented in `request_approval()` in the interceptor and in the
`asyncio.wait_for(..., timeout=60)` fallback in the relay server.
