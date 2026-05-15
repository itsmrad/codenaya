import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

export const useShowcaseList = (opts: {
  category?: string;
  sortBy?: "newest" | "upvotes" | "imports";
}) => {
  return usePaginatedQuery(
    api.showcase.list,
    {
      category: opts.category,
      sortBy: opts.sortBy,
    },
    { initialNumItems: 12 }
  );
};

export const useShowcaseSearch = (query: string) => {
  return useQuery(
    api.showcase.search,
    query.length >= 2 ? { query, limit: 20 } : "skip"
  );
};

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
