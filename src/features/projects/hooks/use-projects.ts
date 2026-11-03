/* eslint-disable react-hooks/purity */

import { useMutation, useQuery } from "convex/react";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

export const useProject = (projectId: Id<"projects">) => {
  return useQuery(api.projects.getById, { id: projectId });
};

/** Agent runs not pushed to the linked GitHub repo yet (#343). */
export const useUnpushedRuns = (projectId: Id<"projects">) => {
  return useQuery(api.githubSync.unpushedRuns, { projectId });
};

export const useProjects = () => {
  return useQuery(api.projects.get);
};

export const useRenameProject = () => {
  return useMutation(api.projects.rename).withOptimisticUpdate(
    (localStore, args) => {
      const existingProject = localStore.getQuery(
        api.projects.getById,
        { id: args.id }
      );

      if (existingProject !== undefined  && existingProject !== null) {
        localStore.setQuery(
          api.projects.getById,
          { id: args.id },
          {
            ...existingProject,
            name: args.name,
            updatedAt: Date.now(),
          }
        );
      }

      const existingProjects = localStore.getQuery(api.projects.get);

      if (existingProjects !== undefined) {
        localStore.setQuery(
          api.projects.get,
          {},
          existingProjects.map((project) => {
            return project._id === args.id
              ? { ...project, name: args.name, updatedAt: Date.now() }
              : project
          })
        );
      }
    }
  )
};

export const useUpdateProjectSettings = () => {
  return useMutation(api.projects.updateSettings);
};

export const useUpdateProjectInstructions = () => {
  return useMutation(api.projects.updateInstructions);
};

export const useDuplicateProject = () => {
  return useMutation(api.projects.duplicate);
};

/** Removes the project from the lists right away; the server hides it too. */
export const useRemoveProject = () => {
  return useMutation(api.projects.remove).withOptimisticUpdate(
    (localStore, args) => {
      const existingProjects = localStore.getQuery(api.projects.get);

      if (existingProjects !== undefined) {
        localStore.setQuery(
          api.projects.get,
          {},
          existingProjects.filter((project) => project._id !== args.id)
        );
      }

      for (const { args: queryArgs, value } of localStore.getAllQueries(
        api.projects.getPartial
      )) {
        if (value !== undefined) {
          localStore.setQuery(
            api.projects.getPartial,
            queryArgs,
            value.filter((project) => project._id !== args.id)
          );
        }
      }
    }
  );
};
