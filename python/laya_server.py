#!/usr/bin/env python3
"""Loopback-only Laya text classifier; screenshots/OCR stay in the scanner.

The model runs in a supervised process so load and inference deadlines can stop
native inference as well as Python code. There is no heuristic inference fallback.
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing as mp
import os
import re
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MODEL_ID = "convaiinnovations/laya-multilingual"
MODEL_REVISION = "1720e3e3357cfe1e281542e223f8273b0890ca34"
MODEL_SHA256 = "9d628fd971b700382ac6f65920a86f149777b2e748e0c955fb3b19695aa8f204"
LAYA_VERSION = "0.4.14"
MODEL = {"id": MODEL_ID, "revision": MODEL_REVISION}
MAX_BODY_BYTES = 65536


def validate_payload(payload: Any) -> dict[str, Any]:
    """Validate both Node and direct HTTP callers without changing their IDs."""
    if not isinstance(payload, dict) or set(payload) != {"text", "candidates"}:
        raise ValueError("Expected exactly text and candidates.")
    text, candidates = payload["text"], payload["candidates"]
    if not isinstance(text, str) or len(text) > 8000:
        raise ValueError("text must contain at most 8000 characters.")
    if not isinstance(candidates, list) or len(candidates) > 8:
        raise ValueError("candidates must contain at most 8 controls.")
    ids: set[str] = set()
    clean = []
    for candidate in candidates:
        if not isinstance(candidate, dict) or not {"id", "text"}.issubset(candidate):
            raise ValueError("Each candidate needs an id and text.")
        if set(candidate) - {"id", "text", "kind"}:
            raise ValueError("Candidate fields are id, text, and optional kind.")
        cid, label = candidate["id"], candidate["text"]
        kind = candidate.get("kind", "unknown")
        if not isinstance(cid, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", cid) or cid in ids:
            raise ValueError("Candidate IDs must be unique and use letters, numbers, or _.:-.")
        if not isinstance(label, str) or len(label) > 160 or not isinstance(kind, str) or len(kind) > 32:
            raise ValueError("Candidate text or kind exceeds its limit.")
        ids.add(cid)
        clean.append({"id": cid, "text": label, "kind": kind})
    return {"text": text, "candidates": clean}


def abstain(reason: str, *, inference: bool = False, confidence: float = 0.0,
            details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "status": "needs_review", "action": "none", "candidateId": None,
        "confidence": confidence, "inference": inference, "reason": reason,
        "model": MODEL, "details": details or {},
    }


def questions_for(payload: dict[str, Any]) -> dict[str, Any]:
    target_options = {
        f"control_{index}": candidate["text"] or "Unlabelled control; purpose is unknown."
        for index, candidate in enumerate(payload["candidates"])
    }
    target_options["no_control"] = (
        "No matching opening-screen control. The labels are gameplay, "
        "purchase, unrelated or unclear controls."
    )
    return {
        "intent": {
            "type": "choice",
            "instructions": "What does this game screen ask the user to do before gameplay?",
            "criteria": {
                "continue": "Click or tap to continue past a welcome, introduction, tutorial, or loading screen.",
                "dismiss": "Close or dismiss an informational introduction or tutorial overlay.",
                "none": "No introduction to advance: gameplay, spinning, betting, purchasing, or an unclear screen.",
            },
        },
        "target": {
            "type": "choice",
            "instructions": (
                "Which displayed control matches the explicit instruction "
                "to advance or dismiss the opening screen? "
                "Select no_control if no label matches."
            ),
            "criteria": target_options,
        },
    }


def interpret_prediction(raw: dict[str, Any], payload: dict[str, Any], min_confidence: float) -> dict[str, Any]:
    """Keep low confidence, truncated evidence, and unmatched targets non-actionable."""
    intent, target = raw["answers"]["intent"], raw["answers"]["target"]
    action, target_choice = intent["choice"], target["choice"]
    confidence = min(float(intent["answer_confidence"]), float(target["answer_confidence"]))
    if not math.isfinite(confidence) or not 0 <= confidence <= 1 or action not in {"continue", "dismiss", "none"}:
        raise ValueError("Laya returned an invalid choice or confidence.")
    allowed_targets = {f"control_{i}" for i in range(len(payload["candidates"]))} | {"no_control"}
    if target_choice not in allowed_targets:
        raise ValueError("Laya returned a target outside the submitted candidate set.")
    usage = raw.get("usage", {})
    details = {"intent": intent, "target": target, "usage": usage}
    if usage.get("truncated") or usage.get("options"):
        return abstain("truncated_input", inference=True, confidence=confidence, details=details)
    if action == "none":
        return {**abstain("no_intro", inference=True, confidence=confidence, details=details), "status": "ok"}
    if target_choice == "no_control":
        return abstain("no_target", inference=True, confidence=confidence, details=details)
    if confidence < min_confidence:
        return abstain("low_confidence", inference=True, confidence=confidence, details=details)
    candidate = payload["candidates"][int(target_choice.removeprefix("control_"))]
    if not candidate["text"].strip():
        return abstain("unlabelled_target", inference=True, confidence=confidence, details=details)
    return {
        "status": "ok", "action": action, "candidateId": candidate["id"],
        "confidence": confidence, "inference": True, "reason": "intro_action",
        "model": MODEL, "details": details,
    }


def classify(agent: Any, payload: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
    # Import here so --help and pure schema checks do not need model dependencies.
    from laya.common import encode_text, serialize_state

    if not payload["text"].strip() and not any(c["text"].strip() for c in payload["candidates"]):
        return abstain("no_visible_text")
    if not payload["candidates"]:
        return abstain("no_candidates")
    state = {"screen_text": payload["text"], "visible_controls": payload["candidates"]}
    token_count = len(encode_text(agent.tok, serialize_state(state), add_special_tokens=False)["input_ids"])
    if token_count > settings["max_state_tokens"]:
        return abstain("input_token_limit", details={"stateTokens": token_count, "maxStateTokens": settings["max_state_tokens"]})
    start = time.monotonic()
    raw = agent.predict(state, questions_for(payload), max_len=1024, head_max_len=256)
    result = interpret_prediction(raw, payload, settings["min_confidence"])
    result["elapsedMs"] = round((time.monotonic() - start) * 1000, 2)
    result["details"]["stateTokens"] = token_count
    return result


def model_worker(connection: Any, settings: dict[str, Any]) -> None:
    """Load exactly one verified checkpoint and handle one inference at a time."""
    try:
        os.environ["USE_TF"] = "0"
        os.environ["USE_TORCH"] = "1"
        os.environ["TOKENIZERS_PARALLELISM"] = "false"
        os.environ["OMP_NUM_THREADS"] = str(settings["threads"])
        # Generic hosted CPUs need fp32; do not inherit a hardware-specific AMP setting.
        os.environ.pop("LAYA_CPU_AMP", None)
        import torch
        import laya

        if laya.__version__ != LAYA_VERSION:
            raise RuntimeError(f"Expected laya {LAYA_VERSION}, found {laya.__version__}.")
        torch.set_num_threads(settings["threads"])
        torch.set_num_interop_threads(1)
        torch.manual_seed(0)
        agent = laya.load(
            MODEL_ID, device="cpu", revision=MODEL_REVISION, backend="eager",
            expected_sha256={"model.safetensors": MODEL_SHA256},
        )
        if agent.revision != MODEL_REVISION or str(agent.device) != "cpu":
            raise RuntimeError("Loaded checkpoint revision or device does not match the configured runtime.")
        warmup = classify(agent, validate_payload({
            "text": "Welcome. Click to continue.",
            "candidates": [{"id": "intro", "text": "Click to continue", "kind": "ocr"}],
        }), settings)
        if warmup["inference"] is not True:
            raise RuntimeError("Warmup did not execute model inference.")
        connection.send({"ready": True, "model": MODEL, "runtime": {
            "layaVersion": laya.__version__, "torchVersion": torch.__version__,
            "device": "cpu", "threads": settings["threads"],
        }, "warmup": warmup})
        while True:
            payload = connection.recv()
            if payload is None:
                break
            try:
                connection.send({"result": classify(agent, payload, settings)})
            except Exception:
                traceback.print_exc()
                connection.send({"error": "inference_failed"})
    except EOFError:
        pass
    except Exception as error:
        traceback.print_exc()
        try:
            connection.send({"error": "model_start_failed", "message": str(error)[:500]})
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        connection.close()


class RuntimeFailure(Exception):
    def __init__(self, code: str, status: int = 503):
        super().__init__(code)
        self.code, self.status = code, status


class Runtime:
    def __init__(self, settings: dict[str, Any]):
        self.settings = settings
        self.lock = threading.Lock()
        self.ready = False
        context = mp.get_context("spawn")
        self.connection, child = context.Pipe()
        self.process = context.Process(target=model_worker, args=(child, settings), daemon=True)
        self.process.start()
        child.close()
        try:
            if not self.connection.poll(settings["load_timeout_seconds"]):
                raise RuntimeFailure("model_load_timeout")
            self.metadata = self.connection.recv()
            if self.metadata.get("ready") is not True:
                raise RuntimeError(f"Laya startup failed: {self.metadata}")
            self.ready = True
        except BaseException:
            self.close()
            raise

    def health(self) -> dict[str, Any]:
        return {**self.metadata, "ready": self.ready and self.process.is_alive()}

    def predict(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.lock.acquire(blocking=False):
            raise RuntimeFailure("inference_busy", 429)
        try:
            if not self.ready or not self.process.is_alive():
                raise RuntimeFailure("not_ready")
            self.connection.send(payload)
            if not self.connection.poll(self.settings["inference_timeout_seconds"]):
                self.close()
                raise RuntimeFailure("inference_timeout", 504)
            reply = self.connection.recv()
            if "error" in reply:
                raise RuntimeFailure(reply["error"], 500)
            return reply["result"]
        except (EOFError, BrokenPipeError, OSError) as error:
            self.ready = False
            raise RuntimeFailure("worker_stopped") from error
        finally:
            self.lock.release()

    def close(self) -> None:
        self.ready = False
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout=2)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(timeout=2)
        self.connection.close()


def handler_for(runtime: Runtime) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def setup(self) -> None:
            super().setup()
            self.connection.settimeout(5)

        def respond(self, status: int, body: dict[str, Any]) -> None:
            encoded = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self) -> None:
            if self.path != "/health":
                self.respond(404, {"error": "not_found"})
                return
            health = runtime.health()
            self.respond(200 if health["ready"] else 503, health)

        def do_POST(self) -> None:
            if self.path != "/classify-intro":
                self.respond(404, {"error": "not_found"})
                return
            if self.headers.get("Origin") or self.headers.get("Transfer-Encoding"):
                self.respond(400, {"error": "unsupported_request"})
                return
            try:
                if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                    raise ValueError("Content-Type must be application/json.")
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY_BYTES:
                    raise ValueError("Request must contain 1 to 65536 bytes.")
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError("Incomplete request body.")
                payload = validate_payload(json.loads(raw))
            except (ValueError, UnicodeDecodeError, TimeoutError) as error:
                self.respond(400, {"error": "invalid_input", "message": str(error)[:200]})
                return
            try:
                self.respond(200, runtime.predict(payload))
            except RuntimeFailure as error:
                self.respond(error.status, {"error": error.code, "inference": False, "model": MODEL})

    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--min-confidence", type=float, default=0.8)
    parser.add_argument("--max-state-tokens", type=int, default=512)
    parser.add_argument("--load-timeout-seconds", type=float, default=600)
    parser.add_argument("--inference-timeout-seconds", type=float, default=12)
    parser.add_argument("--self-test", action="store_true", help="Run real intro/gameplay fixtures and exit; downloads the pinned model.")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.threads <= 32:
        parser.error("port must be 1..65535 and threads 1..32")
    if not 0 <= args.min_confidence <= 1 or not 64 <= args.max_state_tokens <= 512:
        parser.error("min-confidence must be 0..1 and max-state-tokens 64..512")
    if not 1 <= args.load_timeout_seconds <= 1800 or not 0.1 <= args.inference_timeout_seconds <= 120:
        parser.error("load timeout must be 1..1800 s and inference timeout 0.1..120 s")
    settings = vars(args)
    runtime = Runtime(settings)
    try:
        if args.self_test:
            positive = runtime.predict(validate_payload({
                "text": "Welcome to the demo. Click to continue.",
                "candidates": [{"id": "intro", "text": "Click to continue", "kind": "ocr"}],
            }))
            negative = runtime.predict(validate_payload({
                "text": "Balance 1000. Bet 1. Spin the reels.",
                "candidates": [{"id": "spin", "text": "Spin", "kind": "ocr"}],
            }))
            passed = (positive["inference"] and positive["status"] == "ok" and
                      positive["action"] == "continue" and positive["candidateId"] == "intro" and
                      negative["inference"] and negative["action"] == "none")
            print(json.dumps({"passed": bool(passed), "health": runtime.health(),
                              "fixtures": {"intro": positive, "gameplay": negative}}, ensure_ascii=False))
            return 0 if passed else 1
        print(json.dumps({"event": "laya_ready", "url": f"http://127.0.0.1:{args.port}", **runtime.health()}), flush=True)
        with ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(runtime)) as server:
            server.daemon_threads = True
            server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        runtime.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
