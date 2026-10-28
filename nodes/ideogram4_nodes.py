"""Ideogram 4 Prompt Builder Pro (based on the KJ node)."""

import json
import logging
import os
import re

import folder_paths
import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont
from urllib.parse import quote

_BG_LOG = logging.getLogger("byae.ideogram.bg")
BG_DEBUG = False


def _bg_line(msg, *args):
    return "[ByAE Ideogram BG] " + (msg % args if args else msg)


def _bg_log(msg, *args):
    if not BG_DEBUG:
        return
    line = _bg_line(msg, *args)
    _BG_LOG.info("%s", line)
    print(line, flush=True)


def _bg_warn(msg, *args):
    """Surface save/notify failures in the ComfyUI console.

    Success traces stay behind BG_DEBUG. Failures must not, because the
    README tells users to read the console when a background image does not update.
    """
    line = _bg_line(msg, *args)
    _BG_LOG.warning("%s", line)
    print(line, flush=True)

try:
    from comfy_api.latest import io
except ImportError as e:
    raise ImportError(
        "ComfyUI-ByAE-IdeogramTools requires a recent version of ComfyUI "
        "that includes the comfy_api.latest module. "
        "Please update your ComfyUI installation. "
        f"Import error: {e}"
    ) from e

PREVIEW_PALETTE = ["#46b4e6", "#e68246", "#82e646", "#e646b4", "#e6e646", "#46e6c8"]
_FONT_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "fonts", "FreeMono.ttf")
BG_FILENAME_PREFIX = "byae_ideogram_bg_"
_GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def sanitize_bg_guid(guid):
    g = (guid or "").strip()
    if not _GUID_RE.fullmatch(g):
        raise ValueError("invalid background guid")
    return g


def bg_temp_filename(guid):
    return f"{BG_FILENAME_PREFIX}{sanitize_bg_guid(guid)}.png"


def bg_temp_path(guid):
    return os.path.join(folder_paths.get_temp_directory(), bg_temp_filename(guid))


def bg_view_url(guid):
    fname = bg_temp_filename(guid)
    return f"/view?filename={quote(fname)}&type=temp&subfolder="


def notify_bg_updated(guid, path):
    try:
        from server import PromptServer
    except ImportError:
        _bg_warn("notify skipped: PromptServer is not available, so the editor will not get a push")
        return
    if PromptServer is None or PromptServer.instance is None:
        _bg_warn("notify skipped: PromptServer.instance is not available, so the editor will not get a push")
        return
    try:
        safe_guid = sanitize_bg_guid(guid)
        mtime = os.path.getmtime(path)
        payload = {
            "guid": safe_guid,
            "mtime": mtime,
            "url": bg_view_url(safe_guid),
            "path": path,
        }
        PromptServer.instance.send_sync("byae_ideogram_bg_updated", payload, None)
        _bg_log("notify sent guid=%s path=%s", safe_guid, path)
    except Exception as exc:
        _bg_warn("notify failed for %s: %s", path, exc)


def _as_text(value):
    """Caption text. Numbers are kept; other non-strings are dropped.

    A boolean or a list used to reach str.split or iteration and fail the node.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, bool) or value is None:
        return ""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return ""
        return str(value)
    return ""


def _hex_rgb(h):
    # _normalize_hex expands #RGB and rejects values that are not #RRGGBB.
    # int(..., 16) used to raise on a 6-character string that is not hex.
    norm = _normalize_hex(h)
    if not norm:
        return (255, 255, 255)
    return (int(norm[1:3], 16), int(norm[3:5], 16), int(norm[5:7], 16))


def _font(size):
    try:
        return ImageFont.truetype(_FONT_PATH, size)
    except Exception:
        try:
            return ImageFont.load_default(size)
        except Exception:
            return ImageFont.load_default()


def _wrap(draw, text, font, max_w):
    lines = []
    for para in text.split("\n"):
        line = ""
        for word in para.split():
            test = word if not line else line + " " + word
            if line and draw.textlength(test, font=font) > max_w:
                lines.append(line)
                line = word
            else:
                line = test
        lines.append(line)
    return lines


def _coerce_layout_int(value, default=1024):
    try:
        n = int(value)
        return n if n > 0 else default
    except (TypeError, ValueError):
        return default


def _coerce_opacity(value, default=0.5):
    try:
        n = float(value)
        if n != n:
            return default
        return max(0.0, min(1.0, n))
    except (TypeError, ValueError):
        return default


def _tensor_to_pil(image):
    if image is None:
        return None
    arr = (image[0].detach().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def _load_bg_from_temp(guid):
    if not guid or not str(guid).strip():
        return None
    try:
        path = bg_temp_path(str(guid).strip())
    except ValueError:
        return None
    if not os.path.isfile(path):
        return None
    try:
        return Image.open(path).convert("RGBA")
    except Exception:
        return None


def save_bg_image_to_temp(guid, image):
    raw_guid = repr(guid)
    if image is None:
        _bg_warn("background image was not saved: no image was provided (guid=%s)", raw_guid)
        return None
    if not guid or not str(guid).strip():
        _bg_warn(
            "background image was not saved: guid is empty. "
            "Connect the Prompt Builder guid output to Preview BG Update."
        )
        return None
    try:
        path = bg_temp_path(guid)
        safe_guid = sanitize_bg_guid(guid)
    except ValueError as exc:
        _bg_warn(
            "background image was not saved: %s (guid=%s). "
            "Connect the Prompt Builder guid output to Preview BG Update.",
            exc, raw_guid,
        )
        return None
    pil = _tensor_to_pil(image)
    if pil is None:
        _bg_warn("background image was not saved: could not convert the image tensor (guid=%s)", safe_guid)
        return None
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        pil.save(path, "PNG")
        _bg_log("save OK: %s (%sx%s)", path, pil.width, pil.height)
        notify_bg_updated(safe_guid, path)
        return path
    except Exception as exc:
        _bg_warn("background image was not saved: failed to write %s (%s)", path, exc)
        return None


def _render_preview(boxes, width, height, bg_guid="", background_opacity=0.5):
    long_edge = max(width, height)
    scale = min(1.0, 1024 / long_edge) if long_edge > 0 else 1.0
    rw = max(1, round(width * scale))
    rh = max(1, round(height * scale))

    img = Image.new("RGBA", (rw, rh), (0, 0, 0, 255))
    bg_img = _load_bg_from_temp(bg_guid)
    if bg_img is not None:
        bg = bg_img.resize((rw, rh), Image.Resampling.LANCZOS)
        alpha = max(0.0, min(1.0, float(background_opacity)))
        if alpha > 0:
            black = Image.new("RGBA", (rw, rh), (0, 0, 0, 255))
            faded = Image.blend(black, bg, alpha)
            img = Image.alpha_composite(img, faded)

    overlay = Image.new("RGBA", (rw, rh), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    fs = max(10, round(rh / 64))
    font = _font(fs)
    tag_font = _font(max(9, fs - 2))
    lh = fs + 2

    for i, box in enumerate(boxes):
        if not isinstance(box, dict) or box.get("nobbox"):
            continue
        r, g, b = _hex_rgb(PREVIEW_PALETTE[i % len(PREVIEW_PALETTE)])
        edges = _preview_edges(box, rw, rh)
        if edges is None:
            continue
        x1, y1, x2, y2 = edges

        draw.rectangle([x1, y1, x2, y2], outline=(r, g, b, 255), width=2)

        etype = "text" if box.get("type") == "text" else "obj"
        tag = ("T" if etype == "text" else "O") + str(i + 1)
        tw = draw.textlength(tag, font=tag_font)
        draw.rectangle([x1, y1, x1 + tw + 6, y1 + fs + 2], fill=(r, g, b, 255))
        draw.text((x1 + 3, y1 + 1), tag, fill=(0, 0, 0, 255), font=tag_font)

        body = _as_text(box.get("desc", ""))
        if etype == "text":
            text = _as_text(box.get("text", ""))
            if text:
                body = '"%s"%s' % (text, " — " + body if body else "")
        if body and (x2 - x1) > 8:
            ty = y1 + fs + 5
            for line in _wrap(draw, body, font, x2 - x1 - 8):
                if ty > y2:
                    break
                draw.text((x1 + 4, ty), line, fill=(255, 255, 255, 255), font=font)
                ty += lh

        palette = _palette(box.get("palette"), 5)
        ds = max(5, fs - 2)
        for p, hexc in enumerate(palette):
            dx = x1 + 2 + p * (ds + 2)
            if dx + ds > x2:
                break
            draw.rectangle([dx, y2 - ds - 2, dx + ds, y2 - 2], fill=_hex_rgb(hexc), outline=(0, 0, 0, 255))

    img = Image.alpha_composite(img, overlay).convert("RGB")
    arr = np.asarray(img, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _scale_axis(value):
    """Map one finite axis onto Ideogram's integer 0-1000 range.

    Clamp before rounding. round() raises OverflowError once value * 1000
    exceeds the float range, which a hand-edited region can do.
    """
    if value >= 1:
        return 1000
    if value <= 0:
        return 0
    return int(round(value * 1000))


def _box_coords(box):
    """Return x, y, w, h as finite floats, or None when any value is unusable."""
    if not isinstance(box, dict):
        return None
    coords = [_finite_coord(box.get(key, 0.0)) for key in ("x", "y", "w", "h")]
    if any(value is None for value in coords):
        return None
    return coords


def _norm_bbox(box):
    """Return [ymin, xmin, ymax, xmax], or None when a coordinate is unusable.

    Numeric strings are accepted. Booleans are not: True is an int, and
    treating it as 1 used to pin an edge to the far side of the canvas.
    """
    coords = _box_coords(box)
    if coords is None:
        return None
    x, y, w, h = coords
    ymin, xmin, ymax, xmax = (
        _scale_axis(y),
        _scale_axis(x),
        _scale_axis(y + h),
        _scale_axis(x + w),
    )
    if ymin > ymax:
        ymin, ymax = ymax, ymin
    if xmin > xmax:
        xmin, xmax = xmax, xmin
    return [ymin, xmin, ymax, xmax]


def _preview_edges(box, rw, rh):
    """Pixel edges for one region, or None when its coordinates are unusable."""
    coords = _box_coords(box)
    if coords is None:
        return None
    x, y, w, h = coords

    def edge(value, scale):
        if value >= 1:
            return scale
        if value <= 0:
            return 0
        return max(0, min(scale, int(round(value * scale))))

    x1, y1, x2, y2 = edge(x, rw), edge(y, rh), edge(x + w, rw), edge(y + h, rh)
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    return x1, y1, x2, y2


# Ideogram 4 captions accept uppercase #RRGGBB only: 16 style colors, 5 per element.
# https://github.com/ideogram-oss/ideogram4/blob/main/docs/prompting.md
_HEX6 = re.compile(r"^#[0-9A-F]{6}$")
_HEX3 = re.compile(r"^#[0-9A-F]{3}$")
STYLE_PALETTE_MAX = 16
ELEMENT_PALETTE_MAX = 5


def _normalize_hex(color):
    """Return an uppercase #RRGGBB color, expanding #RGB, or None if invalid."""
    if not isinstance(color, str):
        return None
    text = color.strip().upper()
    if _HEX6.match(text):
        return text
    if _HEX3.match(text):
        return "#" + "".join(ch * 2 for ch in text[1:])
    return None


def _palette(colors, limit=None):
    if isinstance(colors, dict):
        colors = list(colors.values())
    elif not isinstance(colors, (list, tuple)):
        return []
    out = []
    for color in colors:
        hex_color = _normalize_hex(color)
        if not hex_color:
            continue
        out.append(hex_color)
        if limit is not None and len(out) >= limit:
            break
    return out


def _dumps(v, lvl=0):
    pad, end = "    " * (lvl + 1), "    " * lvl
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        if not v:
            return "[]"
        if all(not isinstance(x, (dict, list)) for x in v):
            return "[" + ", ".join(_dumps(x, lvl) for x in v) + "]"
        return "[\n" + ", ".join(pad + _dumps(x, lvl + 1) for x in v) + "\n" + end + "]"
    if isinstance(v, dict):
        if not v:
            return "{}"
        items = [pad + json.dumps(k, ensure_ascii=False) + ": " + _dumps(val, lvl + 1) for k, val in v.items()]
        return "{\n" + ",\n".join(items) + "\n" + end + "}"
    return json.dumps(v, ensure_ascii=False)


def _elements_from_boxes(boxes):
    elements = []
    for box in boxes or []:
        if not isinstance(box, dict):
            continue
        etype = "text" if box.get("type") == "text" else "obj"
        elem = {"type": etype}
        if not box.get("nobbox"):
            bbox = _norm_bbox(box)
            if bbox is not None:
                elem["bbox"] = bbox
        if etype == "text":
            elem["text"] = _as_text(box.get("text", ""))
        elem["desc"] = _as_text(box.get("desc", ""))
        palette = _palette(box.get("palette", []), ELEMENT_PALETTE_MAX)
        if palette:
            elem["color_palette"] = palette
        elements.append(elem)
    return elements


def _parse_json_list(s):
    if s:
        try:
            v = json.loads(s)
            if isinstance(v, list):
                return v
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
    return []


def _finite_coord(value):
    """Return a finite float, or None when value is not a usable coordinate."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        value = text
    elif not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _clamp_bbox_axis(value):
    return max(0.0, min(1000.0, value))


def _ideogram_bbox_to_rect(bbox):
    """Map Ideogram [ymin, xmin, ymax, xmax] to x/y/w/h in 0-1 space.

    Returns None when the four values are not finite coordinates. Inverted
    axes are swapped and values are clamped to 0-1000, which is the range
    documented for Ideogram 4 captions.
    """
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None
    coords = [_finite_coord(v) for v in bbox]
    if any(v is None for v in coords):
        return None
    ymin, xmin, ymax, xmax = coords
    if ymin > ymax:
        ymin, ymax = ymax, ymin
    if xmin > xmax:
        xmin, xmax = xmax, xmin
    ymin = _clamp_bbox_axis(ymin)
    xmin = _clamp_bbox_axis(xmin)
    ymax = _clamp_bbox_axis(ymax)
    xmax = _clamp_bbox_axis(xmax)
    return {
        "x": xmin / 1000.0,
        "y": ymin / 1000.0,
        "w": (xmax - xmin) / 1000.0,
        "h": (ymax - ymin) / 1000.0,
    }


def _fallback_region(index):
    # Rows of 4. Same spacing as the editor so pasted captions do not overlap.
    safe_index = index if isinstance(index, int) and index >= 0 else 0
    row, col = divmod(safe_index, 4)
    return {
        "x": 0.02 + col * 0.25,
        "y": 0.02 + row * 0.17,
        "w": 0.22,
        "h": 0.14,
        "nobbox": True,
    }


def _caption_to_boxes(caption):
    cd = caption.get("compositional_deconstruction", {}) if isinstance(caption, dict) else {}
    boxes = []
    for idx, el in enumerate(cd.get("elements", []) or []):
        if not isinstance(el, dict):
            continue
        box = {"type": "text" if el.get("type") == "text" else "obj",
               "text": el.get("text", ""), "desc": el.get("desc", ""),
               "palette": el.get("color_palette", []) or []}
        rect = _ideogram_bbox_to_rect(el.get("bbox"))
        if rect is None:
            box.update(_fallback_region(idx))
        else:
            box.update(rect)
        boxes.append(box)
    return boxes


class Ideogram4PromptBuilderKJEnhancedByAE(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="Ideogram4PromptBuilderKJEnhancedByAE",
            display_name="Ideogram 4 Prompt Builder Pro (based on the KJ node)",
            category="ByAE/Ideogram",
            search_aliases=["ideogram", "caption", "bbox", "prompt builder", "json prompt", "byae", "pro"],
            is_experimental=True,
            description="""
Visual prompt builder for Ideogram 4's structured JSON caption format (Pro, based on the KJ node).

Connect the guid output to Preview BG Update. Background images are written to the ComfyUI temp
folder and picked up automatically by the editor.""",
            inputs=[
                io.Int.Input("width", default=1024, min=64, max=16384, step=8,
                             tooltip="Canvas aspect width."),
                io.Int.Input("height", default=1024, min=64, max=16384, step=8,
                             tooltip="Canvas aspect height."),
                io.Combo.Input(
                    "scale_mode",
                    display_name="Scale Mode (on width/height change)",
                    options=[
                        "center", "top-left", "top", "top-right", "center-left",
                        "center-right", "bottom-left", "bottom", "bottom-right", "stretch",
                    ],
                    default="stretch",
                    tooltip="How regions move when Update Size is clicked.",
                ),
                io.String.Input("high_level_description", multiline=True, default="",
                                tooltip="Optional one-line overview of the whole image (blank = omitted)."),
                io.String.Input("background", multiline=True, default="",
                                tooltip="Required scene background description."),
                io.DynamicCombo.Input("style", options=[
                    io.DynamicCombo.Option("none", []),
                    io.DynamicCombo.Option("photo", [
                        io.String.Input("photo", default=""),
                    ]),
                    io.DynamicCombo.Option("art_style", [
                        io.String.Input("art_style", default=""),
                    ]),
                ]),
                io.String.Input("aesthetics", default="",
                                tooltip="Style descriptor. Included even when blank; the style block is omitted only when style is none."),
                io.String.Input("lighting", default="",
                                tooltip="Style descriptor. Included even when blank; the style block is omitted only when style is none."),
                io.String.Input("medium", default="",
                                tooltip="Style descriptor. Included even when blank; the style block is omitted only when style is none."),
                io.String.Input("import_json", default="", optional=True, force_input=True,
                                tooltip="Optional: a full caption JSON. When connected, overrides the editor."),
                io.Float.Input("background_opacity", default=0.5, min=0.0, max=1.0, step=0.05,
                               tooltip="Canvas background image opacity (0 = hidden, 1 = full)."),
                io.String.Input("bg_guid", default="", socketless=True, advanced=True,
                                tooltip="Background file id (set automatically by the editor)."),
                io.String.Input("style_palette_data", default="", socketless=True, advanced=True,
                                tooltip="Serialized style color palette from the editor."),
                io.String.Input("elements_data", default="", socketless=True, advanced=True,
                                tooltip="Serialized regions from the editor."),
            ],
            outputs=[
                io.String.Output(display_name="prompt"),
                io.Image.Output(display_name="preview"),
                io.Int.Output(display_name="width"),
                io.Int.Output(display_name="height"),
                io.String.Output(display_name="guid"),
            ],
        )

    @classmethod
    def execute(cls, width, height, background, style,
                high_level_description="", aesthetics="", lighting="", medium="",
                style_palette_data="", elements_data="", import_json="",
                background_opacity=0.5, bg_guid="", scale_mode="stretch") -> io.NodeOutput:
        width = _coerce_layout_int(width)
        height = _coerce_layout_int(height)
        background_opacity = _coerce_opacity(background_opacity)
        guid = (bg_guid or "").strip()

        if import_json and import_json.strip():
            try:
                cap = json.loads(import_json)
                if isinstance(cap, dict):
                    preview = _render_preview(_caption_to_boxes(cap), width, height, guid, background_opacity)
                    return io.NodeOutput(_dumps(cap), preview, width, height, guid)
            except (json.JSONDecodeError, TypeError, ValueError):
                pass

        boxes = _parse_json_list(elements_data)

        caption = {}
        if high_level_description.strip():
            caption["high_level_description"] = high_level_description

        kind = style["style"]
        if kind != "none":
            sd = {"aesthetics": aesthetics, "lighting": lighting}
            if kind == "photo":
                sd["photo"] = style.get("photo", "")
                sd["medium"] = medium
            else:
                sd["medium"] = medium
                sd["art_style"] = style.get("art_style", "")
            palette = _palette(_parse_json_list(style_palette_data), STYLE_PALETTE_MAX)
            if palette:
                sd["color_palette"] = palette
            caption["style_description"] = sd

        elements = _elements_from_boxes(boxes)

        caption["compositional_deconstruction"] = {
            "background": background,
            "elements": elements,
        }
        preview = _render_preview(boxes, width, height, guid, background_opacity)
        return io.NodeOutput(_dumps(caption), preview, width, height, guid)


class Ideogram4PromptBuilderKJPreviewUpdateByAE(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="Ideogram4PromptBuilderKJPreviewUpdateByAE",
            display_name="Ideogram 4 Prompt Builder Pro - Preview BG Update",
            category="ByAE/Ideogram",
            search_aliases=["ideogram", "preview", "background", "byae", "pro"],
            description="""
Writes the input image to the ComfyUI temp folder as byae_ideogram_bg_{guid}.png.
Connect guid from the Prompt Builder guid output. The builder editor polls that file
and updates the canvas background automatically.""",
            inputs=[
                io.Image.Input("image", tooltip="Image to use as the builder canvas background."),
                io.String.Input("guid", force_input=True,
                                tooltip="Background id from Prompt Builder guid output."),
            ],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, image, guid) -> io.NodeOutput:
        _bg_log("Preview BG Update execute guid=%s image=%s", repr(guid), type(image).__name__)
        path = save_bg_image_to_temp(guid, image)
        if path is None:
            _bg_log(
                "Preview BG Update finished without writing a file. "
                "Expected filename: byae_ideogram_bg_{guid}.png in %s",
                folder_paths.get_temp_directory(),
            )
        return io.NodeOutput()
