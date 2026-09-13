"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  messageId: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Per-message crash isolation. Before this existed, the app had zero
 * Error Boundaries anywhere — an uncaught exception thrown while
 * rendering any single message bubble (e.g. a malformed `metadata`
 * shape, a thumbnail resolution edge case) unmounted the *entire*
 * React tree, which is the leading candidate for the "tela branca"
 * reported when two video messages land in the same render pass (see
 * the video-pipeline investigation). Scoped to one `MessageRow` at a
 * time — the worst case is now one bubble showing a fallback instead
 * of the whole conversation going blank.
 */
export class MessageErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`[message-error-boundary] message ${this.props.messageId} failed to render:`, error);
  }

  componentDidUpdate(prevProps: Props) {
    // A message row is recycled by id (memoized list), not remounted —
    // if the underlying message object changes (e.g. a retry), give it
    // a fresh chance instead of staying stuck on the fallback forever.
    if (this.state.hasError && prevProps.messageId !== this.props.messageId) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Não foi possível exibir esta mensagem.
        </div>
      );
    }
    return this.props.children;
  }
}
