"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import { ShieldAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useQueueChatMessage } from "@/features/conversations/hooks/use-queue-chat-message";

import type { SecurityGateState } from "../hooks/use-security-gate";
import { SCAN_CATEGORIES, describeRule, fixRequestMessage, ruleCategory } from "../scan-project";

interface SecurityScanDialogProps {
  pending: SecurityGateState | null;
  onDismiss: () => void;
}

/** Findings of a pre-export scan, with "Ask agent to fix" and "Continue anyway". */
export const SecurityScanDialog = ({ pending, onDismiss }: SecurityScanDialogProps) => {
  const queueChatMessage = useQueueChatMessage();
  const [acknowledged, setAcknowledged] = useState(false);
  const checkboxId = useId();

  const close = () => {
    setAcknowledged(false);
    onDismiss();
  };

  const askAgent = () => {
    if (!pending) return;
    queueChatMessage(fixRequestMessage(pending.findings));
    toast.success("Asked the agent to fix these");
    close();
  };

  const continueAnyway = () => {
    if (!pending) return;
    close();
    void pending.proceed();
  };

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-4 text-destructive" />
            {pending?.failed ? "Security check didn't run" : "Possible security issues found"}
          </DialogTitle>
          <DialogDescription>
            {pending?.failed
              ? "We couldn't check this project for exposed keys. You can try again later or continue without the check."
              : "This code may expose keys or data to anyone who gets a copy. Fix these before sharing it."}
          </DialogDescription>
        </DialogHeader>

        {pending && pending.findings.length > 0 && (
          <div className="min-h-0 overflow-y-auto flex flex-col gap-3">
            {SCAN_CATEGORIES.map(({ id, title, fix }) => {
              const findings = pending.findings.filter((f) => ruleCategory(f.rule) === id);
              if (findings.length === 0) return null;
              return (
                <section key={id} className="flex flex-col gap-1.5">
                  <h3 className="text-sm font-medium">{title}</h3>
                  <p className="text-xs text-muted-foreground">{fix}</p>
                  <ul className="rounded-md border divide-y text-xs">
                    {findings.map((finding) => (
                      <li
                        key={`${finding.file}:${finding.line}:${finding.rule}`}
                        className="flex flex-col gap-0.5 px-3 py-2"
                      >
                        <span className="font-mono break-all">
                          {finding.line === null ? finding.file : `${finding.file}:${finding.line}`}
                        </span>
                        <span className="text-muted-foreground">{describeRule(finding.rule)}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Checkbox
            id={checkboxId}
            checked={acknowledged}
            onCheckedChange={(checked) => setAcknowledged(checked === true)}
          />
          <Label htmlFor={checkboxId} className="text-xs font-normal">
            I understand the risk and want to continue anyway
          </Label>
        </div>

        <DialogFooter>
          {pending && !pending.failed && (
            <Button variant="outline" onClick={askAgent}>
              Ask agent to fix
            </Button>
          )}
          <Button variant="destructive" disabled={!acknowledged} onClick={continueAnyway}>
            Continue anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
