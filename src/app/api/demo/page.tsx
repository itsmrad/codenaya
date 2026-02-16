"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import React, { useState } from "react";
import { useAuth } from "@clerk/nextjs";

export default function Page() {
	const { userId } = useAuth();
	const [loading, setLoading] = useState(false);
	const [backgroundLoading, setBackgroundLoading] = useState(false);
	const [result, setResult] = useState<string>("");

	const handleClick = async () => {
		setLoading(true);
		try {
			const response = await fetch("/api/demo/blocking", {
				method: "POST",
			});
			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`API Error: ${response.status} ${errorText}`);
			}
			const data = await response.json();
			console.log("Received data:", data);
			console.log("Text property:", data.text);
			setResult(data.text);
		} catch (error) {
			console.error("Fetch error:", error);
			setResult(error instanceof Error ? error.message : "Error fetching data");
		} finally {
			setLoading(false);
		}
	};

	const handleBackground = async () => {
		setBackgroundLoading(true);
		try {
			const response = await fetch("/api/demo/background", {
				method: "POST",
			});
			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`API Error: ${response.status} ${errorText}`);
			}
			const data = await response.json();
			setResult(
				`Background job ${data.status}! Check your Inngest dashboard or terminal for progress.`,
			);
		} catch (error) {
			console.error("Fetch error:", error);
			setResult(error instanceof Error ? error.message : "Error fetching data");
		} finally {
			setBackgroundLoading(false);
		}
	};

	const handleClientError = async () => {
		Sentry.logger.info("User is attempting to click on the client function", {
			userId: String(userId ?? "unknown"),
		});
		throw new Error("Client Error Something went wrong in the browser");
	};

	const handleApiError = async () => {
		Sentry.logger.info("User is attempting to click on the api function", {
			userId: String(userId ?? "unknown"),
		});
		await fetch("/api/demo/error", { method: "POST" });
	};
	const handleInngestError = async () => {
		await fetch("/api/demo/inngest-error", { method: "POST" });
	};

	return (
		<div className="flex flex-col gap-4 justify-center items-center w-full h-screen">
			<div className="p-4 rounded-lg w-96 min-h-32">
				{loading || backgroundLoading
					? "Loading..."
					: result || "Click a button to generate text"}
			</div>
			<Button
				onClick={handleClick}
				disabled={loading}>
				{loading ? "Generating..." : "Generate Text"}
			</Button>
			<Button
				onClick={handleBackground}
				disabled={backgroundLoading}>
				{backgroundLoading ? "Generating..." : "Background"}
			</Button>

			<Button
				onClick={handleClientError}
				variant={"destructive"}>
				Client Error
			</Button>

			<Button
				onClick={handleApiError}
				variant={"destructive"}>
				API Error
			</Button>

			<Button
				onClick={handleInngestError}
				variant={"destructive"}>
				Inngest Error
			</Button>
		</div>
	);
}
