"""Unit tests for the store module."""

import json
import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Mock folder_paths before importing store
sys.modules['folder_paths'] = MagicMock()

from store import _validate_name, load_bucket, save_entry, delete_entry


class TestStore(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.patcher = patch('store.folder_paths')
        self.mock_folder_paths = self.patcher.start()
        self.mock_folder_paths.get_user_directory.return_value = self.temp_dir

    def tearDown(self):
        self.patcher.stop()
        import shutil
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)

    def test_validate_name_valid(self):
        self.assertEqual(_validate_name("MyCharacter"), "MyCharacter")
        self.assertEqual(_validate_name("char_123"), "char_123")
        self.assertEqual(_validate_name("test-name"), "test-name")
        self.assertEqual(_validate_name("name with spaces"), "name with spaces")

    def test_validate_name_invalid(self):
        with self.assertRaises(ValueError):
            _validate_name("")
        with self.assertRaises(ValueError):
            _validate_name(" ")
        with self.assertRaises(ValueError):
            _validate_name("_starts_with_underscore")
        with self.assertRaises(ValueError):
            _validate_name("-starts-with-dash")
        with self.assertRaises(ValueError):
            _validate_name("has/slash")
        with self.assertRaises(ValueError):
            _validate_name("has\\backslash")
        with self.assertRaises(ValueError):
            _validate_name("a" * 65)

    def test_save_and_load_entry(self):
        test_data = {"desc": "A test character", "palette": ["#FF0000", "#00FF00"]}
        save_entry("characters", "TestChar", test_data)
        
        bucket = load_bucket("characters")
        self.assertIn("TestChar", bucket)
        self.assertEqual(bucket["TestChar"], test_data)

    def test_save_multiple_entries(self):
        save_entry("characters", "Char1", {"data": 1})
        save_entry("characters", "Char2", {"data": 2})
        
        bucket = load_bucket("characters")
        self.assertEqual(len(bucket), 2)
        self.assertEqual(bucket["Char1"]["data"], 1)
        self.assertEqual(bucket["Char2"]["data"], 2)

    def test_overwrite_entry(self):
        save_entry("objects", "Object1", {"version": 1})
        save_entry("objects", "Object1", {"version": 2})
        
        bucket = load_bucket("objects")
        self.assertEqual(bucket["Object1"]["version"], 2)

    def test_delete_entry(self):
        save_entry("scenes", "Scene1", {"data": "test"})
        self.assertTrue(delete_entry("scenes", "Scene1"))
        
        bucket = load_bucket("scenes")
        self.assertNotIn("Scene1", bucket)

    def test_delete_nonexistent_entry(self):
        self.assertFalse(delete_entry("characters", "NonExistent"))

    def test_load_empty_bucket(self):
        bucket = load_bucket("characters")
        self.assertEqual(bucket, {})

    def test_invalid_bucket(self):
        with self.assertRaises(ValueError):
            load_bucket("invalid_bucket")
        with self.assertRaises(ValueError):
            save_entry("invalid_bucket", "name", {})
        with self.assertRaises(ValueError):
            delete_entry("invalid_bucket", "name")

    def test_persistence_across_loads(self):
        save_entry("objects", "Persistent", {"value": "data"})
        
        first_load = load_bucket("objects")
        second_load = load_bucket("objects")
        
        self.assertEqual(first_load["Persistent"], second_load["Persistent"])


if __name__ == "__main__":
    unittest.main()
