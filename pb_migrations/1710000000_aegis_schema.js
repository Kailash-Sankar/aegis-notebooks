/// <reference path="../pb_data/types.d.ts" />
//
// Aegis registry schema (ADR 0002). PocketBase is a projection of disk state;
// these collections only mirror pointers, hashes, and status.
//
// All rules default to null (superuser-only). The runner authenticates as a
// superuser. The MVP is single-user/local (ADR 0006); tighten rules when auth
// is added.
migrate(
  (app) => {
    const workspaces = new Collection({
      type: "base",
      name: "workspaces",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "path", type: "text", required: true },
        { name: "owner_id", type: "text", required: true },
        { name: "status", type: "select", maxSelect: 1, values: ["active", "archived"] },
        { name: "created_at", type: "date" },
      ],
    });
    app.save(workspaces);

    const notebooks = new Collection({
      type: "base",
      name: "notebooks",
      fields: [
        { name: "workspace_id", type: "text", required: true },
        { name: "title", type: "text" },
        { name: "owner_id", type: "text", required: true },
        { name: "last_active", type: "date" },
      ],
    });
    app.save(notebooks);

    const uploads = new Collection({
      type: "base",
      name: "uploads",
      fields: [
        { name: "workspace_id", type: "text", required: true },
        { name: "filename", type: "text", required: true },
        { name: "rel_path", type: "text" },
        { name: "bytes", type: "number" },
        { name: "content_hash", type: "text", required: true },
        { name: "s3_key", type: "text" },
        {
          name: "backup_status",
          type: "select",
          maxSelect: 1,
          values: ["pending", "done", "failed", "skipped"],
        },
        { name: "created_at", type: "date" },
      ],
    });
    app.save(uploads);

    const backups = new Collection({
      type: "base",
      name: "backups",
      fields: [
        { name: "workspace_id", type: "text", required: true },
        { name: "kind", type: "select", maxSelect: 1, values: ["upload", "snapshot"] },
        { name: "s3_key", type: "text", required: true },
        { name: "size", type: "number" },
        { name: "created_at", type: "date" },
      ],
    });
    app.save(backups);

    const widgetSpecs = new Collection({
      type: "base",
      name: "widget_specs",
      fields: [
        { name: "notebook_id", type: "text", required: true },
        {
          name: "type",
          type: "select",
          maxSelect: 1,
          required: true,
          values: ["component", "artifact"],
        },
        { name: "spec", type: "json" },
        { name: "position", type: "json" },
        { name: "updated_at", type: "date" },
      ],
    });
    app.save(widgetSpecs);
  },
  (app) => {
    for (const name of ["widget_specs", "backups", "uploads", "notebooks", "workspaces"]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch {
        // already absent
      }
    }
  },
);
