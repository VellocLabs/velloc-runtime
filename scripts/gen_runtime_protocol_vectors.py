"""Regenerate src/browser/runtimeProtocol/vectors/v1.json — the UI <-> Runtime
protocol v1 conformance vectors.

    python scripts/gen_runtime_protocol_vectors.py        # from the nexus_web root (any cwd works)

Why Python, in a TypeScript repo: the blob-chunk vectors must come from an
implementation the TS codec did NOT write, or the codec would be grading its
own homework. This file is that second implementation of the layout

    u32be headerLen | header JSON (compact, fixed key order id/index/last, UTF-8) | chunk bytes

Keep it independent — never import or shell out to the TS side. When the
layout, a frame kind, an enumeration, or a required field changes, edit the
tables below, run the script, and let `src/__tests__/runtime-protocol.test.ts`
cross-check the TS codec against the regenerated JSON. Never hand-edit the
JSON: the hex would drift from the layout it claims to pin.

Wire conventions the vectors encode (P-3):
  - only `hello` and `welcome` carry the protocol version `v`;
  - routes are `"cap.act"` strings;
  - subscribing and heartbeats are ordinary `req`s on the hub's built-in routes
    (`topics.subscribe` / `topics.unsubscribe` / `sys.ping`), not frame kinds;
  - `res` has no `route`; `evt` carries an optional `type` instead of a route.
"""
import json
import pathlib
import struct

OUT = pathlib.Path(__file__).resolve().parents[1] / "src" / "browser" / "runtimeProtocol" / "vectors" / "v1.json"


def chunk_hex(header, payload_hex):
    hdr = json.dumps(
        {"id": header["id"], "index": header["index"], "last": header["last"]},
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    body = bytes.fromhex(payload_hex)
    return (struct.pack(">I", len(hdr)) + hdr + body).hex()


# Accepted frames. Every frame kind needs at least one; every key a kind may
# carry (FRAME_KEYS in frames.ts) must appear in at least one vector of that kind.
frames = [
    {"name": "hello-local-desktop", "frame": {"kind": "hello", "v": 1,
        "client": {"clientId": "install-7f3a", "kind": "desktop-shell",
                   "build": "2026-09-08T00:00:00Z", "panelId": "panel-1"},
        "auth": {"mode": "local"}}},
    # A client may ask for LESS than the transport grants; the hub clamps down, never up.
    {"name": "hello-local-control-ceiling", "frame": {"kind": "hello", "v": 1,
        "client": {"clientId": "install-7f3a", "kind": "desktop-shell"},
        "auth": {"mode": "local"}, "scopeCeiling": "control"}},
    {"name": "hello-pair-mobile-resume", "frame": {"kind": "hello", "v": 1,
        "client": {"clientId": "device-91c0", "kind": "mobile", "displayName": "Pixel"},
        "auth": {"mode": "pair", "pairId": "pair-2a"},
        "resume": {"connectionId": "conn-4", "topics": {"sessions": 12, "session/s1/state": 40}}}},
    # A newer client is still a FRAME: the hub answers `bye protocol_too_new`
    # instead of dropping it on the floor. Version policy is the hub's, not the codec's.
    {"name": "hello-future-version", "frame": {"kind": "hello", "v": 2,
        "client": {"clientId": "install-9", "kind": "browser"}, "auth": {"mode": "pair", "pairId": "pair-9"}}},
    {"name": "challenge", "frame": {"kind": "challenge", "nonce": "n-3f9c0a"}},
    {"name": "auth", "frame": {"kind": "auth", "proof": "b64url-hmac"}},
    {"name": "welcome-fresh-full", "frame": {"kind": "welcome", "v": 1, "connectionId": "conn-1", "resumed": False,
        "scope": {"mode": "full", "sessions": "all"},
        "server": {"runtimeVersion": "1.149.1.16",
                   "capabilities": [{"cap": "session", "acts": ["list", "submit"]},
                                    {"cap": "ui", "acts": ["pickProjectFolder"]}]},
        "bootstrap": {"homeDir": "C:\\Users\\me", "platform": "win32", "pathSep": "\\"}}},
    {"name": "welcome-resumed-control", "frame": {"kind": "welcome", "v": 1, "connectionId": "conn-4", "resumed": True,
        "scope": {"mode": "control", "sessions": ["s1"]},
        "server": {"runtimeVersion": "1.149.1.16",
                   "capabilities": [{"cap": "session", "acts": ["submit", "interrupt"]}]}}},
    {"name": "bye", "frame": {"kind": "bye", "code": "protocol_too_old", "retryAfterMs": 0}},
    {"name": "req-session-submit", "frame": {"kind": "req", "id": "r-1", "route": "session.submit",
        "payload": {"sessionId": "s1", "prompt": "hi", "promptUuid": "u-1"}}},
    # `payload: undefined` is dropped by JSON.stringify; receivers accept the absent key.
    {"name": "req-without-payload", "frame": {"kind": "req", "id": "r-5", "route": "session.list"}},
    # Subscribing is an ordinary request on a hub built-in route.
    {"name": "req-topics-subscribe", "frame": {"kind": "req", "id": "r-4", "route": "topics.subscribe",
        "payload": {"topics": [{"topic": "sessions"}, {"topic": "session/s1/transcript", "since": 118}]}}},
    {"name": "req-topics-unsubscribe", "frame": {"kind": "req", "id": "r-6", "route": "topics.unsubscribe",
        "payload": {"topics": ["session/s1/stream"]}}},
    # Heartbeat is an ordinary request too; the result echoes `t`.
    {"name": "req-sys-ping", "frame": {"kind": "req", "id": "r-7", "route": "sys.ping", "payload": {"t": 1757289600000}}},
    {"name": "res-ok", "frame": {"kind": "res", "id": "r-1", "ok": True, "result": {"accepted": True}}},
    # A handler that returns undefined yields `ok:true` with no `result` key on the wire.
    {"name": "res-ok-without-result", "frame": {"kind": "res", "id": "r-5", "ok": True}},
    {"name": "res-error-stale", "frame": {"kind": "res", "id": "r-2", "ok": False,
        "error": {"code": "stale", "message": "already resolved by another connection", "retryable": False}}},
    {"name": "res-error-retryable", "frame": {"kind": "res", "id": "r-3", "ok": False,
        "error": {"code": "host_unavailable", "message": "no direct bridge", "retryable": True, "data": {"since": 1}}}},
    {"name": "cancel", "frame": {"kind": "cancel", "id": "r-3"}},
    {"name": "evt-snapshot-paged", "frame": {"kind": "evt", "topic": "session/s1/transcript", "seq": 119,
        "type": "transcriptPage", "payload": {"messages": [], "sinceOrdinal": 118}, "form": "snapshot", "more": True}},
    {"name": "evt-delta-typed", "frame": {"kind": "evt", "topic": "sessions", "seq": 13,
        "type": "updated", "payload": {"session": {"sessionId": "s1"}}, "form": "delta"}},
    # No envelope `type`: the payload (an SDKMessage) carries its own discriminator.
    {"name": "evt-delta-untyped", "frame": {"kind": "evt", "topic": "session/s1/stream", "seq": 2048,
        "payload": {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
                    "delta": {"type": "text_delta", "text": "hi"}}}, "form": "delta"}},
    # A batch: several deltas of one topic in one frame, one seq for the lot.
    {"name": "evt-deltas-batch", "frame": {"kind": "evt", "topic": "sessions", "seq": 14,
        "type": "updated", "payload": [{"session": {"sessionId": "s1"}}, {"session": {"sessionId": "s2"}}],
        "form": "deltas"}},
    {"name": "ack", "frame": {"kind": "ack", "id": "blob-9", "upTo": 7}},
]

# Values `isFrame` must reject. Cover: version, unknown kind (incl. the removed
# ones), missing required fields, malformed nested elements, every enumeration,
# and the two legacy envelopes that share a MessagePort with this protocol today.
rejected = [
    # `deltas` promises a list; a single payload under that form is not one.
    {"name": "evt-deltas-not-a-list", "value": {"kind": "evt", "topic": "sessions", "seq": 15,
        "payload": {"session": {"sessionId": "s1"}}, "form": "deltas"}},
    {"name": "hello-version-zero", "value": {"kind": "hello", "v": 0,
        "client": {"clientId": "c", "kind": "mobile"}, "auth": {"mode": "local"}}},
    {"name": "hello-missing-version", "value": {"kind": "hello",
        "client": {"clientId": "c", "kind": "mobile"}, "auth": {"mode": "local"}}},
    {"name": "welcome-missing-version", "value": {"kind": "welcome", "connectionId": "c", "resumed": False,
        "scope": {"mode": "observe", "sessions": "all"}, "server": {"runtimeVersion": "x", "capabilities": []}}},
    {"name": "unknown-kind-ping", "value": {"kind": "ping", "t": 1}},
    {"name": "unknown-kind-sub", "value": {"kind": "sub", "id": "r-4", "topics": [{"topic": "sessions"}]}},
    {"name": "unknown-kind-call", "value": {"kind": "call", "id": "c-1", "route": "host.notify", "payload": {}}},
    {"name": "req-missing-route", "value": {"kind": "req", "id": "r-1", "payload": {}}},
    {"name": "req-route-single-segment", "value": {"kind": "req", "id": "r-1", "route": "session", "payload": {}}},
    {"name": "req-route-three-segments", "value": {"kind": "req", "id": "r-1", "route": "session.x.list", "payload": {}}},
    {"name": "req-route-object-form", "value": {"kind": "req", "id": "r-1",
        "route": {"cap": "session", "act": "list"}, "payload": {}}},
    {"name": "res-error-unknown-code", "value": {"kind": "res", "id": "r-1", "ok": False,
        "error": {"code": "boom", "message": "x", "retryable": False}}},
    {"name": "res-error-missing-error", "value": {"kind": "res", "id": "r-1", "ok": False}},
    {"name": "evt-seq-not-integer", "value": {"kind": "evt", "topic": "sessions", "seq": "13",
        "type": "updated", "payload": {}, "form": "delta"}},
    {"name": "evt-bad-form", "value": {"kind": "evt", "topic": "sessions", "seq": 13,
        "type": "updated", "payload": {}, "form": "full"}},
    {"name": "evt-more-not-true", "value": {"kind": "evt", "topic": "sessions", "seq": 13,
        "payload": {}, "form": "snapshot", "more": False}},
    {"name": "evt-type-not-string", "value": {"kind": "evt", "topic": "sessions", "seq": 13,
        "type": 7, "payload": {}, "form": "delta"}},
    {"name": "hello-pair-without-id", "value": {"kind": "hello", "v": 1,
        "client": {"clientId": "c", "kind": "mobile"}, "auth": {"mode": "pair"}}},
    {"name": "hello-unknown-client-kind", "value": {"kind": "hello", "v": 1,
        "client": {"clientId": "c", "kind": "toaster"}, "auth": {"mode": "local"}}},
    {"name": "hello-bad-scope-ceiling", "value": {"kind": "hello", "v": 1,
        "client": {"clientId": "c", "kind": "desktop-shell"}, "auth": {"mode": "local"},
        "scopeCeiling": "admin"}},
    {"name": "hello-resume-bad-topics", "value": {"kind": "hello", "v": 1,
        "client": {"clientId": "c", "kind": "mobile"}, "auth": {"mode": "pair", "pairId": "p"},
        "resume": {"connectionId": "conn-4", "topics": {"sessions": "12"}}}},
    {"name": "welcome-unknown-scope-mode", "value": {"kind": "welcome", "v": 1, "connectionId": "c", "resumed": False,
        "scope": {"mode": "admin", "sessions": "all"},
        "server": {"runtimeVersion": "x", "capabilities": []}}},
    {"name": "welcome-bad-capability-advert", "value": {"kind": "welcome", "v": 1, "connectionId": "c", "resumed": False,
        "scope": {"mode": "observe", "sessions": ["s1"]},
        "server": {"runtimeVersion": "x", "capabilities": [{"cap": "session", "acts": [1]}]}}},
    {"name": "bye-unknown-code", "value": {"kind": "bye", "code": "???"}},
    {"name": "hello-unknown-auth-mode", "value": {"kind": "hello", "v": 1,
        "client": {"clientId": "c", "kind": "mobile"}, "auth": {"mode": "oauth"}}},
    {"name": "bye-bad-retry", "value": {"kind": "bye", "code": "replaced", "retryAfterMs": -1}},
    {"name": "legacy-direct-bridge-envelope", "value": {"hostBridge": True, "direction": "request", "id": "x",
        "route": {"namespace": "nexus", "capability": "fs", "action": "cwd"}, "payload": {}}},
    {"name": "legacy-shared-worker-message", "value": {"type": "worker.init", "sessionId": "s1", "payload": {}}},
    {"name": "null", "value": None},
    {"name": "string", "value": "hello"},
    {"name": "array", "value": [1, 2, 3]},
]

# Of `rejected`, the ones a RECEIVER must still read: the only fault is an
# enumeration value this version does not know, which a later version may add.
# `isFrame` (what a sender may emit) rejects them; `readFrame` / `decodeFrame`
# (what a receiver accepts) reads them as `reads`. D-2 invariant: receivers
# tolerate unknown values. A missing or mistyped field is never tolerated.
_rejected_by_name = {r["name"]: r["value"] for r in rejected}
tolerated = [
    {"name": "res-error-unknown-code", "reads": {"kind": "res", "id": "r-1", "ok": False,
        "error": {"code": "internal", "message": "x", "retryable": False, "unknownCode": "boom"}}},
    {"name": "evt-bad-form", "reads": {"kind": "evt", "topic": "sessions", "seq": 13,
        "type": "updated", "payload": [], "form": "deltas"}},
    {"name": "hello-unknown-client-kind", "reads": {"kind": "hello", "v": 1,
        "client": {"clientId": "c", "kind": "browser"}, "auth": {"mode": "local"}}},
    {"name": "hello-bad-scope-ceiling", "reads": {"kind": "hello", "v": 1,
        "client": {"clientId": "c", "kind": "desktop-shell"}, "auth": {"mode": "local"},
        "scopeCeiling": "observe"}},
    {"name": "hello-unknown-auth-mode", "reads": {"kind": "hello", "v": 1,
        "client": {"clientId": "c", "kind": "mobile"}, "auth": {"mode": "pair", "pairId": ""}}},
    {"name": "welcome-unknown-scope-mode", "reads": {"kind": "welcome", "v": 1, "connectionId": "c",
        "resumed": False, "scope": {"mode": "observe", "sessions": "all"},
        "server": {"runtimeVersion": "x", "capabilities": []}}},
    {"name": "bye-unknown-code", "reads": {"kind": "bye", "code": "shutting_down"}},
]
for t in tolerated:
    t["value"] = _rejected_by_name[t["name"]]
tolerated = [{"name": t["name"], "value": t["value"], "reads": t["reads"]} for t in tolerated]

blob_chunks = []
for name, header, payload_hex in [
    ("single-chunk-last", {"id": "blob-1", "index": 0, "last": True}, "00ff10"),
    ("middle-chunk", {"id": "blob-9", "index": 7, "last": False}, "deadbeefcafebabe"),
    ("empty-final-chunk", {"id": "blob-9", "index": 8, "last": True}, ""),
    ("utf8-id", {"id": "附件-1", "index": 0, "last": True}, "01"),
]:
    blob_chunks.append({"name": name, "header": header, "bytesHex": payload_hex,
                        "encodedHex": chunk_hex(header, payload_hex)})

doc = {
    "$comment": ("Conformance vectors for the UI <-> Runtime protocol v1. Every implementation "
                 "(nexus_web, the panel-host Lit build, a relay) must accept `frames`, never "
                 "send `rejected`, drop every `rejected` on receipt EXCEPT `tolerated`, which it "
                 "reads as `tolerated[].reads`, and reproduce `blobChunks[].encodedHex` byte-for-byte from header + "
                 "bytesHex. GENERATED by scripts/gen_runtime_protocol_vectors.py (an independent "
                 "Python encoder) — edit that script and re-run it; never edit this file by hand."),
    "protocol": 1,
    "frames": frames,
    "rejected": rejected,
    "tolerated": tolerated,
    "blobChunks": blob_chunks,
}


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes((json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes): {len(frames)} frames, {len(rejected)} rejected, "
          f"{len(tolerated)} tolerated, "
          f"{len(blob_chunks)} blob chunks")


if __name__ == "__main__":
    main()
