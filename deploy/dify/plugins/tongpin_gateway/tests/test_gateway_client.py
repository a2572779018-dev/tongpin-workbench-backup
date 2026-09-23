import io
import json
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from tools.gateway_client import build_tool_payload, invoke_gateway, parse_asset_ids, parse_request_id, stable_tool_call_id, validate_gateway_url


class GatewayHandler(BaseHTTPRequestHandler):
    requests = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.__class__.requests.append((self.headers.get("X-Dify-Tool-Secret"), self.headers.get("Authorization"), json.loads(body)))
        response = json.dumps({"output": {"ok": True}, "ledger": {"chargedPoints": 0}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, *_args):
        return


class GatewayClientTest(unittest.TestCase):
    def test_stable_id_and_real_local_http_round_trip(self):
        binding = {"tenantId": "tenant-a", "userId": "member", "conversationId": "chat", "runId": "run", "attemptId": "attempt"}
        first = stable_tool_call_id(binding, "lookup", {"b": 2, "a": 1}, ["asset-a"])
        second = stable_tool_call_id(binding, "lookup", {"a": 1, "b": 2}, ["asset-a"])
        self.assertEqual(first, second)
        server = ThreadingHTTPServer(("127.0.0.1", 0), GatewayHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = invoke_gateway(f"http://127.0.0.1:{server.server_port}/invoke", "service-credential-for-local-tests-32-bytes", {**binding, "toolCallId": first, "authorization": "a" * 64})
        finally:
            server.shutdown(); server.server_close(); thread.join()
        self.assertEqual(result["output"], {"ok": True})
        self.assertEqual(GatewayHandler.requests[-1][0], "service-credential-for-local-tests-32-bytes")
        self.assertEqual(GatewayHandler.requests[-1][1], "Bearer " + "a" * 64)
        self.assertNotIn("authorization", GatewayHandler.requests[-1][2])

    def test_rejects_unsafe_urls_and_invalid_parameters(self):
        with self.assertRaises(ValueError): validate_gateway_url("http://example.com/invoke")
        self.assertEqual(validate_gateway_url("https://example.com/invoke"), "https://example.com/invoke")
        self.assertEqual(parse_request_id("approved-request-123456"), "approved-request-123456")
        with self.assertRaises(ValueError): parse_request_id("model-picked")
        with self.assertRaises(ValueError): parse_request_id(1234567890123456)
        with self.assertRaises(ValueError): parse_asset_ids('["same","same"]')
        with self.assertRaises(ValueError): parse_asset_ids("")
        with self.assertRaisesRegex(ValueError, "per-run Tongpin grant"):
            invoke_gateway("http://127.0.0.1:4318/api/dify/tools/invoke", "service-credential-for-local-tests-32-bytes", {"authorization": "not-a-grant"})
        with self.assertRaisesRegex(ValueError, "gateway_secret"):
            invoke_gateway("http://127.0.0.1:4318/api/dify/tools/invoke", "weak", {"authorization": "a" * 64})

    def test_timeout_is_an_explicit_unknown_outcome(self):
        with patch("urllib.request.urlopen", side_effect=TimeoutError("timed out")):
            with self.assertRaisesRegex(RuntimeError, "result unknown; do not retry"):
                invoke_gateway("http://127.0.0.1:4318/api/dify/tools/invoke", "service-credential-for-local-tests-32-bytes", {"authorization": "a" * 64})

    def test_plugin_payload_uses_only_bound_request_and_asset_parameters(self):
        parameters = {
            "tenant_id": "tenant-a", "user_id": "member-a", "conversation_id": "conversation-a",
            "run_id": "run-a", "attempt_id": "approved-request-123456", "request_id": "approved-request-123456",
            "source_asset_ids_json": '["asset-a"]', "authorization": "a" * 64,
            "tool_name": "video.submit", "input_json": '{"requestId":"model-chosen-request"}',
        }
        payload = build_tool_payload(parameters)
        self.assertEqual(payload["input"], {"requestId": "approved-request-123456"})
        self.assertEqual(payload["sourceAssetIds"], ["asset-a"])
        self.assertEqual(payload["authorization"], "a" * 64)
        self.assertTrue(payload["toolCallId"].startswith("dify-"))
        with self.assertRaisesRegex(ValueError, "approved attempt"):
            build_tool_payload({**parameters, "request_id": "another-request-123456"})
        with self.assertRaises(KeyError):
            build_tool_payload({key: value for key, value in parameters.items() if key != "source_asset_ids_json"})

    def test_preserves_nested_tongpin_auth_error_code_and_http_status(self):
        for status, code in [(401, "DIFY_TOOL_AUTH_INVALID"), (403, "DIFY_TOOL_AUTH_EXPIRED")]:
            body = json.dumps({"error": {"code": code, "message": "授权不可用"}}).encode()
            error = urllib.error.HTTPError("http://127.0.0.1/invoke", status, "failure", {}, io.BytesIO(body))
            with patch("urllib.request.urlopen", side_effect=error):
                with self.assertRaisesRegex(RuntimeError, f"{code} \\(HTTP {status}\\): 授权不可用"):
                    invoke_gateway("http://127.0.0.1:4318/api/dify/tools/invoke", "service-credential-for-local-tests-32-bytes", {"authorization": "a" * 64})


if __name__ == "__main__":
    unittest.main()
