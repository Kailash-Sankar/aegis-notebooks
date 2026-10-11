import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import {
  discoverSource,
  saveSourceContract,
  saveSourceCredentials,
} from "../api.js";
import type { SourceDiscoverResult } from "../types.js";

type AuthType = "none" | "bearer" | "header" | "query";

/**
 * Connect an external pull source: describe the connection, sample it
 * (Discover), confirm the key + event-time column, then save the contract.
 * Credentials are sent to a separate, never-echoed endpoint.
 */
export function ConnectSourceDialog({
  open,
  onOpenChange,
  workspaceId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onSaved: () => void;
}) {
  const [source, setSource] = useState("");
  const [dataset, setDataset] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [secretRef, setSecretRef] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [headerName, setHeaderName] = useState("x-api-key");
  const [paramName, setParamName] = useState("api_key");

  const [result, setResult] = useState<SourceDiscoverResult | null>(null);
  const [key, setKey] = useState("");
  const [eventTime, setEventTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function authSpec(): Record<string, unknown> | undefined {
    switch (authType) {
      case "none":
        return { type: "none" };
      case "bearer":
        return secretRef ? { type: "bearer", secretRef } : { type: "none" };
      case "header":
        return secretRef
          ? { type: "header", header: headerName, secretRef }
          : { type: "none" };
      case "query":
        return secretRef
          ? { type: "query", param: paramName, secretRef }
          : { type: "none" };
    }
  }

  async function persistCredentials(): Promise<void> {
    if (authType === "none" || !secretRef || !secretValue) return;
    await saveSourceCredentials(workspaceId, source, { [secretRef]: secretValue });
  }

  async function doDiscover() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      await persistCredentials();
      const found = await discoverSource(workspaceId, {
        source,
        dataset,
        baseUrl,
        endpoint,
        auth: authSpec(),
      });
      setResult(found);
      setKey(found.candidateKeys[0] ?? Object.keys(found.draft.columns)[0] ?? "");
      // Prefer the column discovery already flagged as event time (the
      // partition key), then fall back to the first candidate timestamp.
      setEventTime(
        Object.entries(found.draft.columns).find(([, c]) => c.eventTime)?.[0] ??
          found.candidateCursorFields[0] ??
          "",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doSave() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      await persistCredentials();
      const draft = result.draft;
      const columns = Object.fromEntries(
        Object.entries(draft.columns).map(([name, col]) => [
          name,
          {
            type: col.type,
            ...(name === eventTime ? { eventTime: true } : {}),
            ...(col.pii ? { pii: true } : {}),
          },
        ]),
      );
      const contract = {
        version: 1,
        source,
        dataset,
        baseUrl,
        sync: {
          mode: draft.sync.mode,
          endpoint,
          pageSize: draft.sync.pageSize,
          ...(draft.sync.cursorField ? { cursorField: draft.sync.cursorField } : {}),
          ...(draft.sync.cursorParam ? { cursorParam: draft.sync.cursorParam } : {}),
        },
        load: { ...draft.load, key: key ? [key] : draft.load.key },
        columns,
        ...(draft.quality ? { quality: draft.quality } : {}),
        ...(authType !== "none" && secretRef ? { auth: authSpec() } : {}),
      };
      await saveSourceContract(workspaceId, source, contract);
      reset();
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setSource("");
    setDataset("");
    setBaseUrl("");
    setEndpoint("");
    setAuthType("none");
    setSecretRef("");
    setSecretValue("");
    setResult(null);
    setKey("");
    setEventTime("");
    setError(null);
  }

  function close(next: boolean) {
    if (busy) return;
    if (!next) reset();
    onOpenChange(next);
  }

  const canDiscover =
    source.length > 0 && dataset.length > 0 && baseUrl.length > 0 && endpoint.length > 0;
  const columnOptions = result
    ? Object.keys(result.draft.columns).map((c) => ({ value: c, label: c }))
    : [];

  return (
    <Dialog isOpen={open} onOpenChange={close} width={620} purpose="form">
      <DialogHeader
        title="Connect a source"
        subtitle="Pull data from an external API into the local warehouse."
        onOpenChange={() => close(false)}
      />
      <Stack gap={4} paddingBlockStart={4}>
        <TextInput
          label="Source name"
          value={source}
          onChange={setSource}
          placeholder="twitch-mock"
        />
        <TextInput
          label="Dataset"
          value={dataset}
          onChange={setDataset}
          placeholder="stream_events"
        />
        <TextInput
          label="Base URL"
          value={baseUrl}
          onChange={setBaseUrl}
          placeholder="http://mock-source:8099"
        />
        <TextInput
          label="Endpoint"
          value={endpoint}
          onChange={setEndpoint}
          placeholder="/v1/stream_events"
        />
        <Selector
          label="Authentication"
          value={authType}
          onChange={(v) => setAuthType(v as AuthType)}
          options={[
            { value: "none", label: "None (open API)" },
            { value: "bearer", label: "Bearer token" },
            { value: "header", label: "Custom header" },
            { value: "query", label: "Query parameter" },
          ]}
        />
        {authType === "header" && (
          <TextInput label="Header name" value={headerName} onChange={setHeaderName} />
        )}
        {authType === "query" && (
          <TextInput label="Query param" value={paramName} onChange={setParamName} />
        )}
        {authType !== "none" && (
          <>
            <TextInput
              label="Secret reference"
              value={secretRef}
              onChange={setSecretRef}
              placeholder="TWITCH_API_KEY"
            />
            <TextInput
              label="Secret value"
              type="password"
              value={secretValue}
              onChange={setSecretValue}
              placeholder="stored locally, never shown again"
            />
          </>
        )}

        <Stack direction="horizontal" gap={2}>
          <Button
            label="Discover"
            variant="secondary"
            onClick={doDiscover}
            isDisabled={!canDiscover || busy}
          />
          {result && <Button label="Save source" variant="primary" onClick={doSave} isDisabled={busy} />}
        </Stack>

        {error && <Text color="secondary">⚠ {error}</Text>}

        {result && (
          <Stack gap={3}>
            <Text type="supporting" color="secondary">
              Sampled {result.rowCount} row(s); {result.columns.length} column(s).{" "}
              {result.warnings.join(" ")}
            </Text>
            <Selector
              label="Primary key"
              value={key}
              onChange={setKey}
              options={columnOptions}
            />
            <Selector
              label="Event-time column (watermark / partitions)"
              value={eventTime}
              onChange={setEventTime}
              options={columnOptions}
            />
          </Stack>
        )}
      </Stack>
    </Dialog>
  );
}
