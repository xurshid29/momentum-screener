import { App } from 'antd';
import type { CSSProperties, ReactNode } from 'react';

interface Props {
  ticker: string;
  onSelect?: (ticker: string) => void;
  // Stop the click from bubbling to a parent (e.g. a row onClick that selects).
  // The component already handles selection internally via `onSelect`, so the
  // caller can keep them isolated.
  stopPropagation?: boolean;
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
}

// Renders a ticker as a clickable text. On click: copies the symbol to the
// clipboard, fires onSelect, and surfaces a brief toast confirmation.
export function TickerLink({ ticker, onSelect, stopPropagation, style, className, children }: Props) {
  const { message } = App.useApp();

  async function handleClick(e: React.MouseEvent) {
    if (stopPropagation) e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(ticker);
      message.success({ content: `Copied ${ticker}`, duration: 1.2 });
    } catch {
      // Clipboard API can fail on insecure origins or denied permission.
      message.error({ content: `Failed to copy ${ticker}`, duration: 1.5 });
    }
    onSelect?.(ticker);
  }

  return (
    <a
      onClick={handleClick}
      className={className}
      style={{ cursor: 'pointer', ...style }}
    >
      {children ?? ticker}
    </a>
  );
}
