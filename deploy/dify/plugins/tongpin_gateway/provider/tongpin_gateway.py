from typing import Any

from dify_plugin import ToolProvider
from dify_plugin.errors.tool import ToolProviderCredentialValidationError

from tools.gateway_client import validate_gateway_url


class TongpinGatewayProvider(ToolProvider):
    def _validate_credentials(self, credentials: dict[str, Any]) -> None:
        try:
            validate_gateway_url(str(credentials.get("gateway_url", "")))
            if not str(credentials.get("gateway_secret", "")).strip():
                raise ValueError("gateway_secret is required")
        except ValueError as error:
            raise ToolProviderCredentialValidationError(str(error)) from error
