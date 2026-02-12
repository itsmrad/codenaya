"use client";

import Image from "next/image";
import { useMutation, useQuery } from "convex/react";
import { api } from "convex/_generated/api";
import { Button } from "@/components/ui/button";

export default function Home() {
  const projects = useQuery(api.projects.get)
  const createMutation = useMutation(api.projects.create)

	return (
		<main className="flex min-h-screen flex-col items-center justify-between p-24">
      <Button onClick={async () => {
        await createMutation({
          name: "New Project"
        })
      }}>
        Create Project
      </Button>

			{projects?.map((project) => (
        <div key={project._id} className="flex flex-col border rounded p-2">
          <p>{project.name}</p>
          <p>Owner Id: {project.ownerId}</p>
        </div>
      ))}
		</main>
	);
}
