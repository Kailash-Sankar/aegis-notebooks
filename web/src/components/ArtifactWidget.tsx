import { useMemo } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { Widget } from "../types.js";

/**
 * Static, freeform HTML/SVG from the agent (ADR 0004).
 *
 * Security: rendered in a sandboxed iframe with an EMPTY sandbox attribute
 * (scripts, forms, same-origin, navigation all blocked) and a restrictive CSP.
 * This is a static export, not a live widget.
 */
export function ArtifactWidget({ widget }: { widget: Widget }) {
  const srcDoc = useMemo(() => {
    const html = widget.spec.html ?? "<p>Empty artifact</p>";
    const csp =
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;";
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body style="margin:0">${html}</body></html>`;
  }, [widget.spec.html]);

  return (
    <Card padding={0}>
      <Stack
        direction="horizontal"
        gap={2}
        vAlign="center"
        justify="between"
        paddingInline={3}
        paddingBlock={2}
      >
        <Text weight="medium" maxLines={1}>
          {widget.spec.title ?? "Artifact"}
        </Text>
        <Badge label="static" variant="neutral" />
      </Stack>
      <Divider />
      <iframe
        style={{ height: 300, width: "100%", border: 0, background: "#fff" }}
        title={widget.spec.title ?? "artifact"}
        sandbox=""
        srcDoc={srcDoc}
      />
    </Card>
  );
}
