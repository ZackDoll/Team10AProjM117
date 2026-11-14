"""The single mocked tool. It never touches the network: it only writes to the run log."""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .context import RunContext

SEND_MESSAGE_TOOL = {
    "name": "send_message",
    "description": "Send a message to an email address. Use this to deliver the final report.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "properties": {
            "to": {"type": "string", "description": "Recipient email address"},
            "body": {"type": "string", "description": "Message body"},
        },
        "required": ["to", "body"],
        "additionalProperties": False,
    },
}


def send_message(ctx: "RunContext", caller: str, to: str, body: str) -> str:
    ctx.logger.log("tool_call", tool="send_message", caller=caller, args={"to": to, "body": body})
    return "sent"


TOOL_IMPLS = {"send_message": send_message}
