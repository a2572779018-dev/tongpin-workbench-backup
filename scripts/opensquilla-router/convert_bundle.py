# Derived in part from OpenSquilla (https://github.com/TokenRhythm/opensquilla @ d27ba0e, Apache-2.0).
# See THIRD_PARTY_NOTICES.md.
"""Convert OpenSquilla's V4.2 Phase 3 router bundle into a portable runtime bundle.

Input: the upstream directory ``src/opensquilla/squilla_router/models/v4.2_phase3_inference``
at the pinned commit (fetch_bundle.py), whose files are verified against its own
``artifact_manifest.json``.  Output: plain little-endian arrays, JSON and the
two unchanged ONNX graphs, readable without Python, pickle or LightGBM:

  tfidf-vocab.json   TfidfVectorizer.vocabulary_ as a column-ordered list
  tfidf-idf.f64      TfidfTransformer.idf_                        (10000 f64)
  svd-components.f64 TruncatedSVD.components_ row-major           (100x10000 f64)
  bge-pca.f32        PCA.mean_ then PCA.components_ row-major     (512 + 64x512 f32)
  mlp-scaler.f64     StandardScaler.mean_ then .scale_            (1536 + 1536 f64)
  lgbm-main.bin      LightGBM main booster, flattened trees (layout in manifest)
  lgbm-aux.bin       LightGBM aux head booster, same layout
  bge.onnx           bge_onnx/model.onnx, byte-identical
  mlp.onnx           mlp/model.onnx, byte-identical
  tokenizer.json     bge_onnx/tokenizer.json, byte-identical
  manifest.json      provenance, runtime config, layouts and sha256 of every file

The pickles are only ever loaded here, by the same libraries OpenSquilla uses,
from files whose sha256 matches the upstream manifest.  The script finishes by
re-evaluating every converted part in NumPy against the original objects.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import runpy
import shutil
import warnings
from pathlib import Path

import numpy as np
import yaml

UPSTREAM_COMMIT = "d27ba0e7ac452392b7c8e38f2f7f43cd5d6912c6"
UPSTREAM_BUNDLE = "src/opensquilla/squilla_router/models/v4.2_phase3_inference"
FORMAT = "tongpin-opensquilla-router-bundle"
FORMAT_VERSION = 1
# gateway/config.py SquillaRouterConfig defaults consumed by the routing policy.
GATEWAY_POLICY = {
    "default_tier": "c1",
    "confidence_threshold": 0.5,
    "confidence_high_tier_margin": 0.05,
    "kv_cache_anti_downgrade_enabled": True,
    "kv_cache_anti_downgrade_window_seconds": 600,
    "complaint_upgrade_enabled": True,
    "complaint_upgrade_steps": 1,
    "complaint_upgrade_max_chars": 160,
    "routing_history_window_seconds": 1800,
    "max_routing_history": 5,
    "router_history_user_max_turns": 4,
    "router_history_user_max_chars": 8000,
    "router_prev_assistant_max_chars": 8000,
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_upstream(bundle: Path) -> dict[str, str]:
    manifest = json.loads((bundle / "artifact_manifest.json").read_text(encoding="utf-8"))
    hashes = {}
    for entry in manifest["files"]:
        path = bundle / entry["path"]
        actual = sha256(path)
        if actual != entry["sha256"] or path.stat().st_size != entry["size_bytes"]:
            raise SystemExit(f"upstream artifact mismatch: {entry['path']}")
        hashes[entry["path"]] = actual
    return hashes


def parse_lightgbm(path: Path) -> dict:
    """Parse LightGBM's text model format (the file OpenSquilla loads)."""
    header: dict[str, str] = {}
    trees: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line == "end of trees":
            break
        if line.startswith("Tree="):
            current = {}
            trees.append(current)
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        (current if current is not None else header)[key] = value
    if header.get("version") != "v4":
        raise SystemExit(f"unsupported LightGBM model version {header.get('version')}")
    num_class = int(header["num_class"])
    per_iteration = int(header["num_tree_per_iteration"])
    objective = header["objective"].split()[0]
    if objective != "multiclass" or per_iteration != num_class:
        raise SystemExit(f"unsupported objective {header['objective']}")
    split_feature, decision_type, left, right, threshold, leaf_value = [], [], [], [], [], []
    node_offsets, leaf_offsets = [0], [0]
    for tree in trees:
        leaves = int(tree["num_leaves"])
        if int(tree.get("num_cat", "0")) != 0:
            raise SystemExit("categorical splits are not supported")
        if tree.get("is_linear", "0") != "0":
            raise SystemExit("linear trees are not supported")
        values = [float(v) for v in tree["leaf_value"].split()]
        if len(values) != leaves:
            raise SystemExit("leaf count mismatch")
        leaf_value.extend(values)
        if leaves > 1:
            internal = leaves - 1
            features = [int(v) for v in tree["split_feature"].split()]
            decisions = [int(v) for v in tree["decision_type"].split()]
            lefts = [int(v) for v in tree["left_child"].split()]
            rights = [int(v) for v in tree["right_child"].split()]
            thresholds = [float(v) for v in tree["threshold"].split()]
            if not all(len(column) == internal for column in (features, decisions, lefts, rights, thresholds)):
                raise SystemExit("internal node count mismatch")
            for kind in decisions:
                if kind & 1:
                    raise SystemExit("categorical decision found")
            split_feature.extend(features)
            decision_type.extend(decisions)
            left.extend(lefts)
            right.extend(rights)
            threshold.extend(thresholds)
        node_offsets.append(len(split_feature))
        leaf_offsets.append(len(leaf_value))
    return {
        "numClass": num_class,
        "numFeatures": int(header["max_feature_idx"]) + 1,
        "objective": header["objective"],
        "trees": len(trees),
        "arrays": {
            "nodeOffsets": np.asarray(node_offsets, dtype="<u4"),
            "leafOffsets": np.asarray(leaf_offsets, dtype="<u4"),
            "splitFeature": np.asarray(split_feature, dtype="<u2"),
            "decisionType": np.asarray(decision_type, dtype="u1"),
            "leftChild": np.asarray(left, dtype="<i2"),
            "rightChild": np.asarray(right, dtype="<i2"),
            "threshold": np.asarray(threshold, dtype="<f8"),
            "leafValue": np.asarray(leaf_value, dtype="<f8"),
        },
    }


def write_lightgbm(model: dict, out: Path) -> dict:
    sections = {}
    offset = 0
    with out.open("wb") as handle:
        for name, array in model["arrays"].items():
            pad = (-offset) % 8
            handle.write(b"\0" * pad)
            offset += pad
            data = array.tobytes()
            handle.write(data)
            sections[name] = {"offset": offset, "length": int(array.size), "dtype": array.dtype.str.lstrip("<|")}
            offset += len(data)
    return {key: model[key] for key in ("numClass", "numFeatures", "objective", "trees")} | {"sections": sections}


def predict_flat(model: dict, features: np.ndarray) -> np.ndarray:
    """Reference evaluator for the flattened layout (LightGBM NumericalDecision)."""
    a = model["arrays"]
    scores = np.zeros(model["numClass"], dtype=np.float64)
    x = features.astype(np.float64)
    for tree in range(model["trees"]):
        node_base, leaf_base = int(a["nodeOffsets"][tree]), int(a["leafOffsets"][tree])
        if int(a["nodeOffsets"][tree + 1]) == node_base:
            scores[tree % model["numClass"]] += a["leafValue"][leaf_base]
            continue
        node = 0
        while node >= 0:
            index = node_base + node
            value = x[a["splitFeature"][index]]
            kind = int(a["decisionType"][index])
            missing = (kind >> 2) & 3
            if np.isnan(value) and missing != 2:
                value = 0.0
            if (missing == 1 and -1e-35 <= value <= 1e-35) or (missing == 2 and np.isnan(value)):
                node = int(a["leftChild"][index]) if kind & 2 else int(a["rightChild"][index])
            else:
                node = int(a["leftChild"][index]) if value <= a["threshold"][index] else int(a["rightChild"][index])
        scores[tree % model["numClass"]] += a["leafValue"][leaf_base + ~node]
    shifted = np.exp(scores - scores.max())
    return shifted / shifted.sum()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True, type=Path, help="upstream v4.2_phase3_inference directory")
    parser.add_argument("--opensquilla-src", required=True, type=Path, help="OpenSquilla src/ at the pinned commit (routing policy data)")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--fixture", type=Path, help="reference fixture used for the LightGBM round-trip check")
    args = parser.parse_args()
    warnings.filterwarnings("ignore", message=".*Trying to unpickle estimator.*")

    import joblib
    import lightgbm as lgb

    upstream = verify_upstream(args.bundle)
    policy_data = runpy.run_path(str(args.opensquilla_src / "opensquilla" / "engine" / "routing" / "policy_data.py"))
    gateway_policy = GATEWAY_POLICY | {
        "complaint_terms": list(policy_data["COMPLAINT_TERMS"]),
        "thinking_mode_order": dict(policy_data["THINKING_MODE_ORDER"]),
    }
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.iterdir():
        if stale.is_file():
            stale.unlink()

    inference = json.loads((args.bundle / "inference_manifest.json").read_text(encoding="utf-8"))
    version = json.loads((args.bundle / "version.json").read_text(encoding="utf-8"))
    runtime = yaml.safe_load((args.bundle / "router.runtime.yaml").read_text(encoding="utf-8"))

    # TF-IDF / SVD.
    tfidf = joblib.load(args.bundle / "features" / "tfidf.pkl")
    params = tfidf.get_params()
    expected = {"analyzer": "char_wb", "ngram_range": (2, 4), "lowercase": True, "strip_accents": None, "sublinear_tf": True,
                "norm": "l2", "use_idf": True, "binary": False, "preprocessor": None, "tokenizer": None, "stop_words": None}
    for key, value in expected.items():
        if params[key] != value:
            raise SystemExit(f"unexpected TfidfVectorizer.{key}={params[key]!r}")
    vocabulary = [None] * len(tfidf.vocabulary_)
    for term, column in tfidf.vocabulary_.items():
        vocabulary[int(column)] = term
    (out / "tfidf-vocab.json").write_text(json.dumps(vocabulary, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    idf = np.asarray(tfidf.idf_, dtype="<f8")
    (out / "tfidf-idf.f64").write_bytes(idf.tobytes())
    svd = joblib.load(args.bundle / "features" / "svd.pkl")
    components = np.ascontiguousarray(svd.components_, dtype="<f8")
    (out / "svd-components.f64").write_bytes(components.tobytes())

    # BGE PCA (float32 in the artifact; sklearn transforms in float32).
    state = joblib.load(args.bundle / "features" / "bge_pca.joblib")
    pca = state["pca"]
    if pca.whiten or pca.components_.shape != (64, 512):
        raise SystemExit("unexpected PCA state")
    pca_mean = np.asarray(pca.mean_, dtype="<f4")
    pca_components = np.ascontiguousarray(pca.components_, dtype="<f4")
    (out / "bge-pca.f32").write_bytes(pca_mean.tobytes() + pca_components.tobytes())

    # MLP scaler.
    scaler = joblib.load(args.bundle / "mlp" / "scaler.joblib")
    if not (scaler.with_mean and scaler.with_std) or scaler.mean_.shape != (1536,):
        raise SystemExit("unexpected StandardScaler state")
    (out / "mlp-scaler.f64").write_bytes(np.asarray(scaler.mean_, dtype="<f8").tobytes() + np.asarray(scaler.scale_, dtype="<f8").tobytes())

    # LightGBM heads.
    layouts = {}
    parsed = {}
    for name, source in (("lgbm-main.bin", "lgbm_main.bin"), ("lgbm-aux.bin", "lgbm_aux.bin")):
        model = parse_lightgbm(args.bundle / source)
        parsed[name] = model
        layouts[name] = write_lightgbm(model, out / name)

    shutil.copyfile(args.bundle / "bge_onnx" / "model.onnx", out / "bge.onnx")
    shutil.copyfile(args.bundle / "mlp" / "model.onnx", out / "mlp.onnx")
    shutil.copyfile(args.bundle / "bge_onnx" / "tokenizer.json", out / "tokenizer.json")

    # Round-trip checks against the original Python objects.
    rng = np.random.default_rng(20260927)
    sample = ["你好", "Design a multi-tenant SaaS architecture", "只返回JSON", "café ＡＢＣ 𠀀 👍", ""]
    dense = tfidf.transform(sample)
    expected_svd = svd.transform(dense)
    for row, text in enumerate(sample):
        counts: dict[int, int] = {}
        for gram in tfidf.build_analyzer()(text):
            column = tfidf.vocabulary_.get(gram)
            if column is not None:
                counts[int(column)] = counts.get(int(column), 0) + 1
        vector = np.zeros(len(vocabulary))
        for column, count in counts.items():
            vector[column] = (1.0 + np.log(count)) * idf[column]
        norm = np.linalg.norm(vector)
        if norm:
            vector /= norm
        if not np.allclose(vector @ components.T, expected_svd[row], rtol=0, atol=1e-12):
            raise SystemExit(f"TF-IDF/SVD round-trip failed for {text!r}")
    embeddings = rng.standard_normal((4, 512)).astype(np.float32)
    embeddings /= np.linalg.norm(embeddings, axis=1, keepdims=True)
    projected = embeddings @ pca_components.T - pca_mean @ pca_components.T
    if not np.allclose(projected, pca.transform(embeddings), rtol=0, atol=1e-5):
        raise SystemExit("PCA round-trip failed")
    raw = rng.standard_normal((2, 1536)).astype(np.float32)
    scaled = (raw - scaler.mean_.astype(np.float32)) / scaler.scale_.astype(np.float32)
    if not np.array_equal(scaled, scaler.transform(raw.copy())):
        raise SystemExit("StandardScaler round-trip failed")
    lgbm_checks = 0
    if args.fixture:
        import base64
        fixture = json.loads(args.fixture.read_text(encoding="utf-8"))
        main_booster = lgb.Booster(model_file=str(args.bundle / "lgbm_main.bin"))
        aux_booster = lgb.Booster(model_file=str(args.bundle / "lgbm_aux.bin"))
        for case in fixture["cases"]:
            for turn in case["turns"]:
                if not turn["routed"]:
                    continue
                features = np.frombuffer(base64.b64decode(turn["output"]["features"]), dtype="<f4")
                for name, booster in (("lgbm-main.bin", main_booster), ("lgbm-aux.bin", aux_booster)):
                    got = predict_flat(parsed[name], features)
                    want = booster.predict(features[None, :])[0]
                    if not np.allclose(got, want, rtol=0, atol=1e-12):
                        raise SystemExit(f"LightGBM round-trip failed for {case['id']} ({name}): {got} vs {want}")
                lgbm_checks += 1

    files = {}
    for path in sorted(out.iterdir()):
        if path.name != "manifest.json":
            files[path.name] = {"sha256": sha256(path), "bytes": path.stat().st_size}
    manifest = {
        "format": FORMAT,
        "formatVersion": FORMAT_VERSION,
        "router": {
            "name": "OpenSquilla SquillaRouter",
            "version": "v4.2",
            "phase": "phase3",
            "modelVersion": version.get("version"),
            "bgeModel": version.get("bge_model"),
            "license": "Apache-2.0",
            "upstream": "https://github.com/TokenRhythm/opensquilla",
            "upstreamCommit": UPSTREAM_COMMIT,
            "upstreamBundle": UPSTREAM_BUNDLE,
            "upstreamSha256": upstream,
        },
        "inference": {
            "featureDim": inference["feature_dim"],
            "mlpInputDim": inference["mlp_input_dim"],
            "routeClasses": inference["route_classes"],
            "temperature": inference["temperature"],
            "perClassAlpha": inference["per_class_alpha"],
            "tfidfDims": 102,
            "svdComponents": int(components.shape[0]),
            "vocabularySize": len(vocabulary),
            "pcaDim": int(pca_components.shape[0]),
            "embeddingDim": int(pca_components.shape[1]),
            "bgeMaxLength": 510,
            "auxHead": True,
        },
        "runtimeConfig": runtime,
        "gatewayPolicy": gateway_policy,
        "lightgbm": layouts,
        "files": files,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    total = sum(item["bytes"] for item in files.values())
    print(f"wrote {out} ({total} bytes); lightgbm round-trip checks: {lgbm_checks}")


if __name__ == "__main__":
    main()
