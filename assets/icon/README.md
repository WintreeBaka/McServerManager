# Application icon

The production SVG icon is stored at:

`assets/icon/app.svg`

The multi-resolution Windows executable icon is generated from the same design:

`assets/icon/app.ico`

The desktop client already searches for this file beside the executable and in
the source tree. Draft images remain local; only the approved production asset
and this README are tracked.

To replace the icon, overwrite `app.svg` and run `python tools/render-app-icon.py`
to regenerate `app.ico`. The packaging script copies both files into the GUI
release; CMake embeds the ICO into the Windows executable.
