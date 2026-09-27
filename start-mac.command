#!/bin/bash
# Double-click on macOS (or run ./start-mac.command on macOS/Linux) to start Arena Touch.
cd "$(dirname "$0")"
python3 server.py "$@"
