\"use client\";

import { useState, useRef, useEffect } from \"react\";
import { CopyIcon, CheckIcon, SmartphoneIcon, ExternalLinkIcon } from \"lucide-react\";
import { toast } from \"sonner\";

import { Button } from \"@/components/ui/button\";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from \"@/components/ui/popover\";
import { QRCode } from \"./qr-code\";

interface OpenOnPhonePopoverProps {
  previewUrl: string | null;
  status: string;
  activeEngine: string;
}

export const OpenOnPhonePopover = ({
  previewUrl,
  status,
  activeEngine,
}: OpenOnPhonePopoverProps) => {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up any pending copy timeout on unmount
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  // WebContainers run in-browser and have no reachable public host for a phone
  if (activeEngine !== \"sandbox\") {
    return null;
  }

  // Strictly running state: status must be \"running\" and previewUrl must be populated
  const isRunning = status === \"running\" && Boolean(previewUrl);

  const handleCopy = async () => {
    if (!previewUrl) return;
    try {
      await navigator.clipboard.writeText(previewUrl);
      setCopied(true);
      toast.success(\"Preview link copied\");
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
        copyTimeoutRef.current = null;
      }, 2000);
    } catch {
      toast.error(\"Failed to copy link\");
    }
  };

  return (
    <div className=\"hidden @md:inline-flex\">
      <span
        className=\"flex\"
        title={isRunning ? \"Open on phone\" : \"Available once the preview is running\"}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              size=\"icon\"
              variant=\"ghost\"
              className=\"size-8 rounded-md hover:bg-muted\"
              disabled={!isRunning}
              aria-label=\"Open on phone\"
            >
              <SmartphoneIcon className=\"size-4\" />
            </Button>
          </PopoverTrigger>
          {previewUrl && (
            <PopoverContent
              align=\"end\"
              className=\"w-72 p-4 flex flex-col items-center gap-3 bg-popover text-popover-foreground border shadow-lg rounded-xl\"
            >
              <div className=\"w-full flex items-center justify-between text-xs\">
                <span className=\"font-medium flex items-center gap-1.5\">
                  <SmartphoneIcon className=\"size-3.5 text-muted-foreground\" />
                  Open on phone
                </span>
                <span className=\"inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400\">
                  <span className=\"size-1.5 rounded-full bg-emerald-500 animate-pulse\" />
                  Live
                </span>
              </div>

              <div className=\"p-3 bg-white rounded-lg border shadow-xs flex items-center justify-center\">
                <QRCode value={previewUrl} size={150} />
              </div>

              <p className=\"text-[11px] text-muted-foreground text-center leading-relaxed\">
                Live while this project is open on this computer. Changes appear on your phone as you build.
              </p>

              <div className=\"w-full flex items-center gap-1.5 pt-1\">
                <input
                  type=\"text\"
                  readOnly
                  value={previewUrl}
                  className=\"flex-1 min-w-0 h-7 px-2 rounded-md bg-muted/50 border text-[11px] font-mono truncate select-all outline-none\"
                  aria-label=\"Preview URL\"
                />
                <Button
                  size=\"sm\"
                  variant=\"outline\"
                  className=\"h-7 px-2 text-xs shrink-0\"
                  onClick={handleCopy}
                  aria-label={copied ? \"Copied\" : \"Copy preview URL\"}
                >
                  {copied ? (
                    <CheckIcon className=\"size-3.5 text-emerald-600 dark:text-emerald-400\" />
                  ) : (
                    <CopyIcon className=\"size-3.5\" />
                  )}
                </Button>
                <Button
                  asChild
                  size=\"sm\"
                  variant=\"outline\"
                  className=\"size-7 p-0 shrink-0\"
                >
                  <a
                    href={previewUrl}
                    target=\"_blank\"
                    rel=\"noopener noreferrer\"
                    aria-label=\"Open preview in new tab\"
                  >
                    <ExternalLinkIcon className=\"size-3.5\" />
                  </a>
                </Button>
              </div>
            </PopoverContent>
          )}
        </Popover>
      </span>
    </div>
  );
};
