"""Entry point for MCP clients: python run_server.py (stdio)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from indesign_mcp.server import main  # noqa: E402

main()
