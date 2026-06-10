"""File-based character/object/scene storage in ComfyUI user data."""

import json
import os
import re

import folder_paths

_STORE_SUBDIR = "byae-ideogram-tools"
_BUCKETS = frozenset({"characters", "objects", "scenes"})
_SAFE_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_\- ]{0,63}$")


def _store_dir() -> str:
    path = os.path.join(folder_paths.get_user_directory(), _STORE_SUBDIR)
    os.makedirs(path, exist_ok=True)
    return path


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
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else {}


def _write_json(path: str, data: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def load_bucket(bucket: str) -> dict:
    return _read_json(_bucket_path(bucket))


def load_all() -> dict:
    return {bucket: load_bucket(bucket) for bucket in _BUCKETS}


def save_entry(bucket: str, name: str, data) -> None:
    name = _validate_name(name)
    path = _bucket_path(bucket)
    store = _read_json(path)
    store[name] = data
    _write_json(path, store)


def delete_entry(bucket: str, name: str) -> bool:
    name = _validate_name(name)
    path = _bucket_path(bucket)
    store = _read_json(path)
    if name not in store:
        return False
    del store[name]
    _write_json(path, store)
    return True
