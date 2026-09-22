// relay.js
//
// Connects to the Guardian relay server, which bridges the phone (this PWA)
// and the agent-side interceptor. If no relay is reachable (e.g. running the
// UI standalone during development, or for an offline demo), falls back to a
// local simulate mode so the app is always independently demoable.

// Auto Detect generates a fresh, randomized simulated tool-call every time
// it's triggered — different agent, different target, different numbers —
// rather than replaying the same fixed script. The generated text still
// goes through the exact same real, on-device embedding/scoring pipeline
// as Manual Entry (see app.js: handleIncomingRequest -> scoreRequest), so
// the risk level you see is genuinely computed from that text each time,
// not a canned label attached to the template.

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const AGENTS = [
  'billing-cleanup-agent', 'docs-summarizer-agent', 'invoice-settlement-agent',
  'infra-maintenance-agent', 'support-triage-bot', 'data-sync-agent',
  'release-automation-agent', 'analytics-agent', 'onboarding-agent', 'backup-agent',
];

// Each generator produces its own tool/description/payload shape — risk
// level is NOT attached here, it's left entirely to the real scoring model
// to determine from the resulting text, same as Manual Entry.
const ACTION_GENERATORS = [
  () => {
    const table = pick(['customers', 'orders', 'users', 'transactions', 'audit_logs']);
    const rows = randInt(40, 6000);
    return {
      tool: 'db.deleteRecords',
      description: `This agent wants to permanently delete ${rows.toLocaleString()} ${table} records from the production database.`,
      payload: { table, row_count: rows, environment: 'production' },
    };
  },
  () => {
    const amount = randInt(5000, 950000);
    const acct = `XXXX-XXXX-${randInt(1000, 9999)}`;
    return {
      tool: 'payments.wireTransfer',
      description: `This agent wants to send a wire payment of ₹${amount.toLocaleString('en-IN')} to a bank account (${acct}) not seen before.`,
      payload: { amount, currency: 'INR', recipient_account: `${acct} (new payee)` },
    };
  },
  () => {
    const cmd = pick(['sudo systemctl restart nginx', 'sudo rm -rf /var/cache/app', 'sudo useradd newadmin', 'sudo iptables -F']);
    const host = `prod-web-0${randInt(1, 9)}`;
    return {
      tool: 'shell.exec',
      description: `This agent wants to run a shell command with sudo privileges on ${host}: "${cmd}".`,
      payload: { command: cmd, host },
    };
  },
  () => {
    const user = pick(['jsmith', 'a.patel', 'm.chen', 'k.lee', 'r.gomez']);
    return {
      tool: 'auth.revokeAccess',
      description: `This agent wants to revoke access credentials for user "${user}".`,
      payload: { user, reason: 'automated cleanup' },
    };
  },
  () => {
    const branch = pick(['main', 'release', 'production']);
    return {
      tool: 'git.forcePush',
      description: `This agent wants to force-push to the ${branch} branch, overwriting existing commit history.`,
      payload: { branch, force: true },
    };
  },
  () => {
    const field = pick(['email', 'shipping address', 'phone number', 'billing plan']);
    return {
      tool: 'db.updateRecord',
      description: `This agent wants to update the ${field} field on a customer record.`,
      payload: { field, table: 'customers' },
    };
  },
  () => {
    const service = pick(['auth-service', 'checkout-service', 'notification-worker']);
    return {
      tool: 'infra.restartService',
      description: `This agent wants to restart the ${service} background service.`,
      payload: { service },
    };
  },
  () => {
    const file = pick(['report.csv', 'notes.md', 'config.yaml', 'summary.txt']);
    return {
      tool: 'files.createFile',
      description: `This agent wants to create a new file "${file}" in the project directory.`,
      payload: { path: `./${file}` },
    };
  },
  () => {
    const file = pick(['README.md', 'CHANGELOG.md', 'package.json', 'LICENSE']);
    return {
      tool: 'files.readFile',
      description: `This agent wants to read the file "${file}" to generate a summary.`,
      payload: { path: `./${file}`, mode: 'read-only' },
    };
  },
  () => {
    const city = pick(['Bengaluru', 'Mumbai', 'Delhi', 'Chennai', 'Hyderabad']);
    return {
      tool: 'api.fetchWeather',
      description: `This agent wants to fetch the current weather for ${city}.`,
      payload: { city },
    };
  },
  () => {
    const table = pick(['orders', 'sessions', 'events']);
    return {
      tool: 'db.query',
      description: `This agent wants to query the ${table} table for a read-only list of recent records.`,
      payload: { table, mode: 'read-only' },
    };
  },
  () => ({
    tool: 'ci.runTestSuite',
    description: 'This agent wants to run the automated test suite before a deploy.',
    payload: { suite: 'full' },
  }),
];

let lastGeneratorIndex = -1;
let socket = null;
let listeners = { request: [], statusChange: [] };

export function onRequest(fn) { listeners.request.push(fn); }
export function onStatusChange(fn) { listeners.statusChange.push(fn); }
export function getSocket() { return socket; }

function emitStatus(state) {
  listeners.statusChange.forEach((fn) => fn(state));
}

function emitRequest(req) {
  listeners.request.forEach((fn) => fn(req));
}

/** Attempts a real relay connection; falls back to demo mode if unreachable. */
export function connect(relayUrl) {
  if (!relayUrl) {
    emitStatus('demo');
    return;
  }

  try {
    socket = new WebSocket(relayUrl);

    socket.addEventListener('open', () => {
      // Identify this connection as the phone client — without this handshake,
      // the server's router() never routes us into handle_phone(), so nothing
      // (tool-call requests, auth messages, history) would ever reach us.
      socket.send(JSON.stringify({ type: 'hello', role: 'phone' }));
      emitStatus('live');
    });

    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'tool_call_request') {
          emitRequest(data.payload);
        }
      } catch (e) {
        console.warn('Malformed relay message', e);
      }
    });

    socket.addEventListener('close', () => emitStatus('demo'));
    socket.addEventListener('error', () => emitStatus('demo'));
  } catch (e) {
    emitStatus('demo');
  }
}

/** Sends a decision back through the relay, if connected. No-op in demo mode. */
export function sendDecision(requestId, decision) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'decision', requestId, decision }));
  } else {
    console.log(`[demo mode] would send decision "${decision}" for ${requestId}`);
  }
}

/**
 * Generates a fresh simulated tool-call request for Auto Detect — a
 * randomly picked action shape with randomized specifics (table names,
 * amounts, hosts, files, ...) and a randomly picked agent name. Never
 * repeats the same action shape twice in a row. The resulting description
 * is real, varying text — not a fixed script — so it feeds the on-device
 * risk model something genuinely new to scan each time.
 */
export function nextDemoRequest() {
  let index = randInt(0, ACTION_GENERATORS.length - 1);
  if (ACTION_GENERATORS.length > 1) {
    while (index === lastGeneratorIndex) {
      index = randInt(0, ACTION_GENERATORS.length - 1);
    }
  }
  lastGeneratorIndex = index;

  const action = ACTION_GENERATORS[index]();
  return {
    id: `auto-${Date.now()}-${randInt(1000, 9999)}`,
    agent: pick(AGENTS),
    ...action,
  };
}
