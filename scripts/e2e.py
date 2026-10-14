"""Live end-to-end test: drives the MCP server over stdio against a throwaway InDesign document.

Usage: python scripts/e2e.py [--keep]   (InDesign must be running; never touches saved documents)
"""
import base64
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix="indesign-mcp-e2e-")


class Client:
    def __init__(self):
        self.p = subprocess.Popen([sys.executable, "-m", "indesign_mcp"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.n = 0

    def rpc(self, method, params=None):
        self.n += 1
        self.p.stdin.write((json.dumps({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params or {}}) + "\n").encode())
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())

    def call(self, name, args=None, expect_error=False):
        t = time.perf_counter()
        r = self.rpc("tools/call", {"name": name, "arguments": args or {}})["result"]
        ms = (time.perf_counter() - t) * 1000
        text = next((c["text"] for c in r["content"] if c["type"] == "text"), "")
        data = json.loads(text) if text else {}
        ok = r["isError"] == expect_error
        print(f"{'PASS' if ok else 'FAIL'} {ms:7.1f} ms {name} {json.dumps(args)[:90]}\n      -> {text[:260]}")
        if not ok:
            FAILS.append(name)
        return data, r


FAILS = []


def png(path, w=64, h=40):
    raw = b"".join(b"\x00" + b"".join(bytes((x * 4 % 256, y * 6 % 256, 160)) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def check(label, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'} check {label} {detail}")
    if not cond:
        FAILS.append(label)


def v11(c, doc, img):
    """1.1 features: fill, grid, CSV tables, thread/flow, align/distribute, relink folder, PDF overrides, batch."""
    imgs = os.path.join(TMP, "imgs"); os.makedirs(imgs, exist_ok=True)
    for i in range(5):
        png(os.path.join(imgs, f"Ansicht {i + 1}.png"), 48 + i * 8, 32)
    csv = os.path.join(TMP, "raeume.csv")
    open(csv, "w", encoding="cp1252", newline="").write('Raum;Fläche m²;Bemerkung\r\nWohnen;"32,5";"mit ""Loggia"""\r\nBad;6,5;\r\n')
    c.call("indesign_apply", {"doc": doc, "label": "v11 setup", "ops": [
        {"op": "pages", "action": "add", "count": 1},
        {"op": "create", "kind": "text", "page": 4, "x": 15, "y": 15, "w": 120, "h": 12, "name": "Head",
         "text": "{{Projekt}} – Stand {{Datum}} {{Bauherr}}"},
        {"op": "grid", "page": 4, "folder": imgs, "area": [15, 40, 180, 90], "gutter": 4, "captions": True},
        {"op": "table", "page": 4, "x": 15, "y": 140, "w": 180, "h": 30, "csv": csv, "header_rows": 1},
        {"op": "create", "kind": "rect", "page": 4, "x": 20, "y": 200, "w": 20, "h": 10, "name": "A1"},
        {"op": "create", "kind": "rect", "page": 4, "x": 70, "y": 215, "w": 30, "h": 15, "name": "A2"},
        {"op": "create", "kind": "rect", "page": 4, "x": 150, "y": 205, "w": 10, "h": 20, "name": "A3"},
    ]})
    r, _ = c.call("indesign_apply", {"doc": doc, "ops": [
        {"op": "fill", "data": {"Projekt": "Wohnquartier Spreeufer", "Datum": "14.10.2026"}},
        {"op": "align", "ids": ["A1", "A2", "A3"], "to": "top"},
        {"op": "distribute", "ids": ["A1", "A2", "A3"], "axis": "h", "gap": 10},
    ]})
    f = r["results"][0]
    check("fill counts", f["total"] == 2 and f["unfilled"] == ["{{Bauherr}}"], json.dumps(f, ensure_ascii=False))
    its, _ = c.call("indesign_read", {"doc": doc, "what": "items", "ids": ["A1", "A2", "A3"]})
    b = {x["name"]: x for x in its["items"]}
    check("align top", b["A1"]["y"] == b["A2"]["y"] == b["A3"]["y"] == 200)
    check("distribute gap", abs(b["A2"]["x"] - (b["A1"]["x"] + 20 + 10)) < 0.05 and abs(b["A3"]["x"] - (b["A2"]["x"] + 30 + 10)) < 0.05,
          str([(b[k]["x"]) for k in ("A1", "A2", "A3")]))
    grid, _ = c.call("indesign_read", {"doc": doc, "what": "items", "page": 4, "type": "Rectangle"})
    check("grid placed 5 images", sum(1 for x in grid["items"] if x.get("link", "").startswith("Ansicht")) == 5)
    tabs, _ = c.call("indesign_read", {"doc": doc, "what": "tables"})
    t = c.call("indesign_read", {"doc": doc, "what": "tables", "id": tabs["items"][-1]["table"]})[0]
    check("csv table (cp1252, quotes)", t["rows"][0][1] == "Fläche m²" and t["rows"][1][2][5:11] == "Loggia" and t["rows"][1][1] == "32,5", json.dumps(t["rows"], ensure_ascii=False))
    pages, _ = c.call("indesign_read", {"doc": doc, "what": "pages", "page": 4})
    mb = pages["items"][0].get("margin_box") or [0, 0, 999, 0]
    check("pages margin_box", abs(mb[0] * 2 + mb[2] - 210) < 0.05, str(mb))  # page 4 has no master -> default margins

    # flow: overset story grows the document
    long = "\r".join(f"Absatz {i}: " + "Baukörper und Freiraum bilden ein Ensemble. " * 6 for i in range(60))
    r, _ = c.call("indesign_apply", {"doc": doc, "ops": [
        {"op": "create", "kind": "text", "page": 4, "x": 15, "y": 240, "w": 180, "h": 30, "text": long, "name": "Long"}]})
    n0 = c.call("indesign_read", {"doc": doc, "what": "document"})[0]["pages"]
    r, _ = c.call("indesign_apply", {"doc": doc, "ops": [{"op": "flow", "id": "Long"}]})
    fl = r["results"][0]
    check("flow resolves overset", fl["overset"] is False and fl["pages_added"] >= 1 and fl["total_pages"] == n0 + fl["pages_added"], json.dumps(fl)[:200])

    # relink folder: move the image so the link goes missing, then repair from another folder
    moved = os.path.join(TMP, "moved"); os.makedirs(moved, exist_ok=True)
    c.call("indesign_apply", {"doc": doc, "ops": [{"op": "place", "file": os.path.join(imgs, "Ansicht 1.png"), "page": 4, "x": 0, "y": 0, "w": 10, "h": 10, "name": "Tmp"}]})
    os.replace(os.path.join(imgs, "Ansicht 5.png"), os.path.join(moved, "Ansicht 5.png"))
    c.call("indesign_script", {"doc": doc, "code": "for (var i=0;i<D.links.length;i++) try{D.links[i].update()}catch(e){} return D.links.length;"})
    miss, _ = c.call("indesign_read", {"doc": doc, "what": "links", "status": "missing"})
    r, _ = c.call("indesign_apply", {"doc": doc, "ops": [{"op": "relink", "folder": moved}]})
    check("relink folder", miss["total"] >= 1 and r["results"][0]["relinked"] == miss["total"], json.dumps(r["results"][0]))

    # PDF with preset + overrides; user export prefs restored afterwards
    before = c.call("indesign_script", {"code": "var p=app.pdfExportPreferences; return [p.cropMarks, p.pageRange+''];"})[0]["result"]
    c.call("indesign_document", {"doc": doc, "action": "export", "format": "pdf", "path": os.path.join(TMP, "print.pdf"),
                                 "preset": "[PDF/X-4:2008]", "crop_marks": True, "bleed": True, "pages": "4"})
    after = c.call("indesign_script", {"code": "var p=app.pdfExportPreferences; return [p.cropMarks, p.pageRange+''];"})[0]["result"]
    check("pdf export prefs restored", before == after and os.path.getsize(os.path.join(TMP, "print.pdf")) > 1000, f"{before} {after}")

    # batch: two saved copies with placeholders -> fill + PDF each
    bdir = os.path.join(TMP, "batch"); os.makedirs(bdir, exist_ok=True)
    for name in ("Blatt A.indd", "Blatt B.indd"):
        c.call("indesign_document", {"doc": doc, "action": "save_copy", "path": os.path.join(bdir, name)})
    r, _ = c.call("indesign_document", {"action": "batch", "folder": bdir, "fill": {"data": {"Bauherr": "WBM"}},
                                        "preflight": True, "export": {"format": "pdf", "dir": os.path.join(bdir, "pdf"), "pages": "4"}})
    check("batch", r["ok"] == 2 and all(x.get("filled") == 1 and os.path.exists(x["export"]) for x in r["results"]), json.dumps(r)[:300])

    # latency of the persistent engine
    ts = []
    for _ in range(10):
        t0 = time.perf_counter(); c.rpc("tools/call", {"name": "indesign_read", "arguments": {"doc": doc, "what": "pages", "limit": 1}}); ts.append((time.perf_counter() - t0) * 1000)
    ts.sort()
    print(f"      read latency median {ts[5]:.1f} ms, min {ts[0]:.1f} ms")


def main():
    c = Client()
    t = time.perf_counter()
    init = c.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "1"}})
    print("initialize", round((time.perf_counter() - t) * 1000, 1), "ms", init["result"]["protocolVersion"])
    tools = c.rpc("tools/list")["result"]["tools"]
    print("tools:", [x["name"] for x in tools], "schema bytes:", len(json.dumps(tools)))

    c.call("indesign_status")
    d, _ = c.call("indesign_document", {"action": "new", "w": 210, "h": 297, "pages": 2, "facing": False, "margins": [15, 15, 20, 15], "columns": 2, "gutter": 5})
    doc = d["name"]
    img = os.path.join(TMP, "render.png"); png(img)
    txt = os.path.join(TMP, "copy.txt")
    open(txt, "w", encoding="utf-8").write("Projektbeschreibung\rDas Gebäude gliedert sich in drei Baukörper.\r")

    c.call("indesign_apply", {"doc": doc, "label": "e2e build", "ops": [
        {"op": "swatch", "name": "EBA Blue", "space": "cmyk", "values": [90, 50, 0, 0]},
        {"op": "style", "kind": "paragraph", "name": "Title", "props": {"pointSize": 28, "fill": "EBA Blue", "align": "left", "spaceAfter": 4}},
        {"op": "style", "kind": "paragraph", "name": "Body", "props": {"pointSize": 9.5, "leading": 13}},
        {"op": "style", "kind": "character", "name": "Bold", "props": {"fontStyle": "Bold"}},
        {"op": "layer", "name": "Images"},
        {"op": "create", "kind": "text", "page": 1, "x": 15, "y": 15, "w": 180, "h": 20, "text": "Wohnquartier Spreeufer", "para_style": "Title", "name": "Title"},
        {"op": "create", "kind": "text", "page": 1, "x": 15, "y": 40, "w": 87.5, "h": 80, "text": "Lorem ipsum Baukörper dolor sit amet.\rZweiter Absatz mit Baukörper.", "para_style": "Body", "name": "Body"},
        {"op": "create", "kind": "rect", "page": 1, "x": 107.5, "y": 40, "w": 87.5, "h": 60, "props": {"fill": "EBA Blue", "strokeWeight": 0}, "layer": "Images"},
        {"op": "create", "kind": "ellipse", "page": 1, "x": 150, "y": 240, "w": 30, "h": 30, "props": {"fill": "Black", "opacity": 50}},
        {"op": "create", "kind": "line", "page": 1, "x1": 15, "y1": 35, "x2": 195, "y2": 35, "props": {"stroke": "Black", "weight": 0.5}},
        {"op": "place", "file": img, "page": 1, "x": 15, "y": 130, "w": 80, "h": 50, "fit": "proportional", "name": "Render"},
        {"op": "place", "file": txt, "page": 2, "x": 15, "y": 15, "w": 120, "h": 60},
        {"op": "table", "page": 2, "x": 15, "y": 90, "w": 180, "h": 40, "header_rows": 1,
         "data": [["Raum", "Fläche m²"], ["Wohnen", "32,5"], ["Küche", "12,0"]]},
    ]})
    c.call("indesign_read", {"doc": doc, "what": "document"})
    items, _ = c.call("indesign_read", {"doc": doc, "what": "items", "page": 1})
    c.call("indesign_read", {"doc": doc, "what": "items", "type": "text"})
    c.call("indesign_read", {"doc": doc, "what": "item", "id": "Title", "props": ["fillColor", "strokeWeight", "geometricBounds"]})
    c.call("indesign_read", {"doc": doc, "what": "text", "id": "Body", "detail": True})
    c.call("indesign_read", {"doc": doc, "what": "text"})
    c.call("indesign_read", {"doc": doc, "what": "find", "find": "Baukörper"})
    c.call("indesign_read", {"doc": doc, "what": "find", "find": "\\d+,\\d", "grep": True})
    c.call("indesign_read", {"doc": doc, "what": "styles", "kind": "paragraph", "detail": True})
    c.call("indesign_read", {"doc": doc, "what": "styles"})
    c.call("indesign_read", {"doc": doc, "what": "swatches"})
    c.call("indesign_read", {"doc": doc, "what": "layers"})
    c.call("indesign_read", {"doc": doc, "what": "links"})
    c.call("indesign_read", {"doc": doc, "what": "fonts"})
    tables, _ = c.call("indesign_read", {"doc": doc, "what": "tables"})
    c.call("indesign_read", {"doc": doc, "what": "tables", "id": tables["items"][0]["table"]})
    c.call("indesign_read", {"doc": doc, "what": "pages"})
    c.call("indesign_read", {"doc": doc, "what": "masters"})
    c.call("indesign_read", {"doc": doc, "what": "presets"})

    c.call("indesign_apply", {"doc": doc, "ops": [
        {"op": "set", "id": "Title", "y": 18, "props": {"textFramePreferences": {"verticalJustification": "CENTER_ALIGN"}}},
        {"op": "text", "id": "Body", "match": "Baukörper", "char_style": "Bold"},
        {"op": "text", "id": "Body", "paragraphs": [1, 1], "props": {"justification": "RIGHT_ALIGN", "size": 11}},
        {"op": "replace", "find": "Lorem", "replace": "Entwurf"},
        {"op": "replace", "find": "(\\d+),(\\d)", "replace": "$1.$2", "grep": True},
        {"op": "set", "id": "Body", "text": "\rAngehängt.", "mode": "append"},
        {"op": "duplicate", "id": "Render", "count": 2, "dx": 0, "dy": 55},
        {"op": "cells", "id": tables["items"][0]["table"], "row": 3, "col": 0, "data": [["Bad", "6.5"]], "cell_props": {"fillColor": "Paper"}},
        {"op": "pages", "action": "add", "count": 1},
        {"op": "arrange", "id": "Title", "to": "back"},
    ]})
    c.call("indesign_apply", {"doc": doc, "label": "e2e extra", "ops": [
        {"op": "create", "kind": "polygon", "page": 3, "points": [[20, 20], [60, 20], [40, 50]], "props": {"fill": "EBA Blue"}, "name": "Tri"},
        {"op": "create", "kind": "rect", "page": 3, "x": 70, "y": 20, "w": 20, "h": 20, "name": "Sq"},
        {"op": "group", "ids": ["Tri", "Sq"], "name": "Grp"},
        {"op": "set", "id": "Grp", "dx": 10, "dy": 5},
        {"op": "place", "file": img, "page": 3, "x": 20, "y": 100},
        {"op": "layer", "name": "Images", "rename": "Bilder", "props": {"locked": False}},
        {"op": "style", "kind": "paragraph", "name": "Body", "props": {"leading": 14, "font": "Minion Pro"}},
        {"op": "style", "kind": "object", "name": "Card", "props": {"fillColor": "Paper", "strokeWeight": 2}},
        {"op": "set", "id": "Sq", "props": {"object_style": "Card"}},
        {"op": "text", "id": "Title", "props": {"tracking": 20}, "clear_overrides": False},
        {"op": "document", "bleed": 3},
        {"op": "select", "ids": ["Title"]},
    ]})
    c.call("indesign_read", {"doc": doc, "what": "items", "page": 3, "nested": True})
    c.call("indesign_read", {"doc": doc, "what": "selection"})
    c.call("indesign_read", {"doc": doc, "what": "items", "page": 1, "units": "pt", "limit": 2})
    c.call("indesign_apply", {"doc": doc, "ops": [{"op": "ungroup", "id": "Grp"}, {"op": "fit", "id": "Render", "mode": "fill"},
                                                {"op": "pages", "action": "master", "pages": [3], "master": "None"},
                                                {"op": "pages", "action": "add", "count": 1, "after": 1},
                                                {"op": "pages", "action": "delete", "pages": [2]}]})
    c.call("indesign_read", {"doc": doc, "what": "text", "id": "Body", "raw": True})
    c.call("indesign_read", {"doc": doc, "what": "tables", "id": tables["items"][0]["table"]})
    # failure path: second op invalid -> created first item must be removed
    before, _ = c.call("indesign_read", {"doc": doc, "what": "items", "limit": 1})
    c.call("indesign_apply", {"doc": doc, "ops": [{"op": "create", "kind": "rect", "page": 1, "x": 0, "y": 0, "w": 10, "h": 10},
                                                {"op": "set", "id": "Title", "props": {"noSuchProperty": 1}}]}, expect_error=True)
    after, _ = c.call("indesign_read", {"doc": doc, "what": "items", "limit": 1})
    print("rollback check:", "PASS" if before["total"] == after["total"] else "FAIL", before["total"], after["total"])
    if before["total"] != after["total"]:
        FAILS.append("rollback")
    c.call("indesign_apply", {"doc": doc, "ops": [{"op": "set", "id": 999999, "x": 1}]}, expect_error=True)
    c.call("indesign_apply", {"doc": doc, "ops": [{"op": "set", "id": "Title", "props": {"fill": "No Such Swatch"}}]}, expect_error=True)

    v11(c, doc, img)

    for args in ({"doc": doc, "page": 1}, {"doc": doc, "id": "Render"}, {"doc": doc, "page": 2, "max_px": 600}):
        _, raw = c.call("indesign_capture", args)
        im = next(x for x in raw["content"] if x["type"] == "image")
        out = os.path.join(TMP, f"cap-{args.get('page', 'item')}.png")
        open(out, "wb").write(base64.b64decode(im["data"]))
        print("      saved", out, os.path.getsize(out), "bytes")

    c.call("indesign_document", {"doc": doc, "action": "export", "format": "pdf", "path": os.path.join(TMP, "out.pdf"), "pages": "1-2"})
    c.call("indesign_document", {"doc": doc, "action": "export", "format": "jpg", "path": os.path.join(TMP, "p2.jpg"), "pages": [2], "resolution": 72})
    c.call("indesign_document", {"doc": doc, "action": "export", "format": "idml", "path": os.path.join(TMP, "out.idml")})
    c.call("indesign_document", {"doc": doc, "action": "export", "format": "png", "path": os.path.join(TMP, "p1.png"), "pages": "1", "resolution": 50})
    c.call("indesign_document", {"doc": doc, "action": "preflight"})
    c.call("indesign_document", {"doc": doc, "action": "zoom", "page": 1, "fit": "page"})
    c.call("indesign_script", {"doc": doc, "code": "return {pages: D.pages.length, frames: D.textFrames.length, w: D.documentPreferences.pageWidth, a: A.x};", "args": {"x": 1}})
    c.call("indesign_script", {"doc": doc, "code": "null.foo();"}, expect_error=True)
    c.call("indesign_read", {"what": "nope"}, expect_error=True)
    c.call("indesign_document", {"doc": doc, "action": "close"}, expect_error=True)
    c.call("indesign_document", {"doc": doc, "action": "save", "path": os.path.join(TMP, "e2e.indd")})
    if "--keep" not in sys.argv:
        c.call("indesign_document", {"doc": "e2e.indd", "action": "close", "save": False})
    print("\nartifacts:", TMP)
    print("RESULT:", "ALL PASS" if not FAILS else f"FAILED: {FAILS}")
    c.p.stdin.close()
    c.p.wait(5)
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
