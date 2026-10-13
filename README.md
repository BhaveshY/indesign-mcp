# InDesign MCP

Local MCP server for Adobe InDesign on Windows. It's pure Python (stdlib only, no pip installs) and talks to the running InDesign over COM. Each tool call runs one ExtendScript batch in InDesign, which typically takes about 20 ms.

Tested live against InDesign CS6 (8.0). The server also tries the ProgIDs of newer versions (`InDesign.Application.2023`–`2026`), but those versions have not been tested.

## Tools (6)

| Tool | What it does |
|---|---|
| `indesign_status` | Connection check, open docs, active doc/page, selection count (`launch=true` starts InDesign) |
| `indesign_read` | `what=` document · pages · items · item (raw DOM props) · text · find (text/GREP) · styles · swatches · layers · links · fonts · selection · tables · masters · presets · issues. Paginated (`offset`/`limit` → `next_offset`) |
| `indesign_apply` | One batch of ops: create · place · set · text · replace · delete · duplicate · group · ungroup · arrange · fit · pages · layer · style · swatch · table · cells · relink · select · document. Inputs are checked before anything runs. Items it created are removed if an op fails |
| `indesign_document` | new · open · info · activate · save · save_copy · close · export (pdf/png/jpg/idml/eps/rtf/txt) · package · undo/redo · preflight · zoom |
| `indesign_capture` | PNG of a page, a spread or a single item, returned as an image |
| `indesign_script` | Raw ExtendScript with helpers in scope (`D`, `item`, `page`, `info`, `setProps`) |

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
- If InDesign is not running, the server reports `not_running` rather than starting it. To start it, call `indesign_status` with `launch=true`.
- If a call takes longer than 180 s (set `INDESIGN_MCP_TIMEOUT` to change this), the server returns `timeout`. This usually means a dialog is open in InDesign.
- Scripted `undo()` is unreliable in CS6, so a failed batch only removes the items it created. Edits made by earlier ops in that batch are reported in `error.done`.
