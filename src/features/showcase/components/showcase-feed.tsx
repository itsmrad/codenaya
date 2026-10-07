"use client";

import { useState } from "react";
import { Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import { Doc } from "../../../../convex/_generated/dataModel";
import { useShowcaseTrending } from "../hooks/use-showcase";
import { showcasePath } from "../hooks/use-remix";
import {
  TECH_STACK_OPTIONS,
  DESIGN_STYLE_OPTIONS,
  CATEGORY_OPTIONS,
} from "../constants/tags";
import { ShowcaseCard } from "./showcase-card";

type ShowcaseProject = Doc<"showcaseProjects"> & { previewUrl: string | null };
type SortBy = "newest" | "upvotes" | "imports";

/** The full community showcase: search, sort, tag filters and a card grid. */
export const ShowcaseFeed = () => {
  const [showcaseSearch, setShowcaseSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  const [selectedCategory, setSelectedCategory] = useState<string | undefined>(undefined);
  const [selectedTech, setSelectedTech] = useState<string[]>([]);
  const [selectedDesign, setSelectedDesign] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  const trending = useShowcaseTrending(30);

  // Client-side filtering
  const filteredProjects = (trending ?? []).filter((project) => {
    if (showcaseSearch.length >= 2) {
      const q = showcaseSearch.toLowerCase();
      if (!project.title.toLowerCase().includes(q)) return false;
    }
    if (selectedCategory && project.category !== selectedCategory) return false;
    if (selectedTech.length > 0) {
      if (!selectedTech.some((t) => project.techStack.includes(t))) return false;
    }
    if (selectedDesign.length > 0) {
      if (!selectedDesign.some((d) => project.designStyle.includes(d))) return false;
    }
    return true;
  });

  // Sort
  const sortedProjects = [...filteredProjects].sort((a, b) => {
    if (sortBy === "upvotes") return b.upvotes - a.upvotes;
    if (sortBy === "imports") return b.importCount - a.importCount;
    return b.publishedAt - a.publishedAt;
  });

  const hasActiveFilters = selectedCategory || selectedTech.length > 0 || selectedDesign.length > 0;

  return (
    <>
      <div>
        {/* Header + Search + Sort */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4">
          <div className="relative w-full sm:w-auto sm:flex-1 sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
            <input
              type="text"
              placeholder="Search showcase..."
              value={showcaseSearch}
              onChange={(e) => setShowcaseSearch(e.target.value)}
              className="w-full h-8 pl-8 pr-3 rounded-lg bg-muted/30 border border-border/40 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-brand/30 focus:border-brand/40 transition-all"
            />
          </div>

          {/* Sort */}
          <div className="flex items-center p-0.5 bg-muted/30 rounded-lg border border-border/40">
            {(["newest", "upvotes", "imports"] as SortBy[]).map((s) => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${
                  sortBy === s
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {s === "newest" ? "New" : s === "upvotes" ? "Top" : "Popular"}
              </button>
            ))}
          </div>

          {/* Filter toggle */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`h-8 px-2.5 rounded-lg border text-[11px] font-medium transition-colors ${
              showFilters || hasActiveFilters
                ? "border-brand/40 text-brand bg-brand/5"
                : "border-border/40 text-muted-foreground hover:text-foreground"
            }`}
          >
            Filters{hasActiveFilters ? " ●" : ""}
          </button>
        </div>

        {/* Filter panel */}
        {showFilters && (
          <div className="mb-4 p-3 rounded-xl border border-border/40 bg-card/50 space-y-3">
            {/* Category */}
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Category</p>
              <div className="flex flex-wrap gap-1">
                {CATEGORY_OPTIONS.map((cat) => (
                  <Badge
                    key={cat.value}
                    variant={selectedCategory === cat.value ? "default" : "outline"}
                    className="cursor-pointer text-[10px] px-2 py-0"
                    onClick={() => setSelectedCategory(selectedCategory === cat.value ? undefined : cat.value)}
                  >
                    {cat.label}
                  </Badge>
                ))}
              </div>
            </div>
            {/* Tech */}
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Tech Stack</p>
              <div className="flex flex-wrap gap-1">
                {TECH_STACK_OPTIONS.map((tag) => (
                  <Badge
                    key={tag}
                    variant={selectedTech.includes(tag) ? "default" : "outline"}
                    className="cursor-pointer text-[10px] px-2 py-0"
                    onClick={() => setSelectedTech((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])}
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
            {/* Design */}
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Design Style</p>
              <div className="flex flex-wrap gap-1">
                {DESIGN_STYLE_OPTIONS.map((tag) => (
                  <Badge
                    key={tag}
                    variant={selectedDesign.includes(tag) ? "default" : "outline"}
                    className="cursor-pointer text-[10px] px-2 py-0"
                    onClick={() => setSelectedDesign((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])}
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
            {hasActiveFilters && (
              <button
                onClick={() => { setSelectedCategory(undefined); setSelectedTech([]); setSelectedDesign([]); }}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear all
              </button>
            )}
          </div>
        )}

        {/* Grid */}
        {sortedProjects.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-muted-foreground/50">
              {trending === undefined
                ? "Loading..."
                : trending.length === 0
                  ? "No showcase projects yet. Be the first to publish!"
                  : "No projects match your filters"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedProjects.map((project) => (
              <ShowcaseCard
                key={project._id}
                project={project as ShowcaseProject}
                href={showcasePath(project._id)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
};
