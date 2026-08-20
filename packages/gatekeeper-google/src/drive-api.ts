// Read-only wrapper around the Google Drive v3 API.
//
// Scope containment: every list/search query carries `sharedWithMe = false`, and `corpora`
// defaults to the user's own corpus, so items under "Shared with me" and items in shared drives
// are never returned. Lookups by ID go through `#toRecord`, which rejects the same two cases —
// otherwise a Drive URL for a shared-drive file would slip past the query-level filter.
//
// Drive has no "everything under this folder" query: `'<id>' in parents` matches direct children
// only. A recursive search therefore walks the subtree to collect folder IDs (bounded by
// MAX_RECURSIVE_FOLDERS / MAX_RECURSIVE_DEPTH) and queries them in batched `in parents` groups.

import type {
  DriveItemInfo, DriveListOptions, DriveNativeType, DriveSearchFilter, DriveSharingEntry,
} from "./drive-types";
import { AccessTokenProvider, fetchWithAuthRetry } from "./auth-retry";

const API_BASE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3/files";

export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
export const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";

/** Google editor MIME types, mapped to the friendly `nativeType` the session API exposes. */
const NATIVE_TYPES: Record<string, DriveNativeType> = {
  "application/vnd.google-apps.document": "document",
  "application/vnd.google-apps.spreadsheet": "spreadsheet",
  "application/vnd.google-apps.presentation": "presentation",
  "application/vnd.google-apps.form": "form",
  "application/vnd.google-apps.drawing": "drawing",
};

/** Non-editor MIME types we are willing to decode as text. */
const TEXT_MIME_TYPES = new Set([
  "application/json", "application/xml", "application/yaml", "application/x-yaml",
  "application/csv", "application/javascript", "application/x-ndjson", "application/sql",
  "application/toml", "image/svg+xml",
]);

const FILE_FIELDS =
  "id,name,mimeType,size,createdTime,modifiedTime,lastModifyingUser(displayName),ownedByMe," +
  // `sharedWithMe` is a query term only; the File resource spells the same fact as a timestamp.
  "trashed,starred,webViewLink,parents,sharedWithMeTime,driveId,shortcutDetails(targetId)";

/** Text beyond this is truncated rather than refused, so a huge file still yields something. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** Binary reads above this are refused outright — the caller gets nothing usable from a prefix. */
export const MAX_BINARY_BYTES = 25 * 1024 * 1024;

export const MAX_RECURSIVE_FOLDERS = 500;
export const MAX_RECURSIVE_DEPTH = 10;

const MAX_JSON_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
// Uploads carry up to MAX_BINARY_BYTES of body, so they get a longer budget than a metadata call.
const UPLOAD_TIMEOUT_MS = 120_000;
const PAGE_SIZE = 50;
const MAX_PERMISSIONS = 200;
const MAX_QUERY_TEXT_LENGTH = 500;
// Parent IDs per `in parents` group. Drive caps query length, so a wide subtree is split across
// several queries rather than one enormous one.
const PARENT_GROUP_SIZE = 25;
// Guard against a parent chain that loops or is pathologically deep.
const MAX_ANCESTOR_HOPS = 50;

type GoogleErrorResponse = { error?: { message?: string } };

type RestDriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  lastModifyingUser?: { displayName?: string };
  ownedByMe?: boolean;
  trashed?: boolean;
  starred?: boolean;
  webViewLink?: string;
  parents?: string[];
  sharedWithMeTime?: string;
  driveId?: string;
  shortcutDetails?: { targetId?: string };
};

type RestFileList = {
  files?: RestDriveFile[];
  nextPageToken?: string;
};

type RestPermissionList = {
  permissions?: {
    type?: string;
    emailAddress?: string;
    domain?: string;
    role?: string;
  }[];
};

/**
 * A Drive item as the gatekeeper tracks it: the agent-facing `info`, plus the internal fields the
 * session layer needs for scope containment and which never leave the gatekeeper.
 */
export type DriveFileRecord = {
  info: DriveItemInfo;
  parents: string[];
};

export type DrivePage = {
  files: DriveFileRecord[];
  nextPageToken?: string;
};

/** How a file's text can be obtained, or undefined when it has no text form. */
export type DriveTextSource =
  | { via: "export"; exportMimeType: string; format: "markdown" | "csv" }
  | { via: "download"; format: "plain" };

/** Escape a string for interpolation into a single-quoted Drive query literal. */
function escapeQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function checkQueryText(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Drive search ${field} must be a non-empty string.`);
  }
  if (value.length > MAX_QUERY_TEXT_LENGTH) {
    throw new Error(
      `Drive search ${field} must be at most ${MAX_QUERY_TEXT_LENGTH} characters.`);
  }
  return value;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function nativeMimeType(nativeType: DriveNativeType): string {
  for (let [mimeType, mapped] of Object.entries(NATIVE_TYPES)) {
    if (mapped === nativeType) return mimeType;
  }
  throw new Error(`Unknown Drive native type: ${nativeType}`);
}

function timestamp(value: string | undefined, field: string): Date {
  let parsed = value === undefined ? NaN : Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Google Drive returned no valid ${field}.`);
  return new Date(parsed);
}

function orderByParam(
  orderBy: "modified" | "created" | "name" | undefined,
  descending: boolean | undefined,
): string {
  let field = orderBy ?? "modified";
  let column = field === "name" ? "name" : field === "created" ? "createdTime" : "modifiedTime";
  // Recency reads best newest-first; names read best A-Z.
  let desc = descending ?? field !== "name";
  // Folders first keeps a listing browsable regardless of the chosen sort.
  return `folder,${column}${desc ? " desc" : ""}`;
}

/** Query clauses shared by every read: My Drive only, and trash excluded unless asked for. */
function baseClauses(includeTrashed: boolean | undefined): string[] {
  let clauses = ["sharedWithMe = false"];
  if (!includeTrashed) clauses.push("trashed = false");
  return clauses;
}

function filterClauses(filter: DriveSearchFilter): string[] {
  let clauses = baseClauses(filter.includeTrashed);

  if (filter.nameContains !== undefined) {
    clauses.push(
      `name contains '${escapeQueryLiteral(checkQueryText(filter.nameContains, "nameContains"))}'`);
  }
  if (filter.fullText !== undefined) {
    clauses.push(
      `fullText contains '${escapeQueryLiteral(checkQueryText(filter.fullText, "fullText"))}'`);
  }

  let mimeTypes = [
    ...asArray(filter.mimeType).map(value => checkQueryText(value, "mimeType")),
    ...asArray(filter.nativeType).map(nativeMimeType),
  ];
  if (mimeTypes.length > 0) {
    clauses.push(
      "(" + mimeTypes.map(t => `mimeType = '${escapeQueryLiteral(t)}'`).join(" or ") + ")");
  }

  if (filter.modifiedAfter !== undefined) {
    clauses.push(`modifiedTime > '${new Date(filter.modifiedAfter).toISOString()}'`);
  }
  if (filter.modifiedBefore !== undefined) {
    clauses.push(`modifiedTime < '${new Date(filter.modifiedBefore).toISOString()}'`);
  }
  if (filter.starredOnly) clauses.push("starred = true");

  return clauses;
}

function parentsClause(parentIds: string[]): string {
  return "(" + parentIds.map(id => `'${escapeQueryLiteral(id)}' in parents`).join(" or ") + ")";
}

/** Split parent IDs into groups small enough to query in one `q`. */
export function parentGroups(parentIds: string[]): string[][] {
  let groups: string[][] = [];
  for (let i = 0; i < parentIds.length; i += PARENT_GROUP_SIZE) {
    groups.push(parentIds.slice(i, i + PARENT_GROUP_SIZE));
  }
  return groups;
}

/**
 * How to read an item as text, or undefined if it has no text form. Google editor files are
 * converted by Drive's export endpoint; everything else is decoded only when its MIME type is
 * plausibly textual.
 */
export function textSourceFor(
  item: { mimeType: string; nativeType?: DriveNativeType },
): DriveTextSource | undefined {
  let { nativeType, mimeType } = item;
  if (nativeType === "document") {
    return { via: "export", exportMimeType: "text/markdown", format: "markdown" };
  }
  if (nativeType === "spreadsheet") {
    return { via: "export", exportMimeType: "text/csv", format: "csv" };
  }
  if (nativeType !== undefined) return undefined;  // Slides, Forms, Drawings: no useful text form.
  if (mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType)) {
    return { via: "download", format: "plain" };
  }
  return undefined;
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  onExcess: "error" | "truncate",
  label: string,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (onExcess === "error") {
    let contentLength = response.headers.get("Content-Length");
    if (contentLength !== null) {
      let declared = Number(contentLength);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`${label} exceeded the ${maxBytes}-byte limit.`);
      }
    }
  }

  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };

  let reader = response.body.getReader();
  let chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;
  try {
    while (true) {
      let { done, value } = await reader.read();
      if (done) break;
      if (totalBytes + value.byteLength > maxBytes) {
        if (onExcess === "error") {
          await reader.cancel().catch(() => {});
          throw new Error(`${label} exceeded the ${maxBytes}-byte limit.`);
        }
        chunks.push(value.subarray(0, maxBytes - totalBytes));
        totalBytes = maxBytes;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  let bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (let chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

export class GoogleDriveApi {
  constructor(private getAccessToken: AccessTokenProvider) {}

  async #fetch(url: URL): Promise<Response> {
    return fetchWithAuthRetry(
      url.toString(), {}, this.getAccessToken, { timeoutMs: REQUEST_TIMEOUT_MS });
  }

  async #requestJson<T>(url: URL): Promise<T> {
    let response = await this.#fetch(url);

    let text: string;
    try {
      let { bytes } = await readBoundedBytes(
        response,
        response.ok ? MAX_JSON_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES,
        "error",
        "Google Drive response",
      );
      text = new TextDecoder().decode(bytes);
    } catch (error) {
      if (!response.ok) {
        throw new Error(`Google Drive request failed [http=${response.status}]`, { cause: error });
      }
      throw error;
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      if (!response.ok) throw new Error(`Google Drive request failed [http=${response.status}]`);
      throw new Error("Google Drive returned an invalid JSON response.");
    }

    if (!response.ok) {
      let detail = (body as GoogleErrorResponse)?.error?.message;
      throw new Error(
        `Google Drive request failed [http=${response.status}]${detail ? `: ${detail}` : ""}`);
    }
    return body as T;
  }

  // Normalize a REST file, rejecting anything outside the account's own My Drive. Both checks
  // matter for by-ID lookups, where no query filter applied.
  #toRecord(rest: RestDriveFile): DriveFileRecord {
    if (!rest.id || rest.mimeType === undefined) {
      throw new Error("Google Drive returned a file without an ID or MIME type.");
    }
    if (rest.driveId !== undefined) {
      throw new Error(
        `Drive item ${rest.id} lives in a shared drive, which this connection cannot access.`);
    }
    if (rest.sharedWithMeTime !== undefined) {
      throw new Error(
        `Drive item ${rest.id} is shared with this account rather than owned by it, so this ` +
        "connection cannot access it.");
    }

    let mimeType = rest.mimeType;
    let nativeType = NATIVE_TYPES[mimeType];
    let kind = mimeType === FOLDER_MIME_TYPE ? "folder" as const
      : mimeType === SHORTCUT_MIME_TYPE ? "shortcut" as const
      : "file" as const;
    let sizeBytes = rest.size === undefined ? undefined : Number(rest.size);

    let info: DriveItemInfo = {
      id: rest.id,
      name: rest.name ?? "Untitled",
      kind,
      mimeType,
      ...(nativeType ? { nativeType } : {}),
      ...(sizeBytes !== undefined && Number.isSafeInteger(sizeBytes) ? { sizeBytes } : {}),
      created: timestamp(rest.createdTime, "createdTime"),
      modified: timestamp(rest.modifiedTime, "modifiedTime"),
      ...(rest.lastModifyingUser?.displayName
        ? { lastModifiedBy: rest.lastModifyingUser.displayName }
        : {}),
      ownedByMe: rest.ownedByMe ?? false,
      trashed: rest.trashed ?? false,
      starred: rest.starred ?? false,
      webUrl: rest.webViewLink ?? `https://drive.google.com/open?id=${rest.id}`,
      ...(rest.shortcutDetails?.targetId
        ? { shortcutTargetId: rest.shortcutDetails.targetId }
        : {}),
    };
    return { info, parents: rest.parents ?? [] };
  }

  async getFile(fileId: string): Promise<DriveFileRecord> {
    let url = new URL(`${API_BASE}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("fields", FILE_FIELDS);
    return this.#toRecord(await this.#requestJson<RestDriveFile>(url));
  }

  /** The account's My Drive root folder. */
  async getRootFolder(): Promise<DriveFileRecord> {
    return this.getFile("root");
  }

  async #listPage(q: string, orderBy: string, pageToken: string | undefined): Promise<DrivePage> {
    let url = new URL(API_BASE);
    url.searchParams.set("q", q);
    url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
    url.searchParams.set("orderBy", orderBy);
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    url.searchParams.set("spaces", "drive");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let body = await this.#requestJson<RestFileList>(url);
    return {
      files: (body.files ?? []).map(file => this.#toRecord(file)),
      ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    };
  }

  /** One page of a folder's direct children. */
  async listChildren(
    folderId: string,
    options: DriveListOptions | undefined,
    pageToken: string | undefined,
  ): Promise<DrivePage> {
    let clauses = [...baseClauses(options?.includeTrashed), parentsClause([folderId])];
    return this.#listPage(
      clauses.join(" and "),
      orderByParam(options?.orderBy, options?.descending),
      pageToken,
    );
  }

  /**
   * One page of a search. `parentIds` restricts results to direct children of those folders; omit
   * it to search the whole Drive.
   */
  async search(
    filter: DriveSearchFilter | undefined,
    parentIds: string[] | undefined,
    pageToken: string | undefined,
  ): Promise<DrivePage> {
    let clauses = filterClauses(filter ?? {});
    if (parentIds && parentIds.length > 0) clauses.push(parentsClause(parentIds));
    return this.#listPage(
      clauses.join(" and "),
      orderByParam(filter?.orderBy, filter?.descending),
      pageToken,
    );
  }

  /** Every folder directly inside `folderId`. */
  async listChildFolders(folderId: string): Promise<DriveFileRecord[]> {
    let clauses = [
      ...baseClauses(false),
      parentsClause([folderId]),
      `mimeType = '${FOLDER_MIME_TYPE}'`,
    ];
    let q = clauses.join(" and ");
    let folders: DriveFileRecord[] = [];
    let pageToken: string | undefined;
    do {
      let page = await this.#listPage(q, "name", pageToken);
      folders.push(...page.files);
      pageToken = page.nextPageToken;
      if (folders.length > MAX_RECURSIVE_FOLDERS) break;
    } while (pageToken);
    return folders;
  }

  /** Folders directly inside `folderId` whose name matches exactly. */
  async findChildFoldersByName(folderId: string, name: string): Promise<DriveFileRecord[]> {
    let clauses = [
      ...baseClauses(false),
      parentsClause([folderId]),
      `mimeType = '${FOLDER_MIME_TYPE}'`,
      `name = '${escapeQueryLiteral(checkQueryText(name, "folder name"))}'`,
    ];
    let page = await this.#listPage(clauses.join(" and "), "name", undefined);
    return page.files;
  }

  /**
   * Breadth-first collection of every folder ID in the subtree rooted at `rootId`, including
   * `rootId` itself. Throws once the subtree exceeds the folder or depth bound, so a recursive
   * search over an enormous tree fails fast instead of issuing thousands of requests.
   */
  async collectSubtreeFolderIds(rootId: string): Promise<string[]> {
    let collected = [rootId];
    let frontier = [rootId];
    for (let depth = 0; frontier.length > 0; depth++) {
      if (depth >= MAX_RECURSIVE_DEPTH) {
        throw new Error(
          `This folder is nested more than ${MAX_RECURSIVE_DEPTH} levels deep; search a deeper ` +
          "folder instead of using a recursive search here.");
      }
      let next: string[] = [];
      for (let folderId of frontier) {
        for (let child of await this.listChildFolders(folderId)) {
          collected.push(child.info.id);
          next.push(child.info.id);
          if (collected.length > MAX_RECURSIVE_FOLDERS) {
            throw new Error(
              `This folder contains more than ${MAX_RECURSIVE_FOLDERS} subfolders; narrow the ` +
              "search or start from a deeper folder.");
          }
        }
      }
      frontier = next;
    }
    return collected;
  }

  /**
   * Whether `fileId` is `ancestorId` or sits beneath it, walking the parent chain upward. Used to
   * keep a folder binding's capabilities inside its own subtree.
   */
  async isWithinFolder(fileId: string, ancestorId: string): Promise<boolean> {
    let current = fileId;
    for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
      if (current === ancestorId) return true;
      let record = await this.getFile(current);
      let parent = record.parents[0];
      if (parent === undefined) return false;
      current = parent;
    }
    return false;
  }

  async listPermissions(fileId: string): Promise<DriveSharingEntry[]> {
    let url = new URL(`${API_BASE}/${encodeURIComponent(fileId)}/permissions`);
    url.searchParams.set("fields", "permissions(type,emailAddress,domain,role)");
    url.searchParams.set("pageSize", String(Math.min(MAX_PERMISSIONS, 100)));

    let body = await this.#requestJson<RestPermissionList>(url);
    return (body.permissions ?? []).flatMap(permission => {
      let granteeType = permission.type;
      if (granteeType !== "user" && granteeType !== "group" && granteeType !== "domain" &&
          granteeType !== "anyone") {
        return [];
      }
      // `fileOrganizer` is a shared-drive-only role; fold it into the closest exposed role.
      let role = permission.role === "fileOrganizer" ? "organizer" : permission.role;
      if (role !== "owner" && role !== "organizer" && role !== "writer" && role !== "commenter" &&
          role !== "reader") {
        return [];
      }
      let grantee = permission.emailAddress ?? permission.domain;
      return [{ granteeType, role, ...(grantee ? { grantee } : {}) }];
    });
  }

  /** Export a Google editor file to text, truncating past MAX_TEXT_BYTES. */
  async exportText(
    fileId: string,
    exportMimeType: string,
  ): Promise<{ text: string; truncated: boolean }> {
    let url = new URL(`${API_BASE}/${encodeURIComponent(fileId)}/export`);
    url.searchParams.set("mimeType", exportMimeType);
    return this.#readText(url, `Google Drive export of ${fileId}`);
  }

  /** Download an uploaded file's bytes and decode them as UTF-8, truncating past MAX_TEXT_BYTES. */
  async downloadText(fileId: string): Promise<{ text: string; truncated: boolean }> {
    return this.#readText(this.#mediaUrl(fileId), `Google Drive download of ${fileId}`);
  }

  async #readText(url: URL, label: string): Promise<{ text: string; truncated: boolean }> {
    let response = await this.#fetch(url);
    if (!response.ok) {
      let { bytes } = await readBoundedBytes(
        response, MAX_ERROR_RESPONSE_BYTES, "error", label).catch(
          () => ({ bytes: new Uint8Array(0) }));
      let detail = new TextDecoder().decode(bytes).slice(0, 500);
      throw new Error(
        `Google Drive request failed [http=${response.status}]${detail ? `: ${detail}` : ""}`);
    }
    let { bytes, truncated } = await readBoundedBytes(
      response, MAX_TEXT_BYTES, "truncate", label);
    // A truncated read can cut a multi-byte character in half. TextDecoder is non-fatal by
    // default, so the partial character becomes U+FFFD rather than throwing.
    return { text: new TextDecoder().decode(bytes), truncated };
  }

  async downloadBytes(fileId: string): Promise<ArrayBuffer> {
    let label = `Google Drive download of ${fileId}`;
    let response = await this.#fetch(this.#mediaUrl(fileId));
    if (!response.ok) {
      let { bytes } = await readBoundedBytes(
        response, MAX_ERROR_RESPONSE_BYTES, "error", label).catch(
          () => ({ bytes: new Uint8Array(0) }));
      let detail = new TextDecoder().decode(bytes).slice(0, 500);
      throw new Error(
        `Google Drive request failed [http=${response.status}]${detail ? `: ${detail}` : ""}`);
    }
    let { bytes } = await readBoundedBytes(response, MAX_BINARY_BYTES, "error", label);
    // Copy into an exactly-sized buffer: `bytes.buffer` may be larger than the filled region.
    return bytes.slice().buffer;
  }

  #mediaUrl(fileId: string): URL {
    let url = new URL(`${API_BASE}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("alt", "media");
    return url;
  }

  // ── Writes ────────────────────────────────────────────────────────

  async #requestJsonWithBody<T>(url: URL, method: string, body: unknown): Promise<T> {
    let response = await fetchWithAuthRetry(
      url.toString(),
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      this.getAccessToken,
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );

    let { bytes } = await readBoundedBytes(
      response,
      response.ok ? MAX_JSON_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES,
      "error",
      "Google Drive response",
    );
    let text = new TextDecoder().decode(bytes);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (!response.ok) throw new Error(`Google Drive request failed [http=${response.status}]`);
      throw new Error("Google Drive returned an invalid JSON response.");
    }
    if (!response.ok) {
      let detail = (parsed as GoogleErrorResponse)?.error?.message;
      throw new Error(
        `Google Drive request failed [http=${response.status}]${detail ? `: ${detail}` : ""}`);
    }
    return parsed as T;
  }

  /**
   * Upload content with the resumable protocol: an initiation request carrying the metadata, then a
   * single PUT of the whole body to the session URI it returns.
   *
   * Resumable rather than multipart or simple upload because those are limited to 5 MB, well under
   * the size a gadget may legitimately write.
   */
  async #uploadContent(
    method: "POST" | "PATCH",
    fileId: string | undefined,
    metadata: Record<string, unknown>,
    mimeType: string,
    content: Uint8Array,
  ): Promise<DriveFileRecord> {
    let initiateUrl = new URL(
      fileId === undefined
        ? `${UPLOAD_BASE}`
        : `${UPLOAD_BASE}/${encodeURIComponent(fileId)}`);
    initiateUrl.searchParams.set("uploadType", "resumable");
    initiateUrl.searchParams.set("fields", FILE_FIELDS);

    let initiation = await fetchWithAuthRetry(
      initiateUrl.toString(),
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Upload-Content-Type": mimeType,
          "X-Upload-Content-Length": String(content.byteLength),
        },
        body: JSON.stringify(metadata),
      },
      this.getAccessToken,
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );

    if (!initiation.ok) {
      let { bytes } = await readBoundedBytes(
        initiation, MAX_ERROR_RESPONSE_BYTES, "error", "Google Drive response");
      let detail = new TextDecoder().decode(bytes).slice(0, 500);
      throw new Error(
        `Google Drive upload could not be started [http=${initiation.status}]` +
        `${detail ? `: ${detail}` : ""}`);
    }

    let sessionUri = initiation.headers.get("Location");
    await initiation.body?.cancel().catch(() => {});
    if (!sessionUri) {
      throw new Error("Google Drive did not return an upload session URI.");
    }

    // The session URI carries its own credentials, so this PUT is not authenticated with the
    // bearer token and does not go through fetchWithAuthRetry. A non-replayable body could not be
    // retried anyway.
    let upload = await fetch(sessionUri, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(content.byteLength),
      },
      body: content,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    let { bytes } = await readBoundedBytes(
      upload,
      upload.ok ? MAX_JSON_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES,
      "error",
      "Google Drive response",
    );
    let text = new TextDecoder().decode(bytes);
    if (!upload.ok) {
      throw new Error(
        `Google Drive upload failed [http=${upload.status}]` +
        `${text ? `: ${text.slice(0, 500)}` : ""}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Google Drive returned an invalid JSON response for an upload.");
    }
    return this.#toRecord(parsed as RestDriveFile);
  }

  async createFolder(parentId: string, name: string): Promise<DriveFileRecord> {
    let url = new URL(API_BASE);
    url.searchParams.set("fields", FILE_FIELDS);
    return this.#toRecord(await this.#requestJsonWithBody<RestDriveFile>(url, "POST", {
      name,
      mimeType: FOLDER_MIME_TYPE,
      parents: [parentId],
    }));
  }

  async uploadFile(
    parentId: string,
    name: string,
    mimeType: string,
    content: Uint8Array,
  ): Promise<DriveFileRecord> {
    return this.#uploadContent(
      "POST", undefined, { name, parents: [parentId] }, mimeType, content);
  }

  async updateContent(
    fileId: string,
    mimeType: string,
    content: Uint8Array,
  ): Promise<DriveFileRecord> {
    return this.#uploadContent("PATCH", fileId, { mimeType }, mimeType, content);
  }

  async updateMetadata(
    fileId: string,
    changes: {
      name?: string;
      addParents?: string;
      removeParents?: string;
      trashed?: boolean;
    },
  ): Promise<DriveFileRecord> {
    let url = new URL(`${API_BASE}/${encodeURIComponent(fileId)}`);
    url.searchParams.set("fields", FILE_FIELDS);
    if (changes.addParents) url.searchParams.set("addParents", changes.addParents);
    if (changes.removeParents) url.searchParams.set("removeParents", changes.removeParents);

    let body: Record<string, unknown> = {};
    if (changes.name !== undefined) body.name = changes.name;
    if (changes.trashed !== undefined) body.trashed = changes.trashed;

    return this.#toRecord(
      await this.#requestJsonWithBody<RestDriveFile>(url, "PATCH", body));
  }

  /**
   * Copy a file, optionally converting it on the way.
   *
   * Passing `targetMimeType` is how Drive performs a format conversion: copying a PDF or image to
   * `application/vnd.google-apps.document` runs Google's OCR and produces a Doc whose body is the
   * recognized text. `ocrLanguage` is an ISO 639-1 hint for that pass.
   */
  async copyFile(
    sourceId: string,
    parentId: string,
    name: string,
    options?: { targetMimeType?: string; ocrLanguage?: string },
  ): Promise<DriveFileRecord> {
    let url = new URL(`${API_BASE}/${encodeURIComponent(sourceId)}/copy`);
    url.searchParams.set("fields", FILE_FIELDS);
    if (options?.ocrLanguage) url.searchParams.set("ocrLanguage", options.ocrLanguage);
    return this.#toRecord(await this.#requestJsonWithBody<RestDriveFile>(url, "POST", {
      name,
      parents: [parentId],
      ...(options?.targetMimeType ? { mimeType: options.targetMimeType } : {}),
    }));
  }
}

/** MIME type of a Google Doc, the conversion target for OCR. */
export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";

/**
 * Whether Drive can convert this type to a Doc with OCR. Google accepts PDFs and the common raster
 * image formats; anything else either has no text to recognize or is already text we can read
 * directly with `textSourceFor()`.
 */
export function isOcrConvertible(mimeType: string): boolean {
  return mimeType === "application/pdf" ||
      mimeType === "image/jpeg" || mimeType === "image/png" ||
      mimeType === "image/gif" || mimeType === "image/bmp" ||
      mimeType === "image/tiff" || mimeType === "image/webp";
}
