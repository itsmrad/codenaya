"use client";

import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useTheme } from "next-themes";

import { getTerminalTheme } from "@/lib/terminal-theme";
import { normalizeBufferText } from "@/features/sandbox-preview/utils/log-viewer";

import "@xterm/xterm/css/xterm.css";

export interface PreviewTerminalHandle {
  copyLogs: () => Promise<boolean>;
  clear: () => void;
  scrollToBottom: () => void;
  getBufferText: () => string;
}

interface PreviewTerminalProps {
  output: string;
  onScrolledUpChange?: (isScrolledUp: boolean) => void;
}

export const PreviewTerminal = forwardRef<PreviewTerminalHandle, PreviewTerminalProps>(
  ({ output, onScrolledUpChange }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const lastLengthRef = useRef(0);
    const { resolvedTheme } = useTheme();

    const getBufferText = () => {
      if (!terminalRef.current) return "";
      const buffer = terminalRef.current.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) {
          lines.push(line.translateToString(true));
        }
      }
      return normalizeBufferText(lines);
    };

    useImperativeHandle(ref, () => ({
      copyLogs: async () => {
        const text = getBufferText();
        if (!text) return false;
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          return false;
        }
      },
      clear: () => {
        if (!terminalRef.current) return;
        terminalRef.current.clear();
        lastLengthRef.current = 0;
      },
      scrollToBottom: () => {
        if (!terminalRef.current) return;
        terminalRef.current.scrollToBottom();
        onScrolledUpChange?.(false);
      },
      getBufferText,
    }));

    // Initialize terminal
    useEffect(() => {
      if (!containerRef.current || terminalRef.current) return;

      const terminal = new Terminal({
        convertEol: true,
        disableStdin: true,
        fontSize: 12,
        fontFamily: 'var(--font-plex-mono), var(--font-nerd-mono), "IBM Plex Mono", monospace',
        lineHeight: 1.35,
        allowTransparency: true,
        theme: getTerminalTheme(resolvedTheme),
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      const webLinksAddon = new WebLinksAddon((_event, uri) => {
        window.open(uri, "_blank", "noopener,noreferrer");
      });
      terminal.loadAddon(webLinksAddon);

      terminal.open(containerRef.current);

      const updateScrollState = () => {
        if (!terminalRef.current) return;
        const buffer = terminalRef.current.buffer.active;
        const isScrolledUp = buffer.viewportY < buffer.baseY;
        onScrolledUpChange?.(isScrolledUp);
      };

      const scrollDisposable = terminal.onScroll(updateScrollState);
      const lineFeedDisposable = terminal.onLineFeed(updateScrollState);

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // Write existing output on mount
      if (output) {
        terminal.write(output);
        lastLengthRef.current = output.length;
      }

      requestAnimationFrame(() => fitAddon.fit());

      const resizeObserver = new ResizeObserver(() => fitAddon.fit());
      resizeObserver.observe(containerRef.current);

      return () => {
        scrollDisposable.dispose();
        lineFeedDisposable.dispose();
        resizeObserver.disconnect();
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- output and resolvedTheme are only read on mount; the effects below follow later changes
    }, []);

    // Follow theme changes on the open terminal
    useEffect(() => {
      if (!terminalRef.current) return;
      terminalRef.current.options.theme = getTerminalTheme(resolvedTheme);
    }, [resolvedTheme]);

    // Write output
    useEffect(() => {
      if (!terminalRef.current) return;

      if (output.length < lastLengthRef.current) {
        terminalRef.current.clear();
        lastLengthRef.current = 0;
      }

      const newData = output.slice(lastLengthRef.current);
      if (newData) {
        terminalRef.current.write(newData);
        lastLengthRef.current = output.length;
      }
    }, [output]);

    return (
      <div
        ref={containerRef}
        className="flex-1 min-h-0 p-3 [&_.xterm]:h-full! [&_.xterm-viewport]:h-full! [&_.xterm-viewport]:bg-transparent! [&_.xterm-screen]:h-full! bg-transparent"
      />
    );
  }
);

PreviewTerminal.displayName = "PreviewTerminal";
