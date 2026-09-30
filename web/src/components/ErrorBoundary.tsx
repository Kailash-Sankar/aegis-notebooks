import { Component, type ReactNode } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Text } from "@astryxdesign/core/Text";

/**
 * Keeps one bad widget (or any render error) from taking down the app.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <Card variant="red" padding={3}>
          <Text type="supporting">
            {(this.props.label ?? "Something") + " failed to render"} —{" "}
            {this.state.error.message}
          </Text>
        </Card>
      );
    }
    return this.props.children;
  }
}
