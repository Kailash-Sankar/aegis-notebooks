import test from "node:test";
import assert from "node:assert/strict";
import { mapBackupRow, mapUploadRow, mapWidgetRow, mapWorkspaceRow } from "./pocketbase.js";

test("mapWorkspaceRow maps snake_case and coerces status", () => {
  const w = mapWorkspaceRow({
    id: "w1",
    name: "W",
    path: "/x",
    owner_id: "local",
    status: "archived",
    created_at: "t",
  });
  assert.deepEqual(w, {
    id: "w1",
    name: "W",
    path: "/x",
    ownerId: "local",
    status: "archived",
    createdAt: "t",
  });
});

test("mapWorkspaceRow defaults unknown status to active", () => {
  assert.equal(mapWorkspaceRow({ id: "w1", status: "bogus" }).status, "active");
});

test("mapUploadRow maps every field", () => {
  const u = mapUploadRow({
    id: "u1",
    workspace_id: "w1",
    filename: "x.csv",
    rel_path: "abc-x.csv",
    bytes: 5,
    content_hash: "h",
    s3_key: "w1/uploads/h.csv",
    backup_status: "done",
    created_at: "t",
  });
  assert.deepEqual(u, {
    id: "u1",
    workspaceId: "w1",
    filename: "x.csv",
    relPath: "abc-x.csv",
    bytes: 5,
    contentHash: "h",
    s3Key: "w1/uploads/h.csv",
    backupStatus: "done",
    createdAt: "t",
  });
});

test("mapUploadRow tolerates missing/null fields", () => {
  const u = mapUploadRow({ id: "u1", s3_key: null, backup_status: "weird" });
  assert.equal(u.bytes, 0);
  assert.equal(u.s3Key, null);
  assert.equal(u.backupStatus, "pending");
  assert.equal(u.workspaceId, "");
});

test("mapBackupRow maps kind and size", () => {
  const b = mapBackupRow({
    id: "b1",
    workspace_id: "w1",
    kind: "snapshot",
    s3_key: "k",
    size: 42,
    created_at: "t",
  });
  assert.deepEqual(b, {
    id: "b1",
    workspaceId: "w1",
    kind: "snapshot",
    s3Key: "k",
    size: 42,
    createdAt: "t",
  });
});

test("mapWidgetRow parses json spec/position and defaults type", () => {
  const w = mapWidgetRow({
    id: "wg1",
    notebook_id: "n1",
    type: "artifact",
    spec: { html: "<b>x</b>" },
    position: { x: 0, y: 1 },
    updated_at: "t",
  });
  assert.equal(w.type, "artifact");
  assert.deepEqual(w.spec, { html: "<b>x</b>" });
  assert.deepEqual(w.position, { x: 0, y: 1 });

  const comp = mapWidgetRow({ id: "wg2", type: "nonsense" });
  assert.equal(comp.type, "component");
  assert.deepEqual(comp.spec, {});
  assert.equal(comp.position, null);
});
