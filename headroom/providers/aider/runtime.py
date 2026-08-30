"""Runtime helpers for Aider integrations."""

from __future__ import annotations

import os
from collections.abc import Mapping

from headroom.providers.claude import proxy_base_url as claude_proxy_base_url
from headroom.providers.codex import proxy_base_url as codex_proxy_base_url


def build_launch_env(
    port: int,
    environ: Mapping[str, str] | None = None,
    project: str | None = None,
) -> tuple[dict[str, str], list[str]]:
    """Build environment variables for Aider through a local or remote proxy.

    ``project`` (the wrap launch directory) is encoded as a ``/p/<name>``
    base-URL prefix because aider cannot send custom headers; the proxy
    strips it and attributes savings per project.
    """
    env = dict(environ or os.environ)
    openai_base_url = codex_proxy_base_url(port, project, environ=env)
    anthropic_base_url = claude_proxy_base_url(port, project, environ=env)
    env["OPENAI_API_BASE"] = openai_base_url
    env["ANTHROPIC_BASE_URL"] = anthropic_base_url
    return env, [
        f"OPENAI_API_BASE={openai_base_url}",
        f"ANTHROPIC_BASE_URL={anthropic_base_url}",
    ]
