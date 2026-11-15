"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronDownIcon, ExternalLinkIcon, EyeOffIcon, RocketIcon } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { convexErrorMessage } from "@/lib/convex-error";

import { useUnpublish } from "../hooks/use-showcase";
import { Id } from "../../../../convex/_generated/dataModel";

/** The IDE navbar's "Published" control: a link to the showcase entry, and Unpublish behind a confirm. */
export const PublishedMenu = ({
  showcaseId,
  className,
  trigger,
}: {
  showcaseId: Id<"showcaseProjects">;
  className?: string;
  trigger?: React.ReactNode;
}) => {
  const unpublish = useUnpublish();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleUnpublish = async () => {
    try {
      await unpublish({ id: showcaseId });
      toast.success("Removed from the showcase");
    } catch (err: unknown) {
      toast.error(convexErrorMessage(err, "Failed to unpublish"));
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? <button aria-label="Published" title="Published" className={className}>
            <RocketIcon aria-hidden="true" className="size-3.5 text-brand" />
            <span className="hidden @3xl:inline">Published</span>
            <ChevronDownIcon aria-hidden="true" className="hidden @3xl:block size-3" />
          </button>}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem asChild>
            <Link href={`/showcase/${showcaseId}`}>
              <ExternalLinkIcon />
              View in showcase
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmOpen(true)}>
            <EyeOffIcon />
            Unpublish
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unpublish this project?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves the showcase and its page stops working. You can publish it
              again later; its votes are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={handleUnpublish}
            >
              Unpublish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
