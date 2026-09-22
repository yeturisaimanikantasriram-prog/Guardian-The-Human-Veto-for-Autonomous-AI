"""
auth_store.py

Accounts and per-account decision history for Guardian, backed by SQLite
(stdlib only — no extra install needed beyond what the relay already uses).

Scope note: the face_descriptor captured at signup is a 128-number
face-api.js embedding (see pwa/js/faceMatch.js), stored here as JSON, not
a raw photo. It's used for identity matching at ONE gate only — the
on-device camera check before approving a high-risk agent action — where
the live face is compared against this stored descriptor via Euclidean
distance. It is NOT used for login: password is still the sole login
credential, so an attacker with the password but not the account owner's
face is stopped at the approval gate, not before. Accounts without a
captured descriptor (camera declined at signup, or guest mode) fall back
to presence-only checks at that gate (any face detected, not identity
verified) — see pwa/js/presenceCheck.js.

Passwords are hashed with PBKDF2-HMAC-SHA256 (stdlib hashlib, no external
crypto dependency needed) — a real, salted, iterated hash, not plaintext
and not a bare unsalted SHA256.
"""

import sqlite3
import hashlib
import json
import secrets
import time
from pathlib import Path

DB_PATH = Path(__file__).parent / "guardian.db"
PBKDF2_ITERATIONS = 200_000


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_connection()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            face_captured INTEGER NOT NULL DEFAULT 0,
            face_descriptor TEXT,
            created_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at REAL NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS decisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            tool TEXT NOT NULL,
            agent TEXT NOT NULL,
            description TEXT NOT NULL,
            score INTEGER,
            level TEXT NOT NULL,
            decision TEXT NOT NULL,
            auto INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        """
    )
    # Migration for DBs created before face_descriptor existed — CREATE TABLE
    # IF NOT EXISTS above won't add a column to an already-existing table.
    existing_columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
    if "face_descriptor" not in existing_columns:
        conn.execute("ALTER TABLE users ADD COLUMN face_descriptor TEXT")
    conn.commit()
    conn.close()


def _hash_password(password: str, salt: str = None) -> tuple[str, str]:
    if salt is None:
        salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS
    )
    return digest.hex(), salt


def create_user(username: str, password: str, face_captured: bool = False, face_descriptor: list | None = None) -> dict:
    """Returns {"ok": True, "user_id": int} or {"ok": False, "error": str}.

    face_descriptor, when given, is the 128-number face-api.js descriptor
    computed on-device at signup — stored as JSON, not the raw photo, so
    later logins can compare against it without ever holding an image.
    """
    username = username.strip()
    if not username or not password:
        return {"ok": False, "error": "Username and password are required."}
    if len(password) < 6:
        return {"ok": False, "error": "Password must be at least 6 characters."}

    conn = get_connection()
    try:
        existing = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if existing:
            return {"ok": False, "error": "That username is already taken."}

        password_hash, salt = _hash_password(password)
        descriptor_json = json.dumps(face_descriptor) if face_descriptor else None
        cursor = conn.execute(
            "INSERT INTO users (username, password_hash, password_salt, face_captured, face_descriptor, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (username, password_hash, salt, int(face_captured), descriptor_json, time.time()),
        )
        conn.commit()
        return {"ok": True, "user_id": cursor.lastrowid}
    finally:
        conn.close()


def verify_login(username: str, password: str) -> dict:
    """Returns {"ok": True, "user_id": int, "token": str} or {"ok": False, "error": str}."""
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username.strip(),)).fetchone()
        if not row:
            return {"ok": False, "error": "No account with that username."}

        candidate_hash, _ = _hash_password(password, row["password_salt"])
        if not secrets.compare_digest(candidate_hash, row["password_hash"]):
            return {"ok": False, "error": "Incorrect password."}

        token = secrets.token_hex(24)
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
            (token, row["id"], time.time()),
        )
        conn.commit()
        face_descriptor = json.loads(row["face_descriptor"]) if row["face_descriptor"] else None
        return {
            "ok": True, "user_id": row["id"], "username": row["username"], "token": token,
            "faceDescriptor": face_descriptor,
        }
    finally:
        conn.close()


def get_user_by_token(token: str):
    conn = get_connection()
    try:
        row = conn.execute(
            """SELECT users.id, users.username FROM sessions
               JOIN users ON users.id = sessions.user_id
               WHERE sessions.token = ?""",
            (token,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def save_decision(user_id: int, tool: str, agent: str, description: str,
                   score, level: str, decision: str, auto: bool = False) -> int:
    conn = get_connection()
    try:
        cursor = conn.execute(
            """INSERT INTO decisions (user_id, tool, agent, description, score, level, decision, auto, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (user_id, tool, agent, description, score, level, decision, int(auto), time.time()),
        )
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()


def get_history(user_id: int, limit: int = 50) -> list:
    conn = get_connection()
    try:
        rows = conn.execute(
            """SELECT tool, agent, description, score, level, decision, auto, created_at
               FROM decisions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?""",
            (user_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()
