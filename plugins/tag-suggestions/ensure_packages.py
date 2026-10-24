"""Install this plugin's PyPI dependencies into a local folder.

The official Stash image ships ``pip`` and not ``git``. PythonDepManager
refuses to run without ``git`` even for packages that are not git checkouts,
so the plugin installs ``pydantic``, ``httpx``, and ``pyyaml`` itself.
"""

from __future__ import annotations

import importlib
import os
import subprocess
import sys
from collections.abc import Callable

PACKAGES = ("pydantic>=2.14.1", "httpx>=0.28.1", "pyyaml>=6.0.3")
_SPEC = "\n".join(PACKAGES) + "\n"

Run = Callable[..., subprocess.CompletedProcess[str]]


def ensure_packages(plugin_dir: str, *, run: Run = subprocess.run) -> None:
    """Put the pinned packages on ``sys.path``, installing them on first use."""
    target = os.path.join(os.path.abspath(plugin_dir), "py_deps")
    marker = os.path.join(target, ".spec")
    if _spec_matches(marker):
        _prepend(target)
        return

    os.makedirs(target, exist_ok=True)
    try:
        completed = run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "--no-input",
                "--break-system-packages",
                "--upgrade",
                "--target",
                target,
                *PACKAGES,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "pip is not available. Install the py3-pip package in the Stash image."
        ) from exc

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"Could not install plugin dependencies: {detail}")

    with open(marker, "w", encoding="utf-8") as handle:
        handle.write(_SPEC)
    _prepend(target)
    importlib.invalidate_caches()
    _require_imports()


def _spec_matches(marker: str) -> bool:
    try:
        with open(marker, encoding="utf-8") as handle:
            return handle.read() == _SPEC
    except OSError:
        return False


def _prepend(target: str) -> None:
    if target not in sys.path:
        sys.path.insert(0, target)


def _require_imports() -> None:
    for name in ("pydantic", "httpx", "yaml"):
        try:
            importlib.import_module(name)
        except ImportError as exc:
            raise RuntimeError(
                f"Installed plugin dependencies, but {name} still cannot be imported."
            ) from exc
