export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type DriveConfiguratorValues = {
  /** `"drive"` for the whole My Drive, `"folder"` for one folder subtree, `"file"` for one file. */
  scope?: string | null;
  folderId?: string | null;
  fileId?: string | null;
}

export interface DriveConfiguratorRpc {
  listFolders(query: string): Promise<ConfiguratorOption[]>;
  listFiles(query: string): Promise<ConfiguratorOption[]>;
}
