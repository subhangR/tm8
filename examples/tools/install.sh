#!/usr/bin/env bash
# Install the starter tools this CLI ships into a Space.
#
# A thin wrapper over `tm8 tool starters install`, which reads the starter set
# (TOOL_STARTERS in @tm8/contract, generated from the directories next to this
# script), skips names that already exist in the Space, creates the rest and
# sets each tool's selection header. Every argument is passed through, so
# global options (`--space <id>`, `--format json`) and `--only <name>` work:
#
#   bash examples/tools/install.sh --space <space-id>
#   bash examples/tools/install.sh --only url-check --only space-digest
set -euo pipefail
exec tm8 tool starters install "$@"
