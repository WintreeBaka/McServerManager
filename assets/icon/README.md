# Application icon

The production SVG icon will be added for 1.3.1 at:

`assets/icon/app.svg`

The desktop client already searches for this file beside the executable and in
the source tree. Until the final asset is supplied it draws a temporary
placeholder icon so the window and taskbar are not blank.

All files in this directory except this README are ignored by Git to prevent
partial or generated icon drafts from being pushed accidentally. When the final
asset is approved for 1.3.1, force-add that exact file or narrow the ignore rule.
