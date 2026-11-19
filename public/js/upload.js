// Bill uploads: photos are shrunk in the browser, files are sent raw one by one, then the group is processed.
import { ApiError, processGroup } from './api.js';

export const MAX_FILES = 20;
export const MAX_IMAGES_PER_GROUP = 6;
const LONG_SIDE = 2000;

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name ?? '');

// Pure: every PDF is its own group; images share one group (at most 6 each) unless onePerPhoto. At most 20 files.
export function groupFiles(files, { onePerPhoto = false } = {}) {
  const groups = [];
  let photos = null;
  for (const file of [...files].slice(0, MAX_FILES)) {
    if (isPdf(file) || onePerPhoto) {
      groups.push([file]);
    } else {
      if (!photos || photos.length >= MAX_IMAGES_PER_GROUP) groups.push(photos = []);
      photos.push(file);
    }
  }
  return groups;
}

// A decodable image becomes a JPEG with its long side at most 2000 px; anything else (HEIC on a browser that cannot
// decode it, PDFs) goes as it is.
export async function prepareImage(file) {
  if (typeof createImageBitmap !== 'function') return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob ?? file;
  } finally {
    bitmap.close?.();
  }
}

async function sendFile(groupId, pos, file, source, signal) {
  const body = file.type?.startsWith('image/') ? await prepareImage(file) : file;
  const type = body.type || file.type || 'application/octet-stream';
  const url = `/api/invoices/upload?group=${encodeURIComponent(groupId)}&pos=${pos}&source=${encodeURIComponent(source)}`;
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': type, 'x-filename': encodeURIComponent(file.name ?? '') }, body, signal,
  });
  if (res.status === 401) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.hash)}`);
    return new Promise(() => {});
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`, data);
  }
}

// Returns [{ groupId, files: [{ name, status: 'ok' | 'error', error }], processed, error }]; onFile(groupId, entry) after each file.
// Processing starts only when every file of the group arrived; with the assistant off the files stay stored
// (error 'ai_disabled' on the group, not on the files).
export async function uploadFiles(files, { onePerPhoto = false, source = 'upload', signal, onFile } = {}) {
  const results = [];
  for (const group of groupFiles(files, { onePerPhoto })) {
    const groupId = crypto.randomUUID();
    const result = { groupId, files: [], processed: false, error: null };
    results.push(result);
    for (const [pos, file] of group.entries()) {
      const entry = { name: file.name, status: 'ok', error: null };
      try {
        await sendFile(groupId, pos, file, source, signal);
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        entry.status = 'error';
        entry.error = err?.body?.error ?? err?.message ?? 'upload_failed';
      }
      result.files.push(entry);
      onFile?.(groupId, entry);
    }
    if (result.files.some((f) => f.status === 'error')) continue;
    try {
      await processGroup(groupId, { signal });
      result.processed = true;
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      result.error = err?.body?.error ?? err?.message ?? 'process_failed';
    }
  }
  return results;
}
