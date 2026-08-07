import { describe, expect, it } from "vitest";
import {
  buildDriveOverlay, createdSyntheticId, DriveIdMap, isSyntheticId, matchesDriveFilter,
  overlayFolderChildren, overlayItemInfo, pendingItemInfo, pendingSearchMatches, referencedIds,
  syntheticId,
} from "../src/drive-actions";
import type { DriveAction, PendingDriveAction } from "../src/drive-actions";
import type { DriveItemInfo } from "../src/drive-types";

const SUBMITTED_AT = Date.parse("2026-08-01T12:00:00Z");

function item(overrides: Partial<DriveItemInfo> & { id: string; name: string }): DriveItemInfo {
  return {
    kind: "file",
    mimeType: "text/plain",
    created: new Date("2026-01-01T00:00:00Z"),
    modified: new Date("2026-01-02T00:00:00Z"),
    ownedByMe: true,
    trashed: false,
    starred: false,
    webUrl: `https://drive.google.com/file/d/${overrides.id}/view`,
    ...overrides,
  };
}

// Wrap actions as the store would hand them back: submission order, IDs from 1.
function pending(...actions: DriveAction[]): PendingDriveAction[] {
  return actions.map((action, index) => ({ id: index + 1, action }));
}

function record(info: DriveItemInfo, ...parents: string[]) {
  return { info, parents };
}

describe("buildDriveOverlay", () => {
  it("collapses later changes onto the item a pending creation will produce", () => {
    let overlay = buildDriveOverlay(pending(
      {
        type: "createFolder", syntheticId: syntheticId(1), parentId: "root", name: "Receipts",
        submittedAt: SUBMITTED_AT,
      },
      { type: "rename", fileId: syntheticId(1), name: "Receipts 2026", submittedAt: SUBMITTED_AT },
      { type: "move", fileId: syntheticId(1), parentId: "archive", submittedAt: SUBMITTED_AT },
    ));

    expect(overlay.patches.size).toBe(0);
    let created = overlay.created.get(syntheticId(1));
    expect(created).toMatchObject({
      name: "Receipts 2026",
      parentId: "archive",
      isFolder: true,
      trashed: false,
    });
  });

  it("records changes to committed items as patches", () => {
    let overlay = buildDriveOverlay(pending(
      { type: "rename", fileId: "abc", name: "Renamed.txt", submittedAt: SUBMITTED_AT },
      { type: "trash", fileId: "def", submittedAt: SUBMITTED_AT },
    ));

    expect(overlay.created.size).toBe(0);
    expect(overlay.patches.get("abc")).toMatchObject({ name: "Renamed.txt" });
    expect(overlay.patches.get("def")).toMatchObject({ trashed: true });
  });

  it("ignores invalidated actions", () => {
    let overlay = buildDriveOverlay(pending(
      {
        type: "rename", fileId: "abc", name: "Never.txt", submittedAt: SUBMITTED_AT,
        invalidatedReason: "the folder it lived in was never created",
      },
    ));

    expect(overlay.patches.size).toBe(0);
  });

  it("lets a restore undo a pending trash", () => {
    let overlay = buildDriveOverlay(pending(
      { type: "trash", fileId: "abc", submittedAt: SUBMITTED_AT },
      { type: "restore", fileId: "abc", submittedAt: SUBMITTED_AT },
    ));

    expect(overlay.patches.get("abc")).toMatchObject({ trashed: false });
  });
});

describe("overlayItemInfo", () => {
  it("applies a pending rename and bumps the modified time", () => {
    let overlay = buildDriveOverlay(pending(
      { type: "rename", fileId: "abc", name: "New.txt", submittedAt: SUBMITTED_AT },
    ));

    let result = overlayItemInfo(item({ id: "abc", name: "Old.txt" }), overlay);
    expect(result.name).toBe("New.txt");
    expect(result.modified.valueOf()).toBe(SUBMITTED_AT);
  });

  it("passes an unaffected item through unchanged", () => {
    let overlay = buildDriveOverlay([]);
    let info = item({ id: "abc", name: "Old.txt" });
    expect(overlayItemInfo(info, overlay)).toBe(info);
  });
});

describe("pendingItemInfo", () => {
  it("reports a folder with no Drive URL until it is committed", () => {
    let overlay = buildDriveOverlay(pending({
      type: "createFolder", syntheticId: syntheticId(1), parentId: "root", name: "Receipts",
      submittedAt: SUBMITTED_AT,
    }));

    let info = pendingItemInfo(overlay.created.get(syntheticId(1))!);
    expect(info).toMatchObject({ kind: "folder", name: "Receipts", webUrl: "" });
    expect(isSyntheticId(info.id)).toBe(true);
  });

  it("presents a pending OCR conversion as the Doc it will become", () => {
    let overlay = buildDriveOverlay(pending({
      type: "copy", syntheticId: syntheticId(1), sourceId: "scan", parentId: "receipts",
      name: "Invoice March", mimeType: "application/vnd.google-apps.document",
      targetMimeType: "application/vnd.google-apps.document", ocrLanguage: "fr",
      submittedAt: SUBMITTED_AT,
    }));

    let info = pendingItemInfo(overlay.created.get(syntheticId(1))!);
    // Not the source PDF: the pending item is the converted Doc, and Docs carry no size.
    expect(info).toMatchObject({ nativeType: "document", name: "Invoice March" });
    expect(info.sizeBytes).toBeUndefined();
  });

  it("maps a Google editor MIME type to its native type", () => {
    let overlay = buildDriveOverlay(pending({
      type: "copy", syntheticId: syntheticId(1), sourceId: "abc", parentId: "root",
      name: "Copy of Plan", mimeType: "application/vnd.google-apps.document",
      submittedAt: SUBMITTED_AT,
    }));

    expect(pendingItemInfo(overlay.created.get(syntheticId(1))!).nativeType).toBe("document");
  });
});

describe("overlayFolderChildren", () => {
  it("drops a child a pending move took out of the folder", () => {
    let overlay = buildDriveOverlay(pending(
      { type: "move", fileId: "gone", parentId: "elsewhere", submittedAt: SUBMITTED_AT },
    ));

    let result = overlayFolderChildren(
      "folder",
      [record(item({ id: "gone", name: "Gone.txt" }), "folder"),
       record(item({ id: "stays", name: "Stays.txt" }), "folder")],
      overlay,
      { alreadyListed: new Set(), isLastPage: true },
    );

    expect(result.map(info => info.id)).toEqual(["stays"]);
  });

  it("hides a pending trash unless trashed items were requested", () => {
    let overlay = buildDriveOverlay(pending(
      { type: "trash", fileId: "doomed", submittedAt: SUBMITTED_AT },
    ));
    let remote = [record(item({ id: "doomed", name: "Doomed.txt" }), "folder")];

    expect(overlayFolderChildren("folder", remote, overlay, {
      alreadyListed: new Set(), isLastPage: true,
    })).toEqual([]);

    expect(overlayFolderChildren("folder", remote, overlay, {
      includeTrashed: true, alreadyListed: new Set(), isLastPage: true,
    }).map(info => info.id)).toEqual(["doomed"]);
  });

  it("appends pending creations only on the last page, and only once", () => {
    let overlay = buildDriveOverlay(pending({
      type: "uploadFile", syntheticId: syntheticId(1), parentId: "folder", name: "New.txt",
      mimeType: "text/plain", contentKey: "drive:content:1", sizeBytes: 4,
      submittedAt: SUBMITTED_AT,
    }));
    let alreadyListed = new Set<string>();

    let firstPage = overlayFolderChildren(
      "folder", [record(item({ id: "old", name: "Old.txt" }), "folder")], overlay,
      { alreadyListed, isLastPage: false });
    expect(firstPage.map(info => info.id)).toEqual(["old"]);

    let lastPage = overlayFolderChildren("folder", [], overlay, { alreadyListed, isLastPage: true });
    expect(lastPage.map(info => info.id)).toEqual([syntheticId(1)]);

    // A repeat call must not surface the same pending item a second time.
    let extraPage = overlayFolderChildren(
      "folder", [], overlay, { alreadyListed, isLastPage: true });
    expect(extraPage).toEqual([]);
  });

  it("does not leak a pending creation into a different folder's listing", () => {
    let overlay = buildDriveOverlay(pending({
      type: "createFolder", syntheticId: syntheticId(1), parentId: "somewhere-else",
      name: "Receipts", submittedAt: SUBMITTED_AT,
    }));

    expect(overlayFolderChildren("folder", [], overlay, {
      alreadyListed: new Set(), isLastPage: true,
    })).toEqual([]);
  });
});

describe("matchesDriveFilter", () => {
  let info = item({
    id: "abc",
    name: "Invoice March.pdf",
    mimeType: "application/pdf",
    modified: new Date("2026-03-15T00:00:00Z"),
  });

  it("matches an empty filter", () => {
    expect(matchesDriveFilter(info, undefined)).toBe(true);
    expect(matchesDriveFilter(info, {})).toBe(true);
  });

  it("matches names case-insensitively", () => {
    expect(matchesDriveFilter(info, { nameContains: "invoice" })).toBe(true);
    expect(matchesDriveFilter(info, { nameContains: "receipt" })).toBe(false);
  });

  it("honors mimeType, nativeType, dates, and starredOnly", () => {
    expect(matchesDriveFilter(info, { mimeType: ["application/pdf", "text/plain"] })).toBe(true);
    expect(matchesDriveFilter(info, { mimeType: "text/plain" })).toBe(false);
    expect(matchesDriveFilter(info, { nativeType: "document" })).toBe(false);
    expect(matchesDriveFilter(info, { modifiedAfter: new Date("2026-03-01T00:00:00Z") })).toBe(true);
    expect(matchesDriveFilter(info, { modifiedAfter: new Date("2026-04-01T00:00:00Z") }))
        .toBe(false);
    expect(matchesDriveFilter(info, { modifiedBefore: new Date("2026-04-01T00:00:00Z") }))
        .toBe(true);
    expect(matchesDriveFilter(info, { starredOnly: true })).toBe(false);
    expect(matchesDriveFilter({ ...info, starred: true }, { starredOnly: true })).toBe(true);
  });

  it("excludes trashed items unless they were requested", () => {
    let trashed = { ...info, trashed: true };
    expect(matchesDriveFilter(trashed, {})).toBe(false);
    expect(matchesDriveFilter(trashed, { includeTrashed: true })).toBe(true);
  });
});

describe("pendingSearchMatches", () => {
  let overlay = buildDriveOverlay(pending(
    {
      type: "uploadFile", syntheticId: syntheticId(1), parentId: "inbox", name: "Invoice.pdf",
      mimeType: "application/pdf", contentKey: "drive:content:1", sizeBytes: 10,
      submittedAt: SUBMITTED_AT,
    },
    {
      type: "createFolder", syntheticId: syntheticId(2), parentId: "archive", name: "2026",
      submittedAt: SUBMITTED_AT,
    },
  ));

  it("restricts matches to the searched parents", () => {
    expect(pendingSearchMatches(overlay, ["inbox"], undefined, new Set()).map(i => i.id))
        .toEqual([syntheticId(1)]);
    expect(pendingSearchMatches(overlay, ["nowhere"], undefined, new Set())).toEqual([]);
  });

  it("searches every parent when none is given, and applies the filter", () => {
    expect(pendingSearchMatches(overlay, undefined, undefined, new Set()).length).toBe(2);
    expect(pendingSearchMatches(overlay, undefined, { nameContains: "invoice" }, new Set())
        .map(i => i.id)).toEqual([syntheticId(1)]);
  });

  it("skips items already emitted on an earlier page", () => {
    let alreadyListed = new Set([syntheticId(1)]);
    expect(pendingSearchMatches(overlay, undefined, undefined, alreadyListed).map(i => i.id))
        .toEqual([syntheticId(2)]);
  });
});

describe("action metadata", () => {
  it("reports the IDs each action type depends on", () => {
    expect(referencedIds({
      type: "createFolder", syntheticId: syntheticId(1), parentId: "root", name: "x",
      submittedAt: SUBMITTED_AT,
    })).toEqual(["root"]);

    expect(referencedIds({
      type: "copy", syntheticId: syntheticId(2), sourceId: "src", parentId: "dst", name: "x",
      mimeType: "text/plain", submittedAt: SUBMITTED_AT,
    })).toEqual(["src", "dst"]);

    expect(referencedIds({
      type: "move", fileId: "abc", parentId: "dst", submittedAt: SUBMITTED_AT,
    })).toEqual(["abc", "dst"]);
  });

  it("reports which actions create something", () => {
    expect(createdSyntheticId({
      type: "createFolder", syntheticId: syntheticId(1), parentId: "root", name: "x",
      submittedAt: SUBMITTED_AT,
    })).toBe(syntheticId(1));

    expect(createdSyntheticId({
      type: "rename", fileId: "abc", name: "x", submittedAt: SUBMITTED_AT,
    })).toBeUndefined();
  });
});

// Minimal stand-in for the Durable Object synchronous KV surface DriveIdMap uses.
function fakeKv() {
  let entries = new Map<string, unknown>();
  return {
    get: (key: string) => entries.get(key),
    put: (key: string, value: unknown) => { entries.set(key, value); },
    delete: (key: string) => { entries.delete(key); },
    list: ({ prefix }: { prefix: string }) =>
      [...entries.entries()].filter(([key]) => key.startsWith(prefix)),
  } as unknown as DurableObjectStorage["kv"];
}

describe("DriveIdMap", () => {
  it("refuses to resolve a creation that has not been applied", () => {
    let idMap = new DriveIdMap(fakeKv());
    expect(() => idMap.resolve(syntheticId(1))).toThrow(/awaiting approval/);
    expect(idMap.tryResolve(syntheticId(1))).toBe(syntheticId(1));
  });

  it("resolves to the real ID once the creation is recorded", () => {
    let idMap = new DriveIdMap(fakeKv());
    idMap.record(syntheticId(1), "real-drive-id");
    expect(idMap.resolve(syntheticId(1))).toBe("real-drive-id");
    expect(idMap.tryResolve(syntheticId(1))).toBe("real-drive-id");
  });

  it("leaves committed IDs alone", () => {
    let idMap = new DriveIdMap(fakeKv());
    expect(idMap.resolve("real-drive-id")).toBe("real-drive-id");
  });
});
