import logging

_logger = logging.getLogger(__name__)

try:
    from .nodes.ideogram4_nodes import (
        Ideogram4PromptBuilderKJEnhancedByAE,
        Ideogram4PromptBuilderKJPreviewUpdateByAE,
    )

    NODE_CLASS_MAPPINGS = {
        "Ideogram4PromptBuilderKJEnhancedByAE": Ideogram4PromptBuilderKJEnhancedByAE,
        "Ideogram4PromptBuilderKJPreviewUpdateByAE": Ideogram4PromptBuilderKJPreviewUpdateByAE,
    }

    NODE_DISPLAY_NAME_MAPPINGS = {
        "Ideogram4PromptBuilderKJEnhancedByAE": "Ideogram 4 Prompt Builder Pro (based on the KJ node)",
        "Ideogram4PromptBuilderKJPreviewUpdateByAE": "Ideogram 4 Prompt Builder Pro - Preview BG Update",
    }

    WEB_DIRECTORY = "./web"

    __all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

except ImportError as e:
    _logger.error(
        "ComfyUI-ByAE-IdeogramTools: Failed to import nodes. "
        "Make sure you are running this inside ComfyUI with required dependencies: %s", e
    )
    NODE_CLASS_MAPPINGS = {}
    NODE_DISPLAY_NAME_MAPPINGS = {}
    WEB_DIRECTORY = None
    __all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

try:
    from server import PromptServer
    from .routes import register_routes

    if hasattr(PromptServer, "instance") and PromptServer.instance is not None:
        try:
            register_routes(PromptServer.instance.app)
        except Exception:
            _logger.exception("ComfyUI-ByAE-IdeogramTools: failed to register store routes")
except ImportError:
    _logger.warning(
        "ComfyUI-ByAE-IdeogramTools: PromptServer not available, "
        "store routes will not be registered"
    )
