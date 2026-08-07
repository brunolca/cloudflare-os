import { Autocomplete, Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  DriveConfiguratorRpc, DriveConfiguratorValues,
} from "./drive-configurator-types";

const SCOPE_OPTIONS = [
  {
    value: "drive",
    title: "Whole Drive",
    description: "Read any file in My Drive.",
  },
  {
    value: "folder",
    title: "One folder",
    description: "Read only this folder and everything inside it.",
  },
  {
    value: "file",
    title: "One file",
    description: "Read only this single file.",
  },
];

export default {
  initial: { scope: "folder" },

  isReady({ values }) {
    if (values.scope === "drive") return true;
    if (values.scope === "folder") return !!values.folderId;
    if (values.scope === "file") return !!values.fileId;
    return false;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    let path = new URL(resourceUrl).pathname.split("/").filter(Boolean)
        .map(segment => decodeURIComponent(segment));
    // Normalize the way the gatekeeper's own parser does, so a URL copied out of Drive's UI
    // pre-fills the granularity it names. Drive writes the signed-in account into the path
    // (/drive/u/0/folders/<id>) whenever more than one account is signed in, and treating that as
    // unrecognized would silently pre-fill whole-Drive for a URL that named one folder.
    if (path[0] === "drive") path.shift();
    if (path[0] === "u" && /^\d+$/.test(path[1] ?? "")) path.splice(0, 2);

    // folders/<id>
    if (path[0] === "folders" && path[1]) {
      return { scope: "folder", folderId: path[1] };
    }
    // file/d/<id>
    if (path[0] === "file" && path[1] === "d" && path[2]) {
      return { scope: "file", fileId: path[2] };
    }
    return { scope: "drive" };
  },

  resourceUrl({ values }) {
    if (values.scope === "folder") {
      return `https://drive.google.com/drive/folders/${encodeURIComponent(values.folderId ?? "")}`;
    }
    if (values.scope === "file") {
      return `https://drive.google.com/file/d/${encodeURIComponent(values.fileId ?? "")}/view`;
    }
    return "https://drive.google.com/drive/my-drive";
  },

  render({ values, setValues, clearFields, ui }) {
    return <Section>
      <Field label="Access" description="How much of Drive this connection can read.">
        <RadioCards
          value={values.scope}
          options={SCOPE_OPTIONS}
          onChange={scope => {
            clearFields("folderId", "fileId");
            setValues({ scope, folderId: null, fileId: null });
          }}
        />
      </Field>

      {values.scope === "folder"
        ? <Field label="Folder" description="Search folders in My Drive.">
            <Autocomplete
              name="folderId"
              value={values.folderId}
              placeholder="Search folders..."
              loadOptions={query => ui.listFolders(query)}
              onChange={folderId => setValues({ folderId })}
            />
          </Field>
        : null}

      {values.scope === "file"
        ? <Field label="File" description="Search files in My Drive.">
            <Autocomplete
              name="fileId"
              value={values.fileId}
              placeholder="Search files..."
              loadOptions={query => ui.listFiles(query)}
              onChange={fileId => setValues({ fileId })}
            />
          </Field>
        : null}
    </Section>;
  },
} satisfies ConfiguratorUISpec<DriveConfiguratorRpc, DriveConfiguratorValues>;
