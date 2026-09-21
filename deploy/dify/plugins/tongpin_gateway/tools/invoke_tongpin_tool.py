from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from tools.gateway_client import invoke_gateway, parse_asset_ids, parse_object, stable_tool_call_id


class InvokeTongpinTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        try:
            binding = {
                "tenantId": str(tool_parameters["tenant_id"]),
                "userId": str(tool_parameters["user_id"]),
                "conversationId": str(tool_parameters["conversation_id"]),
                "runId": str(tool_parameters["run_id"]),
                "attemptId": str(tool_parameters["attempt_id"]),
            }
            tool_name = str(tool_parameters["tool_name"])
            tool_input = parse_object(str(tool_parameters["input_json"]))
            asset_ids = parse_asset_ids(str(tool_parameters.get("source_asset_ids_json", "[]")))
            payload = {
                **binding,
                "toolCallId": stable_tool_call_id(binding, tool_name, tool_input, asset_ids),
                "toolName": tool_name,
                "input": tool_input,
                "sourceAssetIds": asset_ids,
                "authorization": str(tool_parameters["authorization"]),
            }
            result = invoke_gateway(
                str(self.runtime.credentials["gateway_url"]),
                str(self.runtime.credentials["gateway_secret"]),
                payload,
            )
            yield self.create_json_message(result)
        except (KeyError, TypeError, ValueError, RuntimeError) as error:
            yield self.create_json_message({"success": False, "error": str(error)})
