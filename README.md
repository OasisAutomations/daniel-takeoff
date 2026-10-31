# Daniel Takeoff

Plan takeoff and estimating app for any trade: scale, length, area, count, product pricing, estimate export, checklists,
markups, and drafting on blank pages.
Runs entirely in the browser; plans and projects are stored only on the device (IndexedDB). No uploads, no analytics.

## Blank pages and drafting (v1.7, v1.7.1)

- **Blank page…** (empty screen, the **+ Blank** button next to **+ PDF**, or the **Draw** tab in the bottom panel) adds a blank
  white sheet to the current takeoff, landscape or portrait (default Tabloid landscape). Sizes: ANSI (Letter 8.5x11,
  Legal 8.5x14, Tabloid/ANSI B 11x17, ANSI C 17x22, ANSI D 22x34, ANSI E 34x44), Architectural (Arch A 9x12, B 12x18,
  C 18x24, D 24x36, E1 30x42, E 36x48), ISO (A4, A3, A2, A1, A0) or custom W x H inches. A blank page's sheet size can be
  changed later (Draw tab → This sheet); markups stay put. A sheet scale preset (1/8", 1/4", 1/2", 1" or
  3" = 1'-0") is applied automatically. It's a real one-page PDF built in the browser, so every takeoff, print and export feature works on it.
- **Draw tools**: plan line / polyline, plan rectangle, wall, dimension. Type exact lengths (feet-inches like `10'6"`) and
  angles, or width × height for rectangles, in the Draw tab. Grid (G) with snap-to-grid, ortho (O or hold Shift), and snap to
  endpoints and midpoints (these snaps also help the length and area takeoff tools).
- Plan lines, rectangles and dimensions are linework: they print with the drawing but never count toward quantities.
- **Walls** have real thickness (2x4 4-1/2", 2x6 6-1/2", 3-5/8" metal stud with 5/8" GWB, or custom) drawn with architectural
  patterns. A wall is a length takeoff (centerline LF) for the picked product; turn on **Wall area = LF × height** in the Draw
  tab (or set a height in Properties) to get wall SF.
- **Patterns**: the basic hatches plus materials (stud, CMU, concrete, brick, insulation, gypsum board, wood, earth, gravel,
  tile) and surface textures (orange peel, knockdown, smooth, popcorn, wood grain, carpet, mosaic tile). Material and texture
  patterns are drawn at real size on scaled pages and show in print and in the legend. **Insert pattern key** (Draw tab) drops
  a labelled key of every material and texture on the sheet.
- Value labels are placed clear of plan linework and openings (v1.7.1); snapping reach is capped at about 2' of real length so
  zoomed-out phone views don't grab distant points.

Prints save as "<takeoff name> Takeoff" (summary) and "<takeoff name> Takeoff - Drawing".

Vendored: pdf.js 4.10.38 (Apache-2.0), SheetJS Community Edition 0.20.3 (Apache-2.0).
