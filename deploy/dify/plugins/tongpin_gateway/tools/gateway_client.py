import hashlib
import ipaddress
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def validate_gateway_url(value: str) -> str:
    url = value.strip().rstrip("/")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("gateway_url must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError("gateway_url must not contain credentials or a fragment")
    if parsed.scheme == "http":
        host = parsed.hostname.lower()
        private = host in {"localhost", "host.docker.internal"}
        try:
            private = private or ipaddress.ip_address(host).is_private or ipaddress.ip_address(host).is_loopback
        except ValueError:
            pass
        if not private:
            raise ValueError("plain HTTP is allowed only for local/private development gateways")
    return url


def parse_object(value: str) -> dict[str, Any]:
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError("input_json must be a JSON object")
    return parsed


def parse_asset_ids(value: str) -> list[str]:
    parsed = json.loads(value or "[]")
    if not isinstance(parsed, list) or any(not isinstance(item, str) or not item for item in parsed):
        raise ValueError("source_asset_ids_json must be a JSON string array")
    if len(set(parsed)) != len(parsed):
        raise ValueError("source asset ids must not repeat")
    return parsed


def stable_tool_call_id(binding: dict[str, str], tool_name: str, tool_input: dict[str, Any], asset_ids: list[str]) -> str:
    material = json.dumps(
        {"binding": binding, "toolName": tool_name, "input": tool_input, "sourceAssetIds": asset_ids},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return "dify-" + hashlib.sha256(material).hexdigest()[:48]


def invoke_gateway(url: str, secret: str, payload: dict[str, Any], timeout: float = 60.0) -> dict[str, Any]:
    request = urllib.request.Request(
        validate_gateway_url(url),
        data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Dify-Tool-Secret": secret},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(262145)
            if len(body) > 262144:
                raise RuntimeError("Tongpin gateway response exceeded 256 KiB")
            result = json.loads(body)
            if not isinstance(result, dict):
                raise RuntimeError("Tongpin gateway returned a non-object result")
            return result
    except urllib.error.HTTPError as error:
        body = error.read(8192)
        try:
            detail = json.loads(body)
            code = detail.get("code", "TONGPIN_TOOL_REJECTED") if isinstance(detail, dict) else "TONGPIN_TOOL_REJECTED"
            message = detail.get("message", "Tongpin rejected the tool call") if isinstance(detail, dict) else "Tongpin rejected the tool call"
        except (UnicodeDecodeError, json.JSONDecodeError):
            code, message = "TONGPIN_TOOL_REJECTED", "Tongpin rejected the tool call"
        raise RuntimeError(f"{code}: {message}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError("TONGPIN_TOOL_GATEWAY_UNAVAILABLE: result unknown; do not retry automatically") from error
