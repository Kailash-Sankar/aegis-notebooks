import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  LayoutDashboard,
  NotebookPen,
  Plus,
} from "lucide-react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { DataFile, Notebook, Workspace } from "../types.js";

export function Sidebar({
  workspaces,
  workspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
  notebooks,
  notebookId,
  onSelectNotebook,
  onCreateNotebook,
  dataFiles,
  canCreateNotebook,
  isWorkspaceView,
  onSelectWorkspaceView,
  collapsed,
  onToggleCollapse,
}: {
  workspaces: Workspace[];
  workspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
  notebooks: Notebook[];
  notebookId: string | null;
  onSelectNotebook: (id: string) => void;
  onCreateNotebook: () => void;
  dataFiles: DataFile[];
  canCreateNotebook: boolean;
  isWorkspaceView: boolean;
  onSelectWorkspaceView: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  return (
    <aside className="aegis-sidebar" data-collapsed={collapsed}>
      <div className="aegis-sidebar-header">
        {!collapsed && (
          <Text type="label" weight="semibold">
            Aegis
          </Text>
        )}
        <IconButton
          label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          variant="ghost"
          size="sm"
          icon={collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          onClick={onToggleCollapse}
        />
      </div>

      {collapsed ? (
        <Stack gap={1} hAlign="center" paddingBlock={2}>
          <IconButton
            label="Workspace overview"
            tooltip="Workspace overview"
            variant={isWorkspaceView ? "secondary" : "ghost"}
            size="sm"
            icon={<LayoutDashboard size={16} />}
            onClick={onSelectWorkspaceView}
            isDisabled={!workspaceId}
          />
        </Stack>
      ) : (
        <div className="aegis-sidebar-body">
          <Stack gap={5} paddingInline={3} paddingBlock={2}>
            <section>
              <span className="aegis-section-label">
                <FolderOpen size={13} />
                Workspace
              </span>
              <Stack direction="horizontal" gap={2} vAlign="end">
                <Selector
                  label="Workspace"
                  isLabelHidden
                  width="100%"
                  placeholder="No workspace"
                  value={workspaceId ?? undefined}
                  onChange={onSelectWorkspace}
                  options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
                />
                <IconButton
                  label="New workspace"
                  tooltip="New workspace"
                  variant="secondary"
                  size="sm"
                  icon={<Plus size={16} />}
                  onClick={onCreateWorkspace}
                />
              </Stack>
            </section>

            <Button
              label="Workspace overview"
              variant={isWorkspaceView ? "secondary" : "ghost"}
              size="sm"
              width="100%"
              icon={<LayoutDashboard size={15} />}
              endContent={
                workspaceId ? (
                  <Badge
                    label={`${dataFiles.length} file${dataFiles.length === 1 ? "" : "s"}`}
                    variant="neutral"
                  />
                ) : undefined
              }
              onClick={onSelectWorkspaceView}
              isDisabled={!workspaceId}
            />

            <section>
              <span className="aegis-section-label">
                <NotebookPen size={13} />
                Notebook
              </span>
              <Stack direction="horizontal" gap={2} vAlign="end">
                <Selector
                  label="Notebook"
                  isLabelHidden
                  width="100%"
                  placeholder="Select a notebook"
                  value={notebookId}
                  onChange={(v) => onSelectNotebook(v ?? "")}
                  hasClear
                  isDisabled={!workspaceId}
                  options={notebooks.map((n) => ({ value: n.id, label: n.title }))}
                />
                <IconButton
                  label="New notebook"
                  tooltip={
                    canCreateNotebook ? "New notebook" : "Onboard the workspace first"
                  }
                  variant="secondary"
                  size="sm"
                  icon={<Plus size={16} />}
                  onClick={onCreateNotebook}
                  isDisabled={!workspaceId || !canCreateNotebook}
                />
              </Stack>
              {!canCreateNotebook && workspaceId && (
                <Text type="supporting" color="secondary">
                  Onboard the workspace to create notebooks.
                </Text>
              )}
            </section>
          </Stack>
        </div>
      )}
    </aside>
  );
}
