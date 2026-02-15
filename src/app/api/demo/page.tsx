"use client";

import { Button } from "@/components/ui/button";
import React, { useState } from "react";

export default function Page() {
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
		</div>
	);
}
