"""InDesign MCP server: stdio JSON-RPC, stdlib only, talks to InDesign over COM (DoScript)."""
import base64
import hashlib
import json
import os
import queue
import sys
import tempfile
import threading
import time
import uuid

from . import com
from .tools import TOOLS, INSTRUCTIONS

__version__ = "1.1.0"
PROGIDS = [p for p in os.environ.get("INDESIGN_PROGID", "").split(";") if p] + [
    "InDesign.Application.2026", "InDesign.Application.2025", "InDesign.Application.2024", "InDesign.Application.2023",
    "InDesign.Application.CS6", "InDesign.Application"]
JS_LANG = 1246973031          # ScriptLanguage.JAVASCRIPT
UNDO_ENTIRE = 1699963733      # UndoModes.ENTIRE_SCRIPT
TIMEOUT = float(os.environ.get("INDESIGN_MCP_TIMEOUT", "180"))
BATCH_TIMEOUT = float(os.environ.get("INDESIGN_MCP_BATCH_TIMEOUT", "1800"))
_SRC = open(os.path.join(os.path.dirname(__file__), "runtime.jsx"), encoding="utf-8").read()
RUNTIME_VERSION = hashlib.sha1(_SRC.encode("utf-8")).hexdigest()[:12]
RUNTIME = _SRC.replace("%VERSION%", RUNTIME_VERSION)
# The runtime lives in a persistent ExtendScript engine: it is parsed once, then each call is a ~1 ms stub.
ENGINE = '#targetengine "indesign_mcp"\n'
RELOAD = "__idmcp_reload__"
PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]


def indesign_running():
    """True if an InDesign.exe process exists (avoids COM silently launching InDesign)."""
    import ctypes
    from ctypes import wintypes

    class PE(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", ctypes.c_wchar * 260)]
    k = ctypes.WinDLL("kernel32")
    k.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    k.Process32FirstW.argtypes = k.Process32NextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(PE)]
    k.CloseHandle.argtypes = [ctypes.c_void_p]
    snap = k.CreateToolhelp32Snapshot(2, 0)
    try:
        e = PE(); e.dwSize = ctypes.sizeof(PE)
        ok = k.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            if e.szExeFile.lower() == "indesign.exe":
                return True
            ok = k.Process32NextW(snap, ctypes.byref(e))
    finally:
        k.CloseHandle(snap)
    return False


class ToolError(Exception):
    def __init__(self, code, message, next_step=None, **extra):
        super().__init__(message)
        self.payload = {"code": code, "message": message, **({"next": next_step} if next_step else {}), **extra}


class Bridge:
    """Owns the COM connection on a dedicated STA thread; calls are serialized."""

    def __init__(self):
        self.q = queue.Queue()
        self.app = None
        threading.Thread(target=self._loop, daemon=True, name="indesign-com").start()

    def _loop(self):
        com.init_thread()
        while True:
            fn, box, done = self.q.get()
            try:
                box["value"] = fn()
            except BaseException as e:  # noqa: BLE001 - forwarded to caller
                box["error"] = e
            done.set()

    def run(self, fn, timeout=TIMEOUT):
        box, done = {}, threading.Event()
        self.q.put((fn, box, done))
        if not done.wait(timeout):
            raise ToolError("timeout", f"InDesign did not answer within {int(timeout)} s (still working or a dialog is open).",
                            "Check InDesign for an open dialog, then call indesign_status. Do not resend edits blindly.")
        if "error" in box:
            raise box["error"]
        return box["value"]

    # --- COM-thread helpers ---
    def _connect(self, launch=False):
        if self.app is not None:
            return self.app
        if not launch and not indesign_running():
            raise ToolError("not_running", "InDesign is not running.", "Start InDesign, or call indesign_status with launch=true.")
        self.app = com.launch(PROGIDS)   # CoCreateInstance attaches to the running instance
        return self.app

    def _doscript(self, js, undo_name=None):
        for attempt in (0, 1):
            app = self._connect()
            try:
                if undo_name:
                    return app.call("DoScript", js, JS_LANG, None, UNDO_ENTIRE, undo_name)
                return app.call("DoScript", js, JS_LANG)
            except com.ComError as e:
                if e.gone and attempt == 0:
                    self.app = None
                    continue
                if e.gone:
                    self.app = None
                    raise ToolError("not_running", "Lost connection to InDesign.", "Start InDesign and retry.")
                if e.busy:
                    raise ToolError("busy", "InDesign is busy (modal dialog open or still working).",
                                    "Close any dialog in InDesign, then retry once.")
                raise ToolError("indesign_error", str(e), "Check the arguments; InDesign rejected the script.")

    def execute(self, tool, args, undo_name=None, launch=False, timeout=TIMEOUT):
        call = "(" + json.dumps(args, ensure_ascii=True) + ", " + json.dumps(tool) + ")"
        stub = (ENGINE + "(function(){var m=$.global.__idmcp;if(!m||m.v!==" + json.dumps(RUNTIME_VERSION) + ")return "
                + json.dumps(RELOAD) + ";return m.run" + call + ";})();")

        def work():
            if launch:
                self._connect(launch=True)
            out = self._doscript(stub, undo_name)
            if out == RELOAD:   # first call, InDesign restarted, or runtime changed: load it once
                out = self._doscript(ENGINE + RUNTIME + "\n$.global.__idmcp.run" + call + ";", undo_name)
            return out
        raw = self.run(work, timeout)
        try:
            res = json.loads(raw)
        except (TypeError, ValueError):
            raise ToolError("bad_response", f"Unexpected InDesign reply: {str(raw)[:300]}")
        if not res.get("ok"):
            err = res.get("error") or {}
            raise ToolError(err.pop("code", "indesign_error"), err.pop("message", "error"), err.pop("next", None), **err)
        return res["result"]


BRIDGE = None


def bridge():
    global BRIDGE
    if BRIDGE is None:
        BRIDGE = Bridge()
    return BRIDGE


def _dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def call_tool(name, args):
    b = bridge()
    t0 = time.perf_counter()
    if name == "indesign_status":
        launch = bool(args.get("launch"))
        if not launch and not indesign_running():
            return [{"type": "text", "text": _dump({"running": False, "next": "Start InDesign or call indesign_status launch=true"})}]
        res = b.execute("status", {}, launch=launch)
        res["running"] = True
        res["server"] = __version__
        return [{"type": "text", "text": _dump(res)}]
    if name == "indesign_read":
        return [{"type": "text", "text": _dump(b.execute("read", args))}]
    if name == "indesign_apply":
        label = str(args.get("label") or "MCP edit")[:60]
        res = b.execute("apply", args, undo_name=label)
        res["ms"] = int((time.perf_counter() - t0) * 1000)
        return [{"type": "text", "text": _dump(res)}]
    if name == "indesign_document":
        to = BATCH_TIMEOUT if args.get("action") == "batch" else TIMEOUT
        return [{"type": "text", "text": _dump(b.execute("document", args, timeout=to))}]
    if name == "indesign_capture":
        path = os.path.join(tempfile.gettempdir(), f"indesign-mcp-{uuid.uuid4().hex}.png")
        a = dict(args, path=path)
        res = b.execute("capture", a)
        try:
            with open(res["path"], "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
        finally:
            try:
                os.remove(res["path"])
            except OSError:
                pass
        res.pop("path", None)
        return [{"type": "image", "data": data, "mimeType": "image/png"}, {"type": "text", "text": _dump(res)}]
    if name == "indesign_script":
        undo = args.get("undo", True)
        res = b.execute("script", args, undo_name="MCP script" if undo else None)
        return [{"type": "text", "text": _dump({"result": res})}]
    raise ToolError("unknown_tool", f"Unknown tool {name}")


# ---------------- JSON-RPC over stdio ----------------
OUT_LOCK = threading.Lock()


def send(msg):
    data = (json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    with OUT_LOCK:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def handle(msg):
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        want = params.get("protocolVersion")
        return {"protocolVersion": want if want in PROTOCOLS else PROTOCOLS[0],
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "indesign", "title": "Adobe InDesign", "version": __version__},
                "instructions": INSTRUCTIONS}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        try:
            return {"content": call_tool(name, args), "isError": False}
        except ToolError as e:
            return {"content": [{"type": "text", "text": _dump({"error": e.payload})}], "isError": True}
        except Exception as e:  # noqa: BLE001
            return {"content": [{"type": "text", "text": _dump({"error": {"code": "internal", "message": f"{type(e).__name__}: {e}"}})}], "isError": True}
    if method in ("resources/list", "prompts/list"):
        return {method.split("/")[0]: []}
    if mid is not None:
        raise LookupError(method)
    return None


def worker(msg):
    mid = msg.get("id")
    try:
        res = handle(msg)
        if mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "result": res})
    except LookupError:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {msg.get('method')}"}})
    except Exception as e:  # noqa: BLE001
        if mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": str(e)}})


def main():
    stdin = sys.stdin.buffer
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
            continue
        if isinstance(msg, list):
            for m in msg:
                threading.Thread(target=worker, args=(m,), daemon=True).start()
            continue
        if msg.get("method") == "tools/call":
            threading.Thread(target=worker, args=(msg,), daemon=True).start()  # keep stdio responsive; COM calls serialize
        else:
            worker(msg)


if __name__ == "__main__":
    main()
