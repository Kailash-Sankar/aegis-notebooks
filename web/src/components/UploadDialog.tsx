import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { uploadFile } from "../api.js";
import type { DataFile } from "../types.js";

export function UploadDialog({
  open,
  onOpenChange,
  workspaceId,
  existing,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  existing: DataFile[];
  onUploaded: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleChange(value: File | File[] | null) {
    const incoming = Array.isArray(value) ? value : value ? [value] : [];
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...incoming.filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
  }

  async function doUpload() {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        await uploadFile(workspaceId, file);
      }
      setFiles([]);
      onUploaded();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function close(next: boolean) {
    if (busy) return;
    if (!next) {
      setFiles([]);
      setError(null);
    }
    onOpenChange(next);
  }

  return (
    <Dialog isOpen={open} onOpenChange={close} width={560} purpose="form">
      <DialogHeader
        title="Add data sources"
        subtitle="Files are stored immutably and backed up before analysis."
        onOpenChange={() => close(false)}
      />
      <Stack gap={4} paddingBlockStart={4}>
        <FileInput
          label="Files"
          isLabelHidden
          mode="dropzone"
          isMultiple
          value={files}
          onChange={handleChange}
          accept=".csv,.tsv,.parquet,.json,.jsonl,.ndjson,.log,.txt"
          placeholder="Drag & drop files here, or browse"
        />

        {error && <div className="aegis-error">{error}</div>}

        {existing.length > 0 && (
          <Stack gap={1}>
            <Text type="label" color="secondary">
              Already in workspace
            </Text>
            {existing.map((f) => (
              <Text key={f.name} type="supporting" color="secondary">
                {f.name}
              </Text>
            ))}
          </Stack>
        )}

        <Stack direction="horizontal" gap={2} justify="end">
          <Button
            label="Cancel"
            variant="ghost"
            size="sm"
            isDisabled={busy}
            onClick={() => close(false)}
          />
          <Button
            label={
              files.length > 0
                ? `Upload ${files.length} file${files.length === 1 ? "" : "s"}`
                : "Upload"
            }
            variant="primary"
            size="sm"
            isLoading={busy}
            isDisabled={files.length === 0}
            onClick={doUpload}
          />
        </Stack>
      </Stack>
    </Dialog>
  );
}
