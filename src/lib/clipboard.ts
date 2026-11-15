import { toast } from "sonner";

/** Copies `text` and confirms with a toast, or reports that it couldn't. */
export const copyToClipboard = async (text: string, success: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(success);
  } catch {
    toast.error("Couldn't copy to the clipboard");
  }
};
