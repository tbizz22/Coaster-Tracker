COASTER ATTACK — BRAND & ASSET PACKAGE (v1.0, Direction 1a)
========================================================

COLORS
  Coaster Red    #E8362E   (tile / accents / theme-color)
  Ticket Yellow  #FFC629   (track glyph / highlights)
  Electric Blue  #2FA8FF   (secondary accent)
  Ink            #0E1016   (primary background)
  Steel          #2A3042   (surfaces)
  Cloud          #F5F6FA   (light background)

TYPE
  Display / logo : Bangers   (Google Fonts)
  UI / body      : Inter     (Google Fonts)

FOLDERS
  /logo        Primary logo, lockups, wordmark, burst mark
               - .svg files are the MASTER artwork (scalable, editable).
                 Text logos load 'Bangers' via a webfont @import, so they
                 render correctly in any browser. For print/offline tools
                 that don't fetch webfonts, convert text to outlines, or
                 use the PNGs in /logo/png.
  /icons       App icon + favicon
               - app-icon.svg            master vector tile
               - app-icon-maskable.svg   Android adaptive (safe zone)
               - mark-*.svg              1-color track glyph
               - favicon.ico             16/32/48 combined
               - /png/*                  raster at every needed size
  /ui-icons    10 line icons for the app UI (svg + /png)
               coaster, loop, ticket, credit, park-map, ride-car,
               wait-time, milestone, ride-log, thrill
               - stroke="#FFC629"; recolor via the stroke attribute or
                 replace with currentColor to inherit text color.

WEB SETUP
  Copy /icons, /site.webmanifest to your web root and paste the tags in
  favicon-head-snippet.html into <head>.

CLEAR SPACE
  Keep at least one burst star-point of clear space around the logo.
  Never recolor the full burst outside the palette — use the 1-color
  outline mark (logo/mark-burst-outline-*.svg) instead.
