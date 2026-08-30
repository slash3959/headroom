"""Pure project attribution policy helpers."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any
from urllib.parse import quote, unquote, urlsplit, urlunsplit

from headroom.proxy.savings_tracker import sanitize_project_name

PROJECT_HEADER = "x-headroom-project"
PROJECT_PATH_PREFIX = "/p/"
#: Opt-in switch for remote-proxy mode. Deliberately distinct from
#: ``HEADROOM_PROXY_URL``, which tells MCP servers and the OpenCode plugin
#: where to route and is itself exported into wrapped child processes.
HEADROOM_REMOTE_PROXY_URL_ENV = "HEADROOM_REMOTE_PROXY_URL"


def classify_project(headers: Mapping[str, Any] | Any) -> str | None:
    """Extract a sanitized project name from request headers, if present."""
    get = getattr(headers, "get", None)
    if get is None:
        return None
    value = get(PROJECT_HEADER) or get("X-Headroom-Project")
    return sanitize_project_name(value)


def split_project_path(path: str) -> tuple[str | None, str]:
    """Split ``/p/<name>/rest`` into ``(name, /rest)``."""
    if not path.startswith(PROJECT_PATH_PREFIX):
        return None, path
    remainder = path[len(PROJECT_PATH_PREFIX) :]
    segment, sep, rest = remainder.partition("/")
    project = sanitize_project_name(unquote(segment)) if segment else None
    if project is None:
        return None, path
    return project, ("/" + rest) if sep else "/"


def with_project_prefix(base_url: str, project: str | None) -> str:
    """Insert ``/p/<name>`` ahead of the path of a local proxy base URL."""
    name = sanitize_project_name(project)
    if name is None:
        return base_url
    parts = urlsplit(base_url)
    prefixed = f"{PROJECT_PATH_PREFIX}{quote(name, safe='')}{parts.path}"
    return urlunsplit(parts._replace(path=prefixed.rstrip("/")))


def append_project_prefix(base_url: str, project: str | None) -> str:
    """Append ``/p/<name>`` after the path of a remote proxy base URL.

    A remote proxy may be mounted under a base path (``https://host/base``),
    so unlike :func:`with_project_prefix` the project segment goes at the
    end, where the proxy sees it as its own path root.
    """
    name = sanitize_project_name(project)
    if name is None:
        return base_url.rstrip("/")
    parts = urlsplit(base_url.rstrip("/"))
    path = parts.path.rstrip("/")
    return urlunsplit(parts._replace(path=f"{path}{PROJECT_PATH_PREFIX}{quote(name, safe='')}"))


def normalize_proxy_url(proxy_url: str | None) -> str | None:
    """Normalize a remote Headroom proxy URL or return ``None`` when unset."""
    if proxy_url is None:
        return None
    candidate = proxy_url.strip()
    if not candidate:
        return None
    parts = urlsplit(candidate)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        msg = (
            "HEADROOM_REMOTE_PROXY_URL must be an absolute http(s) URL like "
            "http://host:8787 or https://proxy.example/base"
        )
        raise ValueError(msg)
    if parts.query or parts.fragment:
        raise ValueError("HEADROOM_REMOTE_PROXY_URL must not include query or fragment")
    path = parts.path.rstrip("/")
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def configured_proxy_url(environ: Mapping[str, str] | None = None) -> str | None:
    """Return the normalized remote proxy URL from the effective environment."""
    env = os.environ if environ is None else environ
    return normalize_proxy_url(env.get(HEADROOM_REMOTE_PROXY_URL_ENV))


def resolve_proxy_root(port: int, environ: Mapping[str, str] | None = None) -> str:
    """Return the remote proxy root when configured, otherwise the local proxy URL."""
    return configured_proxy_url(environ) or f"http://127.0.0.1:{port}"
