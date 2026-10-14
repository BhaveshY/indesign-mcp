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

__version__ = "1.3.0"
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


LOG_PATH = os.path.join(os.environ.get("LOCALAPPDATA", tempfile.gettempdir()), "indesign-mcp", "server.log")


def log(event, **fields):
    """Append one JSON line to the diagnostics log (kept under ~1 MB)."""
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 1_000_000:
            os.replace(LOG_PATH, LOG_PATH + ".1")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S"), "pid": os.getpid(), "v": __version__,
                                "rt": RUNTIME_VERSION, "event": event, **fields}, ensure_ascii=False, default=str) + "\n")
    except OSError:
        pass


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

    persistent = True   # cleared for the rest of the session if the persistent engine ever returns no result

    def _probe(self):
        try:
            return str(self._doscript(ENGINE + "var m=$.global.__idmcp; (typeof m) + '|' + (m ? m.v : '') + '|' + $.engineName"))
        except Exception as e:  # noqa: BLE001
            return f"probe failed: {e}"

    def execute(self, tool, args, undo_name=None, launch=False, timeout=TIMEOUT, safe_retry=False):
        call = "(" + json.dumps(args, ensure_ascii=True) + ", " + json.dumps(tool) + ")"
        stub = (ENGINE + "(function(){var m=$.global.__idmcp;if(!m||m.v!==" + json.dumps(RUNTIME_VERSION) + ")return "
                + json.dumps(RELOAD) + ";return m.run" + call + ";})();")
        load = ENGINE + RUNTIME + "\n$.global.__idmcp.run" + call + ";"
        main = RUNTIME + "\n$.global.__idmcp.run" + call + ";"   # main engine: parsed per call, nothing persists
        info = {}

        def work():
            if launch:
                self._connect(launch=True)
            if not self.persistent:
                return self._doscript(main, undo_name)
            out = self._doscript(stub, undo_name)
            if out == RELOAD:   # first call, InDesign restarted, or runtime changed: load it once
                out = self._doscript(load, undo_name)
            if isinstance(out, str):
                return out
            # No result from the persistent engine: record why, stop using it, and only retry when re-running is harmless.
            info["vt"] = getattr(self.app, "last_vt", None)   # COM type of the empty reply (read before probing)
            info["probe"] = self._probe()
            self.persistent = False
            log("empty_reply", tool=tool, action=args.get("action") or args.get("what"), vt=info["vt"], probe=info["probe"])
            if safe_retry:
                out = self._doscript(main, undo_name)
                log("fallback_main_engine", tool=tool, ok=isinstance(out, str))
            return out
        raw = self.run(work, timeout)
        if not isinstance(raw, str):
            if safe_retry:
                raise ToolError("bad_response", "InDesign returned no result, even after a retry.",
                                "Call indesign_status; if InDesign shows a dialog close it, otherwise restart InDesign. "
                                "Details are in " + LOG_PATH, **info)
            raise ToolError("unknown_result", "InDesign returned no result: this write may or may not have been applied.",
                            "Do NOT resend blindly. Check the affected items/document with indesign_read first; the server has "
                            "switched to its safe execution mode, so a retry after checking is fine. Details: " + LOG_PATH, **info)
        try:
            res = json.loads(raw)
        except ValueError:
            log("bad_json", tool=tool, raw=raw[:300])
            raise ToolError("bad_response", f"Unexpected InDesign reply: {raw[:300]}",
                            "Check state with indesign_read before retrying; details in " + LOG_PATH)
        if not res.get("ok"):
            err = res.get("error") or {}
            code = err.pop("code", "indesign_error")
            nxt = err.pop("next", None) or ("Fix the arguments per the tool description; re-read the current state before retrying."
                                            if code != "indesign_error" else
                                            "InDesign rejected the call: check ids/names/values with indesign_read, then retry once.")
            raise ToolError(code, err.pop("message", "error"), nxt, **err)
        return res["result"]


# Document actions that are harmless to re-run (read-only or overwrite the same output file).
SAFE_DOC_ACTIONS = {"info", "preflight", "export", "save_copy", "zoom", "activate"}
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
        res = b.execute("status", {}, launch=launch, safe_retry=True)
        res["running"] = True
        res["server"] = __version__
        return [{"type": "text", "text": _dump(res)}]
    if name == "indesign_read":
        return [{"type": "text", "text": _dump(b.execute("read", args, safe_retry=True))}]
    if name == "indesign_apply":
        label = str(args.get("label") or "MCP edit")[:60]
        res = b.execute("apply", args, undo_name=label)
        res["ms"] = int((time.perf_counter() - t0) * 1000)
        return [{"type": "text", "text": _dump(res)}]
    if name == "indesign_document":
        act = args.get("action")
        to = BATCH_TIMEOUT if act == "batch" else TIMEOUT
        return [{"type": "text", "text": _dump(b.execute("document", args, timeout=to, safe_retry=act in SAFE_DOC_ACTIONS))}]
    if name == "indesign_capture":
        path = os.path.join(tempfile.gettempdir(), f"indesign-mcp-{uuid.uuid4().hex}.png")
        a = dict(args, path=path)
        res = b.execute("capture", a, safe_retry=True)
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
