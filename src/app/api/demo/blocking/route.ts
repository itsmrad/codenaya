// localhost:3000/api/demo/blocking
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

export async function POST() {
	try {
		const response = await generateText({
			model: openai("gpt-3.5-turbo"),
			prompt:
				"Greet me say blocking and write a poem on pigeon love",
			experimental_telemetry: {
				isEnabled: true,
				recordInputs: true,
				recordOutputs: true,
			},
		});

		console.log("AI Response:", response.text);
		return Response.json(response);
	} catch (error) {
		console.error("AI Generation Error:", error);
		return Response.json(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			{ status: 500 },
		);
	}
}
