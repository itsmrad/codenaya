import { useEffect, useState } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

export type ShowcaseSort = "newest" | "upvotes" | "imports" | "week";

export type ShowcaseFilters = {
  category?: string;
  techStack?: string[];
  designStyle?: string[];
};

const FEED_PAGE_SIZE = 12;

/**
 * The paginated showcase feed: title search (best match first) for queries of
 * 2+ characters, otherwise every published project in `sortBy` order.
 */
export const useShowcaseFeed = ({
  search,
  sortBy,
  now,
  ...filters
}: ShowcaseFilters & { search: string; sortBy: ShowcaseSort; now?: number }) => {
  const query = search.trim();
  const searching = query.length >= 2;
  const list = usePaginatedQuery(
    api.showcase.list,
    searching ? "skip" : { sortBy, ...(sortBy === "week" ? { now } : {}), ...filters },
    { initialNumItems: FEED_PAGE_SIZE }
  );
  const results = usePaginatedQuery(
    api.showcase.search,
    searching ? { query, ...filters } : "skip",
    { initialNumItems: FEED_PAGE_SIZE }
  );
  const feed = searching ? results : list;
  return { ...feed, loadMore: () => feed.loadMore(FEED_PAGE_SIZE), searching };
};

/** Refresh the rolling window even when no new events arrive. */
export const useShowcaseRankingTime = () => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
};

export const useShowcaseTopCreators = (now: number) =>
  useQuery(api.showcase.getTopCreators, { now, limit: 5 });

export const useShowcaseById = (id: Id<"showcaseProjects"> | undefined) => {
  return useQuery(api.showcase.getById, id ? { id } : "skip");
};

export const useUserVote = (showcaseProjectId: Id<"showcaseProjects"> | undefined) => {
  return useQuery(
    api.showcase.getUserVote,
    showcaseProjectId ? { showcaseProjectId } : "skip"
  );
};

export const useShowcaseTrending = (limit?: number) => {
  return useQuery(api.showcase.getTrending, { limit });
};

export const useIsProjectPublished = (projectId: Id<"projects">) => {
  return useQuery(api.showcase.isProjectPublished, { projectId });
};

export const usePublish = () => {
  return useMutation(api.showcase.publish);
};

export const useUnpublish = () => {
  return useMutation(api.showcase.unpublish);
};

export const useVote = () => {
  return useMutation(api.showcase.vote);
};

export const useImportToWorkspace = () => {
  return useMutation(api.showcase.importToWorkspace);
};

export const useIncrementView = () => {
  return useMutation(api.showcase.incrementView);
};

export const useGenerateUploadUrl = () => {
  return useMutation(api.showcase.generateUploadUrl);
};
