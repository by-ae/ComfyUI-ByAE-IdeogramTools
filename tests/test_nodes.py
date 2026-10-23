"""Unit tests for nodes/ideogram4_nodes.py prompt assembly and validation."""

import json
import unittest

# conftest.py handles mocking and path setup
from nodes.ideogram4_nodes import (
    sanitize_bg_guid, _norm_bbox, _palette, _dumps, _parse_json_list,
    _caption_to_boxes, _coerce_layout_int, _coerce_opacity
)


class TestPromptHelpers(unittest.TestCase):
    def test_sanitize_bg_guid_valid(self):
        valid_guid = "12345678-1234-4abc-8abc-123456789012"
        self.assertEqual(sanitize_bg_guid(valid_guid), valid_guid)
        
        # Test uppercase
        upper_guid = "12345678-1234-4ABC-8ABC-123456789012"
        self.assertEqual(sanitize_bg_guid(upper_guid), upper_guid)

    def test_sanitize_bg_guid_invalid(self):
        with self.assertRaises(ValueError):
            sanitize_bg_guid("not-a-guid")
        
        with self.assertRaises(ValueError):
            sanitize_bg_guid("")
        
        with self.assertRaises(ValueError):
            sanitize_bg_guid("12345678-1234-4abc-8abc")  # Too short
        
        # Path traversal attempt
        with self.assertRaises(ValueError):
            sanitize_bg_guid("../../etc/passwd")

    def test_norm_bbox_basic(self):
        box = {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4}
        result = _norm_bbox(box)
        self.assertEqual(result, [200, 100, 600, 400])

    def test_norm_bbox_swap_coords_if_inverted(self):
        # Test ymin > ymax case
        box = {"x": 0.1, "y": 0.6, "w": 0.3, "h": -0.4}
        result = _norm_bbox(box)
        # Should swap ymin and ymax
        self.assertEqual(result[0], min(result[0], result[2]))
        self.assertEqual(result[2], max(result[0], result[2]))

    def test_norm_bbox_clamps_to_1000(self):
        box = {"x": 0.0, "y": 0.0, "w": 2.0, "h": 2.0}
        result = _norm_bbox(box)
        self.assertTrue(all(0 <= v <= 1000 for v in result))

    def test_norm_bbox_missing_fields(self):
        # Should handle missing fields gracefully
        box = {}
        result = _norm_bbox(box)
        self.assertEqual(result, [0, 0, 0, 0])

    def test_palette_filters_empty_strings(self):
        colors = {"c1": "#FF0000", "c2": "", "c3": "#00FF00", "c4": None}
        result = _palette(colors)
        self.assertEqual(result, ["#FF0000", "#00FF00"])

    def test_palette_uppercase(self):
        colors = ["#ff0000", "#00ff00"]
        result = _palette(colors)
        self.assertEqual(result, ["#FF0000", "#00FF00"])

    def test_dumps_string(self):
        result = _dumps("hello")
        self.assertEqual(result, '"hello"')

    def test_dumps_list_simple(self):
        result = _dumps([1, 2, 3])
        self.assertEqual(result, "[1, 2, 3]")

    def test_dumps_list_nested(self):
        result = _dumps([{"a": 1}, {"b": 2}])
        self.assertIn("[\n", result)
        self.assertIn('"a": 1', result)

    def test_dumps_dict(self):
        result = _dumps({"key": "value", "num": 123})
        self.assertIn('"key": "value"', result)
        self.assertIn('"num": 123', result)

    def test_dumps_unicode(self):
        result = _dumps({"text": "Hello 世界"})
        self.assertIn("世界", result)

    def test_parse_json_list_valid(self):
        result = _parse_json_list('[{"x": 1}, {"y": 2}]')
        self.assertEqual(result, [{"x": 1}, {"y": 2}])

    def test_parse_json_list_invalid(self):
        result = _parse_json_list("not json")
        self.assertEqual(result, [])

    def test_parse_json_list_not_list(self):
        result = _parse_json_list('{"key": "value"}')
        self.assertEqual(result, [])

    def test_parse_json_list_empty(self):
        result = _parse_json_list("")
        self.assertEqual(result, [])

    def test_caption_to_boxes_valid(self):
        caption = {
            "compositional_deconstruction": {
                "elements": [
                    {
                        "type": "text",
                        "text": "Hello",
                        "desc": "A greeting",
                        "bbox": [100, 200, 300, 400],
                        "color_palette": ["#FF0000"]
                    }
                ]
            }
        }
        result = _caption_to_boxes(caption)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["type"], "text")
        self.assertEqual(result[0]["text"], "Hello")
        self.assertAlmostEqual(result[0]["x"], 0.2)
        self.assertAlmostEqual(result[0]["y"], 0.1)

    def test_caption_to_boxes_missing_bbox(self):
        caption = {
            "compositional_deconstruction": {
                "elements": [
                    {"type": "obj", "desc": "No bbox"}
                ]
            }
        }
        result = _caption_to_boxes(caption)
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0]["nobbox"])

    def test_caption_to_boxes_invalid_bbox(self):
        caption = {
            "compositional_deconstruction": {
                "elements": [
                    {"type": "obj", "desc": "Bad bbox", "bbox": "not a list"}
                ]
            }
        }
        result = _caption_to_boxes(caption)
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0]["nobbox"])

    def test_caption_to_boxes_empty(self):
        result = _caption_to_boxes({})
        self.assertEqual(result, [])

    def test_coerce_layout_int_valid(self):
        self.assertEqual(_coerce_layout_int(512), 512)
        self.assertEqual(_coerce_layout_int("1024"), 1024)
        self.assertEqual(_coerce_layout_int(2048.7), 2048)

    def test_coerce_layout_int_invalid(self):
        self.assertEqual(_coerce_layout_int(0), 1024)
        self.assertEqual(_coerce_layout_int(-100), 1024)
        self.assertEqual(_coerce_layout_int("not a number"), 1024)
        self.assertEqual(_coerce_layout_int(None), 1024)

    def test_coerce_opacity_valid(self):
        self.assertEqual(_coerce_opacity(0.5), 0.5)
        self.assertEqual(_coerce_opacity(0), 0.0)
        self.assertEqual(_coerce_opacity(1), 1.0)
        self.assertEqual(_coerce_opacity("0.75"), 0.75)

    def test_coerce_opacity_clamping(self):
        self.assertEqual(_coerce_opacity(-1), 0.0)
        self.assertEqual(_coerce_opacity(2), 1.0)
        self.assertEqual(_coerce_opacity(1.5), 1.0)

    def test_coerce_opacity_invalid(self):
        self.assertEqual(_coerce_opacity("not a number"), 0.5)
        self.assertEqual(_coerce_opacity(None), 0.5)
        self.assertEqual(_coerce_opacity(float('nan')), 0.5)


class TestPromptAssembly(unittest.TestCase):
    """Test full prompt assembly logic without ComfyUI runtime."""
    
    def test_build_minimal_caption(self):
        # Simulate minimal inputs
        boxes = []
        background = "A simple scene"
        
        caption = {
            "compositional_deconstruction": {
                "background": background,
                "elements": []
            }
        }
        
        json_str = _dumps(caption)
        self.assertIn('"background":', json_str)
        self.assertIn('"A simple scene"', json_str)

    def test_build_caption_with_elements(self):
        boxes = [
            {
                "type": "text",
                "text": "HELLO",
                "desc": "Large text",
                "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4,
                "palette": ["#FF0000", "#00FF00"]
            },
            {
                "type": "obj",
                "desc": "A circle",
                "x": 0.5, "y": 0.5, "w": 0.2, "h": 0.2,
                "palette": []
            }
        ]
        
        elements = []
        for box in boxes:
            elem = {"type": box["type"]}
            if "nobbox" not in box:
                elem["bbox"] = _norm_bbox(box)
            if box["type"] == "text":
                elem["text"] = box["text"]
            elem["desc"] = box["desc"]
            pal = _palette(box["palette"])
            if pal:
                elem["color_palette"] = pal
            elements.append(elem)
        
        self.assertEqual(len(elements), 2)
        self.assertEqual(elements[0]["type"], "text")
        self.assertEqual(elements[0]["text"], "HELLO")
        self.assertEqual(elements[1]["type"], "obj")
        self.assertEqual(len(elements[0]["color_palette"]), 2)


if __name__ == "__main__":
    unittest.main()
