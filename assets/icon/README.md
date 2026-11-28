# Application icon

The production SVG icon is stored at:

`assets/icon/app.svg`

The desktop client already searches for this file beside the executable and in
the source tree. Draft images remain local; only the approved production asset
and this README are tracked.

To replace the icon, overwrite `app.svg`. The packaging script copies it into
the GUI release under the same relative path.
