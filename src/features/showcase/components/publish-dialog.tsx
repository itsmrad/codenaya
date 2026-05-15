"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { UploadIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

import {
  TECH_STACK_OPTIONS,
  DESIGN_STYLE_OPTIONS,
  CATEGORY_OPTIONS,
} from "../constants/tags";
import { usePublish, useGenerateUploadUrl } from "../hooks/use-showcase";
import { Id } from "../../../../convex/_generated/dataModel";

interface PublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: Id<"projects">;
  projectName: string;
}

export const PublishDialog = ({
  open,
  onOpenChange,
  projectId,
  projectName,
}: PublishDialogProps) => {
  const publish = usePublish();
  const generateUploadUrl = useGenerateUploadUrl();

  const [title, setTitle] = useState(projectName);
  const [description, setDescription] = useState("");

  // Keep title in sync when projectName loads or dialog opens
  useEffect(() => {
    if (open && projectName) {
      setTitle(projectName);
    }
  }, [open, projectName]);
  const [category, setCategory] = useState("");
  const [techStack, setTechStack] = useState<string[]>([]);
  const [designStyle, setDesignStyle] = useState<string[]>([]);
  const [previewImageId, setPreviewImageId] = useState<Id<"_storage"> | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const toggleTag = (list: string[], setList: (v: string[]) => void, tag: string) => {
    if (list.includes(tag)) {
      setList(list.filter((t) => t !== tag));
    } else {
      setList([...list, tag]);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const url = await generateUploadUrl();
      const result = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const { storageId } = await result.json();
      setPreviewImageId(storageId);
    } catch {
      toast.error("Failed to upload image");
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (!category) {
      toast.error("Please select a category");
      return;
    }

    setSubmitting(true);
    try {
      await publish({
        projectId,
        title: title.trim(),
        description: description.trim(),
        previewImageId: previewImageId ?? undefined,
        techStack,
        designStyle,
        category,
      });
      toast.success("Published to showcase!");
      onOpenChange(false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err) || "Failed to publish";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Publish to Showcase</DialogTitle>
          <DialogDescription>
            Share your project with the community.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="My awesome project"
              maxLength={100}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A short description of your project..."
              rows={3}
              maxLength={280}
            />
            <p className="text-[10px] text-muted-foreground/60 text-right">
              {description.length}/280
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Preview Screenshot
            </label>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border/50 bg-muted/30 text-xs text-muted-foreground hover:bg-muted/50 cursor-pointer transition-colors">
                <UploadIcon className="size-3.5" />
                {previewImageId ? "Replace" : "Upload"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleImageUpload}
                  disabled={uploading}
                />
              </label>
              {previewImageId && (
                <span className="text-xs text-muted-foreground">✓ Uploaded</span>
              )}
              {uploading && (
                <span className="text-xs text-muted-foreground">Uploading...</span>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Category</label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Tech Stack</label>
            <div className="flex flex-wrap gap-1.5">
              {TECH_STACK_OPTIONS.map((tag) => (
                <Badge
                  key={tag}
                  variant={techStack.includes(tag) ? "default" : "outline"}
                  className="cursor-pointer text-[11px] px-2 py-0.5"
                  onClick={() => toggleTag(techStack, setTechStack, tag)}
                >
                  {tag}
                  {techStack.includes(tag) && <XIcon className="size-2.5 ml-1" />}
                </Badge>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Design Style</label>
            <div className="flex flex-wrap gap-1.5">
              {DESIGN_STYLE_OPTIONS.map((tag) => (
                <Badge
                  key={tag}
                  variant={designStyle.includes(tag) ? "default" : "outline"}
                  className="cursor-pointer text-[11px] px-2 py-0.5"
                  onClick={() => toggleTag(designStyle, setDesignStyle, tag)}
                >
                  {tag}
                  {designStyle.includes(tag) && <XIcon className="size-2.5 ml-1" />}
                </Badge>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !title.trim() || !category}
          >
            {submitting ? "Publishing..." : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
