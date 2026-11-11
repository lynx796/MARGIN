// Where the open document's annotation file lives outside the browser (spec §2, §9.3): a file in the
// `margin serve` directory, or (Chromium) a file the user picked, reached through its file handle.
// Both are read and written the same way, so live sync and merging work identically.

import { sha256Hex } from '@margin/core';
import type { BridgeClient, PutResult } from './bridge.ts';

export interface AnnotLink {
  kind: 'bridge' | 'file';
  /** Shown to the user: the bridge path or the file name. */
  name: string;
  /** The file's text and its ETag (SHA-256 of the text); null if there is no file (yet). */
  read(): Promise<{ text: string; etag: string } | null>;
  /** Write unless the file is no longer at `ifMatch` (null: write unconditionally). */
  write(text: string, ifMatch: string | null): Promise<PutResult>;
}

export function bridgeLink(client: BridgeClient, path: string): AnnotLink {
  return { kind: 'bridge', name: path, read: () => client.annot(path), write: (text, ifMatch) => client.putAnnot(path, text, ifMatch) };
}

const encoder = new TextEncoder();

/** The File System Access permission calls, not yet in TypeScript's DOM library. */
type PermissionedHandle = FileSystemFileHandle & {
  queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
};

export interface FileLink extends AnnotLink {
  handle: FileSystemFileHandle;
  /** Call `onChange` whenever another program changes the file (polled once a second). */
  watch(onChange: () => void, onLost: (e: Error) => void): () => void;
}

export function fileLink(handle: FileSystemFileHandle): FileLink {
  const read = async () => {
    const text = await (await handle.getFile()).text();
    // A file just created by the save picker is empty: treat it like a missing annotation file.
    if (!text.trim()) return null;
    return { text, etag: await sha256Hex(encoder.encode(text)) };
  };
  return {
    kind: 'file',
    name: handle.name,
    handle,
    read,
    // There is no compare-and-swap on local files; checking right before writing narrows the window
    // in which another program's change could be overwritten to a few milliseconds.
    async write(text, ifMatch) {
      if (ifMatch !== null) {
        const current = await read();
        if ((current?.etag ?? null) !== ifMatch) return { ok: false, conflict: true, etag: current?.etag ?? null };
      }
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return { ok: true, etag: await sha256Hex(encoder.encode(text)) };
    },
    watch(onChange, onLost) {
      let last: string | null = null;
      let stopped = false;
      const tick = async () => {
        try {
          const f = await handle.getFile();
          const stamp = `${f.lastModified}:${f.size}`;
          if (last !== null && stamp !== last) onChange();
          last = stamp;
        } catch (e) {
          stopped = true;
          clearInterval(timer);
          onLost(e as Error);
        }
      };
      const timer = setInterval(() => void (stopped || tick()), 1000);
      void tick();
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}

/** Whether the page may still read and write the file (permissions of stored handles lapse between sessions). */
export async function hasPermission(handle: FileSystemFileHandle, request = false): Promise<boolean> {
  const h = handle as PermissionedHandle;
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return request && !!h.requestPermission && (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

type OpenPicker = (o: { multiple: boolean; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle[]>;

/** Chromium's open picker, which returns handles the app can write back to. Not used in end-to-end tests. */
export function canPickHandles(): boolean {
  return 'showOpenFilePicker' in window && !new URLSearchParams(location.search).has('e2e');
}

/** Ask for files; null if the user cancelled. */
export async function pickHandles(): Promise<FileSystemFileHandle[] | null> {
  try {
    return await (window as unknown as { showOpenFilePicker: OpenPicker }).showOpenFilePicker({
      multiple: true,
      types: [{ description: 'PDF or Margin annotations', accept: { 'application/pdf': ['.pdf'], 'application/json': ['.json'] } }],
    });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return null;
    throw e;
  }
}
