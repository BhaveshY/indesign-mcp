# InDesign MCP

Local MCP server for Adobe InDesign on Windows. It's pure Python (stdlib only, no pip installs) and talks to the running InDesign over COM. The InDesign-side runtime is loaded once into a persistent ExtendScript engine. After that, a typical call takes 3–10 ms.

Tested live against InDesign CS6 (8.0). The server also tries the ProgIDs of newer versions (`InDesign.Application.2023`–`2026`), but those versions have not been tested.

## Tools (6)

| Tool | What it does |
|---|---|
| `indesign_status` | Connection check, open docs, active doc/page, selection count (`launch=true` starts InDesign) |
| `indesign_read` | `what=` document · pages · items · item (raw DOM props) · text · find (text/GREP) · styles · swatches · layers · links · fonts · selection · tables · masters · presets · issues. Paginated (`offset`/`limit` → `next_offset`) |
| `indesign_apply` | One batch of ops: create · place · set · text · replace · **fill** · delete · duplicate · group · ungroup · arrange · **align** · **distribute** · fit · **grid** · **thread** · **flow** · pages · layer · style · swatch · table (data or **CSV**) · cells · relink (file, or **folder** search) · select · document. Inputs are checked before anything runs. Items it created are removed if an op fails |
| `indesign_document` | new · open · info · activate · save · save_copy · close · export (pdf/png/jpg/idml/eps/rtf/txt; PDF preset + crop marks/bleed/overrides) · package · **batch** · undo/redo · preflight · zoom |
| `indesign_capture` | PNG of a page, a spread or a single item, returned as an image |
| `indesign_script` | Raw ExtendScript with helpers in scope (`D`, `item`, `page`, `info`, `setProps`) |

### Workflows it covers in one call
- **Title blocks and templates**: `fill` with `data: {Projekt: "...", Datum: "..."}` replaces every `{{Projekt}}` placeholder, including on masters. It also reports any placeholders that are still unfilled.
- **Competition boards and portfolios**: `grid` with `folder: "...\Renderings"` lays the images out in rows and columns inside the page margins, with optional captions.
- **Room or area schedules**: `table` with `csv: "...\Flaechen.csv"` reads Excel CSV exports, including semicolon-separated ANSI files from German Excel.
- **Long reports**: `flow` adds pages and threaded frames until a story no longer oversets.
- **Moved project folders**: `relink` with `folder: "..."` repairs missing links by matching file names, searching subfolders too.
- **Many files at once**: `indesign_document action=batch` takes a `folder` and can fill, run ops, preflight and export each file, for example to PDF. It opens every file hidden, closes it afterwards, and reports results per file.

### Conventions
- **Geometry**: `x,y,w,h` are in mm (or set `units`), measured from the top-left of the item's page. Pages are 1-based.
- **Type and DOM props**: values are in points, so `pointSize: 11` means 11 pt.
- **Addressing**: refer to items by numeric id (from reads) or by the item's name/label (`"Title"`).
- **Props**: use InDesign DOM names. Enum values can be strings (`justification: "CENTER_ALIGN"`), and swatch, style and layer values are names. Short aliases also work: `fill`, `stroke`, `weight`, `font`, `size`, `para_style`, `char_style`, `object_style`, `layer`, `opacity`, `align`.
- **Errors**: every error has `code`, `message` and `next`, a hint for what to do next.
- **No blocking dialogs**: the server sets `userInteractionLevel` to `NEVER_INTERACT` while each script runs, then restores it.

## Install
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1   # registers with Claude Code (user) + Codex (backs up config.toml)
```
Manual: `claude mcp add -s user indesign -- python "<repo>\run_server.py"`

## Test (live, uses a throwaway untitled document)
```powershell
python scripts\e2e.py        # full end-to-end over stdio
python scripts\jsxcheck.py   # syntax-check runtime.jsx inside InDesign's ExtendScript engine
```

## Layout
- `indesign_mcp/com.py`: minimal ctypes `IDispatch` client
- `indesign_mcp/runtime.jsx`: all InDesign logic (ES3)
- `indesign_mcp/server.py`: stdio JSON-RPC and the COM worker thread
- `indesign_mcp/tools.py`: tool schemas

## Notes
- If a batch takes longer than 30 min (set `INDESIGN_MCP_BATCH_TIMEOUT` to change this), the server returns `timeout`.
- PDF exports restore your own PDF export preferences afterwards.
- If InDesign is not running, the server reports `not_running` rather than starting it. To start it, call `indesign_status` with `launch=true`.
- If a call takes longer than 180 s (set `INDESIGN_MCP_TIMEOUT` to change this), the server returns `timeout`. This usually means a dialog is open in InDesign.
- **Batches are not atomic.** CS6 scripting cannot undo, so when an op fails mid-batch the server removes only the items that batch created. Other edits stay, and `error.done` lists what already ran.
- **Quotes**: InDesign converts straight quotes to typographic ones. Pass `typographic_quotes: false` on `indesign_apply` to keep `"` and `'` literal, e.g. for dimensions such as `5'`.
- **Grid fitting**: `grid` uses `fit: "fill"` by default, which crops each image to fill its cell. Use `"proportional"` to show whole images.
- **Batch and source files**: batch only saves the source files if you pass `save: true`.
- **Reading props**: `read what=item props=[...]` looks on the frame first, then on its text (returned as `text.pointSize`). Names it can't find are listed in `unsupported`.
- **If InDesign returns nothing**: the server logs a diagnostic line to `%LOCALAPPDATA%\indesign-mcp\server.log` and switches to its safe, non-persistent execution mode for the rest of the session.
  - Read-only calls (reads, status, capture, export, save_copy) are retried automatically.
  - Writes return `unknown_result`, meaning the change may or may not have been applied. Check with `indesign_read` before retrying.
- **Codex acceptance test**: the prompt is in [docs/CODEX_E2E.md](docs/CODEX_E2E.md).
