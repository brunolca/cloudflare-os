// Pending-action state and read-time simulation for the Google Drive gatekeeper.
//
// Every mutating Drive call is submitted to the approval queue and performed only once approved.
// Between submit and apply, reads must look as though the change already happened, so the calling
// agent never has to think about approvals. This module owns that overlay.
//
// Why an overlay rather than a mutated cache: Drive reads are cheap and the gatekeeper keeps no
// remote-content cache, so there is nothing to mutate. Pending state is stored separately and
// merged into each read.
//
// Synthetic IDs. A created folder or file has no Drive ID until its action is applied, but the
// caller gets a capability for it immediately (so "make Receipts/2026, then file this into it" works
// in one pass). Creations are addressed by a synthetic `pending:<actionId>` ID, which
// `DriveIdMap` rewrites to the real ID once the creation commits. An action that still references an
// unresolved synthetic ID cannot be applied yet — see `blockingDependency()`.

import { FOLDER_MIME_TYPE } from "./drive-api";
import type { DriveItemInfo, DriveNativeType, DriveSearchFilter } from "./drive-types";

export const SYNTHETIC_ID_PREFIX = "pending:";

export function syntheticId(actionId: number): string {
  return `${SYNTHETIC_ID_PREFIX}${actionId}`;
}

export function isSyntheticId(id: string): boolean {
  return id.startsWith(SYNTHETIC_ID_PREFIX);
}

// ── Actions ─────────────────────────────────────────────────────────

type ActionBase = {
  submittedAt: number;
  /**
   * Set when the action can no longer be performed — e.g. the pending creation it depended on was
   * rejected. Mirrors the Google Docs gatekeeper: an invalidated action is dropped on apply rather
   * than failing the approval.
   */
  invalidatedReason?: string;
};

export type DriveCreateFolderAction = ActionBase & {
  type: "createFolder";
  syntheticId: string;
  parentId: string;
  name: string;
};

export type DriveUploadFileAction = ActionBase & {
  type: "uploadFile";
  syntheticId: string;
  parentId: string;
  name: string;
  mimeType: string;
  contentKey: string;
  sizeBytes: number;
};

export type DriveCopyAction = ActionBase & {
  type: "copy";
  syntheticId: string;
  sourceId: string;
  parentId: string;
  name: string;
  /** MIME type the copy will have — the conversion target when `targetMimeType` is set. */
  mimeType: string;
  sizeBytes?: number;
  /** Set when the copy is a format conversion, e.g. a PDF to a Doc via OCR. */
  targetMimeType?: string;
  /** ISO 639-1 hint for the OCR pass. */
  ocrLanguage?: string;
};

export type DriveWriteAction = ActionBase & {
  type: "write";
  fileId: string;
  mimeType: string;
  contentKey: string;
  sizeBytes: number;
};

export type DriveRenameAction = ActionBase & {
  type: "rename";
  fileId: string;
  name: string;
  /** Name before the rename, for revertAction(). Absent when the target was itself pending. */
  previousName?: string;
};

export type DriveMoveAction = ActionBase & {
  type: "move";
  fileId: string;
  parentId: string;
  /** Parent before the move, for revertAction(). */
  previousParentId?: string;
};

export type DriveTrashAction = ActionBase & { type: "trash"; fileId: string };
export type DriveRestoreAction = ActionBase & { type: "restore"; fileId: string };

export type DriveAction =
  | DriveCreateFolderAction
  | DriveUploadFileAction
  | DriveCopyAction
  | DriveWriteAction
  | DriveRenameAction
  | DriveMoveAction
  | DriveTrashAction
  | DriveRestoreAction;

export type PendingDriveAction = { id: number; action: DriveAction };

/** The synthetic ID an action creates, if it creates anything. */
export function createdSyntheticId(action: DriveAction): string | undefined {
  switch (action.type) {
    case "createFolder":
    case "uploadFile":
    case "copy":
      return action.syntheticId;
    default:
      return undefined;
  }
}

/** Every Drive ID an action needs resolved before it can be performed. */
export function referencedIds(action: DriveAction): string[] {
  switch (action.type) {
    case "createFolder":
      return [action.parentId];
    case "uploadFile":
      return [action.parentId];
    case "copy":
      return [action.sourceId, action.parentId];
    case "write":
      return [action.fileId];
    case "rename":
      return [action.fileId];
    case "move":
      return [action.fileId, action.parentId];
    case "trash":
    case "restore":
      return [action.fileId];
    default:
      action satisfies never;
      throw new Error(`unknown Drive action type: ${(action as { type: string }).type}`);
  }
}

// ── Overlay ─────────────────────────────────────────────────────────

/** An item that exists only as a pending creation. */
export type PendingDriveItem = {
  id: string;
  name: string;
  parentId: string;
  mimeType: string;
  isFolder: boolean;
  sizeBytes?: number;
  /** Content of the most recent pending write, when there is one. */
  contentKey?: string;
  trashed: boolean;
  submittedAt: number;
};

/** Changes pending against an item that already exists in Drive. */
export type PendingDrivePatch = {
  name?: string;
  parentId?: string;
  trashed?: boolean;
  contentKey?: string;
  mimeType?: string;
  sizeBytes?: number;
  modified?: number;
};

export type DriveOverlay = {
  created: Map<string, PendingDriveItem>;
  patches: Map<string, PendingDrivePatch>;
};

/**
 * Fold the pending actions into an overlay. Actions are applied in submission order, so a rename of
 * a pending upload lands on the item that upload created.
 */
export function buildDriveOverlay(pending: PendingDriveAction[]): DriveOverlay {
  let created = new Map<string, PendingDriveItem>();
  let patches = new Map<string, PendingDrivePatch>();

  let patch = (id: string): PendingDrivePatch => {
    let existing = patches.get(id);
    if (existing) return existing;
    let fresh: PendingDrivePatch = {};
    patches.set(id, fresh);
    return fresh;
  };

  // Route a change to the created item when the target is a pending creation, so a pending item
  // carries its own state rather than being split across two structures.
  let mutate = (id: string, change: PendingDrivePatch): void => {
    let item = created.get(id);
    if (item) {
      if (change.name !== undefined) item.name = change.name;
      if (change.parentId !== undefined) item.parentId = change.parentId;
      if (change.trashed !== undefined) item.trashed = change.trashed;
      if (change.contentKey !== undefined) item.contentKey = change.contentKey;
      if (change.mimeType !== undefined) item.mimeType = change.mimeType;
      if (change.sizeBytes !== undefined) item.sizeBytes = change.sizeBytes;
      return;
    }
    Object.assign(patch(id), change);
  };

  for (let { action } of pending) {
    if (action.invalidatedReason) continue;

    switch (action.type) {
      case "createFolder":
        created.set(action.syntheticId, {
          id: action.syntheticId,
          name: action.name,
          parentId: action.parentId,
          mimeType: FOLDER_MIME_TYPE,
          isFolder: true,
          trashed: false,
          submittedAt: action.submittedAt,
        });
        break;

      case "uploadFile":
        created.set(action.syntheticId, {
          id: action.syntheticId,
          name: action.name,
          parentId: action.parentId,
          mimeType: action.mimeType,
          isFolder: false,
          sizeBytes: action.sizeBytes,
          contentKey: action.contentKey,
          trashed: false,
          submittedAt: action.submittedAt,
        });
        break;

      case "copy":
        created.set(action.syntheticId, {
          id: action.syntheticId,
          name: action.name,
          parentId: action.parentId,
          mimeType: action.mimeType,
          isFolder: false,
          ...(action.sizeBytes !== undefined ? { sizeBytes: action.sizeBytes } : {}),
          trashed: false,
          submittedAt: action.submittedAt,
        });
        break;

      case "write":
        mutate(action.fileId, {
          contentKey: action.contentKey,
          mimeType: action.mimeType,
          sizeBytes: action.sizeBytes,
          modified: action.submittedAt,
        });
        break;

      case "rename":
        mutate(action.fileId, { name: action.name, modified: action.submittedAt });
        break;

      case "move":
        mutate(action.fileId, { parentId: action.parentId, modified: action.submittedAt });
        break;

      case "trash":
        mutate(action.fileId, { trashed: true, modified: action.submittedAt });
        break;

      case "restore":
        mutate(action.fileId, { trashed: false, modified: action.submittedAt });
        break;

      default:
        action satisfies never;
    }
  }

  return { created, patches };
}

const NATIVE_TYPES_BY_MIME: Record<string, DriveNativeType> = {
  "application/vnd.google-apps.document": "document",
  "application/vnd.google-apps.spreadsheet": "spreadsheet",
  "application/vnd.google-apps.presentation": "presentation",
  "application/vnd.google-apps.form": "form",
  "application/vnd.google-apps.drawing": "drawing",
};

/** Present a pending creation as ordinary item metadata. */
export function pendingItemInfo(item: PendingDriveItem): DriveItemInfo {
  let nativeType = NATIVE_TYPES_BY_MIME[item.mimeType];
  let timestamp = new Date(item.submittedAt);
  return {
    id: item.id,
    name: item.name,
    kind: item.isFolder ? "folder" : "file",
    mimeType: item.mimeType,
    ...(nativeType ? { nativeType } : {}),
    ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
    created: timestamp,
    modified: timestamp,
    ownedByMe: true,
    trashed: item.trashed,
    starred: false,
    // The item has no Drive URL until it exists in Drive.
    webUrl: "",
  };
}

/** Apply any pending patch to metadata read from Drive. */
export function overlayItemInfo(info: DriveItemInfo, overlay: DriveOverlay): DriveItemInfo {
  let item = overlay.created.get(info.id);
  if (item) return pendingItemInfo(item);

  let patch = overlay.patches.get(info.id);
  if (!patch) return info;

  return {
    ...info,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.trashed !== undefined ? { trashed: patch.trashed } : {}),
    ...(patch.mimeType !== undefined ? { mimeType: patch.mimeType } : {}),
    ...(patch.sizeBytes !== undefined ? { sizeBytes: patch.sizeBytes } : {}),
    ...(patch.modified !== undefined ? { modified: new Date(patch.modified) } : {}),
  };
}

/** The parent a (possibly patched) item currently sits in, as far as the overlay knows. */
function overlayParentId(id: string, remoteParentId: string | undefined, overlay: DriveOverlay)
    : string | undefined {
  let item = overlay.created.get(id);
  if (item) return item.parentId;
  return overlay.patches.get(id)?.parentId ?? remoteParentId;
}

/**
 * Merge pending state into one page of a folder listing: drop items moved out or trashed, apply
 * renames, and append pending creations that now belong here.
 *
 * `alreadyListed` carries the pending items appended on earlier pages so a multi-page listing does
 * not repeat them.
 */
export function overlayFolderChildren(
  folderId: string,
  remote: { info: DriveItemInfo; parents: string[] }[],
  overlay: DriveOverlay,
  options: { includeTrashed?: boolean; alreadyListed: Set<string>; isLastPage: boolean },
): DriveItemInfo[] {
  let result: DriveItemInfo[] = [];

  for (let record of remote) {
    let currentParent = overlayParentId(record.info.id, record.parents[0], overlay);
    if (currentParent !== undefined && currentParent !== folderId) continue;
    let info = overlayItemInfo(record.info, overlay);
    if (info.trashed && !options.includeTrashed) continue;
    result.push(info);
  }

  // Pending creations only have a place to appear once the listing reaches its final page;
  // appending them earlier would push them ahead of remote items that sort before them.
  if (options.isLastPage) {
    for (let item of overlay.created.values()) {
      if (item.parentId !== folderId) continue;
      if (options.alreadyListed.has(item.id)) continue;
      if (item.trashed && !options.includeTrashed) continue;
      options.alreadyListed.add(item.id);
      result.push(pendingItemInfo(item));
    }
  }

  return result;
}

/**
 * Whether a pending item satisfies a search filter, evaluated locally because Drive cannot see it
 * yet. Mirrors the clauses drive-api.ts sends to Drive.
 */
export function matchesDriveFilter(info: DriveItemInfo, filter: DriveSearchFilter | undefined)
    : boolean {
  if (!filter) return true;

  if (filter.nameContains !== undefined &&
      !info.name.toLowerCase().includes(filter.nameContains.toLowerCase())) {
    return false;
  }
  // `fullText` also matches indexed content, which a pending item has none of; the name is the
  // only part we can evaluate.
  if (filter.fullText !== undefined &&
      !info.name.toLowerCase().includes(filter.fullText.toLowerCase())) {
    return false;
  }

  if (filter.mimeType !== undefined) {
    let allowed = Array.isArray(filter.mimeType) ? filter.mimeType : [filter.mimeType];
    if (!allowed.includes(info.mimeType)) return false;
  }
  if (filter.nativeType !== undefined) {
    let allowed = Array.isArray(filter.nativeType) ? filter.nativeType : [filter.nativeType];
    if (info.nativeType === undefined || !allowed.includes(info.nativeType)) return false;
  }

  if (filter.modifiedAfter !== undefined &&
      info.modified.valueOf() <= new Date(filter.modifiedAfter).valueOf()) {
    return false;
  }
  if (filter.modifiedBefore !== undefined &&
      info.modified.valueOf() >= new Date(filter.modifiedBefore).valueOf()) {
    return false;
  }
  if (filter.starredOnly && !info.starred) return false;
  if (info.trashed && !filter.includeTrashed) return false;

  return true;
}

/** Pending creations that fall inside `parentIds` and match `filter`. */
export function pendingSearchMatches(
  overlay: DriveOverlay,
  parentIds: string[] | undefined,
  filter: DriveSearchFilter | undefined,
  alreadyListed: Set<string>,
): DriveItemInfo[] {
  let matches: DriveItemInfo[] = [];
  for (let item of overlay.created.values()) {
    if (alreadyListed.has(item.id)) continue;
    if (parentIds !== undefined && !parentIds.includes(item.parentId)) continue;
    let info = pendingItemInfo(item);
    if (!matchesDriveFilter(info, filter)) continue;
    alreadyListed.add(item.id);
    matches.push(info);
  }
  return matches;
}

// ── Durable state ───────────────────────────────────────────────────

/**
 * Maps the synthetic ID of an applied creation to the Drive ID it produced, so capabilities handed
 * out before approval keep working afterwards.
 */
export class DriveIdMap {
  #kv: DurableObjectStorage["kv"];

  constructor(kv: DurableObjectStorage["kv"]) {
    this.#kv = kv;
  }

  #key(pendingId: string): string {
    return `drive:idmap:${pendingId}`;
  }

  record(pendingId: string, realId: string): void {
    this.#kv.put(this.#key(pendingId), realId);
  }

  /** The real ID for a synthetic one, or undefined while the creation is still pending. */
  lookup(pendingId: string): string | undefined {
    return this.#kv.get<string>(this.#key(pendingId));
  }

  /** Resolve an ID for use against the Drive API, throwing if it is not yet real. */
  resolve(id: string): string {
    if (!isSyntheticId(id)) return id;
    let real = this.lookup(id);
    if (real === undefined) {
      throw new Error(
        "This Drive item has not been created yet, because the change that creates it is still " +
        "awaiting approval.");
    }
    return real;
  }

  /** Resolve an ID if possible, leaving synthetic IDs alone when still pending. */
  tryResolve(id: string): string {
    if (!isSyntheticId(id)) return id;
    return this.lookup(id) ?? id;
  }
}

const CONTENT_CHUNK_BYTES = 512 * 1024;

/**
 * Content staged for a pending upload or write.
 *
 * Durable Object rows are size-limited, so content is split into chunks. It lives in SQL rather than
 * KV because a single upload can be tens of megabytes.
 */
export class DrivePendingContentStore {
  #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS drive_pending_content (" +
      "  key TEXT NOT NULL, seq INTEGER NOT NULL, chunk BLOB NOT NULL, " +
      "  PRIMARY KEY (key, seq)) WITHOUT ROWID");
  }

  put(key: string, bytes: Uint8Array): void {
    this.delete(key);
    let seq = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += CONTENT_CHUNK_BYTES) {
      // Copy each slice: a subarray shares the parent buffer, which the storage layer would
      // serialize in full.
      let chunk = bytes.slice(offset, Math.min(offset + CONTENT_CHUNK_BYTES, bytes.byteLength));
      this.#sql.exec(
        "INSERT INTO drive_pending_content (key, seq, chunk) VALUES (?, ?, ?)", key, seq, chunk);
      seq++;
    }
    // A zero-length body still needs a row, so `get()` can tell "empty" from "missing".
    if (bytes.byteLength === 0) {
      this.#sql.exec(
        "INSERT INTO drive_pending_content (key, seq, chunk) VALUES (?, ?, ?)",
        key, 0, new Uint8Array(0));
    }
  }

  get(key: string): Uint8Array | undefined {
    let chunks = [...this.#sql.exec<{ chunk: ArrayBuffer }>(
      "SELECT chunk FROM drive_pending_content WHERE key = ? ORDER BY seq", key)]
      .map(row => new Uint8Array(row.chunk));
    if (chunks.length === 0) return undefined;

    let total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    let bytes = new Uint8Array(total);
    let offset = 0;
    for (let chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  delete(key: string): void {
    this.#sql.exec("DELETE FROM drive_pending_content WHERE key = ?", key);
  }
}
