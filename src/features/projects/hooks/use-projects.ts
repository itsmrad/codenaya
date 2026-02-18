/* eslint-disable react-hooks/purity */

import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";

export const useProjects = () => {
	return useQuery(api.projects.get);
};

export const useProjectsPartial = (limit: number) => {
	return useQuery(api.projects.getPartial, {
		limit,
	});
};

export const useCreateProject = () => {
	return useMutation(api.projects.create).withOptimisticUpdate(
		(localStore, args) => {
			const existingProjects = localStore.getQuery(api.projects.get);

			if (existingProjects !== undefined) {
				const now = Date.now();
				const newProject = {
					_id: crypto.randomUUID() as Id<"projects">,
					_creationTime: now,
					updatedAt: now,
					name: args.name,
					ownerId: "annonymous",
				};
				localStore.setQuery(api.projects.get, {}, [
					newProject,
					...existingProjects,
				]);
			}
		},
	);
};
