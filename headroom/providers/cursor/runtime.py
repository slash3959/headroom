"""Runtime helpers for Cursor integrations."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from headroom.providers.claude import proxy_base_url as claude_proxy_base_url
from headroom.providers.codex import proxy_base_url as codex_proxy_base_url


@dataclass(frozen=True)
class CursorProxyTargets:
    """Resolved local proxy targets shown in Cursor setup instructions."""

    openai_base_url: str
    anthropic_base_url: str


def build_proxy_targets(
    port: int,
    project: str | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> CursorProxyTargets:
    """Build the proxy URLs shown to Cursor users.

    ``project`` (the wrap launch directory) is encoded as a ``/p/<name>``
    base-URL prefix because Cursor cannot send custom headers; the proxy
    strips it and attributes savings per project.
    """
    return CursorProxyTargets(
        openai_base_url=codex_proxy_base_url(port, project, environ=environ),
        anthropic_base_url=claude_proxy_base_url(port, project, environ=environ),
    )


def render_setup_lines(
    port: int,
    project: str | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> list[str]:
    """Render the Cursor setup instructions for the proxy."""
    targets = build_proxy_targets(port, project, environ=environ)
    lines = [
        "  Headroom proxy is running. Configure Cursor:",
        "",
        "  For OpenAI models:",
        f"    Base URL:  {targets.openai_base_url}",
        "    API Key:   your-openai-api-key",
        "",
        "  For Anthropic models:",
        f"    Base URL:  {targets.anthropic_base_url}",
        "    API Key:   your-anthropic-api-key",
        "",
        "  In Cursor:",
        "    Settings > Models > OpenAI API Key > Override OpenAI Base URL",
        f"    Set to: {targets.openai_base_url}",
    ]
    if project:
        lines += [
            "",
            f"  Dashboard savings will be attributed to project '{project}'",
            "  (the directory this command was run from). Re-run from another",
            "  project directory to get that project's URL.",
        ]
    return lines
