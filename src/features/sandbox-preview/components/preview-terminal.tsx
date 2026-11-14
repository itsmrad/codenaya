"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ArrowDownIcon, CopyIcon, EraserIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { getTerminalTheme } from "@/lib/terminal-theme";

import "@xterm/xterm/css/xterm.css";

interface PreviewTerminalProps {
  output: string;
  /** Hides the current logs; only output after this shows (#480). */
  onClear: () => void;
}

export const PreviewTerminal = ({ output, onClear }: PreviewTerminalProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastLengthRef = useRef(0);
  const { resolvedTheme } = useTheme();
  // Scrolled up from the newest output: offer a way back (#480).
  const [scrolledUp, setScrolledUp] = useState(false);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    const terminal = new Terminal({
      convertEol: true,
      disableStdin: true,
      fontSize: 12,
      lineHeight: 1.35,
      // The editor's IBM Plex Mono, set on <body> by the root layout.
      fontFamily: [getComputedStyle(containerRef.current).getPropertyValue("--font-plex-mono").trim(), "monospace"]
        .filter(Boolean)
        .join(", "),
      allowTransparency: true,
      theme: getTerminalTheme(resolvedTheme),
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    // Sandbox output links ("Server ready at https://…") open in a new tab.
    terminal.loadAddon(
      new WebLinksAddon((_event, uri) => window.open(uri, "_blank", "noopener,noreferrer")),
    );
    terminal.open(containerRef.current);
    terminal.onScroll(() => {
      const { viewportY, baseY } = terminal.buffer.active;
      setScrolledUp(viewportY < baseY);
    });

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
      // reset, not clear: clear keeps the current line on screen (#480).
      terminalRef.current.reset();
      lastLengthRef.current = 0;
    }

    const newData = output.slice(lastLengthRef.current);
    if (newData) {
      terminalRef.current.write(newData);
      lastLengthRef.current = output.length;
    }
  }, [output]);

  // Plain text from xterm's own buffer, so ANSI colour codes stay behind.
  const copy = async () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.selectAll();
    const text = terminal.getSelection();
    terminal.clearSelection();
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Logs copied");
    } catch {
      toast.error("Couldn't copy the logs");
    }
  };

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={containerRef}
        className="size-full p-3 [&_.xterm]:h-full! [&_.xterm-viewport]:h-full! [&_.xterm-viewport]:bg-transparent! [&_.xterm-screen]:h-full! bg-transparent"
      />
      <div className="absolute top-1.5 right-3 flex gap-0.5 rounded-md bg-background/80 backdrop-blur-sm">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Copy logs"
          title="Copy logs"
          className="size-7 text-muted-foreground hover:text-foreground"
          disabled={!output}
          onClick={copy}
        >
          <CopyIcon className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Clear logs"
          title="Clear logs"
          className="size-7 text-muted-foreground hover:text-foreground"
          disabled={!output}
          onClick={onClear}
        >
          <EraserIcon className="size-3.5" />
        </Button>
      </div>
      {scrolledUp && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 right-3 h-7 gap-1 px-2 text-xs shadow-sm"
          onClick={() => terminalRef.current?.scrollToBottom()}
        >
          <ArrowDownIcon className="size-3.5" />
          Jump to latest
        </Button>
      )}
    </div>
  );
};
