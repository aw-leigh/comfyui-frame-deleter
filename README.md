# FrameDeleter — ComfyUI Node

A custom ComfyUI node that lets you **interactively review and remove individual frames from a video batch** before it continues through your workflow — no external tools required.

---

## What it does

When a video batch reaches the FrameDeleter node, execution **pauses** and a full interactive UI appears directly on the node. You scrub through every frame, mark any you want removed, and then resume. The node outputs the cleaned image batch with your selected frames deleted, and the rest of the workflow continues normally.

---

## Features

- **Frame scrubber** — drag a slider to seek through the batch instantly
- **Prev / Next buttons** — step through frames one at a time
- **Drop / Restore toggle** — mark the current frame for deletion or undo it
- **Dropped-frames bubble list** — a scrollable panel shows all marked frames; click any bubble to jump straight to that frame
- **Live preview** — the current frame is rendered inside the node, with a red ❌ overlay when it is marked for deletion
- **Non-destructive** — nothing is modified until you click **Confirm Cuts & Resume**; cancelling the queue discards all selections and returns the original batch untouched

---

## Installation

1. Clone or copy this repository into your ComfyUI `custom_nodes` directory:

   ```
   cd ComfyUI/custom_nodes
   git clone https://github.com/aw-leigh/frame-deleter
   ```

2. Restart ComfyUI. The node will register automatically — no extra dependencies are required beyond a standard ComfyUI install.

---

## Usage

1. Add the **FrameDeleter** node to your graph (found under **Video Processing**).
2. Connect an `IMAGE` batch — typically the output of a video loader node — to its input.
3. Connect the node's `IMAGE` output to the rest of your pipeline.
4. Run the queue. When execution reaches FrameDeleter, it will pause and the UI will become active.
5. Scrub or step through the frames and press **❌ Drop Frame** on any you want removed. Press it again on a marked frame to restore it.
6. When you are happy with your selections, press **🚀 Confirm Cuts & Resume**. The node outputs the batch with the marked frames removed and execution continues.

> **Tip:** If you mark every frame by mistake, the node will raise an error rather than silently passing the full batch through. Just re-run and keep at least one frame.

---

## Node reference

| Property | Value |
|---|---|
| Category | `Video Processing` |
| Input | `IMAGE` batch |
| Output | `IMAGE` batch (frames removed) |
| Cache | Always re-executes (`IS_CHANGED` returns `NaN`) |

---

## How it works

When execution reaches the node, the Python backend saves each frame as a temporary JPEG and sends their filenames to the frontend over ComfyUI's WebSocket. The node thread then waits on a `threading.Event`. The JavaScript extension receives the filenames, loads previews via the `/view` endpoint, and renders the interactive UI. When you confirm your selections, the frontend POSTs the list of frame indices to `/frame_deleter/confirm`, the backend wakes up, filters the tensor batch, and temporary files are cleaned up on a background thread. Stale temp files from any previous crashed session are also removed automatically on startup.

---

## License

MIT
