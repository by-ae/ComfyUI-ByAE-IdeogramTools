# ComfyUI-ByAE-IdeogramTools

An improved version of [Kijai](https://github.com/kijai)'s excellent **Ideogram 4 Prompt Builder** from [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes). Same node (literally built on top of), replacement drop in, but with workflow and live editor QoL layered on top.

I may add other Ideogram 4 tools here in future, hence the name.

![Ideogram 4 Prompt Builder Pro](assets/demo.png)

## Nodes

| Node | Role |
|------|------|
| **Ideogram 4 Prompt Builder Pro (based on the KJ node)** | Main visual prompt builder |
| **Ideogram 4 Prompt Builder Pro - Preview BG Update** | Feeds a workflow image into the builder's canvas background |

## Improvements over the KJ builder

- **Character/Object store** — Save, Save As, and Load named characters/objects
- **Save/Load entire scenes** — save and restore full scenes (boxes, overview, aesthetic, style colors, and the rest); add imported boxes (selected by default) or wipe and replace the entire scene
- **Multi-select (Shift+click individual or Shift-drag to select and move/scale them all)** — Shift+drag a selection rectangle; any partially overlapping box is included, the entire selection can be moved around or scaled uniformly on the sides or corners. Shift+click a box to add or remove it from the selection
- **Live background image** — Preview BG Update pushes a workflow image onto the builder canvas; opacity slider blends it over black
- **Copy and paste** — Ctrl+C / Ctrl+V for selected boxes (geometry and field data)
- **Scale mode on resize** — center, corner anchors, or stretch when canvas width/height change. Non-stretch modes scale from the bounding box of your regions and crop unused canvas space when narrowing
- **Paste JSON resize dialog** — when pasting layout JSON, choose how the source canvas was sized (don't care / same / dimensions / aspect ratio) and it will perform content-aware scaling of the pasted regions.
- **Width and height outputs** — separate INT sockets for downstream workflow use
- **Update Size button** — width/height edits apply only when you click Update Size (with chosen scale mode).

## Installation

1. Clone into `ComfyUI/custom_nodes/`:
```bash
# open a terminal in the ComfyUI/custom_nodes directory
git clone https://github.com/by-ae/ComfyUI-ByAE-IdeogramTools.git
```
2. Restart ComfyUI

**ComfyUI-KJNodes does not need to be installed.**

## License

This project is a derivative work based on **ComfyUI-KJNodes**, in particular `Ideogram4PromptBuilderKJ` and shared frontend utilities.

- Licensed under **GNU General Public License v3.0** — same as [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes). See [LICENSE](LICENSE).
- Copyright for the original Ideogram 4 Prompt Builder and related KJNodes code belongs to [Kijai](https://github.com/kijai) and other KJNodes contributors.
- Enhancements in this repository are provided under the same GPL-3.0 terms. If you distribute this pack, keep the license file and preserve appropriate attribution to Kijai / ComfyUI-KJNodes.
