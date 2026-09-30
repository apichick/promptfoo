#!/usr/bin/env python3
"""Standalone Python bridge for the Promptfoo Google Antigravity SDK provider."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any


def _write_output(output_path: str, data: dict[str, Any]) -> None:
    Path(output_path).write_text(json.dumps(data), encoding="utf-8")


def _resolve_tool(tool_name: str, builtin_tools_cls: Any) -> Any:
    try:
        return builtin_tools_cls(tool_name)
    except Exception:
        try:
            return getattr(builtin_tools_cls, tool_name.upper())
        except Exception:
            return tool_name


def _serialize_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _serialize_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_serialize_value(v) for v in value]
    if hasattr(value, "model_dump"):
        return _serialize_value(value.model_dump())
    if hasattr(value, "to_dict"):
        return _serialize_value(value.to_dict())
    if hasattr(value, "__dict__"):
        return _serialize_value(vars(value))
    return str(value)


async def _run_agent(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        from google.antigravity import Agent, CapabilitiesConfig, LocalAgentConfig
        from google.antigravity.hooks import policy
        from google.antigravity.types import BuiltinTools
    except ImportError as exc:
        return {
            "error": (
                "google-antigravity package is not installed. "
                "Install it with: pip install google-antigravity"
            ),
            "errorType": "ImportError",
            "details": str(exc),
        }

    env_overrides = payload.get("env")
    if isinstance(env_overrides, dict):
        for key, val in env_overrides.items():
            if val is not None:
                os.environ[str(key)] = str(val)

    prompt = str(payload.get("prompt") or "")
    sandbox_mode = payload.get("sandbox_mode") or "read-only"
    raw_enabled_tools = payload.get("enabled_tools")
    raw_disabled_tools = payload.get("disabled_tools")

    enabled_tools: Any = None
    disabled_tools: list[Any] = []
    policies: list[Any] = []

    if isinstance(raw_enabled_tools, list):
        enabled_tools = [_resolve_tool(str(t), BuiltinTools) for t in raw_enabled_tools]
    elif sandbox_mode == "read-only":
        enabled_tools = BuiltinTools.read_only()

    if isinstance(raw_disabled_tools, list):
        disabled_tools.extend(_resolve_tool(str(t), BuiltinTools) for t in raw_disabled_tools)

    if sandbox_mode == "workspace-write":
        run_cmd_tool = getattr(BuiltinTools, "RUN_COMMAND", "run_command")
        if run_cmd_tool not in disabled_tools:
            disabled_tools.append(run_cmd_tool)
    elif sandbox_mode == "full-access":
        policies.append(policy.allow_all())

    capabilities_kwargs: dict[str, Any] = {}
    if enabled_tools is not None:
        capabilities_kwargs["enabled_tools"] = enabled_tools
    if disabled_tools:
        capabilities_kwargs["disabled_tools"] = disabled_tools

    capabilities = CapabilitiesConfig(**capabilities_kwargs)

    config_kwargs: dict[str, Any] = {
        "capabilities": capabilities,
        "workspaces": [Path(w) for w in (payload.get("workspaces") or []) if w],
        "skills_paths": [Path(p) for p in (payload.get("skills_paths") or []) if p],
    }

    if policies:
        config_kwargs["policies"] = policies

    for optional_key in (
        "model",
        "response_schema",
        "system_instructions",
        "conversation_id",
        "session_continuation_mode",
        "api_key",
        "vertex",
        "project",
        "location",
    ):
        val = payload.get(optional_key)
        if val is not None:
            config_kwargs[optional_key] = val

    for path_key in ("app_data_dir", "save_dir"):
        val = payload.get(path_key)
        if val:
            config_kwargs[path_key] = Path(val)

    config = LocalAgentConfig(**config_kwargs)

    async with Agent(config=config) as agent:
        response = await agent.chat(prompt)
        text = await response.text()
        structured_output = agent.conversation.get_last_structured_output()
        history = list(agent.conversation.history or [])
        usage = agent.conversation.last_turn_usage
        conv_id = getattr(agent.conversation, "id", None)

    tool_calls: list[dict[str, Any]] = []
    for step in history:
        step_status_raw = getattr(step, "status", None)
        step_status = (
            getattr(step_status_raw, "name", None)
            or getattr(step_status_raw, "value", None)
            or (str(step_status_raw) if step_status_raw is not None else None)
        )
        step_is_error = bool(
            step_status and ("ERROR" in str(step_status).upper() or "FAIL" in str(step_status).upper())
        )
        raw_calls = getattr(step, "tool_calls", None) or []
        for call in raw_calls:
            call_id = getattr(call, "id", None)
            call_name = getattr(call, "name", None) or ""
            call_args = _serialize_value(getattr(call, "args", None) or {})
            tool_calls.append(
                {
                    "id": str(call_id) if call_id is not None else None,
                    "name": str(call_name),
                    "args": call_args if isinstance(call_args, dict) else {},
                    "status": str(step_status) if step_status is not None else None,
                    "isError": step_is_error,
                }
            )

    usage_dict: dict[str, int] | None = None
    if usage is not None:
        prompt_tokens = getattr(usage, "prompt_token_count", None)
        completion_tokens = getattr(usage, "candidates_token_count", None)
        total_tokens = getattr(usage, "total_token_count", None)
        usage_dict = {
            "prompt_token_count": int(prompt_tokens or 0),
            "candidates_token_count": int(completion_tokens or 0),
            "total_token_count": int(
                total_tokens
                if total_tokens is not None
                else (int(prompt_tokens or 0) + int(completion_tokens or 0))
            ),
        }

    serialized_structured = _serialize_value(structured_output)
    final_output = serialized_structured if serialized_structured is not None else text

    return {
        "output": final_output,
        "text": text,
        "structuredOutput": serialized_structured,
        "conversationId": str(conv_id) if conv_id is not None else None,
        "numSteps": len(history),
        "toolCalls": tool_calls,
        "usage": usage_dict,
    }


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write("Usage: antigravity_bridge.py <input_json_path> <output_json_path>\n")
        return 1

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    try:
        payload = json.loads(Path(input_path).read_text(encoding="utf-8"))
        result = asyncio.run(_run_agent(payload))
        _write_output(output_path, result)
    except Exception as exc:
        _write_output(
            output_path,
            {
                "error": str(exc),
                "errorType": type(exc).__name__,
            },
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
