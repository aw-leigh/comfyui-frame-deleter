import os
import glob
import uuid
import threading
import numpy as np
import time
from PIL import Image
from aiohttp import web

import comfy.model_management as model_management
from server import PromptServer
import folder_paths

# --- FIX 1: Lock guards all mutations of the shared global dicts ---
_state_lock = threading.Lock()
paused_events = {}
cut_results = {}
pending_temp_files = {}


def cleanup_stale_temp_files():
    """
    FIX 5: Runs once at startup to remove any fd_*.jpg files left behind
    by a previous session that crashed before it could clean up.
    """
    temp_dir = folder_paths.get_temp_directory()
    stale = glob.glob(os.path.join(temp_dir, "fd_*.jpg"))
    for filepath in stale:
        try:
            os.remove(filepath)
        except Exception as e:
            print(f"[FrameDeleter] Could not remove stale temp file {filepath}: {e}")

# Run immediately at import time
cleanup_stale_temp_files()


def save_temp_frames(images, unique_id):
    temp_dir = folder_paths.get_temp_directory()
    run_id = str(uuid.uuid4())[:8]
    saved_filenames = []

    for i, tensor_img in enumerate(images):
        i_8 = 255. * tensor_img.cpu().numpy()
        img = Image.fromarray(np.clip(i_8, 0, 255).astype(np.uint8))
        filename = f"fd_{unique_id}_{run_id}_{i:04d}.jpg"
        filepath = os.path.join(temp_dir, filename)
        img.save(filepath, quality=85)
        saved_filenames.append(filename)
    return saved_filenames


def cleanup_temp_frames(unique_id):
    """
    FIX 6: Runs cleanup on a daemon thread so the retry sleep loop
    never blocks the ComfyUI execution queue.
    The browser is given a moment to release file handles (Windows) before
    deletion is attempted, with up to 3 retries per file.
    """
    with _state_lock:
        files_to_delete = pending_temp_files.pop(unique_id, [])

    if not files_to_delete:
        return

    def _do_cleanup():
        # Give the browser a moment to release file handles after the
        # frame_deleter_cleanup signal has been sent.
        time.sleep(0.1)

        temp_dir = folder_paths.get_temp_directory()
        for filename in files_to_delete:
            filepath = os.path.join(temp_dir, filename)
            for _attempt in range(3):
                try:
                    if os.path.exists(filepath):
                        os.remove(filepath)
                    break  # Success
                except PermissionError:
                    time.sleep(0.1)  # Wait and retry (Windows file lock)
                except Exception as e:
                    print(f"[FrameDeleter] Error deleting {filename}: {e}")
                    break

    t = threading.Thread(target=_do_cleanup, daemon=True)
    t.start()


class FrameDeleter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"images": ("IMAGE",)},
            "hidden":   {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        """Returning float('NaN') tells ComfyUI to never use a cached result."""
        return float("NaN")

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "process"
    CATEGORY = "Video Processing"

    def process(self, images, unique_id):
        total_frames = images.shape[0]

        # FIX 2: Store directly; no redundant local alias needed
        with _state_lock:
            pending_temp_files[unique_id] = save_temp_frames(images, unique_id)
            saved_filenames = pending_temp_files[unique_id]

        event = threading.Event()
        with _state_lock:
            paused_events[unique_id] = event

        PromptServer.instance.send_sync("frame_deleter_paused", {
            "node_id":      unique_id,
            "total_frames": total_frames,
            "filenames":    saved_filenames,
        })

        try:
            # FIX 3: Cleaner interrupt-aware wait — no redundant outer is_set() check
            while not model_management.processing_interrupted():
                if event.wait(timeout=0.5):
                    break  # event.set() was called

            if model_management.processing_interrupted():
                return (images,)

            with _state_lock:
                to_drop = cut_results.get(unique_id, [])

            to_keep = [i for i in range(total_frames) if i not in to_drop]

            # FIX 4: Dropping every frame is almost certainly a user mistake;
            # raise a clear error rather than silently returning the full input.
            if not to_keep:
                raise ValueError(
                    "[FrameDeleter] All frames were marked for deletion. "
                    "Please keep at least one frame and confirm again."
                )

            return (images[to_keep],)

        finally:
            # Signal JS to clear the UI and release file handles
            PromptServer.instance.send_sync("frame_deleter_cleanup", {"node_id": unique_id})

            # FIX 6: Cleanup runs on a daemon thread (non-blocking)
            cleanup_temp_frames(unique_id)

            with _state_lock:
                paused_events.pop(unique_id, None)
                cut_results.pop(unique_id, None)


@PromptServer.instance.routes.post("/frame_deleter/confirm")
async def confirm_cuts(request):
    json_data = await request.json()
    node_id = json_data.get("node_id")

    with _state_lock:
        event = paused_events.get(node_id)
        if event is not None:
            cut_results[node_id] = json_data.get("dropped_frames", [])

    if event is not None:
        event.set()
        return web.json_response({"status": "ok"})

    return web.json_response({"error": "Node not found or already resumed"}, status=400)
