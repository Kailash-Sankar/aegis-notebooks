import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { Widget } from "../types.js";
import { SandboxedHtml } from "./SandboxedHtml.js";

/** Approximate card chrome (header + divider + body padding) in px. */
const CHROME_HEIGHT = 64;

/**
 * Static, freeform HTML/SVG tile (ADR 0004). Rendered via the shared
 * `SandboxedHtml` iframe; the injected height reporter lets the canvas grow the
 * tile's row when the content would be clipped.
 */
export function ArtifactWidget({
  widget,
  maxHeight,
  onContentHeight,
}: {
  widget: Widget;
  maxHeight?: number;
  onContentHeight?: (id: string, px: number) => void;
}) {
  return (
    <Card padding={0} className="aegis-widget-card" style={{ height: "100%" }}>
      <Stack
        className="aegis-drag-handle"
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
      <div className="aegis-widget-body" style={{ padding: 12 }}>
        <SandboxedHtml
          html={widget.spec.html ?? "<p>Empty artifact</p>"}
          title={widget.spec.title ?? "artifact"}
          allowScripts
          frameHeight={widget.spec.height !== undefined ? widget.spec.height : "100%"}
          onContentHeight={(px) => {
            if (maxHeight !== undefined && px + CHROME_HEIGHT > maxHeight) {
              onContentHeight?.(widget.id, px);
            }
          }}
        />
      </div>
    </Card>
  );
}
