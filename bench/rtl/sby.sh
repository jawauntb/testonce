#!/usr/bin/env bash
# One SymbiYosys proof file as one test: run every task in it from its own directory.
# Pass is sby's exit status (0 only when every task passes).
set -u
cd "$(dirname "$1")" && exec sby -f "$(basename "$1")"
