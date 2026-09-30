import { MessageSquareText, Sparkles, Upload } from "lucide-react";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";

const STEPS = [
  {
    icon: Upload,
    title: "Add data",
    body: "Upload CSV, Parquet, JSON or logs — or drag multiple files at once.",
  },
  {
    icon: Sparkles,
    title: "Run onboarding",
    body: "The agent profiles each dataset, writes workspace memory, and asks questions.",
  },
  {
    icon: MessageSquareText,
    title: "Ask & chart",
    body: "Request analysis or dashboards in chat; widgets appear on the canvas.",
  },
];

export function EmptyState({ needsNotebook }: { needsNotebook: boolean }) {
  return (
    <Center axis="both" width="100%" padding={8}>
      <Stack gap={4} width="100%" maxWidth={520}>
        <Stack gap={1}>
          <Text type="large" weight="semibold">
            {needsNotebook ? "Create a notebook to begin" : "Get started"}
          </Text>
          <Text color="secondary">
            {needsNotebook
              ? "Use the + next to Notebook in the sidebar."
              : "Three steps to your first dashboard."}
          </Text>
        </Stack>
        <Stack gap={3}>
          {STEPS.map((s, i) => (
            <Card key={s.title} padding={3}>
              <Stack direction="horizontal" gap={3} vAlign="start">
                <Card variant="muted" padding={2} width={36} height={36}>
                  <Center axis="both" width="100%" height="100%">
                    <s.icon size={16} />
                  </Center>
                </Card>
                <Stack gap={0}>
                  <Text weight="medium">
                    {i + 1}. {s.title}
                  </Text>
                  <Text type="supporting" color="secondary">
                    {s.body}
                  </Text>
                </Stack>
              </Stack>
            </Card>
          ))}
        </Stack>
      </Stack>
    </Center>
  );
}
