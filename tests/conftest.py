"""pytest configuration for ComfyUI-ByAE-IdeogramTools tests."""

import sys
import os
from unittest.mock import MagicMock

# Mock ComfyUI dependencies before any imports
sys.modules['folder_paths'] = MagicMock()
sys.modules['torch'] = MagicMock()
sys.modules['numpy'] = MagicMock()
sys.modules['PIL'] = MagicMock()
sys.modules['PIL.Image'] = MagicMock()
sys.modules['PIL.ImageDraw'] = MagicMock()
sys.modules['PIL.ImageFont'] = MagicMock()
sys.modules['comfy_api'] = MagicMock()
sys.modules['comfy_api.latest'] = MagicMock()
sys.modules['comfy_api.latest.io'] = MagicMock()
sys.modules['server'] = MagicMock()

# Make the repo root importable as a package
repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
parent_dir = os.path.dirname(repo_root)
package_name = os.path.basename(repo_root).replace('-', '_')

if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

# Create a pseudo-package that wraps the repo
import importlib.util
import types

# Create package module
pkg = types.ModuleType(package_name)
pkg.__path__ = [repo_root]
pkg.__file__ = os.path.join(repo_root, '__init__.py')
sys.modules[package_name] = pkg

# Import and register store module
store_spec = importlib.util.spec_from_file_location(
    f"{package_name}.store",
    os.path.join(repo_root, 'store.py')
)
store_module = importlib.util.module_from_spec(store_spec)
sys.modules[f"{package_name}.store"] = store_module
store_spec.loader.exec_module(store_module)

# Import and register nodes package
nodes_pkg = types.ModuleType(f"{package_name}.nodes")
nodes_pkg.__path__ = [os.path.join(repo_root, 'nodes')]
sys.modules[f"{package_name}.nodes"] = nodes_pkg

# Import and register ideogram4_nodes
nodes_spec = importlib.util.spec_from_file_location(
    f"{package_name}.nodes.ideogram4_nodes",
    os.path.join(repo_root, 'nodes', 'ideogram4_nodes.py')
)
nodes_module = importlib.util.module_from_spec(nodes_spec)
sys.modules[f"{package_name}.nodes.ideogram4_nodes"] = nodes_module
nodes_spec.loader.exec_module(nodes_module)

# Import and register routes with the package context
routes_spec = importlib.util.spec_from_file_location(
    f"{package_name}.routes",
    os.path.join(repo_root, 'routes.py'),
    submodule_search_locations=[repo_root]
)
routes_module = importlib.util.module_from_spec(routes_spec)
sys.modules[f"{package_name}.routes"] = routes_module
routes_spec.loader.exec_module(routes_module)

# Make them available without package prefix in test files
sys.modules['store'] = store_module
sys.modules['routes'] = routes_module
sys.modules['nodes'] = nodes_pkg
sys.modules['nodes.ideogram4_nodes'] = nodes_module
