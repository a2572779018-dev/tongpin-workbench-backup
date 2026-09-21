import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from tools.gateway_client import invoke_gateway, parse_asset_ids, parse_object, stable_tool_call_id, validate_gateway_url


class GatewayHandler(BaseHTTPRequestHandler):
    requests = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.__class__.requests.append((self.headers.get("X-Dify-Tool-Secret"), json.loads(body)))
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
            result = invoke_gateway(f"http://127.0.0.1:{server.server_port}/invoke", "service-secret", {**binding, "toolCallId": first})
        finally:
            server.shutdown(); server.server_close(); thread.join()
        self.assertEqual(result["output"], {"ok": True})
        self.assertEqual(GatewayHandler.requests[-1][0], "service-secret")

    def test_rejects_unsafe_urls_and_invalid_parameters(self):
        with self.assertRaises(ValueError): validate_gateway_url("http://example.com/invoke")
        self.assertEqual(validate_gateway_url("https://example.com/invoke"), "https://example.com/invoke")
        with self.assertRaises(ValueError): parse_object("[]")
        with self.assertRaises(ValueError): parse_asset_ids('["same","same"]')

    def test_timeout_is_an_explicit_unknown_outcome(self):
        with patch("urllib.request.urlopen", side_effect=TimeoutError("timed out")):
            with self.assertRaisesRegex(RuntimeError, "result unknown; do not retry"):
                invoke_gateway("http://127.0.0.1:4318/internal/ai/dify/tools/invoke", "secret", {})


if __name__ == "__main__":
    unittest.main()
