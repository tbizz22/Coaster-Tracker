COASTER ATTACK — BRAND & ASSET PACKAGE (v2.0)
=============================================
Replaces v1 ("Direction 1a"). All text is converted to outlines, so every
SVG renders the same everywhere with no font loading.

THE SYSTEM
  Hero badge   The lead car head-on (riders' hands up) on a yellow burst,
               inside a scalloped red band: COASTER ATTACK on top,
               "EVERY CREDIT COUNTS" on the bottom. Use at 96px and up.
  Small mark   One continuous coaster track that draws "CA": a loop for the
               C, then a lift hill and drop for the A. Used for the app icon,
               favicon and anywhere under ~96px.
               - 64px and up: ladder track (two rails + ties)
               - under 64px: one solid rail (favicon.svg / 16-48px PNGs)

COLORS
  Coaster Red    #E8362E   (band / tile / theme-color)
  Ticket Yellow  #FFC629   (track, nose dome, highlights)
  Electric Blue  #2FA8FF   (sky, wordmark shadow)
  Ink            #0E1016   (outlines, dark background)
  Steel          #2A3042   (car body, surfaces)
  Cloud          #F5F6FA   (light background)

TYPE
  Display / logo : Bangers   (Google Fonts) — already outlined in the logo files
  UI / body      : Inter     (Google Fonts)

FOLDERS
  /logo
    badge.svg              hero badge (master, 240 box)
    logo-horizontal.svg    badge + two-line wordmark
    logo-stacked.svg       badge over one-line wordmark
    wordmark.svg           comic wordmark (ink outline + blue shadow), light or dark bg
    wordmark-black.svg     flat 1-color, for light backgrounds / print
    wordmark-white.svg     flat 1-color, for dark backgrounds
    /png                   raster exports
  /icons
    app-icon.svg           rounded red tile + ladder-track CA (64px and up)
    favicon.svg            same tile, solid-rail CA (tuned for 16-48px)
    app-icon-maskable.svg  full-bleed tile, mark inside Android safe zone
    mark-yellow.svg        color mark, no tile (for dark backgrounds)
    mark-mono-black.svg    1-color mark
    mark-mono-white.svg    1-color mark
    favicon.ico            16/32/48 combined
    /png                   every size the web manifest / iOS / browsers need
  /ui-icons                10 line icons, stroke="currentColor" (inherit text color)
    coaster, loop and ride-car were redrawn to match the new marks;
    the other seven are unchanged apart from currentColor.
    /png are rendered in Ticket Yellow.

WEB SETUP
  Copy /icons and site.webmanifest to your web root and paste the tags in
  favicon-head-snippet.html into <head>. Note the SVG favicon now points at
  favicon.svg (the small-size version), not app-icon.svg.

USAGE
  - Keep clear space of at least one scallop point around the badge.
  - Don't place the badge below ~96px; switch to the small mark.
  - Don't recolor the badge. For 1-color needs use the mono mark + wordmark.
