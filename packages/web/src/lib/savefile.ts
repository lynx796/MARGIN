// Saving files the user asked for (spec §8.3): a save picker in Chromium, a download elsewhere.

type Picker = (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;

const TYPES: Record<string, { description: string; accept: Record<string, string[]> }> = {
  'application/pdf': { description: 'PDF', accept: { 'application/pdf': ['.pdf'] } },
  'application/json': { description: 'Margin annotations', accept: { 'application/json': ['.json'] } },
};

/** The picker needs a click, so it is shown first and the data is produced afterwards. Not used in end-to-end tests. */
export function canPick(): boolean {
  return 'showSaveFilePicker' in window && !new URLSearchParams(location.search).has('e2e');
}

export type Target = { handle: FileSystemFileHandle } | { name: string };

/** Ask where to save; `null` if the user cancelled. */
export async function chooseTarget(name: string, mime: string): Promise<Target | null> {
  if (!canPick()) return { name };
  try {
    const handle = await (window as unknown as { showSaveFilePicker: Picker }).showSaveFilePicker({ suggestedName: name, types: [TYPES[mime]!] });
    return { handle };
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return null;
    return { name };
  }
}

export async function writeTarget(target: Target, data: Blob): Promise<void> {
  if ('handle' in target) {
    const w = await target.handle.createWritable();
    await w.write(data);
    await w.close();
    return;
  }
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = target.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
