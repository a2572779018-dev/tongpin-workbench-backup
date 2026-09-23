from typing import Any

from dify_plugin import ToolProvider
from dify_plugin.errors.tool import ToolProviderCredentialValidationError

from tools.gateway_client import validate_gateway_url


class TongpinGatewayProvider(ToolProvider):
    def _validate_credentials(self, credentials: dict[str, Any]) -> None:
        try:
            validate_gateway_url(str(credentials.get("gateway_url", "")))
            secret = str(credentials.get("gateway_secret", ""))
            if secret != secret.strip() or len(secret.encode("utf-8")) < 32:
                raise ValueError("gateway_secret must be at least 32 bytes and contain no surrounding whitespace")
        except ValueError as error:
            raise ToolProviderCredentialValidationError(str(error)) from error
