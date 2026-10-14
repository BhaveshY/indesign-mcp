"""Tool schemas. Kept lean: few tools, rich actions, short descriptions."""

INSTRUCTIONS = (
    "Adobe InDesign (local, via COM). Lengths are mm unless units is set; x,y,w,h are relative to the item's page "
    "top-left; pages are 1-based. Read with indesign_read (follow next_offset), look with indesign_capture, change with "
    "ONE indesign_apply call holding all ops (pre-validated; created items are removed if an op fails). Address items by "
    "numeric id (from reads) or by their name/label. Props take InDesign DOM names (fillColor, pointSize, "
    "justification:'CENTER_ALIGN', textFramePreferences:{...}); swatch/style/layer values are names. Every error has "
    "error.next: follow it, don't loop. Text sizes and DOM props are points. Shortcuts: fill (placeholders like {{Projekt}}), "
    "grid (image boards), flow (fix overset by adding pages), align/distribute, table csv=, relink folder= (moved project "
    "folders); indesign_document action=batch processes many .indd files (fill/ops/preflight/export). Use read what=pages "
    "margin_box to place inside the live area. indesign_script runs raw ExtendScript (ES3, CS6+ DOM) for anything else."
)

_doc = {"type": ["string", "integer"], "description": "Document name, path or 1-based index; default active"}
_units = {"type": "string", "enum": ["mm", "cm", "pt", "in", "px", "pica"], "description": "default mm"}
_id = {"type": ["integer", "string"], "description": "item/story id, or item name/label"}
_page = {"type": ["integer", "string"], "description": "1-based page"}
_pages = {"type": ["integer", "string", "array"], "items": {"type": "integer"}, "description": "n, 'a-b' range or [n,...]"}
_margins = {"type": ["number", "array"], "items": {"type": "number"}, "description": "n or [top,right,bottom,left]"}
_num = {"type": "number"}
_str = {"type": "string"}
_bool = {"type": "boolean"}
_obj = {"type": "object"}

# Typed fields shared by apply ops (each op uses a subset; the tool description says which).
_OP_FIELDS = {
    "op": {"type": "string", "enum": [
        "create", "place", "set", "text", "replace", "fill", "delete", "duplicate", "group", "ungroup", "arrange", "align",
        "distribute", "fit", "grid", "thread", "flow", "pages", "layer", "style", "swatch", "table", "cells", "relink",
        "select", "document"]},
    "id": _id, "ids": {"type": "array", "items": _id}, "into": _id, "page": _page, "pages": _pages,
    "kind": {"type": "string", "description": "create: text|rect|ellipse|polygon|line; style: paragraph|character|object|table|cell"},
    "x": _num, "y": _num, "w": _num, "h": _num, "dx": _num, "dy": _num, "rotate": _num,
    "x1": _num, "y1": _num, "x2": _num, "y2": _num,
    "points": {"type": "array", "items": {"type": "array", "items": _num}},
    "area": {"type": "array", "items": _num, "description": "[x,y,w,h]"},
    "text": _str, "mode": {"type": "string", "enum": ["replace", "append", "prepend"]},
    "name": _str, "label": _str, "layer": _str, "para_style": _str, "char_style": _str, "style": _str, "based_on": _str,
    "props": _obj, "text_props": _obj, "cell_props": _obj, "find_props": _obj, "change_props": _obj,
    "file": _str, "files": {"type": "array", "items": _str}, "folder": _str, "pattern": _str, "recursive": _bool, "csv": _str,
    "fit": {"type": "string", "enum": ["proportional", "fill", "content", "frame", "center"]},
    "match": _str, "find": _str, "replace": _str, "grep": _bool, "case": _bool, "whole_word": _bool, "dry_run": _bool,
    "data": {"type": ["object", "array"], "description": "fill: {Key:value}; table/cells: [[row cells]]"}, "map": _obj,
    "rows": {"type": "integer"}, "cols": {"type": "integer"}, "header_rows": {"type": "integer"}, "row": {"type": "integer"},
    "col": {"type": "integer"}, "range": {"type": "array", "items": {"type": "integer"}}, "count": {"type": "integer"},
    "action": _str, "master": _str, "margins": _margins, "after": {"type": "integer"},
    "to": {"type": ["string", "array", "integer"], "items": _str}, "ref": {"type": ["string", "integer"]},
    "axis": {"type": "string", "enum": ["h", "v"]}, "gap": _num, "gutter": _num,
    "captions": {"type": ["boolean", "array"], "items": _str}, "caption_style": _str, "max_pages": {"type": "integer"},
    "link": {"type": ["string", "integer"]}, "space": {"type": "string", "enum": ["cmyk", "rgb", "lab"]},
    "values": {"type": "array", "items": _num}, "spot": _bool,
}

TOOLS = [
    {
        "name": "indesign_status",
        "title": "InDesign status",
        "description": "Connection check + open documents, active doc/page, selection count. launch=true starts InDesign if closed.",
        "inputSchema": {"type": "object", "properties": {"launch": {"type": "boolean"}}},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
    },
    {
        "name": "indesign_read",
        "title": "Read InDesign document",
        "description": (
            "Query a document. what: document (summary+issues) | pages (size, master, margin_box[x,y,w,h], columns) | items (filter page/type/layer/name/text, nested) | "
            "item (id; geometry + text_format of first char; props=true|[names] reads DOM props, falling back to the frame's text; unknown names are listed in unsupported) | text (no id: stories list; id: paragraphs w/ styles, raw=true for plain text) | "
            "find (find, grep, case, whole_word, find_props, id=story scope) | styles (kind, detail) | swatches | layers | "
            "links (status filter e.g. missing) | fonts | selection | tables (id: cell contents) | masters | presets | issues. "
            "document counts.items = top-level items (same scope as what=items); counts.all_items adds group children and placed graphics. "
            "Lists page with offset/limit and return next_offset."
        ),
        "inputSchema": {"type": "object", "properties": {
            "what": {"type": "string", "enum": ["document", "pages", "items", "item", "text", "find", "styles", "swatches", "layers",
                                                "links", "fonts", "selection", "tables", "masters", "presets", "issues"]},
            "doc": _doc, "id": _id, "ids": {"type": "array", "items": _id},
            "page": _pages,
            "type": {"type": "string", "description": "TextFrame|Rectangle|Oval|Polygon|GraphicLine|Group (substring)"},
            "layer": {"type": "string"}, "name": {"type": "string", "description": "name/label contains"},
            "text": {"type": "string", "description": "items: contents contains"},
            "nested": {"type": "boolean", "description": "include items inside groups"},
            "find": {"type": "string"}, "grep": {"type": "boolean"}, "case": {"type": "boolean"}, "whole_word": {"type": "boolean"},
            "find_props": {"type": "object", "description": "e.g. {appliedParagraphStyle:'Heading'}"},
            "kind": {"type": "string", "enum": ["paragraph", "character", "object", "table", "cell"]},
            "status": {"type": "string"}, "detail": {"type": "boolean"}, "raw": {"type": "boolean"},
            "props": {"type": ["boolean", "array"], "items": {"type": "string"}},
            "max_chars": {"type": "integer"}, "offset": {"type": "integer"}, "limit": {"type": "integer"}, "units": _units,
        }},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
    },
    {
        "name": "indesign_apply",
        "title": "Edit InDesign document",
        "description": (
            "Run a batch of edits. References (ids, styles, pages, files) are validated before anything runs. NOT atomic: if an op fails "
            "mid-batch, items created by the batch are removed but other edits stay (CS6 has no scripted undo); error.done lists what ran. "
            "typographic_quotes=false keeps straight quotes literal (InDesign converts them by default). ops[] items (op + fields):\n"
            "create kind=text|rect|ellipse|polygon|line page,x,y,w,h (line: x1,y1,x2,y2; polygon: points[[x,y]]) text? para_style? char_style? text_props? fit_text? name? label? layer? props?\n"
            "place file page,x,y[,w,h] | into=id; fit=proportional|fill|content|frame|center; autoflow?\n"
            "set id|ids: x,y,w,h,dx,dy,rotate,text(+mode=replace|append|prepend, para_style,char_style,text_props),name,label,props\n"
            "text id [match(+grep)|paragraphs:[a,b]|chars:[a,b]]: para_style,char_style,props,replace,clear_overrides\n"
            "replace find,replace? grep? case? whole_word? id?(story) find_props? change_props? dry_run?\n"
            "delete ids | duplicate id,count,dx,dy,page | group ids,name | ungroup id | arrange ids,to=front|back|forward|backward | fit ids,mode\n"
            "pages action=add(count,after,master)|delete(pages)|master(pages,master)|move(pages,to,before)|duplicate(pages)|set(pages,margins,props)\n"
            "layer name,rename?,props?,active?,delete? | style kind,name,based_on?,props (create/update) | swatch name,space=cmyk|rgb|lab,values,spot?\n"
            "table id(text frame)|page,x,y,w,h rows,cols,data[[...]],header_rows,style,props,cell_props | cells id,row,col,data,cell_props,range[r1,c1,r2,c2]\n"
            "  table csv=path (auto ; , tab; UTF-8 or ANSI) instead of data\n"
            "fill data{Key:value} (token '{{%s}}') | map{'literal':value}; id?(story) masters? -> counts + unfilled placeholders left\n"
            "grid files[]|folder(+pattern regex,recursive) page; rows?,cols?,gutter=5,area[x,y,w,h]?(default margins),fit=fill(crops to fill each cell; proportional shows the whole image),captions(true|[..]),caption_style,layer,props\n"
            "thread ids (link text frames in order) | flow id (add pages+frames in margins until no overset; max_pages, master)\n"
            "align ids|id to=left|right|hcenter|top|bottom|vcenter|center|[..] ref=selection|page|margins|<id> | distribute ids axis=h|v gap?\n"
            "relink link(name|id),file | relink folder (recursive; fixes missing links by file name; all=true relinks every match) | relink (update out-of-date)\n"
            "select ids | document w,h,facing,bleed,props\n"
            "props use InDesign DOM names; aliases: fill stroke weight font size color para_style char_style object_style layer opacity align(left|center|right|justify)."
        ),
        "inputSchema": {"type": "object", "required": ["ops"], "properties": {
            "ops": {"type": "array", "items": {"type": "object", "required": ["op"], "properties": _OP_FIELDS}},
            "typographic_quotes": {"type": "boolean", "description": "false: keep straight quotes in text set by this batch"},
            "doc": _doc, "units": _units, "label": {"type": "string", "description": "undo step name"},
            "keep_partial": {"type": "boolean", "description": "don't remove created items when an op fails"},
        }},
        "annotations": {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False, "openWorldHint": False},
    },
    {
        "name": "indesign_document",
        "title": "InDesign document & export",
        "description": (
            "action: new (w,h,pages,facing,margins,columns,gutter,bleed,preset,path?) | open path | info | activate | save (path?) | "
            "save_copy path | close save=true|false (required if modified) | export format=pdf|png|jpg|idml|eps|rtf|txt path "
            "pages('1-3'|[1,4]) preset(pdf) crop_marks bleed props(pdfExportPreferences overrides) resolution spreads id(png/jpg single item, rtf/txt story) | "
            "package path fonts links pdf idml report | batch files[]|folder(+pattern,recursive) fill{data|map} ops[] preflight "
            "export{format,preset,dir,suffix,pages,...} save (default false: source files stay unchanged) -> per-file results (opens hidden, closes after; up to 30 min) | "
            "undo|redo steps (not supported by CS6 scripting) | preflight | zoom page id fit=page|spread|actual percent."
        ),
        "inputSchema": {"type": "object", "required": ["action"], "properties": {
            "action": {"type": "string", "enum": ["new", "open", "info", "activate", "save", "save_copy", "close", "export", "package",
                                                  "batch", "undo", "redo", "preflight", "zoom"]},
            "files": {"type": "array", "items": {"type": "string"}}, "folder": {"type": "string"}, "pattern": {"type": "string"},
            "recursive": {"type": "boolean"}, "fill": {"type": "object"}, "ops": {"type": "array", "items": {"type": "object"}},
            "export": {"type": "object"}, "crop_marks": {"type": "boolean"}, "props": {"type": "object"},
            "doc": _doc, "path": {"type": "string"}, "format": {"type": "string"}, "preset": {"type": "string"},
            "pages": _pages, "page": _page, "id": _id,
            "w": {"type": "number"}, "h": {"type": "number"}, "facing": {"type": "boolean"},
            "margins": _margins,
            "columns": {"type": "integer"}, "gutter": {"type": "number"}, "bleed": {"type": ["number", "boolean"], "description": "new: mm; export: include bleed"},
            "preflight": {"type": "boolean"}, "save": {"type": "boolean"}, "resolution": {"type": "number"}, "spreads": {"type": "boolean"},
            "quality": {"type": "string"}, "transparent": {"type": "boolean"}, "overwrite": {"type": "boolean"},
            "fonts": {"type": "boolean"}, "links": {"type": "boolean"}, "pdf": {"type": "boolean"}, "idml": {"type": "boolean"},
            "report": {"type": "boolean"}, "steps": {"type": "integer"}, "window": {"type": "boolean"},
            "fit": {"type": "string"}, "percent": {"type": "number"}, "limit": {"type": "integer"}, "units": _units,
        }},
        "annotations": {"readOnlyHint": False, "destructiveHint": True, "openWorldHint": False},
    },
    {
        "name": "indesign_capture",
        "title": "See an InDesign page",
        "description": "PNG of a page (default active page), a spread (spread=true) or one item (id). max_px caps the long side (default 1400).",
        "inputSchema": {"type": "object", "properties": {
            "doc": _doc, "page": _page, "id": _id, "spread": {"type": "boolean"},
            "max_px": {"type": "integer"}, "resolution": {"type": "number"}, "units": _units}},
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
    },
    {
        "name": "indesign_script",
        "title": "Run ExtendScript",
        "description": (
            "Run ExtendScript (ES3, no JSON/indexOf) as a function body; `return` a value (auto-serialized). In scope: app, D (target "
            "doc or null), A (args), item(id|name), page(n), info(item), setProps(obj,props), doc(sel), J(v). Units per `units` "
            "(default mm). undo=true (default) groups changes as one undo step."
        ),
        "inputSchema": {"type": "object", "required": ["code"], "properties": {
            "code": {"type": "string"}, "args": {"type": "object"}, "doc": _doc, "units": _units, "undo": {"type": "boolean"}}},
        "annotations": {"readOnlyHint": False, "destructiveHint": True, "openWorldHint": False},
    },
]
