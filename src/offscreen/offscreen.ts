import { MSG } from '@shared/types';
import type { ExtensionMessage, CropRect } from '@shared/types';
import { api } from '@shared/api';

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let recordingId: string | null = null;
let startTime: number | null = null;
let cropIntervalId: ReturnType<typeof setInterval> | null = null;

chrome.runtime.onMessage.addListener(
  (msg: any, _sender: any, sendResponse: any) => {
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

    if (msg.type === MSG.PAUSE_RECORDING) {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.pause();
      }
      sendResponse({ success: true });
      return false;
    }

    if (msg.type === MSG.RESUME_RECORDING) {
      if (mediaRecorder && mediaRecorder.state === 'paused') {
        mediaRecorder.resume();
      }
      sendResponse({ success: true });
      return false;
    }

  }
);

async function startCapture(recId: string, cropRect?: CropRect): Promise<void> {
  recordingId = recId;
  startTime = Date.now();
  chunks = [];

  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true,
      // @ts-expect-error — Chrome-specific options
      preferCurrentTab: false,
      surfaceSwitching: 'exclude',
      selfBrowserSurface: 'include',
      monitorTypeSurfaces: 'exclude',
      systemAudio: 'include',
    });

    const surface = displayStream.getVideoTracks()[0]?.getSettings()?.displaySurface;
    if (surface === 'monitor') {
      displayStream.getTracks().forEach((t) => t.stop());
      throw new Error('Please select a Window or Chrome Tab, not Entire Screen.');
    }

    // Microphone — only attempt if permission already granted (offscreen can't show prompts)
    let micStream: MediaStream | null = null;
    try {
      const perm = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (perm.state === 'granted') {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
      }
    } catch {
      // Mic unavailable
    }

    let recordStream: MediaStream;
    let audioCtx: AudioContext | null = null;

    const isRegion = cropRect && cropRect.width > 0 && cropRect.height > 0;

    if (isRegion) {
      // ── Region mode: canvas crop + AudioContext for audio ──
      const video = document.createElement('video');
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

      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d')!;

      cropIntervalId = setInterval(() => {
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
      }, 33);

      const canvasStream = canvas.captureStream(30);

      // Mix audio via AudioContext (needed because canvas has no audio)
      const allAudioTracks: MediaStreamTrack[] = [];
      const sysAudio = displayStream.getAudioTracks();
      const hasMic = micStream && micStream.getAudioTracks().length > 0;

      if (sysAudio.length > 0 || hasMic) {
        audioCtx = new AudioContext();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        const dest = audioCtx.createMediaStreamDestination();
        if (sysAudio.length > 0) {
          audioCtx.createMediaStreamSource(new MediaStream(sysAudio)).connect(dest);
        }
        if (hasMic && micStream) {
          audioCtx.createMediaStreamSource(micStream).connect(dest);
        }
        allAudioTracks.push(...dest.stream.getAudioTracks());
      }

      recordStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...allAudioTracks,
      ]);
    } else if (micStream && micStream.getAudioTracks().length > 0) {
      // ── Window mode WITH mic: need AudioContext to mix system + mic audio ──
      // Keep displayStream video track directly (no canvas = better quality)
      const allAudioTracks: MediaStreamTrack[] = [];
      const sysAudio = displayStream.getAudioTracks();

      audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const dest = audioCtx.createMediaStreamDestination();
      if (sysAudio.length > 0) {
        audioCtx.createMediaStreamSource(new MediaStream(sysAudio)).connect(dest);
      }
      audioCtx.createMediaStreamSource(micStream).connect(dest);
      allAudioTracks.push(...dest.stream.getAudioTracks());

      recordStream = new MediaStream([
        ...displayStream.getVideoTracks(),
        ...allAudioTracks,
      ]);
    } else {
      // ── Window mode WITHOUT mic: record displayStream directly ──
      // No canvas, no AudioContext — native audio passthrough
      recordStream = displayStream;
    }

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';

    mediaRecorder = new MediaRecorder(recordStream, {
      mimeType,
      videoBitsPerSecond: 2_500_000,
    });

    mediaRecorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    mediaRecorder.onstop = async () => {
      const duration = Date.now() - startTime!;
      const blob = new Blob(chunks, { type: mimeType });
      const currentRecId = recordingId!;

      if (cropIntervalId) {
        clearInterval(cropIntervalId);
        cropIntervalId = null;
      }

      displayStream.getTracks().forEach((track) => track.stop());
      if (micStream) micStream.getTracks().forEach((track) => track.stop());
      if (audioCtx) audioCtx.close();

      if (blob.size > 0) {
        try {
          await api.uploadVideo(currentRecId, blob);
        } catch {
          // Upload failed
        }
      }

      chrome.runtime.sendMessage({
        type: MSG.RECORDING_SAVED,
        recordingId: currentRecId,
        duration,
      });

      chunks = [];
      mediaRecorder = null;
      recordingId = null;
      startTime = null;
    };

    displayStream.getVideoTracks()[0].addEventListener('ended', () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    });

    mediaRecorder.start(1000);

    chrome.runtime.sendMessage({ type: MSG.CAPTURE_READY });
  } catch (err) {
    chrome.runtime.sendMessage({
      type: MSG.CAPTURE_FAILED,
      error: (err as Error).message,
    });
  }
}

function stopMediaRecorder(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}
