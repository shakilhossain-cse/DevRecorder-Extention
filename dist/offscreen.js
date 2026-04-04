import { t as __commonJSMin } from "./assets/chunk-C9LnQP83.js";
import "./assets/modulepreload-polyfill-aOyzcF2x.js";
import { n as init_types, t as MSG } from "./assets/types-XsW6vnjp.js";
import { n as init_api, t as api } from "./assets/api-CH9pI5WW.js";
(/* @__PURE__ */ __commonJSMin((() => {
	init_types();
	init_api();
	var mediaRecorder = null;
	var chunks = [];
	var recordingId = null;
	var startTime = null;
	var cropIntervalId = null;
	chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
		if (msg.type === MSG.BEGIN_CAPTURE) {
			startCapture(msg.recordingId, msg.cropRect);
			sendResponse({ success: true });
			return false;
		}
		if (msg.type === MSG.STOP_RECORDING) {
			stopMediaRecorder();
			sendResponse({ success: true });
			return false;
		}
	});
	async function startCapture(recId, cropRect) {
		recordingId = recId;
		startTime = Date.now();
		chunks = [];
		try {
			const displayStream = await navigator.mediaDevices.getDisplayMedia({
				video: {
					displaySurface: "window",
					frameRate: 30
				},
				audio: true,
				surfaceSwitching: "exclude",
				selfBrowserSurface: "include",
				monitorTypeSurfaces: "exclude"
			});
			if (displayStream.getVideoTracks()[0]?.getSettings()?.displaySurface === "monitor") {
				displayStream.getTracks().forEach((t) => t.stop());
				throw new Error("Please select a Window or Chrome Tab, not Entire Screen.");
			}
			let micStream = null;
			try {
				if ((await navigator.permissions.query({ name: "microphone" })).state === "granted") {
					micStream = await navigator.mediaDevices.getUserMedia({
						audio: {
							echoCancellation: true,
							noiseSuppression: true
						},
						video: false
					});
					console.log("DevLoom: Mic acquired —", micStream.getAudioTracks().length, "tracks");
				} else console.log("DevLoom: Mic permission not granted, recording without voice");
			} catch {
				console.log("DevLoom: Mic unavailable, recording without voice");
			}
			let recordStream;
			let audioCtx = null;
			if (cropRect && cropRect.width > 0 && cropRect.height > 0) {
				const video = document.createElement("video");
				video.srcObject = displayStream;
				video.muted = true;
				video.playsInline = true;
				await video.play();
				const settings = displayStream.getVideoTracks()[0].getSettings();
				const srcW = settings.width || video.videoWidth;
				const srcH = settings.height || video.videoHeight;
				const screenW = screen.width * (devicePixelRatio || 1);
				const screenH = screen.height * (devicePixelRatio || 1);
				const scaleX = srcW / screenW;
				const scaleY = srcH / screenH;
				const sx = Math.round(cropRect.x * scaleX);
				const sy = Math.round(cropRect.y * scaleY);
				const sw = Math.round(cropRect.width * scaleX);
				const sh = Math.round(cropRect.height * scaleY);
				const canvas = document.createElement("canvas");
				canvas.width = sw;
				canvas.height = sh;
				const ctx = canvas.getContext("2d");
				cropIntervalId = setInterval(() => {
					ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
				}, 33);
				const canvasStream = canvas.captureStream(30);
				audioCtx = new AudioContext();
				const dest = audioCtx.createMediaStreamDestination();
				const sysAudio = displayStream.getAudioTracks();
				if (sysAudio.length > 0) audioCtx.createMediaStreamSource(new MediaStream(sysAudio)).connect(dest);
				if (micStream) audioCtx.createMediaStreamSource(micStream).connect(dest);
				recordStream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
			} else {
				const video = document.createElement("video");
				video.srcObject = displayStream;
				video.muted = true;
				video.playsInline = true;
				await video.play();
				const vw = displayStream.getVideoTracks()[0].getSettings().width || video.videoWidth || 1920;
				const vh = displayStream.getVideoTracks()[0].getSettings().height || video.videoHeight || 1080;
				const canvas = document.createElement("canvas");
				canvas.width = vw;
				canvas.height = vh;
				const ctx = canvas.getContext("2d");
				cropIntervalId = setInterval(() => {
					ctx.drawImage(video, 0, 0, vw, vh);
				}, 33);
				const canvasStream = canvas.captureStream(30);
				const hasSystemAudio = displayStream.getAudioTracks().length > 0;
				const hasMic = micStream && micStream.getAudioTracks().length > 0;
				console.log(`DevLoom: Audio — system: ${hasSystemAudio}, mic: ${hasMic}`);
				const audioTracks = [];
				if (hasSystemAudio || hasMic) {
					audioCtx = new AudioContext();
					const dest = audioCtx.createMediaStreamDestination();
					if (hasSystemAudio) audioCtx.createMediaStreamSource(new MediaStream(displayStream.getAudioTracks())).connect(dest);
					if (hasMic && micStream) audioCtx.createMediaStreamSource(micStream).connect(dest);
					audioTracks.push(...dest.stream.getAudioTracks());
				}
				recordStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioTracks]);
			}
			const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm;codecs=vp8";
			mediaRecorder = new MediaRecorder(recordStream, {
				mimeType,
				videoBitsPerSecond: 25e5
			});
			mediaRecorder.ondataavailable = (e) => {
				if (e.data.size > 0) chunks.push(e.data);
			};
			mediaRecorder.onstop = async () => {
				const duration = Date.now() - startTime;
				const blob = new Blob(chunks, { type: mimeType });
				const currentRecId = recordingId;
				console.log(`DevLoom: onstop fired — blob ${blob.size} bytes, ${chunks.length} chunks`);
				if (cropIntervalId) {
					clearInterval(cropIntervalId);
					cropIntervalId = null;
				}
				displayStream.getTracks().forEach((track) => track.stop());
				if (micStream) micStream.getTracks().forEach((track) => track.stop());
				if (audioCtx) audioCtx.close();
				if (blob.size > 0) try {
					console.log(`DevLoom: Uploading ${blob.size} bytes via presigned URL...`);
					await api.uploadVideo(currentRecId, blob);
					console.log("DevLoom: Video uploaded to R2");
				} catch (err) {
					console.error("DevLoom: Upload failed", err);
				}
				else console.error("DevLoom: Blob is empty — nothing to upload");
				chrome.runtime.sendMessage({
					type: MSG.RECORDING_SAVED,
					recordingId: currentRecId,
					duration
				});
				chunks = [];
				mediaRecorder = null;
				recordingId = null;
				startTime = null;
			};
			displayStream.getVideoTracks()[0].addEventListener("ended", () => {
				if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
			});
			mediaRecorder.start(1e3);
			chrome.runtime.sendMessage({ type: MSG.CAPTURE_READY });
		} catch (err) {
			console.error("DevLoom: Failed to start capture", err);
			chrome.runtime.sendMessage({
				type: MSG.CAPTURE_FAILED,
				error: err.message
			});
		}
	}
	function stopMediaRecorder() {
		if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
	}
})))();
//#endregion
