#!/usr/bin/env python3
"""Stash raw-interface entry point for Tag Suggestions."""

from __future__ import annotations

import os
import sys

_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from ensure_packages import ensure_packages

ensure_packages(_PLUGIN_DIR)

from decision_tagger.stash_plugin import plugin_main

if __name__ == "__main__":
    plugin_main()
