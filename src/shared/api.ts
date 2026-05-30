const API_BASE =  'https://www.devrecorder.com/api'


async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const { apiToken } = await chrome.storage.local.get('apiToken');
    if (apiToken) {
      headers['Authorization'] = `Bearer ${apiToken}`;
    }
  } catch {
    // storage may not be available in all contexts
  }
  return headers;
}

async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  console.log(`Making API request to ${url} with init:`, init);
  const headers = await getAuthHeaders();
  const res = await fetch(url, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string>) },
  });

  if (res.status === 401) {
    // Token is invalid  clear it so popup shows login
    chrome.storage.local.remove('apiToken').catch(() => {});
  }

  return res;
}

export const api = {
  async createRecording(data: {
    title: string;
    description?: string;
    url: string;
    startTime: number;
    duration: number;
    mediaType?: 'video' | 'screenshot';
    recordingSurface?: 'tab' | 'desktop' | 'region';
    micEnabled?: boolean;
    isIncognito?: boolean;
    detectedLibs?: string[];
  }): Promise<{ _id: string }> {
    const res = await authFetch(`${API_BASE}/recordings`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (res.status === 403) {
      const body = await res.json();
      throw new Error(body.error || 'Plan limit reached');
    }
    if (!res.ok) throw new Error(`Failed to create recording: ${res.status}`);
    return res.json();
  },

  async updateRecording(
    id: string,
    data: Partial<{ duration: number }>,
  ): Promise<void> {
    await authFetch(`${API_BASE}/recordings/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  async uploadThumbnail(recordingId: string, imageBlob: Blob): Promise<string | null> {
    try {
      const urlRes = await authFetch(`${API_BASE}/recordings/${recordingId}/upload-url`, {
        method: 'POST',
        body: JSON.stringify({ contentType: 'image/jpeg', isThumbnail: true }),
      });
      if (!urlRes.ok) return null;
      const { uploadUrl, key, videoUrl: thumbnailUrl } = await urlRes.json();

      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        body: imageBlob,
        headers: { 'Content-Type': 'image/jpeg' },
      });
      if (!uploadRes.ok) return null;

      // Save thumbnail URL to the recording
      await authFetch(`${API_BASE}/recordings/${recordingId}`, {
        method: 'PATCH',
        body: JSON.stringify({ thumbnailKey: key, thumbnailUrl }),
      });

      return thumbnailUrl;
    } catch {
      return null;
    }
  },

  async uploadScreenshot(recordingId: string, imageBlob: Blob): Promise<void> {
    const urlRes = await authFetch(`${API_BASE}/recordings/${recordingId}/upload-url`, {
      method: 'POST',
      body: JSON.stringify({ contentType: 'image/png' }),
    });
    if (!urlRes.ok) throw new Error(`Failed to get upload URL: ${urlRes.status}`);
    const { uploadUrl, key, videoUrl } = await urlRes.json();

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: imageBlob,
      headers: { 'Content-Type': 'image/png' },
    });
    if (!uploadRes.ok) throw new Error(`R2 upload failed: ${uploadRes.status}`);

    await authFetch(`${API_BASE}/recordings/${recordingId}/confirm-upload`, {
      method: 'POST',
      body: JSON.stringify({ key, videoUrl, fileSizeBytes: imageBlob.size }),
    });
  },

  async uploadVideo(recordingId: string, videoBlob: Blob, _onProgress?: (pct: number) => void): Promise<void> {
    const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB per part
    const size = videoBlob.size;

    // Small files (<10MB): use simple presigned PUT
    if (size < CHUNK_SIZE) {
      // Small file  simple upload
      const urlRes = await authFetch(`${API_BASE}/recordings/${recordingId}/upload-url`, {
        method: 'POST',
      });
      if (!urlRes.ok) throw new Error(`Failed to get upload URL: ${urlRes.status}`);
      const { uploadUrl, key, videoUrl } = await urlRes.json();

      const uploadRes = await fetch(uploadUrl, { method: 'PUT', body: videoBlob });
      if (!uploadRes.ok) throw new Error(`R2 upload failed: ${uploadRes.status}`);

      await authFetch(`${API_BASE}/recordings/${recordingId}/confirm-upload`, {
        method: 'POST',
        body: JSON.stringify({ key, videoUrl, fileSizeBytes: size }),
      });
      // Simple upload done
      return;
    }

    // Large files: multipart upload
    // Large file  multipart upload

    // 1. Start multipart upload
    const startRes = await authFetch(`${API_BASE}/recordings/${recordingId}/multipart/start`, {
      method: 'POST',
    });
    if (!startRes.ok) throw new Error(`Failed to start multipart: ${startRes.status}`);
    const { key, uploadId, videoUrl } = await startRes.json();

    const totalParts = Math.ceil(size / CHUNK_SIZE);
    const completedParts: { ETag: string; PartNumber: number }[] = [];

    // 2. Upload each part with retry
    for (let i = 0; i < totalParts; i++) {
      const partNumber = i + 1;
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, size);
      const chunk = videoBlob.slice(start, end);

      // Uploading part ${partNumber}/${totalParts}

      // Get presigned URL for this part
      const partRes = await authFetch(`${API_BASE}/recordings/${recordingId}/multipart/part-url`, {
        method: 'POST',
        body: JSON.stringify({ key, uploadId, partNumber }),
      });
      if (!partRes.ok) throw new Error(`Failed to get part URL: ${partRes.status}`);
      const { url: partUrl } = await partRes.json();

      // Upload with retry (3 attempts)
      let etag: string | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const uploadRes = await fetch(partUrl, { method: 'PUT', body: chunk });
          if (!uploadRes.ok) throw new Error(`Part upload ${uploadRes.status}`);
          etag = uploadRes.headers.get('etag');
          break;
        } catch (err) {
          // Part upload retry
          if (attempt === 3) throw err;
          await new Promise((r) => setTimeout(r, 1000 * attempt)); // backoff
        }
      }

      completedParts.push({ ETag: etag || '', PartNumber: partNumber });
    }

    // 3. Complete multipart upload
    const completeRes = await authFetch(`${API_BASE}/recordings/${recordingId}/multipart/complete`, {
      method: 'POST',
      body: JSON.stringify({ key, uploadId, videoUrl, parts: completedParts, fileSizeBytes: size }),
    });
    if (!completeRes.ok) throw new Error(`Complete multipart failed: ${completeRes.status}`);

    // Multipart upload done
  },

  async sendEvents(
    recordingId: string,
    events: { type: string; relativeTime: number; data: Record<string, any> }[],
  ): Promise<void> {
    if (events.length === 0) return;
    await authFetch(`${API_BASE}/recordings/events/bulk`, {
      method: 'POST',
      body: JSON.stringify({ recordingId, events }),
    });
  },

  async getRecordings(): Promise<any[]> {
    const res = await authFetch(`${API_BASE}/recordings`);
    return res.json();
  },

  async getRecording(id: string): Promise<any> {
    const res = await authFetch(`${API_BASE}/recordings/${id}`);
    return res.json();
  },

  async getEvents(id: string, type?: string): Promise<any[]> {
    const url = type
      ? `${API_BASE}/recordings/${id}/events?type=${type}`
      : `${API_BASE}/recordings/${id}/events`;
    const res = await authFetch(url);
    return res.json();
  },

  async deleteRecording(id: string): Promise<void> {
    await authFetch(`${API_BASE}/recordings/${id}`, { method: 'DELETE' });
  },

  // Integrations
  async getConnectedIntegrations(): Promise<{ clickup: boolean; trello: boolean }> {
    try {
      const res = await authFetch(`${API_BASE}/integrations/status`);
      if (!res.ok) return { clickup: false, trello: false };
      return res.json();
    } catch {
      return { clickup: false, trello: false };
    }
  },

  async getClickUpLists(): Promise<{ id: string; name: string; space: string }[]> {
    try {
      const res = await authFetch(`${API_BASE}/integrations/clickup/workspaces`);
      if (!res.ok) return [];
      const data = await res.json();
      const lists: { id: string; name: string; space: string }[] = [];
      for (const ws of data.workspaces || []) {
        for (const space of ws.spaces || []) {
          for (const list of space.lists || []) {
            lists.push({ id: list.id, name: list.name, space: space.name });
          }
          for (const folder of space.folders || []) {
            for (const list of folder.lists || []) {
              lists.push({ id: list.id, name: `${folder.name} / ${list.name}`, space: space.name });
            }
          }
        }
      }
      return lists;
    } catch {
      return [];
    }
  },

  async getTrelloLists(): Promise<{ id: string; name: string; board: string }[]> {
    try {
      const res = await authFetch(`${API_BASE}/integrations/trello/boards`);
      if (!res.ok) return [];
      const data = await res.json();
      const lists: { id: string; name: string; board: string }[] = [];
      for (const board of data.boards || []) {
        for (const list of board.lists || []) {
          lists.push({ id: list.id, name: list.name, board: board.name });
        }
      }
      return lists;
    } catch {
      return [];
    }
  },

  async createClickUpTask(data: {
    listId: string;
    name: string;
    description: string;
    recordingId?: string;
    priority?: number;
  }): Promise<{ task: { id: string; name: string; url: string } }> {
    const res = await authFetch(`${API_BASE}/integrations/clickup/create-task`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to create ClickUp task');
    return res.json();
  },

  async createTrelloCard(data: {
    listId: string;
    name: string;
    description: string;
    recordingId?: string;
  }): Promise<{ card: { id: string; name: string; shortUrl: string; url: string } }> {
    const res = await authFetch(`${API_BASE}/integrations/trello/create-card`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to create Trello card');
    return res.json();
  },
};
