#!/usr/bin/env python3
"""Build the Pages site Stash's plugin installer fetches.

The git repo holds the plugin folder. This writes index.yml and a zip of that
folder. Stash downloads the zip and unpacks it.
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
import zipfile
from datetime import datetime
from pathlib import Path

DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
_TOKEN = re.compile(r"[A-Za-z0-9._+-]+")


def yaml_scalar(value: str) -> str:
    if _TOKEN.fullmatch(value):
        return value
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def read_header(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in text.splitlines():
        if not line or line[0] in " \t#":
            continue
        key, sep, value = line.partition(":")
        if not sep:
            continue
        fields[key] = value.strip().strip('"').strip("'")
    return fields


def git(root: Path, args: list[str]) -> str:
    env = os.environ.copy()
    env["TZ"] = "UTC0"
    completed = subprocess.run(
        ["git", *args],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    return completed.stdout.strip()


def stamp(root: Path) -> tuple[str, str]:
    short = git(root, ["log", "-n", "1", "--pretty=format:%h"])
    date = git(root, ["log", "-n", "1", "--date=format-local:%F %T", "--pretty=format:%cd"])
    datetime.strptime(date, DATE_FORMAT)
    return short, date


def zip_plugin(plugin_dir: Path, zip_path: Path) -> str:
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(plugin_dir.rglob("*")):
            if not path.is_file():
                continue
            if "__pycache__" in path.parts or path.suffix in {".pyc", ".pyo"} or path.name == ".DS_Store":
                continue
            if "py_deps" in path.parts:
                continue
            archive.write(path, path.relative_to(plugin_dir).as_posix())
    return hashlib.sha256(zip_path.read_bytes()).hexdigest()


def render_package(manifest: Path, outdir: Path, short: str, date: str) -> str:
    header = read_header(manifest.read_text(encoding="utf-8"))
    package_id = manifest.stem
    sha256 = zip_plugin(manifest.parent, outdir / f"{package_id}.zip")
    version = f"{header.get('version') or '0.0.0'}-{short}"
    return (
        f"- id: {yaml_scalar(package_id)}\n"
        f"  name: {yaml_scalar(header.get('name') or package_id)}\n"
        f"  metadata:\n"
        f"    description: {yaml_scalar(header.get('description') or '')}\n"
        f"  version: {yaml_scalar(version)}\n"
        f"  date: {yaml_scalar(date)}\n"
        f"  path: {yaml_scalar(package_id + '.zip')}\n"
        f"  sha256: {sha256}\n"
    )


def build(root: Path, outdir: Path) -> Path:
    outdir.mkdir(parents=True, exist_ok=True)
    manifest = root / "tag-suggestions" / "tag-suggestions.yml"
    manifests = [manifest] if manifest.is_file() else []
    index = outdir / "index.yml"
    if not manifests:
        index.write_text("[]\n", encoding="utf-8")
        return index
    short, date = stamp(root)
    index.write_text("".join(render_package(manifest, outdir, short, date) for manifest in manifests), encoding="utf-8")
    return index


def main(argv: list[str]) -> None:
    root = Path(__file__).resolve().parent
    outdir = Path(argv[1]) if len(argv) > 1 else root / "_site"
    if not outdir.is_absolute():
        outdir = Path.cwd() / outdir
    index = build(root, outdir)
    print(f"Built {index.parent}")


if __name__ == "__main__":
    main(sys.argv)
