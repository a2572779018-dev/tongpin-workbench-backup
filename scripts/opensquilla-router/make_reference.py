# Derived in part from OpenSquilla (https://github.com/TokenRhythm/opensquilla @ d27ba0e, Apache-2.0).
# See THIRD_PARTY_NOTICES.md.
"""Generate the OpenSquilla V4.2 router parity fixture with OpenSquilla's own code.

This drives ``opensquilla.squilla_router.v4_phase3.V4Phase3Strategy`` (the
adapter OpenSquilla's gateway uses) over the pinned bundle, then the gateway's
``RoutingPolicyEngine`` (confidence gate, complaint upgrade, KV-cache
anti-downgrade), replaying each reference conversation the way OpenSquilla's
runtime builds router context from a transcript.  Every intermediate the
TypeScript port reproduces is recorded: WordPiece ids, the 390-d feature
vector, the three raw BGE embeddings, LightGBM/MLP head outputs, the fused
distribution, the post-processed decision and the gateway's final tier.

Usage (see requirements-reference.txt for the exact runtime):
  python make_reference.py --opensquilla-src <clone>/src --bundle <v4.2 bundle> \
      --out src/features/tongpin-ai/opensquilla/__fixtures__/reference-v4.2.json
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import importlib.metadata as metadata
import json
import platform
import sys
import types
import warnings
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from reference_cases import build_cases

# OpenSquilla runtime constants (engine/runtime.py and engine/steps/squilla_router.py).
ROUTER_HISTORY_USER_MAX_CHARS = 8000
ROUTER_PREV_ASSISTANT_MAX_CHARS = 8000
ROUTER_HISTORY_USER_MAX_TURNS = 4
MAX_ROUTING_HISTORY = 5
ROUTING_HISTORY_WINDOW = 1800
VALID_TIERS = ["c0", "c1", "c2", "c3"]
# SquillaRouterConfig defaults (gateway/config.py) that the policy engine reads.
GATEWAY_POLICY_DEFAULTS = {
    "default_tier": "c1",
    "confidence_threshold": 0.5,
    "confidence_high_tier_margin": 0.05,
    "kv_cache_anti_downgrade_enabled": True,
    "kv_cache_anti_downgrade_window_seconds": 600,
    "complaint_upgrade_enabled": True,
    "complaint_upgrade_steps": 1,
    "complaint_upgrade_max_chars": 160,
    "calibration_enabled": False,
}


def f32_b64(values: np.ndarray) -> str:
    return base64.b64encode(np.asarray(values, dtype="<f4").tobytes()).decode("ascii")


def floats(values) -> list[float]:
    return [float(v) for v in values]


def import_opensquilla(src: Path):
    sys.path.insert(0, str(src))
    # engine/__init__ eagerly imports the agent runtime (pydantic, providers...).
    # The routing policy modules only need their own package path.
    base = src / "opensquilla" / "engine"
    for name, path in (("opensquilla.engine", base), ("opensquilla.engine.routing", base / "routing")):
        module = types.ModuleType(name)
        module.__path__ = [str(path)]
        sys.modules[name] = module
    from opensquilla.engine.routing.policy import PolicyInputs, RoutingDecision, RoutingPolicyEngine
    from opensquilla.squilla_router.v4_phase3 import V4Phase3Strategy
    return V4Phase3Strategy, PolicyInputs, RoutingDecision, RoutingPolicyEngine


def history_context(transcript: list[dict]) -> dict:
    """OpenSquilla ``TurnRunner._router_history_context`` over a plain transcript."""
    context: dict = {}
    user_texts: list[str] = []
    for entry in transcript:
        if entry["role"] != "user":
            continue
        content = entry["content"]
        if not isinstance(content, str) or not content.strip():
            continue
        text = content.strip()
        if len(text) > ROUTER_HISTORY_USER_MAX_CHARS:
            text = text[-ROUTER_HISTORY_USER_MAX_CHARS:]
        user_texts.append(text)
    if user_texts:
        context["history_user_texts"] = user_texts[-ROUTER_HISTORY_USER_MAX_TURNS:]
    for entry in reversed(transcript):
        if entry["role"] != "assistant":
            continue
        content = entry["content"]
        if not isinstance(content, str) or not content.strip():
            continue
        text = content.strip()
        if len(text) > ROUTER_PREV_ASSISTANT_MAX_CHARS:
            text = text[-ROUTER_PREV_ASSISTANT_MAX_CHARS:]
        context["prev_assistant_text"] = text
        usage = entry.get("usage")
        if usage:
            context["prev_assistant_usage"] = dict(usage)
        return context
    return context


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--opensquilla-src", required=True, type=Path)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    warnings.filterwarnings("ignore", message=".*Trying to unpickle estimator.*")
    V4Phase3Strategy, PolicyInputs, RoutingDecision, RoutingPolicyEngine = import_opensquilla(args.opensquilla_src)
    # OpenSquilla's gateway default: v4_use_aux_head = True, require_router_runtime = True.
    strategy = V4Phase3Strategy(bundle_dir=args.bundle, require_router_runtime=True, use_aux_head=True)
    core = strategy._core
    tokenizer, _session = core.bge_extractor._ensure_bge()._ensure_loaded()
    policy_engine = RoutingPolicyEngine()
    router_cfg = SimpleNamespace(**GATEWAY_POLICY_DEFAULTS)
    tiers = {tier: {"model": f"opensquilla-{tier}"} for tier in VALID_TIERS}

    from src.router.v4_features import make_history_user_text  # bundle runtime_src (import path set by strategy)

    out_cases = []
    turn_count = 0
    for case in build_cases():
        clock = 1_000_000.0
        transcript: list[dict] = []
        routing_history: list[dict] = []
        turns_out = []
        for index, spec in enumerate(case["turns"]):
            clock += float(spec.get("gap_s", 40.0)) if index else 0.0
            message = spec["user"]
            context = history_context(transcript)
            # engine/steps/squilla_router.py: bounded, time-windowed history.
            cutoff = clock - ROUTING_HISTORY_WINDOW
            routing_history = [entry for entry in routing_history if entry.get("_ts", 0) > cutoff][-MAX_ROUTING_HISTORY:]
            turn_input = {
                "message": message,
                "historyUserTexts": context.get("history_user_texts", []),
                "prevAssistantText": context.get("prev_assistant_text"),
                "prevAssistantUsage": context.get("prev_assistant_usage"),
                "routingHistory": [
                    {
                        "routeClass": entry.get("route_class"),
                        "finalRouteClass": entry.get("final_route_class"),
                        "finalTier": entry.get("final_tier"),
                        "difficulty": entry.get("difficulty_score", entry.get("difficulty", 0.0)),
                        "margin": entry.get("margin", 0.0),
                        "ageSeconds": clock - entry["_ts"],
                    }
                    for entry in routing_history
                ],
            }
            turn_out: dict = {"routed": bool(spec.get("routed", True)), "input": turn_input}
            if turn_out["routed"]:
                history_list = [dict(entry) for entry in routing_history] or None
                tier, confidence, source, extra = asyncio.run(strategy.classify(
                    message,
                    VALID_TIERS,
                    routing_history=history_list,
                    prev_assistant_text=context.get("prev_assistant_text"),
                    prev_assistant_usage=context.get("prev_assistant_usage"),
                    history_user_texts=context.get("history_user_texts"),
                ))
                if source != "v4_phase3":
                    raise RuntimeError(f"router degraded for {case['id']}: {source}")
                # Re-run the identical request through the core to capture intermediates.
                request = strategy._build_request(
                    message,
                    history_list or [],
                    prev_assistant_text=context.get("prev_assistant_text"),
                    prev_assistant_usage=context.get("prev_assistant_usage"),
                    history_user_texts=context.get("history_user_texts"),
                )
                bundle = core._build_features(request)
                heads = core._run_heads(bundle)
                fused = core._fuse(heads)
                decision = core._postprocess(fused, heads.p_aux_lgbm, request)
                if decision.route_class != extra["route_class"] or not np.allclose(fused, [extra["probabilities"][c] for c in ("R0", "R1", "R2", "R3")], rtol=0, atol=0):
                    raise RuntimeError(f"non-deterministic router output for {case['id']}")
                history_text = make_history_user_text(request.history_user_texts)
                prev_text = request.prev_assistant_text if request.prev_assistant_text else None
                texts = [request.current_user_text or "", history_text or "", prev_text or ""]
                encoded = tokenizer.encode_batch(texts)
                token_ids = [[int(t) for t, m in zip(e.ids, e.attention_mask) if m] for e in encoded]

                routing_extra = dict(extra)
                policy = policy_engine.run(PolicyInputs(
                    decision=RoutingDecision(tier=tier, model=tiers[tier]["model"], confidence=confidence, source=source),
                    message=message,
                    router_cfg=router_cfg,
                    tiers=tiers,
                    valid_tiers=VALID_TIERS,
                    routing_history=history_list,
                    extra=routing_extra,
                    thinking_mode=extra.get("thinking_mode"),
                    prompt_policy=extra.get("prompt_policy"),
                    history_strategy=True,
                    material_estimated_tokens=0,
                    context_window_tokens=200_000,
                    now=clock,
                ))
                turn_out["output"] = {
                    "tokens": {"current": token_ids[0], "history": token_ids[1], "assistant": token_ids[2]},
                    "historyText": history_text,
                    "features": f32_b64(bundle.features_390),
                    "rawBge": f32_b64(bundle.raw_bge_1536),
                    "pMain": floats(heads.p_main_lgbm),
                    "pAux": floats(heads.p_aux_lgbm) if heads.p_aux_lgbm is not None else None,
                    "mlpLogits": floats(heads.logits_mlp),
                    "pMlp": floats(heads.p_mlp_calibrated),
                    "fused": floats(fused),
                    "decision": {
                        "routeClass": decision.route_class,
                        "margin": float(decision.margin),
                        "difficulty": float(decision.difficulty_score),
                        "flags": {key: bool(value) for key, value in decision.flags.items()},
                        "thinkingMode": decision.thinking_mode,
                        "promptPolicy": decision.prompt_policy,
                        "auxDowngradeApplied": bool(decision.aux_downgrade_applied),
                        "stickyApplied": bool(decision.sticky_applied),
                    },
                    "classify": {"tier": tier, "confidence": float(confidence), "promptHint": extra.get("prompt_hint")},
                    "policy": {
                        "tier": policy.decision.tier,
                        "thinkingMode": policy.thinking_mode,
                        "promptPolicy": policy.prompt_policy,
                        "confidenceGateApplied": bool(routing_extra.get("confidence_gate_applied")),
                        "complaintTerms": list(routing_extra.get("complaint_terms") or []),
                        "complaintUpgradeApplied": bool(routing_extra.get("complaint_upgrade_applied")),
                        "antiDowngradeApplied": bool(routing_extra.get("anti_downgrade_applied")),
                        "previousTier": routing_extra.get("previous_tier"),
                        "preConfidenceTier": routing_extra.get("pre_confidence_tier"),
                    },
                }
                # engine/steps/squilla_router.py::_routing_history_entry + _append_routing_history.
                routing_history.append({
                    "turn_index": len(routing_history),
                    "_ts": clock,
                    "text": message,
                    **routing_extra,
                    "base_tier": routing_extra.get("base_tier", policy.decision.tier),
                    "final_tier": routing_extra.get("final_tier", policy.decision.tier),
                    "final_route_class": routing_extra.get("final_route_class"),
                })
                turn_count += 1
            turns_out.append(turn_out)
            transcript.append({"role": "user", "content": message})
            if "assistant" in spec:
                transcript.append({"role": "assistant", "content": spec["assistant"], "usage": spec.get("usage")})
        out_cases.append({"id": case["id"], "turns": turns_out})

    bundle_files = {}
    for entry in json.loads((args.bundle / "artifact_manifest.json").read_text(encoding="utf-8"))["files"]:
        bundle_files[entry["path"]] = entry["sha256"]
    fixture = {
        "schema": 1,
        "generator": {
            "script": "scripts/opensquilla-router/make_reference.py",
            "opensquillaAdapter": "opensquilla.squilla_router.v4_phase3.V4Phase3Strategy (use_aux_head=True)",
            "policy": "opensquilla.engine.routing.policy.RoutingPolicyEngine",
            "python": platform.python_version(),
            "machine": platform.machine(),
            "packages": {name: metadata.version(name) for name in ("numpy", "scikit-learn", "lightgbm", "onnxruntime", "tokenizers", "joblib", "scipy")},
            "bundleSha256": bundle_files,
        },
        "gatewayPolicy": GATEWAY_POLICY_DEFAULTS,
        "turnCount": turn_count,
        "cases": out_cases,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(fixture, ensure_ascii=False, separators=(",", ":"))
    args.out.write_text(text + "\n", encoding="utf-8")
    print(f"wrote {turn_count} routed turns, {len(out_cases)} cases, {len(text)} bytes, sha256 {hashlib.sha256(text.encode()).hexdigest()[:16]}")


if __name__ == "__main__":
    main()
