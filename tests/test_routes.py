"""Unit tests for the routes module."""

import json
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch, AsyncMock
from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase

# conftest.py handles mocking and path setup
import store
import routes
from nodes.ideogram4_nodes import sanitize_bg_guid, bg_temp_filename, bg_temp_path


class TestRoutes(AioHTTPTestCase):
    async def get_application(self):
        app = web.Application()
        return app

    def setUp(self):
        super().setUp()
        self.temp_dir = tempfile.mkdtemp()
        
        # Get the actual mocked folder_paths from sys.modules (created by conftest)
        import sys
        self.mock_folder_paths = sys.modules['folder_paths']
        self.mock_folder_paths.get_user_directory.return_value = self.temp_dir
        self.mock_folder_paths.get_temp_directory.return_value = self.temp_dir

    def tearDown(self):
        super().tearDown()
        import shutil
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)

    async def test_get_stores_success(self):
        # Pre-populate store
        store.save_entry("characters", "TestChar", {"desc": "A test"})
        
        request = MagicMock(spec=web.Request)
        response = await routes.get_stores(request)
        
        self.assertEqual(response.status, 200)
        data = json.loads(response.body)
        self.assertIn("characters", data)
        self.assertIn("TestChar", data["characters"])

    async def test_get_stores_empty(self):
        request = MagicMock(spec=web.Request)
        response = await routes.get_stores(request)
        
        self.assertEqual(response.status, 200)
        data = json.loads(response.body)
        self.assertEqual(data["characters"], {})
        self.assertEqual(data["objects"], {})
        self.assertEqual(data["scenes"], {})

    async def test_put_store_entry_success(self):
        request = MagicMock(spec=web.Request)
        request.match_info = {"bucket": "characters", "name": "Hero"}
        request.content_length = 100
        request.json = AsyncMock(return_value={"desc": "Main character", "palette": ["#FF0000"]})
        request.read = AsyncMock(return_value=b'{"desc": "Main character", "palette": ["#FF0000"]}')
        
        response = await routes.put_store_entry(request)
        
        self.assertEqual(response.status, 200)
        data = json.loads(response.body)
        self.assertTrue(data["ok"])
        
        # Verify it was saved
        bucket = store.load_bucket("characters")
        self.assertIn("Hero", bucket)
        self.assertEqual(bucket["Hero"]["desc"], "Main character")

    async def test_put_store_entry_invalid_bucket(self):
        request = MagicMock(spec=web.Request)
        request.match_info = {"bucket": "invalid_bucket", "name": "Test"}
        request.json = AsyncMock(return_value={})
        
        response = await routes.put_store_entry(request)
        
        self.assertEqual(response.status, 400)
        data = json.loads(response.body)
        self.assertIn("error", data)
        self.assertIn("Invalid bucket", data["error"])

    async def test_put_store_entry_invalid_name(self):
        request = MagicMock(spec=web.Request)
        request.match_info = {"bucket": "characters", "name": ""}
        request.json = AsyncMock(return_value={})
        
        response = await routes.put_store_entry(request)
        
        self.assertEqual(response.status, 400)
        data = json.loads(response.body)
        self.assertIn("error", data)

    async def test_put_store_entry_name_too_long(self):
        request = MagicMock(spec=web.Request)
        request.match_info = {"bucket": "characters", "name": "a" * 200}
        request.json = AsyncMock(return_value={})
        
        response = await routes.put_store_entry(request)
        
        self.assertEqual(response.status, 400)
        data = json.loads(response.body)
        self.assertIn("error", data)

    async def test_put_store_entry_invalid_json(self):
        request = MagicMock(spec=web.Request)
        request.match_info = {"bucket": "characters", "name": "Test"}
        request.content_length = 50
        request.read = AsyncMock(return_value=b'not valid json')
        request.json = AsyncMock(side_effect=json.JSONDecodeError("", "", 0))
        
        response = await routes.put_store_entry(request)
        
        self.assertEqual(response.status, 400)
        data = json.loads(response.body)
        self.assertIn("error", data)
        self.assertIn("Invalid JSON", data["error"])

    async def test_put_store_entry_non_object_body(self):
        request = MagicMock(spec=web.Request)
        request.match_info = {"bucket": "characters", "name": "Test"}
        request.content_length = 50
        request.read = AsyncMock(return_value=b'["array", "not", "object"]')
        request.json = AsyncMock(return_value=["array", "not", "object"])
        
        response = await routes.put_store_entry(request)
        
        self.assertEqual(response.status, 400)
        data = json.loads(response.body)
        self.assertIn("error", data)
        self.assertIn("JSON object", data["error"])

    async def test_get_bg_stat_valid_guid(self):
        # Create a background file
        guid = "12345678-1234-4abc-8abc-123456789012"
        bg_path = os.path.join(self.temp_dir, f"byae_ideogram_bg_{guid}.png")
        with open(bg_path, "wb") as f:
            f.write(b"fake png data")
        
        # Mock the bg_temp_path to return our test path
        with patch('routes.bg_temp_path', return_value=bg_path):
            request = MagicMock(spec=web.Request)
            request.match_info = {"guid": guid}
            
            response = await routes.get_bg_stat(request)
            
            self.assertEqual(response.status, 200)
            data = json.loads(response.body)
            self.assertTrue(data["exists"])
            self.assertGreater(data["mtime"], 0)
            self.assertIn("url", data)

    async def test_get_bg_stat_file_not_exists(self):
        guid = "12345678-1234-4abc-8abc-123456789012"
        
        request = MagicMock(spec=web.Request)
        request.match_info = {"guid": guid}
        
        response = await routes.get_bg_stat(request)
        
        self.assertEqual(response.status, 200)
        data = json.loads(response.body)
        self.assertFalse(data["exists"])
        self.assertEqual(data["mtime"], 0)

    async def test_get_bg_stat_invalid_guid(self):
        # Test path traversal attempt
        request = MagicMock(spec=web.Request)
        request.match_info = {"guid": "../../../etc/passwd"}
        
        response = await routes.get_bg_stat(request)
        
        self.assertEqual(response.status, 400)
        data = json.loads(response.body)
        self.assertFalse(data["exists"])
        self.assertIn("error", data)

    async def test_get_bg_stat_malformed_guid(self):
        request = MagicMock(spec=web.Request)
        request.match_info = {"guid": "not-a-valid-guid"}
        
        response = await routes.get_bg_stat(request)
        
        self.assertEqual(response.status, 400)
        data = json.loads(response.body)
        self.assertFalse(data["exists"])
        self.assertIn("error", data)

    async def test_delete_store_entry_success(self):
        # Pre-populate store
        store.save_entry("characters", "ToDelete", {"desc": "Will be deleted"})
        
        request = MagicMock(spec=web.Request)
        request.match_info = {"bucket": "characters", "name": "ToDelete"}
        
        response = await routes.delete_store_entry(request)
        
        self.assertEqual(response.status, 200)
        data = json.loads(response.body)
        self.assertTrue(data["ok"])
        self.assertEqual(data["bucket"], "characters")
        self.assertEqual(data["name"], "ToDelete")
        
        # Verify it was deleted
        bucket = store.load_bucket("characters")
        self.assertNotIn("ToDelete", bucket)

    async def test_delete_store_entry_not_found(self):
        request = MagicMock(spec=web.Request)
        request.match_info = {"bucket": "objects", "name": "DoesNotExist"}
        
        response = await routes.delete_store_entry(request)
        
        self.assertEqual(response.status, 404)
        data = json.loads(response.body)
        self.assertIn("error", data)
        self.assertIn("not found", data["error"].lower())

    async def test_delete_store_entry_invalid_bucket(self):
        request = MagicMock(spec=web.Request)
        request.match_info = {"bucket": "invalid_bucket", "name": "Test"}
        
        response = await routes.delete_store_entry(request)
        
        self.assertEqual(response.status, 400)
        data = json.loads(response.body)
        self.assertIn("error", data)
        self.assertIn("Invalid bucket", data["error"])

    async def test_delete_store_entry_invalid_name(self):
        request = MagicMock(spec=web.Request)
        request.match_info = {"bucket": "scenes", "name": ""}
        
        response = await routes.delete_store_entry(request)
        
        self.assertEqual(response.status, 400)
        data = json.loads(response.body)
        self.assertIn("error", data)

    async def test_put_store_entry_payload_too_large(self):
        """Test that oversized payloads are rejected."""
        request = MagicMock(spec=web.Request)
        request.match_info = {"bucket": "characters", "name": "BigChar"}
        # Simulate a 20 MB payload
        request.content_length = 20 * 1024 * 1024
        
        response = await routes.put_store_entry(request)
        
        self.assertEqual(response.status, 413)
        data = json.loads(response.body)
        self.assertIn("error", data)
        self.assertIn("too large", data["error"].lower())

    async def test_put_store_entry_invalid_name_chars(self):
        """Test that names with path traversal attempts are rejected."""
        request = MagicMock(spec=web.Request)
        request.match_info = {"bucket": "characters", "name": "../../../evil"}
        request.content_length = 100
        request.json = AsyncMock(return_value={"desc": "test"})
        request.read = AsyncMock(return_value=b'{"desc": "test"}')
        
        response = await routes.put_store_entry(request)
        
        self.assertEqual(response.status, 400)
        data = json.loads(response.body)
        self.assertIn("error", data)

    async def test_put_store_entry_special_chars_rejected(self):
        """Test that names with special characters are rejected."""
        for bad_name in ["test<script>", "test\x00null", "test\n\nnewline"]:
            request = MagicMock(spec=web.Request)
            request.match_info = {"bucket": "objects", "name": bad_name}
            request.content_length = 100
            request.json = AsyncMock(return_value={"desc": "test"})
            request.read = AsyncMock(return_value=b'{"desc": "test"}')
            
            response = await routes.put_store_entry(request)
            
            self.assertEqual(response.status, 400, f"Expected 400 for name: {repr(bad_name)}")
            data = json.loads(response.body)
            self.assertIn("error", data)

    async def test_delete_store_entry_path_traversal(self):
        """Test that path traversal attempts in DELETE are rejected."""
        request = MagicMock(spec=web.Request)
        request.match_info = {"bucket": "characters", "name": "../../etc/passwd"}
        
        response = await routes.delete_store_entry(request)
        
        self.assertEqual(response.status, 400)
        data = json.loads(response.body)
        self.assertIn("error", data)


if __name__ == "__main__":
    unittest.main()
