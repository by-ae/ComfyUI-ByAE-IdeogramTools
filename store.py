"""File-based character/object/scene storage in ComfyUI user data."""

import contextlib
import json
import logging
import os
import re
import tempfile
import time

import folder_paths

_STORE_SUBDIR = "byae-ideogram-tools"
_BUCKETS = frozenset({"characters", "objects", "scenes"})
# Allow Unicode letters, numbers, spaces, underscores, and hyphens
# Must start with a letter or number (Unicode-aware)
_SAFE_NAME = re.compile(r"^[\w][\w\- ]{0,63}$", re.UNICODE)

logger = logging.getLogger(__name__)

# File locks for concurrent write protection (one lock per bucket)
_BUCKET_LOCKS = {}


def _store_dir() -> str:
    path = os.path.join(folder_paths.get_user_directory(), _STORE_SUBDIR)
    os.makedirs(path, exist_ok=True)
    return path


@contextlib.contextmanager
def _bucket_lock(bucket: str):
    """Thread-safe lock for bucket writes to prevent concurrent write corruption."""
    import threading
    if bucket not in _BUCKET_LOCKS:
        _BUCKET_LOCKS[bucket] = threading.Lock()
    lock = _BUCKET_LOCKS[bucket]
    lock.acquire()
    try:
        yield
    finally:
        lock.release()


def _bucket_path(bucket: str) -> str:
    if bucket not in _BUCKETS:
        raise ValueError(f"Unknown store bucket: {bucket}")
    return os.path.join(_store_dir(), f"{bucket}.json")


def _validate_name(name: str) -> str:
    name = (name or "").strip()
    if not _SAFE_NAME.match(name):
        raise ValueError("Invalid name (use letters, numbers, spaces, _ or -)")
    return name


def _read_json(path: str) -> dict:
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        # Move corrupt file aside and treat bucket as empty
        timestamp = int(time.time())
        backup_path = f"{path}.corrupt-{timestamp}"
        logger.warning(
            "ByAE Ideogram: corrupt store file %s (%s), moving to %s",
            path, e, backup_path
        )
        try:
            os.rename(path, backup_path)
        except OSError as rename_err:
            logger.error("ByAE Ideogram: failed to backup corrupt file: %s", rename_err)
        return {}


def _write_json(path: str, data: dict) -> None:
    # Use a temporary file with a unique name to avoid conflicts during concurrent writes
    temp_fd, tmp = tempfile.mkstemp(
        dir=os.path.dirname(path),
        prefix=".tmp_",
        suffix=".json"
    )
    try:
        with os.fdopen(temp_fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        # Clean up temp file on write failure
        try:
            os.close(temp_fd)
        except (OSError, ValueError):
            pass
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise


def load_bucket(bucket: str) -> dict:
    return _read_json(_bucket_path(bucket))


def load_all() -> dict:
    return {bucket: load_bucket(bucket) for bucket in _BUCKETS}


def save_entry(bucket: str, name: str, data) -> None:
    name = _validate_name(name)
    path = _bucket_path(bucket)
    with _bucket_lock(bucket):
        store = _read_json(path)
        store[name] = data
        _write_json(path, store)


def delete_entry(bucket: str, name: str) -> bool:
    name = _validate_name(name)
    path = _bucket_path(bucket)
    with _bucket_lock(bucket):
        store = _read_json(path)
        if name not in store:
            return False
        del store[name]
        _write_json(path, store)
        return True
