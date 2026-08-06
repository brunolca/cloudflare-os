import { Cursor } from "@gadgets/workshop-shared/gatekeeper";

export type { Cursor };

// ── Plain data types ────────────────────────────────────────────────

/** What kind of item a Drive entry refers to. */
export type DriveItemKind = "file" | "folder" | "shortcut";

/**
 * The Google editor format backing a native Drive file. Absent for ordinary uploaded files (PDFs,
 * images, text, archives, and so on).
 */
export type DriveNativeType =
  | "document" | "spreadsheet" | "presentation" | "form" | "drawing";

/** Metadata about one Drive item. */
export type DriveItemInfo = {
  /** Stable Drive file ID. */
  id: string;
  /** Item name, including any extension. Not unique — several items in one folder may share it. */
  name: string;
  kind: DriveItemKind;
  /** Drive MIME type, e.g. `application/pdf` or `application/vnd.google-apps.folder`. */
  mimeType: string;
  /** Set when the item is a Google editor file rather than an uploaded one. */
  nativeType?: DriveNativeType;
  /** Byte size of the stored content. Absent for folders and Google editor files. */
  sizeBytes?: number;
  created: Date;
  modified: Date;
  /** Display name of whoever last modified the item, when Drive reports one. */
  lastModifiedBy?: string;
  /** Whether the connected account owns the item, as opposed to someone sharing it. */
  ownedByMe: boolean;
  /** Whether the item is in the trash. Trashed items are excluded from reads by default. */
  trashed: boolean;
  starred: boolean;
  /**
   * Link that opens the item in Google's own UI. For a Google Doc or Spreadsheet this is the
   * `docs.google.com` URL, which is what the user must connect to read or edit the document body
   * itself; see `readText()`.
   *
   * Empty for an item this session created but that has not been committed to Drive yet, since it
   * has no Drive URL of its own until then.
   */
  webUrl: string;
  /** ID the shortcut points at. Only set when `kind` is `"shortcut"`. */
  shortcutTargetId?: string;
};

/** One item from a folder listing or search, with a capability for reading it. */
export type DriveEntry =
  | { kind: "file"; info: DriveItemInfo; file: DriveFile }
  | { kind: "folder"; info: DriveItemInfo; folder: DriveFolder }
  /**
   * A shortcut. Its target capability is present only when the target is inside the connected
   * scope; otherwise the entry carries metadata alone.
   */
  | { kind: "shortcut"; info: DriveItemInfo; target?: DriveFile | DriveFolder };

/** Filters for `search()`. All fields are optional; an empty filter matches everything in scope. */
export type DriveSearchFilter = {
  /** Match items whose name contains this text, case-insensitively. */
  nameContains?: string;
  /** Match items whose indexed content or name contains this text. */
  fullText?: string;
  /** Match only these Drive MIME types. */
  mimeType?: string | string[];
  /** Match only these Google editor formats. Use `mimeType` for uploaded file types. */
  nativeType?: DriveNativeType | DriveNativeType[];
  modifiedAfter?: Date;
  modifiedBefore?: Date;
  starredOnly?: boolean;
  /** Include trashed items. Defaults to false. */
  includeTrashed?: boolean;
  /**
   * Search the whole subtree beneath the folder rather than its direct children. Defaults to
   * false. A recursive search walks at most 500 folders and 10 levels of nesting, and throws if
   * the subtree is larger; narrow the filter or start from a deeper folder.
   *
   * Ignored on a whole-Drive binding, which always searches everything.
   */
  recursive?: boolean;
  /** Sort field. Defaults to `"modified"`. */
  orderBy?: "modified" | "created" | "name";
  /** Sort descending. Defaults to true for `"modified"`/`"created"` and false for `"name"`. */
  descending?: boolean;
};

/** Options for a folder listing. */
export type DriveListOptions = {
  includeTrashed?: boolean;
  orderBy?: "modified" | "created" | "name";
  descending?: boolean;
};

/** One way a Drive item is shared. */
export type DriveSharingEntry = {
  /** `"user"`, `"group"`, `"domain"`, or `"anyone"` for link sharing. */
  granteeType: "user" | "group" | "domain" | "anyone";
  /**
   * Email address for user and group grants; domain name for domain grants; absent for
   * `"anyone"`.
   */
  grantee?: string;
  role: "owner" | "organizer" | "writer" | "commenter" | "reader";
};

/** Text content read out of a Drive file. */
export type DriveTextContent = {
  /** The decoded text. Google Docs are converted to Markdown. */
  text: string;
  /**
   * Format of `text`: `"markdown"` for a converted Google Doc, `"csv"` for a converted
   * spreadsheet's first worksheet, `"plain"` for an ordinary text file.
   */
  format: "markdown" | "csv" | "plain";
  /** True when the file was longer than 5 MiB and `text` holds only the leading portion. */
  truncated: boolean;
};

// ── Capability interfaces ───────────────────────────────────────────
// These are RPC stubs — all methods are async. Capabilities can be
// passed across Worker boundaries and retain their access rights.

/**
 * Read access to a whole connected Drive.
 *
 * Only the account's own My Drive is reachable. Shared drives and items under "Shared with me" are
 * not, even when the account can open them in Drive itself.
 */
export interface DriveSession {
  /** The top-level My Drive folder. */
  getRoot(): Promise<DriveFolder>;

  /** Search the whole Drive. Returns a cursor that fetches pages lazily as consumed. */
  search(filter?: DriveSearchFilter): Promise<Cursor<DriveEntry>>;

  /** The most recently modified items across the Drive, newest first. `limit` defaults to 25. */
  listRecent(limit?: number): Promise<DriveEntry[]>;

  /**
   * Resolve a Drive or Google editor URL to a capability — a `drive.google.com` file or folder
   * link, or a `docs.google.com` document, spreadsheet, or presentation link.
   *
   * Throws if the URL is not a recognized Google URL, or if the item does not exist, is in the
   * trash, or is outside this Drive.
   */
  itemFromUrl(url: string): Promise<DriveEntry>;
}

/**
 * A single connected Drive folder and everything beneath it.
 *
 * Every capability reachable from here stays inside this subtree, so a folder binding cannot read
 * anything elsewhere in the Drive.
 */
export interface DriveFolderSession extends DriveFolder {}

/** A single connected Drive file. */
export interface DriveFileSession extends DriveFile {}

export interface DriveFolder {
  getMetadata(): Promise<DriveItemInfo>;

  /** Direct children of this folder. Returns a cursor that fetches pages lazily as consumed. */
  list(options?: DriveListOptions): Promise<Cursor<DriveEntry>>;

  /**
   * Search within this folder. Direct children only unless `filter.recursive` is set. Returns a
   * cursor that fetches pages lazily as consumed.
   */
  search(filter?: DriveSearchFilter): Promise<Cursor<DriveEntry>>;

  /**
   * Resolve a slash-separated path of folder names relative to this folder, e.g.
   * `"Receipts/2026"`. Returns null if any segment is missing. Throws if a segment matches more
   * than one folder, since the result would be ambiguous.
   */
  folderByPath(path: string): Promise<DriveFolder | null>;

  /**
   * Like `folderByPath()`, but create any missing folders along the way and return the deepest
   * one. Existing folders are reused.
   */
  ensureFolderPath(path: string): Promise<DriveFolder>;

  /**
   * Create a folder directly inside this one. Drive permits a duplicate name.
   *
   * The folder appears in subsequent reads immediately, and the returned capability works right
   * away — including for uploading into it. Until the creation is committed to Drive the folder has
   * a temporary ID and an empty `webUrl`.
   */
  createFolder(name: string): Promise<DriveFolder>;

  /**
   * Upload a new file into this folder. Pass a string for text content or an ArrayBuffer for
   * binary. `mimeType` defaults to `text/plain` for strings and `application/octet-stream` for
   * ArrayBuffers.
   *
   * Content must be at most 25 MiB. Drive permits a duplicate name, so search first if you need
   * the name to be unique. Like `createFolder()`, the file appears in subsequent reads immediately
   * and carries a temporary ID until the upload is committed.
   */
  uploadFile(
    name: string,
    content: string | ArrayBuffer,
    options?: { mimeType?: string },
  ): Promise<DriveFile>;

  /** Rename this folder. The new name appears in subsequent reads immediately. */
  rename(newName: string): Promise<void>;

  /**
   * Move this folder into `destination`. Since `destination` is itself a capability, a folder can
   * only be moved somewhere inside the connected scope. Throws if `destination` is this folder or
   * one of its own descendants.
   */
  moveTo(destination: DriveFolder): Promise<void>;

  /** Move this folder and its contents to the trash. */
  trash(): Promise<void>;

  /** Restore this folder from the trash. */
  restore(): Promise<void>;

  /** Who this folder is shared with. */
  listSharing(): Promise<DriveSharingEntry[]>;
}

export interface DriveFile {
  getMetadata(): Promise<DriveItemInfo>;

  /**
   * Read this file as text.
   *
   * Google Docs are converted to Markdown and spreadsheets to CSV (first worksheet only) — for
   * anything beyond reading those, connect the file's `webUrl` as a Google Doc or Google
   * Spreadsheet instead. Ordinary text files are decoded as UTF-8.
   *
   * Throws for formats with no text form, such as images, archives, Google Slides, and Google
   * Forms. Content beyond 5 MiB of text is truncated, which the result reports.
   */
  readText(): Promise<DriveTextContent>;

  /**
   * Read this file's raw bytes. Throws for Google editor files, which have no stored bytes — use
   * `readText()`. Throws for files larger than 25 MiB.
   */
  readBytes(): Promise<ArrayBuffer>;

  /**
   * Replace this file's content, keeping its ID, name, and location. Pass a string for text or an
   * ArrayBuffer for binary; `mimeType` defaults to the file's current type. At most 25 MiB.
   *
   * Subsequent reads return the new content. Throws for Google editor files — connect the file's
   * `webUrl` as a Google Doc to edit a document body.
   */
  write(content: string | ArrayBuffer, options?: { mimeType?: string }): Promise<void>;

  /** Rename this file. The new name appears in subsequent reads immediately. */
  rename(newName: string): Promise<void>;

  /**
   * Move this file into `destination`. Since `destination` is itself a capability, a file can only
   * be moved somewhere inside the connected scope.
   */
  moveTo(destination: DriveFolder): Promise<void>;

  /**
   * Copy this file into `destination`, defaulting to `"Copy of <name>"` when `name` is omitted.
   * The copy carries a temporary ID until it is committed to Drive.
   */
  copyTo(destination: DriveFolder, name?: string): Promise<DriveFile>;

  /** Move this file to the trash. */
  trash(): Promise<void>;

  /** Restore this file from the trash. */
  restore(): Promise<void>;

  /** Who this file is shared with. */
  listSharing(): Promise<DriveSharingEntry[]>;
}
