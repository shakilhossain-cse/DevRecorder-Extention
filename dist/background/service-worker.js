import { t as __commonJSMin } from "../assets/chunk-C9LnQP83.js";
import { n as init_types, t as MSG } from "../assets/types-XsW6vnjp.js";
import { n as init_api, t as api } from "../assets/api-CH9pI5WW.js";
//#region src/background/service-worker.ts
var require_service_worker = /* @__PURE__ */ __commonJSMin((() => {
	init_api();
	init_types();
	chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
	var recording = {
		status: "idle",
		id: null,
		tabId: null,
		startTime: null
	};
	var pendingRequests = /* @__PURE__ */ new Map();
	var eventBuffer = [];
	var flushTimer = null;
	var FLUSH_INTERVAL = 2e3;
	function queueEvent(type, relativeTime, data) {
		if (!recording.id) return;
		eventBuffer.push({
			type,
			relativeTime,
			data
		});
		if (!flushTimer) flushTimer = setTimeout(flushEvents, FLUSH_INTERVAL);
	}
	function flushEvents() {
		flushTimer = null;
		if (eventBuffer.length === 0 || !recording.id) return;
		const batch = eventBuffer;
		eventBuffer = [];
		api.sendEvents(recording.id, batch).catch((err) => console.error("DevLoom: Failed to send events", err));
	}
	var pendingRegion = null;
	chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
		switch (msg.type) {
			case MSG.START_RECORDING:
				startRecording(msg.tabId, msg.tabTitle, msg.tabUrl, msg.captureMode).then(sendResponse);
				return true;
			case MSG.STOP_RECORDING:
				stopRecording().then(sendResponse);
				return true;
			case MSG.RECORDING_STATE:
				sendResponse({ ...recording });
				return false;
			case MSG.RECORDING_SAVED:
				onRecordingSaved(msg.recordingId, msg.duration);
				return false;
			case MSG.CAPTURE_READY: return false;
			case MSG.CAPTURE_FAILED:
				handleCaptureFailed();
				return false;
			case MSG.REGION_SELECTED:
				if (pendingRegion) {
					const { tabId, tabTitle, tabUrl, resolve } = pendingRegion;
					pendingRegion = null;
					beginRecordingWithRegion(tabId, tabTitle, tabUrl, msg.rect).then(resolve);
				}
				return false;
			case MSG.REGION_CANCELLED:
				if (pendingRegion) {
					pendingRegion.resolve({
						success: false,
						error: "Region selection cancelled"
					});
					pendingRegion = null;
				}
				return false;
			case MSG.CONSOLE_EVENT:
				if (recording.status === "recording") handleConsoleEvent(msg.data);
				return false;
			default: {
				const raw = msg;
				if (raw.type === "AUTH_TOKEN_RECEIVED" && raw.token) {
					chrome.storage.local.set({ apiToken: raw.token });
					console.log("DevRecorder SW: auth token stored");
					return false;
				}
				if (raw.type === "AUTH_LOGOUT") {
					chrome.storage.local.remove("apiToken");
					console.log("DevRecorder SW: auth token removed");
					return false;
				}
				if (raw.type === "NETWORK_RESPONSE" && recording.status === "recording") {
					console.log("DevLoom SW: got response body for", raw.data?.method, raw.data?.url?.slice(0, 60));
					handleNetworkResponse(raw.data);
				}
				return false;
			}
		}
	});
	async function startRecording(tabId, tabTitle, tabUrl, captureMode = "window") {
		if (recording.status !== "idle") return {
			success: false,
			error: "Already recording"
		};
		if (captureMode === "region") {
			try {
				await chrome.scripting.executeScript({
					target: { tabId },
					files: ["content/region-selector.js"]
				});
			} catch {
				return {
					success: false,
					error: "Cannot inject region selector on this page"
				};
			}
			return new Promise((resolve) => {
				pendingRegion = {
					tabId,
					tabTitle,
					tabUrl,
					resolve
				};
			});
		}
		return beginRecording(tabId, tabTitle, tabUrl);
	}
	async function beginRecording(tabId, tabTitle, tabUrl, cropRect) {
		try {
			const now = Date.now();
			const rec = await api.createRecording({
				title: tabTitle || "Untitled Recording",
				url: tabUrl || "",
				startTime: now,
				duration: 0
			});
			await ensureOffscreenDocument();
			await chrome.runtime.sendMessage({
				type: MSG.BEGIN_CAPTURE,
				recordingId: rec._id,
				cropRect
			});
			recording = {
				status: "recording",
				id: rec._id,
				tabId,
				startTime: now
			};
			startNetworkListeners();
			startNavigationListeners();
			try {
				await chrome.scripting.executeScript({
					target: { tabId },
					files: ["content/content.js"]
				});
			} catch {}
			try {
				await chrome.scripting.executeScript({
					target: { tabId },
					files: ["content/drawing-overlay.js"]
				});
				injectedTabs.add(tabId);
			} catch {}
			chrome.action.setBadgeText({ text: "REC" });
			chrome.action.setBadgeBackgroundColor({ color: "#dc3232" });
			startKeepalive();
			return {
				success: true,
				recordingId: rec._id
			};
		} catch (err) {
			return {
				success: false,
				error: err.message
			};
		}
	}
	async function beginRecordingWithRegion(tabId, tabTitle, tabUrl, cropRect) {
		return beginRecording(tabId, tabTitle, tabUrl, cropRect);
	}
	function handleCaptureFailed() {
		if (recording.id) api.deleteRecording(recording.id).catch(() => {});
		removeOverlayFromAllTabs();
		stopNetworkListeners();
		stopNavigationListeners();
		chrome.action.setBadgeText({ text: "" });
		stopKeepalive();
		recording = {
			status: "idle",
			id: null,
			tabId: null,
			startTime: null
		};
	}
	function removeOverlayFromAllTabs() {
		for (const tabId of injectedTabs) chrome.tabs.sendMessage(tabId, { type: "DEVLOOM_REMOVE_DRAWING" }).catch(() => {});
		injectedTabs.clear();
	}
	async function stopRecording() {
		if (recording.status !== "recording") return {
			success: false,
			error: "Not recording"
		};
		recording.status = "stopping";
		try {
			flushEvents();
			await chrome.runtime.sendMessage({ type: MSG.STOP_RECORDING });
			stopNetworkListeners();
			stopNavigationListeners();
			chrome.action.setBadgeText({ text: "" });
			stopKeepalive();
			removeOverlayFromAllTabs();
			return {
				success: true,
				recordingId: recording.id
			};
		} catch (err) {
			return {
				success: false,
				error: err.message
			};
		}
	}
	function onRecordingSaved(recordingId, duration) {
		console.log(`DevLoom SW: recording saved — id=${recordingId}, duration=${duration}ms`);
		api.updateRecording(recordingId, { duration }).catch((err) => console.error("DevLoom SW: Failed to update duration", err));
		recording = {
			status: "idle",
			id: null,
			tabId: null,
			startTime: null
		};
	}
	async function ensureOffscreenDocument() {
		try {
			await chrome.offscreen.closeDocument();
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
		await chrome.offscreen.createDocument({
			url: "offscreen.html",
			reasons: ["DISPLAY_MEDIA"],
			justification: "Recording screen/window via getDisplayMedia"
		});
	}
	function onBeforeRequest(details) {
		if (details.tabId !== recording.tabId) return;
		if (details.type !== "xmlhttprequest") return;
		let requestBody = null;
		if (details.requestBody) {
			if (details.requestBody.raw) try {
				const decoder = new TextDecoder();
				requestBody = details.requestBody.raw.filter((p) => p.bytes).map((p) => decoder.decode(p.bytes)).join("");
			} catch {
				requestBody = "[Binary data]";
			}
			else if (details.requestBody.formData) requestBody = JSON.stringify(details.requestBody.formData, null, 2);
		}
		pendingRequests.set(details.requestId, {
			url: details.url,
			method: details.method,
			type: details.type,
			startTime: details.timeStamp,
			initiator: details.initiator || "",
			requestHeaders: {},
			responseHeaders: {},
			requestBody
		});
	}
	function onSendHeaders(details) {
		if (details.tabId !== recording.tabId) return;
		const req = pendingRequests.get(details.requestId);
		if (!req || !details.requestHeaders) return;
		const headers = {};
		for (const h of details.requestHeaders) if (h.name && h.value) headers[h.name] = h.value;
		req.requestHeaders = headers;
	}
	function onHeadersReceived(details) {
		if (details.tabId !== recording.tabId) return;
		const req = pendingRequests.get(details.requestId);
		if (!req || !details.responseHeaders) return;
		const headers = {};
		for (const h of details.responseHeaders) if (h.name && h.value) headers[h.name] = h.value;
		req.responseHeaders = headers;
	}
	function onCompleted(details) {
		if (details.tabId !== recording.tabId) return;
		const req = pendingRequests.get(details.requestId);
		if (!req) return;
		pendingRequests.delete(details.requestId);
		const relTime = req.startTime - recording.startTime;
		setTimeout(() => {
			const bodyKey = `${req.method}:${req.url}`;
			const bodies = responseBodyBuffer.get(bodyKey);
			if (bodies) responseBodyBuffer.delete(bodyKey);
			queueEvent("network", relTime, {
				url: req.url,
				method: req.method,
				resourceType: req.type,
				status: details.statusCode,
				statusLine: details.statusLine,
				duration: details.timeStamp - req.startTime,
				initiator: req.initiator,
				error: null,
				requestHeaders: req.requestHeaders,
				responseHeaders: req.responseHeaders,
				requestBody: bodies?.requestBody || req.requestBody,
				responseBody: bodies?.responseBody || null
			});
		}, 500);
	}
	function onErrorOccurred(details) {
		if (details.tabId !== recording.tabId) return;
		const req = pendingRequests.get(details.requestId);
		if (!req) return;
		pendingRequests.delete(details.requestId);
		const data = {
			url: req.url,
			method: req.method,
			resourceType: req.type,
			status: 0,
			statusLine: "",
			duration: details.timeStamp - req.startTime,
			initiator: req.initiator,
			error: details.error,
			requestHeaders: req.requestHeaders,
			responseHeaders: req.responseHeaders,
			requestBody: req.requestBody,
			responseBody: null
		};
		queueEvent("network", req.startTime - recording.startTime, data);
	}
	function startNetworkListeners() {
		const filter = { urls: ["<all_urls>"] };
		chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, filter, ["requestBody"]);
		chrome.webRequest.onSendHeaders.addListener(onSendHeaders, filter, ["requestHeaders"]);
		chrome.webRequest.onHeadersReceived.addListener(onHeadersReceived, filter, ["responseHeaders"]);
		chrome.webRequest.onCompleted.addListener(onCompleted, filter);
		chrome.webRequest.onErrorOccurred.addListener(onErrorOccurred, filter);
	}
	function stopNetworkListeners() {
		chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
		chrome.webRequest.onSendHeaders.removeListener(onSendHeaders);
		chrome.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
		chrome.webRequest.onCompleted.removeListener(onCompleted);
		chrome.webRequest.onErrorOccurred.removeListener(onErrorOccurred);
		pendingRequests.clear();
	}
	function onNavCommitted(details) {
		if (details.tabId !== recording.tabId || details.frameId !== 0) return;
		queueEvent("navigation", details.timeStamp - recording.startTime, {
			url: details.url,
			transitionType: details.transitionType
		});
	}
	function onHistoryStateUpdated(details) {
		if (details.tabId !== recording.tabId || details.frameId !== 0) return;
		queueEvent("navigation", details.timeStamp - recording.startTime, {
			url: details.url,
			transitionType: "spa_navigation"
		});
	}
	function startNavigationListeners() {
		chrome.webNavigation.onCommitted.addListener(onNavCommitted);
		chrome.webNavigation.onHistoryStateUpdated.addListener(onHistoryStateUpdated);
	}
	function stopNavigationListeners() {
		chrome.webNavigation.onCommitted.removeListener(onNavCommitted);
		chrome.webNavigation.onHistoryStateUpdated.removeListener(onHistoryStateUpdated);
	}
	function handleConsoleEvent(data) {
		queueEvent("console", data.timestamp - recording.startTime, {
			level: data.level,
			args: data.args,
			stack: data.stack || ""
		});
	}
	var responseBodyBuffer = /* @__PURE__ */ new Map();
	function handleNetworkResponse(data) {
		const key = `${data.method}:${data.url}`;
		responseBodyBuffer.set(key, {
			requestBody: data.requestBody,
			responseBody: data.responseBody
		});
		setTimeout(() => responseBodyBuffer.delete(key), 1e4);
	}
	var injectedTabs = /* @__PURE__ */ new Set();
	chrome.tabs.onActivated.addListener(async (activeInfo) => {
		if (recording.status !== "recording") return;
		const newTabId = activeInfo.tabId;
		recording.tabId = newTabId;
		if (!injectedTabs.has(newTabId)) {
			try {
				await chrome.scripting.executeScript({
					target: { tabId: newTabId },
					files: ["content/content.js"]
				});
			} catch {}
			try {
				await chrome.scripting.executeScript({
					target: { tabId: newTabId },
					files: ["content/drawing-overlay.js"]
				});
				injectedTabs.add(newTabId);
			} catch {}
		}
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		injectedTabs.delete(tabId);
		if (recording.status === "recording" && recording.tabId === tabId) stopRecording();
	});
	function startKeepalive() {
		chrome.alarms.create("devloom-keepalive", { periodInMinutes: .4 });
	}
	function stopKeepalive() {
		chrome.alarms.clear("devloom-keepalive");
	}
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === "devloom-keepalive" && recording.status === "recording") {}
	});
}));
//#endregion
export default require_service_worker();
