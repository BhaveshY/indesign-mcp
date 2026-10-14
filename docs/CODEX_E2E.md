# Codex acceptance test

Paste the prompt below into Codex, or run it non-interactively:

```powershell
codex exec (Get-Content -Raw .\docs\CODEX_E2E.md)
```

InDesign must be running. The test only creates and edits a new untitled document and files in `%TEMP%\indesign-codex-e2e`.

---

You are running an end-to-end acceptance test of the "indesign" MCP server (Adobe InDesign via COM). Use ONLY the indesign_* MCP tools for InDesign work. Do not use screen automation, and do not open, modify or save any existing user document. Work only in a NEW untitled document and in the scratch folder %TEMP%\indesign-codex-e2e (create it; you may use the shell only to create test assets there and to check that output files exist).

Rules:
- Put all edits for a step into ONE indesign_apply call.
- On any error, read error.next and follow it once; do not loop.
- Units are mm for geometry; text sizes are pt. Pages are 1-based.
- After each step, verify with indesign_read (or indesign_capture for visual steps). Never assume success from the write alone.

Setup assets (shell): in the scratch folder create imgs\ with 5 small PNG files named "Ansicht 1.png" … "Ansicht 5.png", and raeume.csv encoded Windows-1252 with semicolons:
Raum;Fläche m²;Bemerkung
Wohnen;"32,5";"mit ""Loggia"""
Bad;6,5;

Steps (record PASS/FAIL + evidence for each):
1. indesign_status → InDesign reachable; note version and open docs.
2. indesign_document action=new: A4 (210×297), 3 pages, facing=false, margins [15,15,20,15], 2 columns, gutter 5. Note the doc name and pass it as `doc` in every later call.
3. One indesign_apply: swatch "Test Blue" CMYK [90,50,0,0]; paragraph styles "Title" (28 pt, Test Blue) and "Body" (9.5 pt, leading 13); character style "Bold" (fontStyle Bold); layer "Images"; text frame "Title" on page 1 with text "{{Projekt}} – Stand {{Datum}} {{Bauherr}}" in style Title; text frame "Body" with two paragraphs containing the word "Baukörper"; a rectangle filled Test Blue; an ellipse; a line.
4. Verify via read what=items page=1, what=item id="Title" props=["pointSize","noSuchProperty"] (expect text.pointSize 28 and unsupported ["noSuchProperty"]), what=text id="Body" detail=true, what=styles, what=swatches (expect Test Blue CMYK values [90,50,0,0]), what=layers.
5. One apply: fill data {Projekt:"Wohnquartier Spreeufer", Datum:"14.10.2026"} → expect total 2 and unfilled ["{{Bauherr}}"]; text op on "Body" with match "Baukörper" char_style "Bold"; replace "Lorem"→"Entwurf" (if present) or dry_run a GREP replace.
6. Page 2, one apply: grid folder=imgs captions=true gutter=4; table csv=raeume.csv header_rows=1 below the grid; three rectangles A1,A2,A3 at different x/y, then align them to top and distribute horizontally with gap 10.
   Verify: read what=items page=2 type=Rectangle shows 5 linked images; read what=tables id=<table> shows "Fläche m²" decoded correctly; A1..A3 share the same y and gaps are 10 mm (±0.05).
   Then one apply with typographic_quotes=false creating a text frame with text Typ "A" 5' → read it back raw: quotes must be straight.
7. Create a text frame on page 3 with ~60 long paragraphs (overset), then apply op=flow on it → overset false, pages_added ≥ 1. Confirm with read what=document (issues.overset empty; counts.items equals read what=items total).
8. indesign_capture page 1 and page 2 → look at the images and describe whether title, grid, captions and table look correct.
9. Error handling (must return isError with error.next, and change nothing):
   a) apply set id=999999; b) apply with ops [create rect, set "Title" props {noSuchProperty:1}] → the created rect must be removed (compare read what=items total before/after); c) read what="nope".
10. indesign_script: return {pages: D.pages.length, frames: D.textFrames.length}.
11. Exports into the scratch folder: PDF pages "1-2" with preset "[PDF/X-4:2008]" crop_marks=true bleed=true; PNG page 1 at 72 dpi; IDML. Verify the files exist and are > 0 bytes.
12. save_copy the doc twice into scratch\batch\ ("Blatt A.indd", "Blatt B.indd"), then indesign_document action=batch folder=scratch\batch fill={data:{Bauherr:"WBM"}} preflight=true export={format:"pdf", dir:"scratch\batch\pdf", pages:"1"} → expect ok=2 and filled=1 per file; verify the PDFs exist and that the .indd files were not modified (no save=true).
13. Cleanup: close the test document with save=false (close without save must first error with code unsaved_changes, then succeed with save=false). indesign_status must not list the test document anymore.

Final report: a table Step | Result | Evidence (key values, ids, counts, timings if visible), then a list of any bugs or confusing tool behaviour with the exact call and response, and suggestions to improve tool descriptions. Do not fix anything in the repo.
