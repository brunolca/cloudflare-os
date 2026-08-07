import { describe, expect, it } from "vitest";
import spec from "../src/configurator/drive-configurator-ui";
import type { DriveConfiguratorValues } from "../src/configurator/drive-configurator-types";

function fromUrl(resourceUrl: string): DriveConfiguratorValues {
  return spec.initialValuesFromResourceUrl!({ resourceUrl } as never) as DriveConfiguratorValues;
}

describe("initialValuesFromResourceUrl", () => {
  it("reads the granularity out of each canonical resource URL", () => {
    expect(fromUrl("https://drive.google.com/drive/my-drive")).toMatchObject({ scope: "drive" });
    expect(fromUrl("https://drive.google.com/drive/folders/ABC123"))
      .toMatchObject({ scope: "folder", folderId: "ABC123" });
    expect(fromUrl("https://drive.google.com/file/d/XYZ789/view"))
      .toMatchObject({ scope: "file", fileId: "XYZ789" });
  });

  // Drive writes the signed-in account into the path whenever more than one account is signed in,
  // so this is the shape a user copying a folder link most often has. Falling through to
  // whole-Drive here silently widens a connection the user meant to bound to one folder.
  it("ignores the account segment Drive puts in copied URLs", () => {
    expect(fromUrl("https://drive.google.com/drive/u/0/folders/ABC123"))
      .toMatchObject({ scope: "folder", folderId: "ABC123" });
    expect(fromUrl("https://drive.google.com/drive/u/2/folders/ABC123"))
      .toMatchObject({ scope: "folder", folderId: "ABC123" });
    expect(fromUrl("https://drive.google.com/drive/u/0/my-drive")).toMatchObject({ scope: "drive" });
  });

  it("decodes percent-escaped IDs", () => {
    expect(fromUrl("https://drive.google.com/drive/folders/a%2Bb"))
      .toMatchObject({ scope: "folder", folderId: "a+b" });
  });

  it("falls back to whole Drive only for URLs that name no item", () => {
    expect(fromUrl("https://drive.google.com/")).toMatchObject({ scope: "drive" });
    expect(fromUrl("https://drive.google.com/drive/home")).toMatchObject({ scope: "drive" });
  });

  // A URL that survives a round trip is one the gatekeeper's own dispatch will read back as the
  // same granularity, since both sides normalize the path the same way.
  it("round-trips every granularity through resourceUrl()", () => {
    for (let url of [
      "https://drive.google.com/drive/my-drive",
      "https://drive.google.com/drive/folders/ABC123",
      "https://drive.google.com/file/d/XYZ789/view",
      "https://drive.google.com/drive/u/0/folders/ABC123",
    ]) {
      let values = fromUrl(url);
      expect(fromUrl(spec.resourceUrl({ values } as never))).toMatchObject(values);
    }
  });
});
