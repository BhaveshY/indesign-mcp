"""Syntax-check runtime.jsx inside InDesign's ExtendScript engine (reports line numbers)."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from indesign_mcp import com, server
com.init_thread()
app = com.launch(server.PROGIDS)
js = "var __s = " + json.dumps(server.RUNTIME) + "; var __r; try { new Function(__s); __r = 'syntax ok'; } catch (e) { __r = 'line ' + e.line + ': ' + e.message; } __r"
print(app.call("DoScript", js, server.JS_LANG), "runtime", server.RUNTIME_VERSION)
