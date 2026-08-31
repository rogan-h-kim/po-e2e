import type { Scenario } from '../shared/types';

export const NO_FOLDER = '';
export const NO_FOLDER_LABEL = '미분류';

export interface FolderGroup<T> {
  /** Folder name, or NO_FOLDER for scenarios without one. */
  folder: string;
  label: string;
  items: T[];
}

/**
 * Group scenarios by folder in the suite's folder order. Every declared folder
 * appears (even empty); scenarios whose folder isn't declared fall into 미분류,
 * which is listed last and only when non-empty.
 */
export function groupByFolder<T extends Pick<Scenario, 'folder'>>(folders: string[], items: T[]): FolderGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const f of folders) map.set(f, []);
  for (const it of items) {
    const key = it.folder && folders.includes(it.folder) ? it.folder : NO_FOLDER;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(it);
  }
  const out: FolderGroup<T>[] = [...map.entries()]
    .filter(([k]) => k !== NO_FOLDER)
    .map(([folder, list]) => ({ folder, label: folder, items: list }));
  const loose = map.get(NO_FOLDER);
  if (loose?.length) out.push({ folder: NO_FOLDER, label: NO_FOLDER_LABEL, items: loose });
  return out;
}
