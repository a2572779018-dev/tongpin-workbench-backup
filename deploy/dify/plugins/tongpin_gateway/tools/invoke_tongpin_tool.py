from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from tools.gateway_client import build_tool_payload, invoke_gateway


class InvokeTongpinTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        try:
            payload = build_tool_payload(tool_parameters)
            result = invoke_gateway(
                str(self.runtime.credentials["gateway_url"]),
                str(self.runtime.credentials["gateway_secret"]),
                payload,
            )
            yield self.create_json_message(result)
        except (KeyError, TypeError, ValueError, RuntimeError) as error:
            yield self.create_json_message({"success": False, "error": str(error)})
