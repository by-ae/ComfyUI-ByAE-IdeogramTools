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

    def test_corrupt_json_creates_backup_and_returns_empty(self):
        # Create a corrupt JSON file
        bucket_path = os.path.join(self.temp_dir, "byae-ideogram-tools", "characters.json")
        os.makedirs(os.path.dirname(bucket_path), exist_ok=True)
        with open(bucket_path, "w") as f:
            f.write("{invalid json content")
        
        # Loading should return empty dict and create backup
        bucket = load_bucket("characters")
        self.assertEqual(bucket, {})
        
        # Check that backup file was created
        backup_files = [f for f in os.listdir(os.path.dirname(bucket_path)) 
                       if f.startswith("characters.json.corrupt-")]
        self.assertEqual(len(backup_files), 1)
        
        # Verify backup contains original corrupt content
        backup_path = os.path.join(os.path.dirname(bucket_path), backup_files[0])
        with open(backup_path, "r") as f:
            self.assertEqual(f.read(), "{invalid json content")
        
        # Verify original file no longer exists
        self.assertFalse(os.path.exists(bucket_path))

    def test_corrupt_file_does_not_affect_other_buckets(self):
        # Save valid entry in objects bucket
        save_entry("objects", "ValidObject", {"data": "test"})
        
        # Create corrupt characters file
        bucket_path = os.path.join(self.temp_dir, "byae-ideogram-tools", "characters.json")
        os.makedirs(os.path.dirname(bucket_path), exist_ok=True)
        with open(bucket_path, "w") as f:
            f.write("corrupted")
        
        # Load all should still work, with characters empty but objects intact
        from store import load_all
        stores = load_all()
        
        self.assertEqual(stores["characters"], {})
        self.assertIn("ValidObject", stores["objects"])
        self.assertEqual(stores["objects"]["ValidObject"]["data"], "test")

    def test_save_works_after_corrupt_file_recovery(self):
        # Create corrupt file
        bucket_path = os.path.join(self.temp_dir, "byae-ideogram-tools", "scenes.json")
        os.makedirs(os.path.dirname(bucket_path), exist_ok=True)
        with open(bucket_path, "w") as f:
            f.write("[not a dict]")
        
        # Load should recover
        load_bucket("scenes")
        
        # Save should now work
        save_entry("scenes", "NewScene", {"data": "value"})
        
        # Verify save succeeded
        bucket = load_bucket("scenes")
        self.assertIn("NewScene", bucket)
        self.assertEqual(bucket["NewScene"]["data"], "value")

    def test_unicode_character_names(self):
        # Test that Unicode names work correctly
        save_entry("characters", "角色123", {"desc": "Japanese character"})
        save_entry("characters", "Персонаж", {"desc": "Russian character"})
        save_entry("characters", "Émilie", {"desc": "French character"})
        
        bucket = load_bucket("characters")
        self.assertIn("角色123", bucket)
        self.assertIn("Персонаж", bucket)
        self.assertIn("Émilie", bucket)
        self.assertEqual(bucket["角色123"]["desc"], "Japanese character")
        self.assertEqual(bucket["Персонаж"]["desc"], "Russian character")
        self.assertEqual(bucket["Émilie"]["desc"], "French character")

    def test_concurrent_write_safety(self):
        # Test that concurrent writes don't corrupt the file
        import threading
        import time
        
        errors = []
        
        def writer(name, value):
            try:
                for i in range(10):
                    save_entry("characters", name, {"iteration": i, "value": value})
                    time.sleep(0.001)
            except Exception as e:
                errors.append((name, str(e)))
        
        threads = [
            threading.Thread(target=writer, args=(f"char{i}", i))
            for i in range(5)
        ]
        
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        
        # Check no errors occurred
        self.assertEqual(errors, [], f"Concurrent write errors: {errors}")
        
        # Verify all characters were saved
        bucket = load_bucket("characters")
        for i in range(5):
            self.assertIn(f"char{i}", bucket)
            self.assertIn("iteration", bucket[f"char{i}"])
            self.assertEqual(bucket[f"char{i}"]["value"], i)


if __name__ == "__main__":
    unittest.main()
