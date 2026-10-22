import logging
import os
from urllib.parse import quote

from aiohttp import web

from . import store
from .nodes.ideogram4_nodes import bg_temp_filename, bg_temp_path, sanitize_bg_guid

logger = logging.getLogger(__name__)


async def get_stores(_request: web.Request) -> web.Response:
    try:
        return web.json_response(store.load_all())
    except Exception:
        logger.exception("ByAE Ideogram: failed to load stores")
        return web.json_response({"error": "Failed to load stores"}, status=500)


async def put_store_entry(request: web.Request) -> web.Response:
    bucket = request.match_info.get("bucket", "")
    name = request.match_info.get("name", "")
    if bucket not in ("characters", "objects", "scenes"):
        return web.json_response({"error": "Invalid bucket"}, status=400)
    if not name or len(name) > 128:
        return web.json_response({"error": "Invalid or missing name"}, status=400)
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    if not isinstance(data, dict):
        return web.json_response({"error": "Request body must be a JSON object"}, status=400)
    try:
        store.save_entry(bucket, name, data)
        return web.json_response({"ok": True, "bucket": bucket, "name": name})
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception:
        logger.exception("ByAE Ideogram: failed to save store entry")
        return web.json_response({"error": "Failed to save"}, status=500)


async def get_bg_stat(request: web.Request) -> web.Response:
    guid = request.match_info.get("guid", "")
    try:
        sanitize_bg_guid(guid)
        path = bg_temp_path(guid)
        fname = bg_temp_filename(guid)
    except ValueError:
        return web.json_response({"exists": False, "mtime": 0, "error": "invalid guid"}, status=400)
    temp_dir = os.path.dirname(path)
    if not os.path.isfile(path):
        return web.json_response({
            "exists": False,
            "mtime": 0,
            "path": path,
            "filename": fname,
            "temp_dir": temp_dir,
        })
    try:
        mtime = os.path.getmtime(path)
    except (OSError, IOError) as e:
        logger.warning("ByAE Ideogram: failed to stat background file %s: %s", path, e)
        return web.json_response({"exists": False, "mtime": 0, "error": "stat failed"}, status=500)
    url = f"/view?filename={quote(fname)}&type=temp&subfolder="
    return web.json_response({
        "exists": True,
        "mtime": mtime,
        "url": url,
        "path": path,
        "filename": fname,
        "temp_dir": temp_dir,
    })


def register_routes(app) -> None:
    if app.router.frozen:
        return
    app.add_routes([
        web.get("/byae/ideogram/stores", get_stores),
        web.put("/byae/ideogram/stores/{bucket}/{name}", put_store_entry),
        web.get("/byae/ideogram/bg/{guid}/stat", get_bg_stat),
    ])
