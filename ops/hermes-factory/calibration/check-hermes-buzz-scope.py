"""Fail unless the pinned pipeline-factory Buzz profile is narrowly scoped."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from hermes_cli.config import load_config, read_user_config_raw
from hermes_cli.plugins import discover_plugins
from hermes_cli.tools_config import _get_platform_tools
from model_tools import get_tool_definitions


def fail(message: str) -> None:
    print(f"Hermes Buzz scope check failed: {message}", file=sys.stderr)
    raise SystemExit(1)


raw = read_user_config_raw()
model = raw.get("model") or {}
if model.get("provider") != "xai-oauth" or model.get("default") != "grok-4.5":
    fail("the model must be xai-oauth/grok-4.5")
if raw.get("fallback_providers") != [] or "fallback_model" in raw:
    fail("the Grok fallback chain must be empty")

configured = ((raw.get("platform_toolsets") or {}).get("buzz") or [])
if configured != ["terminal", "no_mcp"]:
    fail("platform_toolsets.buzz must be exactly [terminal, no_mcp]")
if raw.get("toolsets"):
    fail("the profile must not configure a global toolset")

skills = raw.get("skills") or {}
if skills.get("inline_shell") is not False or skills.get("write_approval") is not True:
    fail("skills.inline_shell must be false and skills.write_approval must be true")
if (raw.get("curator") or {}).get("enabled") is not False:
    fail("curator.enabled must be false")
if (raw.get("security") or {}).get("redact_secrets") is not True:
    fail("security.redact_secrets must be true")

platform = (((raw.get("gateway") or {}).get("platforms") or {}).get("buzz") or {})
if platform.get("enabled") is not True:
    fail("the native Buzz platform must be enabled")
extra = platform.get("extra") or {}
allowed_users = set(extra.get("allowed_users") or [])
dm_admins = set(extra.get("allow_admin_from") or [])
group_admins = set(extra.get("group_allow_admin_from") or [])
if len(allowed_users) != 1 or len(dm_admins) != 1 or dm_admins != group_admins:
    fail("Buzz must have one operator and one common non-caller slash admin")
if not all(re.fullmatch(r"[a-f0-9]{64}", value) for value in allowed_users | dm_admins):
    fail("Buzz operator and admin identities must be lowercase 64-hex keys")
if allowed_users & (dm_admins | group_admins):
    fail("an allowed operator must not be a slash-command admin")
for key in ("user_allowed_commands", "group_user_allowed_commands"):
    if extra.get(key) != ["status"]:
        fail(f"{key} must contain only status")
if extra.get("require_mention") is not True or extra.get("allow_all_users") is not False:
    fail("Buzz must require a mention and disable allow_all_users")
channels = extra.get("channels") or []
if len(channels) != 1 or channels[0] != extra.get("home_channel"):
    fail("Buzz must use one allowlisted private channel as its home channel")
if extra.get("transport") != "websocket":
    fail("Buzz must use websocket transport with no polling fallback")
if not str(extra.get("relay_url") or "").startswith("https://"):
    fail("Buzz relay_url must use HTTPS")
if extra.get("cli_path") != "/home/mcomardo/.local/opt/buzz-v0.5.2/bin/buzz":
    fail("Buzz cli_path must select the pinned v0.5.2 install")
credentials_file = Path(str(extra.get("credentials_file") or ""))
if credentials_file != Path("/home/mcomardo/.hermes/profiles/pipeline-factory/buzz-credentials.json"):
    fail("Buzz must use the dedicated profile credential file")

discover_plugins()
config = load_config()
effective_toolsets = sorted(_get_platform_tools(config, "buzz"))
if effective_toolsets != ["terminal"]:
    fail(f"effective Buzz toolsets are {effective_toolsets!r}, expected ['terminal']")

definitions = get_tool_definitions(
    enabled_toolsets=effective_toolsets,
    disabled_toolsets=(config.get("agent") or {}).get("disabled_toolsets") or None,
    quiet_mode=True,
    skip_tool_search_assembly=True,
)
tool_names = sorted(item["function"]["name"] for item in definitions)
if tool_names != ["process", "terminal"]:
    fail(f"effective Buzz tools are {tool_names!r}, expected ['process', 'terminal']")

print(
    json.dumps(
        {
            "schema_version": 1,
            "platform": "buzz",
            "toolsets": effective_toolsets,
            "tools": tool_names,
            "mutating_slash_commands": "denied",
            "curator": "disabled",
        },
        sort_keys=True,
    )
)
