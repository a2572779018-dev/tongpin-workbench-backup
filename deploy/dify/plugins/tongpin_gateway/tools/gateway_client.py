import hashlib
import ipaddress
import json
import re
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


def parse_request_id(value: Any) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9_-]{16,100}", value) is None:
        raise ValueError("request_id must be an approved Tongpin execution ID")
    return value


def parse_asset_ids(value: str) -> list[str]:
    parsed = json.loads(value)
    if not isinstance(parsed, list) or any(not isinstance(item, str) or not item for item in parsed):
        raise ValueError("source_asset_ids_json must be a JSON string array")
    if len(set(parsed)) != len(parsed):
        raise ValueError("source asset ids must not repeat")
    return parsed


def build_tool_payload(tool_parameters: dict[str, Any]) -> dict[str, Any]:
    binding = {
        "tenantId": str(tool_parameters["tenant_id"]),
        "userId": str(tool_parameters["user_id"]),
        "conversationId": str(tool_parameters["conversation_id"]),
        "runId": str(tool_parameters["run_id"]),
        "attemptId": str(tool_parameters["attempt_id"]),
    }
    request_id = parse_request_id(tool_parameters["request_id"])
    if request_id != binding["attemptId"]:
        raise ValueError("request_id does not match the approved attempt")
    tool_name = str(tool_parameters["tool_name"])
    tool_input = {"requestId": request_id}
    asset_ids = parse_asset_ids(str(tool_parameters["source_asset_ids_json"]))
    return {
        **binding,
        "toolCallId": stable_tool_call_id(binding, tool_name, tool_input, asset_ids),
        "toolName": tool_name,
        "input": tool_input,
        "sourceAssetIds": asset_ids,
        "authorization": str(tool_parameters["authorization"]),
    }


def stable_tool_call_id(binding: dict[str, str], tool_name: str, tool_input: dict[str, Any], asset_ids: list[str]) -> str:
    material = json.dumps(
        {"binding": binding, "toolName": tool_name, "input": tool_input, "sourceAssetIds": asset_ids},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return "dify-" + hashlib.sha256(material).hexdigest()[:48]


def invoke_gateway(url: str, secret: str, payload: dict[str, Any], timeout: float = 60.0) -> dict[str, Any]:
    if secret != secret.strip() or len(secret.encode("utf-8")) < 32:
        raise ValueError("gateway_secret must be at least 32 bytes and contain no surrounding whitespace")
    authorization = payload.get("authorization")
    if not isinstance(authorization, str) or re.fullmatch(r"[a-f0-9]{64}", authorization) is None:
        raise ValueError("authorization must be a per-run Tongpin grant")
    request = urllib.request.Request(
        validate_gateway_url(url),
        data=json.dumps({key: value for key, value in payload.items() if key != "authorization"}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Dify-Tool-Secret": secret, "Authorization": f"Bearer {authorization}"},
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
            if isinstance(detail, dict):
                failure = detail.get("error") if isinstance(detail.get("error"), dict) else detail
                code = failure.get("code", "TONGPIN_TOOL_REJECTED")
                message = failure.get("message", "Tongpin rejected the tool call")
                if not isinstance(code, str) or not isinstance(message, str):
                    code, message = "TONGPIN_TOOL_REJECTED", "Tongpin rejected the tool call"
            else:
                code, message = "TONGPIN_TOOL_REJECTED", "Tongpin rejected the tool call"
        except (UnicodeDecodeError, json.JSONDecodeError):
            code, message = "TONGPIN_TOOL_REJECTED", "Tongpin rejected the tool call"
        raise RuntimeError(f"{code} (HTTP {error.code}): {message}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError("TONGPIN_TOOL_GATEWAY_UNAVAILABLE: result unknown; do not retry automatically") from error
