(function() {
	//#region src/content/region-selector.ts
	(() => {
		if (document.getElementById("devloom-region-overlay")) return;
		const overlay = document.createElement("div");
		overlay.id = "devloom-region-overlay";
		overlay.style.cssText = `
    position:fixed;inset:0;z-index:2147483647;
    background:rgba(0,0,0,0.4);cursor:crosshair;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  `;
		const instructions = document.createElement("div");
		instructions.textContent = "Drag to select the region to record. Press Esc to cancel.";
		instructions.style.cssText = `
    position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:2147483647;
    background:#1a1b2e;color:#e0e0e8;padding:10px 20px;border-radius:8px;
    font-size:14px;font-weight:500;pointer-events:none;
    box-shadow:0 4px 20px rgba(0,0,0,0.5);
  `;
		overlay.appendChild(instructions);
		const selBox = document.createElement("div");
		selBox.style.cssText = `
    position:fixed;border:2px solid #6a7bff;background:rgba(106,123,255,0.1);
    display:none;z-index:2147483647;pointer-events:none;
  `;
		overlay.appendChild(selBox);
		const dimLabel = document.createElement("div");
		dimLabel.style.cssText = `
    position:fixed;background:#6a7bff;color:#fff;padding:3px 8px;
    border-radius:4px;font-size:11px;font-weight:600;
    pointer-events:none;display:none;z-index:2147483647;
  `;
		overlay.appendChild(dimLabel);
		let startX = 0, startY = 0;
		let dragging = false;
		overlay.onmousedown = (e) => {
			e.preventDefault();
			dragging = true;
			startX = e.clientX;
			startY = e.clientY;
			selBox.style.display = "block";
			selBox.style.left = `${startX}px`;
			selBox.style.top = `${startY}px`;
			selBox.style.width = "0px";
			selBox.style.height = "0px";
			dimLabel.style.display = "block";
			instructions.style.display = "none";
		};
		overlay.onmousemove = (e) => {
			if (!dragging) return;
			const x = Math.min(startX, e.clientX);
			const y = Math.min(startY, e.clientY);
			const w = Math.abs(e.clientX - startX);
			const h = Math.abs(e.clientY - startY);
			selBox.style.left = `${x}px`;
			selBox.style.top = `${y}px`;
			selBox.style.width = `${w}px`;
			selBox.style.height = `${h}px`;
			dimLabel.style.left = `${x}px`;
			dimLabel.style.top = `${y + h + 6}px`;
			dimLabel.textContent = `${w} × ${h}`;
		};
		overlay.onmouseup = (e) => {
			if (!dragging) return;
			dragging = false;
			const x = Math.min(startX, e.clientX);
			const y = Math.min(startY, e.clientY);
			const w = Math.abs(e.clientX - startX);
			const h = Math.abs(e.clientY - startY);
			if (w < 20 || h < 20) {
				cleanup();
				chrome.runtime.sendMessage({ type: "REGION_CANCELLED" });
				return;
			}
			overlay.remove();
			document.removeEventListener("keydown", onKeydown);
			showRegionBorder(x, y, w, h);
			const dpr = window.devicePixelRatio || 1;
			chrome.runtime.sendMessage({
				type: "REGION_SELECTED",
				rect: {
					x: Math.round(x * dpr),
					y: Math.round(y * dpr),
					width: Math.round(w * dpr),
					height: Math.round(h * dpr)
				}
			});
		};
		function onKeydown(e) {
			if (e.key === "Escape") {
				cleanup();
				chrome.runtime.sendMessage({ type: "REGION_CANCELLED" });
			}
		}
		document.addEventListener("keydown", onKeydown);
		function cleanup() {
			overlay.remove();
			document.removeEventListener("keydown", onKeydown);
		}
		function showRegionBorder(x, y, w, h) {
			const border = document.createElement("div");
			border.id = "devloom-region-border";
			border.style.cssText = `
      position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;
      border:2px dashed #6a7bff;border-radius:4px;
      z-index:2147483646;pointer-events:none;
      box-shadow:0 0 0 9999px rgba(0,0,0,0.15);
    `;
			document.body.appendChild(border);
			chrome.runtime.onMessage.addListener(function handler(msg) {
				if (msg && msg.type === "DEVLOOM_REMOVE_DRAWING") {
					border.remove();
					chrome.runtime.onMessage.removeListener(handler);
				}
			});
		}
		document.body.appendChild(overlay);
	})();
	//#endregion
})();
