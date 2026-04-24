import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// FIX 2 (canvas cache): One shared offscreen canvas for text measurement,
// so we never allocate a new one inside a mouse/pointer event handler.
const _measureCanvas = document.createElement("canvas");
const _measureCtx = _measureCanvas.getContext("2d");
_measureCtx.font = "normal 10px Arial";

async function sendCutsToBackend(nodeId, droppedFrames) {
    const response = await api.fetchApi("/frame_deleter/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: nodeId, dropped_frames: droppedFrames }),
    });
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${response.status}`);
    }
}

app.registerExtension({
    name: "Comfy.FrameDeleter",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "FrameDeleter") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            // --- State ---
            this.totalFrames = 0;
            this.currentFrameIndex = 0;
            this.filenames = [];
            this.droppedFrames = new Set();
            this.previewImage = new Image();
            this.bubbleScrollY = 0;
            this.totalContentH = 0;
            this._confirmed = false; // FIX 3: tracks whether confirm was clicked

            // ----------------------------------------------------------------
            // FIX 1: Accurate topY by summing actual widget heights
            // ----------------------------------------------------------------
            this._getPreviewTopY = () => {
                let topY = LiteGraph.NODE_TITLE_HEIGHT + 4;
                for (const w of this.widgets) {
                    topY += (w.computeSize ? w.computeSize(this.size[0])[1] : 20) + 4;
                }
                return topY;
            };

            // ----------------------------------------------------------------
            // resetUI — FIX 5: detach onload before swapping src so a
            // slow in-flight load can't fire after the reset.
            // ----------------------------------------------------------------
            this.resetUI = () => {
                this.totalFrames = 0;
                this.currentFrameIndex = 0;
                this.filenames = [];
                this.droppedFrames.clear();
                this.bubbleScrollY = 0;
                this._confirmed = false;

                this.previewImage.onload = null; // detach first
                this.previewImage.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
                this.previewImage.onload = () => this.setDirtyCanvas(true, true); // re-attach

                this.frameDisplay.value = "Waiting for execution...";

                // FIX 3: Re-enable confirm & toggle buttons on reset
                this.toggleBtn.disabled = false;
                this.confirmBtn.disabled = false;
                this.confirmBtn.name = "🚀 Confirm Cuts & Resume";

                this.setDirtyCanvas(true, true);
            };

            this.updateUI = () => {
                if (this.totalFrames === 0) return;
                const filename = this.filenames[this.currentFrameIndex];
                if (filename) {
                    this.previewImage.src = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=temp`);
                }
                this.frameDisplay.value = `${this.currentFrameIndex} / ${this.totalFrames - 1}`;
                this.toggleBtn.name = this.droppedFrames.has(this.currentFrameIndex) ? "✅ Restore Frame" : "❌ Drop Frame";
                this.setDirtyCanvas(true, true);
            };

            // FIX 5: onload attached via resetUI pattern — always set here for initial state
            this.previewImage.onload = () => this.setDirtyCanvas(true, true);

            // --- Permanent Widgets ---
            this.frameDisplay = this.addWidget("text", "Frame", "Waiting...", () => {});

            this.mxScrubber = {
                type: "mx_scrubber",
                draw: (ctx, node, w, y, h) => {
                    const margin = 15, sliderW = w - margin * 2;
                    const progress = this.totalFrames > 1 ? this.currentFrameIndex / (this.totalFrames - 1) : 0;
                    ctx.save();
                    ctx.fillStyle = "#0a0a0a"; ctx.beginPath(); ctx.roundRect(margin, y + h * 0.4, sliderW, 6, 3); ctx.fill();
                    ctx.fillStyle = "#EEE"; ctx.beginPath();
                    ctx.arc(margin + (sliderW * progress), y + h * 0.4 + 3, 10, 0, Math.PI * 2); ctx.fill();
                    ctx.restore();
                },
                mouse: (event, pos) => {
                    if (event.buttons !== 1 || this.totalFrames === 0) return false;
                    const margin = 15, sliderW = this.size[0] - margin * 2;
                    const x = Math.max(0, Math.min(1, (pos[0] - margin) / sliderW));
                    this.currentFrameIndex = Math.round(x * (this.totalFrames - 1));
                    this.updateUI();
                    return true;
                },
                computeSize: (w) => [w, 30]
            };
            this.widgets.push(this.mxScrubber);

            this.prevNextWidget = {
                type: "nav",
                draw: (ctx, node, w, y, h) => {
                    const m = 15, s = 10, bw = (w - m * 2 - s) / 2;
                    ctx.save();
                    ctx.fillStyle = "#444";
                    ctx.fillRect(m, y, bw, h);
                    ctx.fillRect(m + bw + s, y, bw, h);
                    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.font = "normal 12px Arial";
                    ctx.fillText("◀ Prev", m + bw / 2, y + h * 0.7);
                    ctx.fillText("Next ▶", m + bw + s + bw / 2, y + h * 0.7);
                    ctx.restore();
                },
                mouse: (event, pos) => {
                    if ((event.type !== "pointerdown" && event.type !== "mousedown") || this.totalFrames === 0) return false;
                    const m = 15, s = 10, bw = (this.size[0] - m * 2 - s) / 2;
                    if (pos[0] >= m && pos[0] <= m + bw)
                        this.currentFrameIndex = Math.max(0, this.currentFrameIndex - 1);
                    else if (pos[0] >= m + bw + s && pos[0] <= this.size[0] - m)
                        this.currentFrameIndex = Math.min(this.totalFrames - 1, this.currentFrameIndex + 1);
                    else return false;
                    this.updateUI();
                    return true;
                },
                computeSize: (w) => [w, 30]
            };
            this.widgets.push(this.prevNextWidget);

            this.toggleBtn = this.addWidget("button", "❌ Drop Frame", null, () => {
                if (this.totalFrames === 0 || this._confirmed) return;
                if (this.droppedFrames.has(this.currentFrameIndex))
                    this.droppedFrames.delete(this.currentFrameIndex);
                else
                    this.droppedFrames.add(this.currentFrameIndex);
                this.updateUI();
            });

            // ----------------------------------------------------------------
            // Bubble widget
            // FIX 2: uses _measureCtx (cached) instead of creating a new canvas
            // FIX 4: bubbleScrollY is clamped after every write
            // FIX 7: mousewheel scrolling via onmousewheel
            // ----------------------------------------------------------------
            this.bubbleWidget = {
                type: "bubbles",
                draw: (ctx, node, w, y, h) => {
                    const dropped = Array.from(this.droppedFrames).sort((a, b) => a - b);
                    const rowH = 22, margin = 10, visibleH = 66;

                    ctx.save();
                    ctx.fillStyle = "#1a1a1a"; ctx.fillRect(margin, y, w - margin * 2, visibleH);
                    ctx.beginPath(); ctx.rect(margin, y, w - margin * 2, visibleH); ctx.clip();

                    let curX = margin + 5, curY = y + 5 - this.bubbleScrollY;
                    for (const frame of dropped) {
                        const txt = frame.toString();
                        const txtW = _measureCtx.measureText(txt).width + 14;
                        if (curX + txtW > w - margin - 15) { curX = margin + 5; curY += rowH; }

                        ctx.fillStyle = (this.currentFrameIndex === frame) ? "#888" : "#444";
                        ctx.beginPath(); ctx.roundRect(curX, curY, txtW, rowH - 4, 4); ctx.fill();
                        ctx.fillStyle = "#fff"; ctx.font = "normal 10px Arial"; ctx.textAlign = "center";
                        ctx.fillText(txt, curX + txtW / 2, curY + 12);
                        curX += txtW + 5;
                    }
                    this.totalContentH = (curY + rowH + this.bubbleScrollY) - y;
                    ctx.restore();

                    if (this.totalContentH > visibleH) {
                        const sbW = 6, sbX = w - margin - sbW;
                        ctx.save();
                        ctx.fillStyle = "#000"; ctx.fillRect(sbX, y, sbW, visibleH);
                        const hH = Math.max(10, (visibleH / this.totalContentH) * visibleH);
                        const hY = y + (this.bubbleScrollY / (this.totalContentH - visibleH)) * (visibleH - hH);
                        ctx.fillStyle = "#666"; ctx.fillRect(sbX, hY, sbW, hH);
                        ctx.restore();
                    }
                },
                mouse: (event, pos, node) => {
                    if (this.totalFrames === 0) return false;

                    const widgetIndex = node.widgets.indexOf(this.bubbleWidget);
                    let yOffset = node.widgets_start_y || 20;
                    for (let i = 0; i < widgetIndex; i++) {
                        const w = node.widgets[i];
                        yOffset += (w.computeSize ? w.computeSize(node.size[0])[1] : 20) + 4;
                    }

                    const visibleH = 66, margin = 10;
                    const localY = pos[1] - yOffset;
                    if (localY < 0 || localY > visibleH) return false;

                    // Scrollbar drag
                    if (event.buttons === 1 && pos[0] > node.size[0] - 25 && this.totalContentH > visibleH) {
                        // FIX 4: clamp scroll position
                        const raw = (localY / visibleH) * (this.totalContentH - visibleH);
                        this.bubbleScrollY = Math.max(0, Math.min(this.totalContentH - visibleH, raw));
                        node.setDirtyCanvas(true, true);
                        return true;
                    }

                    // Bubble click navigation
                    if (event.type === "mousedown" || event.type === "pointerdown") {
                        const dropped = Array.from(this.droppedFrames).sort((a, b) => a - b);
                        const rowH = 22;

                        // FIX 2: use cached _measureCtx, no new canvas allocation
                        let curX = margin + 5, curY = 5 - this.bubbleScrollY;
                        for (const frame of dropped) {
                            const txt = frame.toString();
                            const txtW = _measureCtx.measureText(txt).width + 14;
                            if (curX + txtW > node.size[0] - margin - 15) { curX = margin + 5; curY += rowH; }

                            if (pos[0] >= curX && pos[0] <= curX + txtW && localY >= curY && localY <= curY + rowH - 4) {
                                this.currentFrameIndex = frame;
                                this.updateUI();
                                return true;
                            }
                            curX += txtW + 5;
                        }
                    }
                    return false;
                },
                // FIX 7: mousewheel scrolling
                onMouseWheel: (event) => {
                    if (this.totalFrames === 0 || this.totalContentH <= 66) return false;
                    const delta = event.deltaY || event.detail || 0;
                    const raw = this.bubbleScrollY + delta * 0.5;
                    // FIX 4: clamp here too
                    this.bubbleScrollY = Math.max(0, Math.min(this.totalContentH - 66, raw));
                    this.setDirtyCanvas(true, true);
                    return true;
                },
                computeSize: (w) => [w, 70]
            };
            this.widgets.push(this.bubbleWidget);

            // ----------------------------------------------------------------
            // FIX 3: Confirm button locks itself and the toggle on click.
            // FIX 6: Shows an error in frameDisplay and re-enables buttons
            //        if the POST fails so the node doesn't hang.
            // ----------------------------------------------------------------
            this.confirmBtn = this.addWidget("button", "🚀 Confirm Cuts & Resume", null, async () => {
                if (this.totalFrames === 0 || this._confirmed) return;

                // Lock UI immediately to prevent double-submit
                this._confirmed = true;
                this.confirmBtn.name = "⏳ Resuming...";
                this.confirmBtn.disabled = true;
                this.toggleBtn.disabled = true;
                this.setDirtyCanvas(true, true);

                try {
                    await sendCutsToBackend(this.id, Array.from(this.droppedFrames));
                } catch (e) {
                    // FIX 6: Surface the error and re-enable the UI so the user can retry
                    console.error("[FrameDeleter] Confirm failed:", e);
                    this.frameDisplay.value = `⚠️ Error: ${e.message} — please retry`;
                    this._confirmed = false;
                    this.confirmBtn.name = "🚀 Confirm Cuts & Resume";
                    this.confirmBtn.disabled = false;
                    this.toggleBtn.disabled = false;
                    this.setDirtyCanvas(true, true);
                }
            });

            // ----------------------------------------------------------------
            // FIX 1: onDrawBackground uses _getPreviewTopY() for correct position
            // ----------------------------------------------------------------
            this.onDrawBackground = function (ctx) {
                if (this.totalFrames === 0 || !this.previewImage.complete || this.previewImage.src.startsWith("data:")) return;

                const topY = this._getPreviewTopY();
                const padding = 10;
                const scale = (this.size[0] - 2 * padding) / this.previewImage.width;
                const tw = this.previewImage.width * scale;
                const th = this.previewImage.height * scale;
                const targetHeight = topY + th + padding;

                if (Math.abs(this.size[1] - targetHeight) > 5) {
                    this.size[1] = targetHeight;
                }

                ctx.drawImage(this.previewImage, padding, topY, tw, th);

                if (this.droppedFrames.has(this.currentFrameIndex)) {
                    ctx.save();
                    ctx.fillStyle = "rgba(255,0,0,0.4)"; ctx.fillRect(padding, topY, tw, th);
                    ctx.strokeStyle = "red"; ctx.lineWidth = 5; ctx.beginPath();
                    ctx.moveTo(padding, topY); ctx.lineTo(padding + tw, topY + th);
                    ctx.moveTo(padding + tw, topY); ctx.lineTo(padding, topY + th);
                    ctx.stroke();
                    ctx.restore();
                }
            };
        };
    },

    async setup() {
        api.addEventListener("frame_deleter_paused", (e) => {
            const node = app.graph._nodes.find((n) => n.id.toString() === e.detail.node_id.toString());
            if (node) {
                node.totalFrames = e.detail.total_frames;
                node.filenames = e.detail.filenames;
                node.currentFrameIndex = 0;
                node.updateUI();
            }
        });

        api.addEventListener("frame_deleter_cleanup", (e) => {
            const node = app.graph._nodes.find((n) => n.id.toString() === e.detail.node_id.toString());
            if (node && node.resetUI) node.resetUI();
        });
    }
});
