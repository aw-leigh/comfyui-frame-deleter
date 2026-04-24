# __init__.py

from .frame_deleter import FrameDeleter

# Maps the internal identifier to the actual Python class
NODE_CLASS_MAPPINGS = {
    "FrameDeleter": FrameDeleter
}

# Maps the internal identifier to the readable name shown in the UI
NODE_DISPLAY_NAME_MAPPINGS = {
    "FrameDeleter": "Video Frame Deleter"
}

# This is the secret sauce for custom UI!
# This tells ComfyUI to host the files inside the "js" folder so the browser can load them.
WEB_DIRECTORY = "./js"

# Export these so ComfyUI knows exactly what to pull from this module
__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']