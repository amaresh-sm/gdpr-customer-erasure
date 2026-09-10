"""Run one OpenHands SDK conversation and emit benchmark-safe JSON events."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from pydantic import SecretStr

from openhands.sdk import Agent, Conversation, Event, LLM, LLMConvertibleEvent
from openhands.sdk.tool import Tool
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.terminal import TerminalTool


HACKERRANK_GATEWAY_BASE_URL = "https://gateway-central.ai.private.hackerrank.link/v1"


def _portable_gateway_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove optional chat fields rejected by the internal portable route."""
    return [
        {key: value for key, value in message.items() if key not in {"name", "refusal"}}
        for message in messages
    ]


def _without_gemini_prompt_cache_key(llm: LLM, kwargs: dict[str, Any]) -> dict[str, Any]:
    """Prevent OpenHands' cache-control field from reaching Gemini gateways."""
    if "gemini" not in str(getattr(llm, "model", "")).lower():
        return kwargs

    sanitized = dict(kwargs)
    sanitized.pop("prompt_cache_key", None)
    extra_body = sanitized.get("extra_body")
    if isinstance(extra_body, dict) and "prompt_cache_key" in extra_body:
        sanitized["extra_body"] = {
            key: value for key, value in extra_body.items() if key != "prompt_cache_key"
        }
    return sanitized


def _install_portable_gateway_compatibility(base_url: str) -> None:
    """Adapt OpenHands chat history for the HackerRank OpenAI-compatible gateway."""
    if "gateway-central.ai.private.hackerrank.link" not in base_url:
        return

    original_transport_call = LLM._transport_call
    original_async_transport_call = LLM._atransport_call
    if getattr(original_transport_call, "_astra_gateway_compatible", False):
        return

    def transport_call(self: LLM, *, messages: list[dict[str, Any]], **kwargs: Any):
        kwargs = _without_gemini_prompt_cache_key(self, kwargs)
        return original_transport_call(
            self,
            messages=_portable_gateway_messages(messages),
            **kwargs,
        )

    async def async_transport_call(
        self: LLM, *, messages: list[dict[str, Any]], **kwargs: Any
    ):
        kwargs = _without_gemini_prompt_cache_key(self, kwargs)
        return await original_async_transport_call(
            self,
            messages=_portable_gateway_messages(messages),
            **kwargs,
        )

    transport_call._astra_gateway_compatible = True
    async_transport_call._astra_gateway_compatible = True
    LLM._transport_call = transport_call
    LLM._atransport_call = async_transport_call


def _json_value(value: Any) -> Any:
    """Convert SDK/Pydantic values into JSON-safe primitives."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return str(value)


def _event_record(event: Event) -> dict[str, Any]:
    """Emit only event metadata needed for trajectory/tool telemetry."""
    record: dict[str, Any] = {
        "type": "openhands_event",
        "event_type": event.__class__.__name__,
        "source": _json_value(getattr(event, "source", None)),
        "timestamp": _json_value(getattr(event, "timestamp", None)),
    }
    tool_name = getattr(event, "tool_name", None)
    if tool_name:
        record["tool_name"] = str(tool_name)
    tool_call = getattr(event, "tool_call", None)
    if tool_call is not None and getattr(tool_call, "name", None):
        record["tool_name"] = str(tool_call.name)
    return record


def _metric_value(metrics: Any, name: str) -> int | float | None:
    value = getattr(metrics, name, None)
    if value is None:
        usage = getattr(metrics, "accumulated_token_usage", None)
        value = getattr(usage, name, None) if usage is not None else None
    return value if isinstance(value, (int, float)) else None


def _emit_metrics(llm: LLM, model: str, reasoning: str) -> None:
    metrics = llm.metrics
    usage = getattr(metrics, "accumulated_token_usage", None)
    print(json.dumps({
        "type": "astra_openhands_metrics",
        "model": model,
        "reasoning": reasoning,
        "input_tokens": _metric_value(usage or metrics, "prompt_tokens"),
        "output_tokens": _metric_value(usage or metrics, "completion_tokens"),
        "cache_read_input_tokens": _metric_value(usage or metrics, "cache_read_tokens"),
        "cache_creation_input_tokens": _metric_value(usage or metrics, "cache_write_tokens"),
        "reasoning_tokens": _metric_value(usage or metrics, "reasoning_tokens"),
        "cost_usd": getattr(metrics, "accumulated_cost", None),
    }, separators=(",", ":")), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run an OpenHands SDK task")
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--instruction", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--reasoning", choices=("low", "medium", "high", "xhigh", "ultra", "max"), default="medium")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.workspace.is_dir():
        print(f"workspace does not exist: {args.workspace}", file=sys.stderr)
        return 2
    try:
        instruction = args.instruction.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"cannot read instruction: {exc}", file=sys.stderr)
        return 2
    # Accept the standardized OpenHands variables and the existing HackerRank
    # AI Kit/Astra CLI credentials without copying a secret into another file.
    api_key = os.getenv("LLM_API_KEY") or os.getenv("ASTRA_GATEWAY_API_KEY")
    if not api_key:
        print("LLM_API_KEY or ASTRA_GATEWAY_API_KEY is required", file=sys.stderr)
        return 2
    # Keep the shared launcher vocabulary while mapping stronger Codex-style levels to the
    # highest OpenHands reasoning level supported by the gateway.
    reasoning_effort = args.reasoning if args.reasoning in {"low", "medium", "high"} else "high"
    base_url = os.getenv("LLM_BASE_URL") or os.getenv("ASTRA_GATEWAY_BASE_URL") or HACKERRANK_GATEWAY_BASE_URL
    model = args.model if "/" in args.model else f"openai/{args.model}"
    llm = LLM(
        usage_id="agent",
        model=model,
        api_key=SecretStr(api_key),
        base_url=base_url,
        force_string_serializer=True,
        reasoning_effort=reasoning_effort,
    )
    _install_portable_gateway_compatibility(base_url)

    def callback(event: Event) -> None:
        if isinstance(event, LLMConvertibleEvent) or getattr(event, "tool_name", None):
            print(json.dumps(_event_record(event), separators=(",", ":")), flush=True)

    agent = Agent(llm=llm, tools=[Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)])
    conversation = Conversation(agent=agent, callbacks=[callback], workspace=str(args.workspace))
    try:
        conversation.send_message(instruction)
        conversation.run()
        _emit_metrics(llm, model, args.reasoning)
    except Exception as exc:  # noqa: BLE001 - preserve provider diagnostics in stderr
        print(f"OpenHands task failed: {exc}", file=sys.stderr)
        try:
            _emit_metrics(llm, model, args.reasoning)
        except Exception:
            pass
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
