# Daniel Takeoff

Plan takeoff and estimating app for any trade: scale, length, area, count, product pricing, estimate export, checklists,
markups, and drafting on blank pages.
Runs entirely in the browser; plans and projects are stored only on the device (IndexedDB). No uploads, no analytics.

## Blank pages and drafting (v1.7)

- **Blank page…** (empty screen, the **+ Blank** button next to **+ PDF**, or the **Draw** tab in the bottom panel) adds a blank
  white sheet to the current takeoff: Letter 8.5x11, Tabloid 11x17 or Arch D 24x36, landscape or portrait (default Tabloid
  landscape), with a sheet scale preset (1/8", 1/4", 1/2", 1" or 3" = 1'-0") applied automatically. It's a real one-page PDF
  built in the browser, so every takeoff, print and export feature works on it.
- **Draw tools**: plan line / polyline, plan rectangle, wall, dimension. Type exact lengths (feet-inches like `10'6"`) and
  angles, or width × height for rectangles, in the Draw tab. Grid (G) with snap-to-grid, ortho (O or hold Shift), and snap to
  endpoints and midpoints (these snaps also help the length and area takeoff tools).
- Plan lines, rectangles and dimensions are linework: they print with the drawing but never count toward quantities.
- **Walls** have real thickness (2x4 4-1/2", 2x6 6-1/2", 3-5/8" metal stud with 5/8" GWB, or custom) drawn with architectural
  patterns. A wall is a length takeoff (centerline LF) for the picked product; give it a height to get wall SF.
- **Patterns**: the basic hatches plus materials (stud, CMU, concrete, brick, insulation, gypsum board, wood, earth, gravel,
  tile) and surface textures (orange peel, knockdown, smooth, popcorn, wood grain, carpet, mosaic tile). Material and texture
  patterns are drawn at real size on scaled pages and show in print and in the legend.

Prints save as "<takeoff name> Takeoff" (summary) and "<takeoff name> Takeoff - Drawing".

Vendored: pdf.js 4.10.38 (Apache-2.0), SheetJS Community Edition 0.20.3 (Apache-2.0).
