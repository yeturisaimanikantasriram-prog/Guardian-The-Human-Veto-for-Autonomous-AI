"""
Guardian relay server.

Bridges two kinds of connections over one WebSocket endpoint:
  - the PHONE (the PWA), which needs to receive incoming tool-call requests
    and send back approve/deny decisions
  - the INTERCEPTOR (running alongside the agent), which needs to submit a
    tool-call request and then block until a decision comes back

This is intentionally a thin, stateless-per-request relay: it does no risk
scoring itself (that happens on-device on the phone) and holds no request
history beyond what's needed to route a decision back to the right caller.

Run with:  python3 server.py
Requires:  pip install websockets   (needs internet — not available in the
           sandbox this was written in, so this has not been execution-tested
           here. Test it in your own environment before the hackathon.)
"""

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field

import websockets
from websockets.server import WebSocketServerProtocol

import auth_store

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s")
log = logging.getLogger("guardian-relay")

HOST = "0.0.0.0"
PORT = 8765


@dataclass
class RelayState:
    # Currently connected phone client (only one expected for a hackathon demo;
    # a real deployment would key this by user/device id)
    phone: WebSocketServerProtocol | None = None
    # requestId -> asyncio.Future, resolved when a decision arrives from the phone
    pending: dict[str, asyncio.Future] = field(default_factory=dict)


state = RelayState()


async def handle_phone(ws: WebSocketServerProtocol):
    """Handles the PWA's connection: relays requests out, decisions back in,
    and also serves auth/history messages over the same connection."""
    state.phone = ws
    log.info("Phone connected")
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("Malformed message from phone: %s", raw)
                continue

            msg_type = msg.get("type")

            if msg_type == "decision":
                request_id = msg.get("requestId")
                decision = msg.get("decision")
                future = state.pending.pop(request_id, None)
                if future and not future.done():
                    future.set_result(decision)
                    log.info("Decision received: %s -> %s", request_id, decision)
                else:
                    log.warning("Decision for unknown/expired request: %s", request_id)

            elif msg_type == "signup":
                result = auth_store.create_user(
                    msg.get("username", ""), msg.get("password", ""),
                    face_captured=bool(msg.get("faceCaptured", False)),
                    face_descriptor=msg.get("faceDescriptor"),
                )
                await ws.send(json.dumps({"type": "signup_result", **result}))
                log.info("Signup attempt for '%s': ok=%s", msg.get("username"), result.get("ok"))

            elif msg_type == "login":
                result = auth_store.verify_login(msg.get("username", ""), msg.get("password", ""))
                await ws.send(json.dumps({"type": "login_result", **result}))
                log.info("Login attempt for '%s': ok=%s", msg.get("username"), result.get("ok"))

            elif msg_type == "save_decision":
                user = auth_store.get_user_by_token(msg.get("token", ""))
                if not user:
                    await ws.send(json.dumps({"type": "save_decision_result", "ok": False, "error": "Not logged in."}))
                    continue
                d = msg.get("decision_data", {})
                auth_store.save_decision(
                    user["id"], d.get("tool", ""), d.get("agent", ""), d.get("description", ""),
                    d.get("score"), d.get("level", ""), d.get("decision", ""), bool(d.get("auto", False)),
                )
                await ws.send(json.dumps({"type": "save_decision_result", "ok": True}))

            elif msg_type == "get_history":
                user = auth_store.get_user_by_token(msg.get("token", ""))
                if not user:
                    await ws.send(json.dumps({"type": "history_result", "ok": False, "error": "Not logged in."}))
                    continue
                history = auth_store.get_history(user["id"])
                await ws.send(json.dumps({"type": "history_result", "ok": True, "history": history}))

    finally:
        if state.phone is ws:
            state.phone = None
        log.info("Phone disconnected")


async def router(ws: WebSocketServerProtocol):
    """
    First message on a connection determines its role:
      {"type": "hello", "role": "phone"}       -> handled as the phone client
      {"type": "tool_call_request", ...}       -> handled as an interceptor call
    """
    try:
        raw = await ws.recv()
        msg = json.loads(raw)
    except (websockets.exceptions.ConnectionClosed, json.JSONDecodeError):
        return

    if msg.get("type") == "hello" and msg.get("role") == "phone":
        await handle_phone(ws)
    elif msg.get("type") == "tool_call_request":
        # route() already consumed the first message, so re-dispatch it
        await handle_interceptor_with_first_message(ws, msg)
    else:
        log.warning("Unknown first message: %s", msg)


async def handle_interceptor_with_first_message(ws, first_msg):
    """Same as handle_interceptor, but the first message was already read by router()."""
    payload = first_msg["payload"]
    request_id = payload.get("id") or str(uuid.uuid4())
    payload["id"] = request_id

    if state.phone is None:
        await ws.send(json.dumps({
            "type": "decision_result",
            "requestId": request_id,
            "decision": "denied",
            "reason": "no phone connected — deny by default",
        }))
        log.warning("Request %s denied: no phone connected", request_id)
        return

    future: asyncio.Future = asyncio.get_event_loop().create_future()
    state.pending[request_id] = future

    await state.phone.send(json.dumps({"type": "tool_call_request", "payload": payload}))
    log.info("Forwarded request %s (%s) to phone", request_id, payload.get("tool"))

    try:
        decision = await asyncio.wait_for(future, timeout=60)
    except asyncio.TimeoutError:
        state.pending.pop(request_id, None)
        decision = "denied"
        log.warning("Request %s timed out — deny by default", request_id)

    await ws.send(json.dumps({
        "type": "decision_result",
        "requestId": request_id,
        "decision": decision,
    }))


async def main():
    auth_store.init_db()
    log.info("Guardian relay listening on ws://%s:%s", HOST, PORT)
    async with websockets.serve(router, HOST, PORT):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
