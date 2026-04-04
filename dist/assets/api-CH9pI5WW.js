import { n as __esmMin } from "./chunk-C9LnQP83.js";
//#region src/shared/api.ts
async function getAuthHeaders() {
	const headers = { "Content-Type": "application/json" };
	try {
		const { apiToken } = await chrome.storage.local.get("apiToken");
		if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;
	} catch {}
	return headers;
}
async function authFetch(url, init = {}) {
	const headers = await getAuthHeaders();
	const res = await fetch(url, {
		...init,
		headers: {
			...headers,
			...init.headers
		}
	});
	if (res.status === 401) chrome.storage.local.remove("apiToken").catch(() => {});
	return res;
}
var API_BASE, api;
var init_api = __esmMin((() => {
	API_BASE = "https://www.devrecorder.com/api";
	api = {
		async createRecording(data) {
			const res = await authFetch(`${API_BASE}/recordings`, {
				method: "POST",
				body: JSON.stringify(data)
			});
			if (res.status === 403) {
				const body = await res.json();
				throw new Error(body.error || "Plan limit reached");
			}
			if (!res.ok) throw new Error(`Failed to create recording: ${res.status}`);
			return res.json();
		},
		async updateRecording(id, data) {
			await authFetch(`${API_BASE}/recordings/${id}`, {
				method: "PATCH",
				body: JSON.stringify(data)
			});
		},
		async uploadVideo(recordingId, videoBlob) {
			const CHUNK_SIZE = 10 * 1024 * 1024;
			const size = videoBlob.size;
			if (size < CHUNK_SIZE) {
				console.log(`DevRecorder API: small file (${size} bytes), using simple upload...`);
				const urlRes = await authFetch(`${API_BASE}/recordings/${recordingId}/upload-url`, { method: "POST" });
				if (!urlRes.ok) throw new Error(`Failed to get upload URL: ${urlRes.status}`);
				const { uploadUrl, key, videoUrl } = await urlRes.json();
				const uploadRes = await fetch(uploadUrl, {
					method: "PUT",
					body: videoBlob
				});
				if (!uploadRes.ok) throw new Error(`R2 upload failed: ${uploadRes.status}`);
				await authFetch(`${API_BASE}/recordings/${recordingId}/confirm-upload`, {
					method: "POST",
					body: JSON.stringify({
						key,
						videoUrl,
						fileSizeBytes: size
					})
				});
				console.log("DevRecorder API: simple upload done");
				return;
			}
			console.log(`DevRecorder API: large file (${size} bytes), using multipart upload...`);
			const startRes = await authFetch(`${API_BASE}/recordings/${recordingId}/multipart/start`, { method: "POST" });
			if (!startRes.ok) throw new Error(`Failed to start multipart: ${startRes.status}`);
			const { key, uploadId, videoUrl } = await startRes.json();
			const totalParts = Math.ceil(size / CHUNK_SIZE);
			const completedParts = [];
			for (let i = 0; i < totalParts; i++) {
				const partNumber = i + 1;
				const start = i * CHUNK_SIZE;
				const end = Math.min(start + CHUNK_SIZE, size);
				const chunk = videoBlob.slice(start, end);
				console.log(`DevRecorder API: uploading part ${partNumber}/${totalParts} (${chunk.size} bytes)...`);
				const partRes = await authFetch(`${API_BASE}/recordings/${recordingId}/multipart/part-url`, {
					method: "POST",
					body: JSON.stringify({
						key,
						uploadId,
						partNumber
					})
				});
				if (!partRes.ok) throw new Error(`Failed to get part URL: ${partRes.status}`);
				const { url: partUrl } = await partRes.json();
				let etag = null;
				for (let attempt = 1; attempt <= 3; attempt++) try {
					const uploadRes = await fetch(partUrl, {
						method: "PUT",
						body: chunk
					});
					if (!uploadRes.ok) throw new Error(`Part upload ${uploadRes.status}`);
					etag = uploadRes.headers.get("etag");
					break;
				} catch (err) {
					console.warn(`DevRecorder API: part ${partNumber} attempt ${attempt} failed:`, err);
					if (attempt === 3) throw err;
					await new Promise((r) => setTimeout(r, 1e3 * attempt));
				}
				completedParts.push({
					ETag: etag || "",
					PartNumber: partNumber
				});
			}
			const completeRes = await authFetch(`${API_BASE}/recordings/${recordingId}/multipart/complete`, {
				method: "POST",
				body: JSON.stringify({
					key,
					uploadId,
					videoUrl,
					parts: completedParts,
					fileSizeBytes: size
				})
			});
			if (!completeRes.ok) throw new Error(`Complete multipart failed: ${completeRes.status}`);
			console.log(`DevRecorder API: multipart upload done (${totalParts} parts)`);
		},
		async sendEvents(recordingId, events) {
			if (events.length === 0) return;
			await authFetch(`${API_BASE}/recordings/events/bulk`, {
				method: "POST",
				body: JSON.stringify({
					recordingId,
					events
				})
			});
		},
		async getRecordings() {
			return (await authFetch(`${API_BASE}/recordings`)).json();
		},
		async getRecording(id) {
			return (await authFetch(`${API_BASE}/recordings/${id}`)).json();
		},
		async getEvents(id, type) {
			return (await authFetch(type ? `${API_BASE}/recordings/${id}/events?type=${type}` : `${API_BASE}/recordings/${id}/events`)).json();
		},
		async deleteRecording(id) {
			await authFetch(`${API_BASE}/recordings/${id}`, { method: "DELETE" });
		}
	};
}));
//#endregion
export { init_api as n, api as t };
