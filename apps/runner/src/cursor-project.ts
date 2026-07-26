import {
  installManagedMcpProject,
  managedMcpProjectStatus,
  previewManagedMcpProjectInstall,
  uninstallManagedMcpProject,
  type ManagedMcpProjectPaths,
  type ManagedMcpProjectPreview,
  type ManagedMcpProjectStatus,
} from "./managed-mcp-project.js";

export type CursorProjectPaths = ManagedMcpProjectPaths;
export type CursorProjectStatus = ManagedMcpProjectStatus;
export type CursorProjectPreview = ManagedMcpProjectPreview;

export function previewCursorProjectInstall(input: {
  projectRoot?: string;
  configPath?: string;
  storePath?: string;
  packageSpec?: string;
  authoring?: boolean;
} = {}): Promise<CursorProjectPreview> {
  return previewManagedMcpProjectInstall({ client: "cursor", ...input });
}

export function installCursorProject(input: {
  projectRoot?: string;
  configPath?: string;
  storePath?: string;
  packageSpec?: string;
  authoring?: boolean;
  now?: string;
} = {}): Promise<CursorProjectPreview & { backup?: string }> {
  return installManagedMcpProject({ client: "cursor", ...input });
}

export function uninstallCursorProject(input: {
  projectRoot?: string;
  now?: string;
} = {}): Promise<{ changed: boolean; paths: CursorProjectPaths; backup?: string }> {
  return uninstallManagedMcpProject({ client: "cursor", ...input });
}

export function cursorProjectStatus(projectRoot = process.cwd()): Promise<CursorProjectStatus> {
  return managedMcpProjectStatus("cursor", projectRoot);
}
