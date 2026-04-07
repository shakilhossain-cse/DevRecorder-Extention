import { MSG } from '@shared/types';
import type { ExtensionMessage, CropRect } from '@shared/types';
import { api } from '@shared/api';

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let recordingId: string | null = null;
let startTime: number | null = null;
let cropIntervalId: ReturnType<typeof setInterval> | null = null;

chrome.runtime.onMessage.addListener(
  (msg: ExtensionMessage, _sender, sendResponse) => {
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
  }
);

async function startCapture(recId: string, cropRect?: CropRect): Promise<void> {
  recordingId = recId;
  startTime = Date.now();
  chunks = [];

  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'window',
        frameRate: 30,
      },
      audio: true,
      // @ts-expect-error — Chrome-specific: hide "Entire Screen" tab
      surfaceSwitching: 'exclude',
      selfBrowserSurface: 'include',
      monitorTypeSurfaces: 'exclude',
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
        // Mic acquired
      } else {
        // Mic permission not granted, recording without voice
      }
    } catch {
      // Mic unavailable, recording without voice
    }

    // Build the stream to record — keep displayStream as-is for window mode
    let recordStream: MediaStream;
    let audioCtx: AudioContext | null = null;

    if (cropRect && cropRect.width > 0 && cropRect.height > 0) {
      // Region mode: use hidden video + canvas to crop
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

      // For region mode, mix audio separately
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      const sysAudio = displayStream.getAudioTracks();
      if (sysAudio.length > 0) {
        audioCtx.createMediaStreamSource(new MediaStream(sysAudio)).connect(dest);
      }
      if (micStream) {
        audioCtx.createMediaStreamSource(micStream).connect(dest);
      }

      recordStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ]);
    } else {
      // Window mode: play displayStream in a <video> to keep tracks alive,
      // then use canvas.captureStream for video + AudioContext for mixed audio
      const video = document.createElement('video');
      video.srcObject = displayStream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      const vw = displayStream.getVideoTracks()[0].getSettings().width || video.videoWidth || 1920;
      const vh = displayStream.getVideoTracks()[0].getSettings().height || video.videoHeight || 1080;

      const canvas = document.createElement('canvas');
      canvas.width = vw;
      canvas.height = vh;
      const ctx = canvas.getContext('2d')!;

      cropIntervalId = setInterval(() => {
        ctx.drawImage(video, 0, 0, vw, vh);
      }, 33);

      const canvasStream = canvas.captureStream(30);

      // Mix system audio + mic
      const hasSystemAudio = displayStream.getAudioTracks().length > 0;
      const hasMic = micStream && micStream.getAudioTracks().length > 0;
      // Audio — system: ${hasSystemAudio}, mic: ${hasMic}

      const audioTracks: MediaStreamTrack[] = [];
      if (hasSystemAudio || hasMic) {
        audioCtx = new AudioContext();
        const dest = audioCtx.createMediaStreamDestination();
        if (hasSystemAudio) {
          audioCtx.createMediaStreamSource(new MediaStream(displayStream.getAudioTracks())).connect(dest);
        }
        if (hasMic && micStream) {
          audioCtx.createMediaStreamSource(micStream).connect(dest);
        }
        audioTracks.push(...dest.stream.getAudioTracks());
      }

      recordStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioTracks,
      ]);
    }

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm;codecs=vp8';

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

      // onstop fired

      // Stop crop loop
      if (cropIntervalId) {
        clearInterval(cropIntervalId);
        cropIntervalId = null;
      }

      displayStream.getTracks().forEach((track) => track.stop());
      if (micStream) micStream.getTracks().forEach((track) => track.stop());
      if (audioCtx) audioCtx.close();

      // Upload video FIRST (before notifying saved, so offscreen stays alive)
      if (blob.size > 0) {
        try {
          await api.uploadVideo(currentRecId, blob);
        } catch {
          // Upload failed
        }
      } else {
        // Blob is empty — nothing to upload
      }

      // Notify service worker AFTER upload completes
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
    // Failed to start capture
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
