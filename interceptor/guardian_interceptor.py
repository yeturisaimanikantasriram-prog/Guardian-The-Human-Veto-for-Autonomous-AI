"""
Guardian interceptor.

Wraps a tool call so that, before it actually executes, it's submitted to the
Guardian relay for phone-based approval, and blocks until a decision comes
back (or times out and denies by default).

This file is deliberately framework-agnostic: it doesn't assume a specific
MCP server implementation, because MCP client/server SDKs vary. Two ways to
use it:

1. As a plain decorator around any Python function that performs a
   tool-call-like action (the easiest path for a hackathon demo):

       from guardian_interceptor import guarded

       @guarded(
           tool="db.deleteRecords",
           agent="billing-cleanup-agent",
           describe=lambda table, **kw: f"Delete records from {table}",
       )
       def delete_records(table: str, filter: str):
           ...actual deletion logic...

2. If you're using the official MCP Python SDK, call `request_approval(...)`
   directly at the top of your `@server.call_tool()` handler, before running
   the tool's real logic — see `example_mcp_hook()` below for the shape of
   that integration.

Requires:  pip install websockets   (needs internet — not available in the
           sandbox this was written in, so this has not been execution-tested
           here. Test it in your own environment before the hackathon.)
"""

import asyncio
import functools
import json
import uuid
from dataclasses import dataclass

import websockets

RELAY_URL = "ws://localhost:8765"  # point this at your deployed relay's address
DEFAULT_TIMEOUT_SECONDS = 60


class ActionDenied(Exception):
    """Raised when the phone-side reviewer denies a tool call."""
    def __init__(self, tool: str, request_id: str):
        super().__init__(f"Guardian denied execution of '{tool}' (request {request_id})")
        self.tool = tool
        self.request_id = request_id


@dataclass
class ApprovalResult:
    approved: bool
    request_id: str
    reason: str | None = None


async def request_approval(
    tool: str,
    agent: str,
    description: str,
    payload: dict,
    relay_url: str = RELAY_URL,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
) -> ApprovalResult:
    """
    Submits a tool call to the relay and blocks until the phone responds.
    Fails closed: any connection problem or timeout resolves to denied,
    never to approved — a reviewer being unreachable is not consent.
    """
    request_id = str(uuid.uuid4())
    message = {
        "type": "tool_call_request",
        "payload": {
            "id": request_id,
            "tool": tool,
            "agent": agent,
            "description": description,
            "payload": payload,
        },
    }

    try:
        async with websockets.connect(relay_url) as ws:
            await ws.send(json.dumps(message))
            raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
            response = json.loads(raw)

            decision = response.get("decision")
            return ApprovalResult(
                approved=(decision == "approved"),
                request_id=request_id,
                reason=response.get("reason"),
            )

    except (asyncio.TimeoutError, websockets.exceptions.WebSocketException, OSError) as e:
        # Fail closed — no relay, no reviewer, no approval.
        return ApprovalResult(approved=False, request_id=request_id, reason=f"relay unreachable: {e}")


def guarded(tool: str, agent: str, describe):
    """
    Decorator: wraps a function so it only runs after phone approval.

    `describe` is a callable that takes the same kwargs as the wrapped
    function and returns a one-line, plain-English description of what
    it's about to do — this is what shows up on the phone screen, so make
    it specific and honest, not vague.
    """
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            description = describe(**kwargs)
            result = asyncio.run(
                request_approval(tool=tool, agent=agent, description=description, payload=kwargs)
            )
            if not result.approved:
                raise ActionDenied(tool=tool, request_id=result.request_id)
            return fn(*args, **kwargs)
        return wrapper
    return decorator


# ---------------------------------------------------------------------------
# Example: how this would hook into an actual MCP server's tool handler.
# Adjust to whatever MCP SDK/version you're actually using — this shows the
# shape of the integration, not a drop-in for every SDK.
# ---------------------------------------------------------------------------

async def example_mcp_hook(tool_name: str, agent_name: str, arguments: dict):
    """
    Call this at the top of your MCP server's tool-call handler, before
    running the tool's real logic. Raise/return an error if not approved.
    """
    description = f"Agent '{agent_name}' wants to call '{tool_name}' with: {arguments}"
    result = await request_approval(
        tool=tool_name,
        agent=agent_name,
        description=description,
        payload=arguments,
    )
    if not result.approved:
        raise ActionDenied(tool=tool_name, request_id=result.request_id)
    # ...proceed to actually execute the tool...
