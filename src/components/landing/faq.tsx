"use client";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { SectionHeader } from "./section-header";

const QUESTIONS = [
  {
    q: "What is Codenaya?",
    a: "A browser IDE with an AI agent. Describe what you want to build, the agent writes the code, and your app runs in a live preview. Export it to GitHub or download a ZIP when it's ready.",
  },
  {
    q: "Do I need to install anything?",
    a: "No. Each project runs in a cloud sandbox with a preview and a terminal, so all you need is a browser, on desktop or phone.",
  },
  {
    q: "Which models can the agent use?",
    a: "Claude, GPT, Gemini, Grok, DeepSeek, Qwen and more. You can switch models at any time.",
  },
  {
    q: "Is it free?",
    a: "Yes. The Free plan includes 300 credits a month. A credit is $0.01 of AI usage, and each run costs credits based on the model and how much work it does.",
  },
  {
    q: "Can I use my own API key?",
    a: "Yes. Add an OpenRouter, OpenAI, Anthropic or Groq key, or any OpenAI-compatible endpoint, in Settings. Runs on your key use no credits and have no daily limit, on every plan.",
  },
  {
    q: "Can I start from an existing repo?",
    a: "Yes. Import any GitHub repository to start a project from it, and export your work to a new repository when you're done.",
  },
  {
    q: "Who owns the code?",
    a: "You do. Export it to your own GitHub repository or download the full source as a ZIP whenever you want.",
  },
  {
    q: "What happens if my key stops working?",
    a: "The run stops with a clear error. Codenaya never switches to your credits without asking.",
  },
];

export const LandingFaq = () => (
  <section className="border-b border-border">
    <div className="grid lg:grid-cols-[2fr_3fr]">
      <div className="border-border lg:border-r">
        <SectionHeader
          index={5}
          label="FAQ"
          title="Before your"
          accent="first prompt"
        />
      </div>
      <div className="border-border max-lg:border-t">
        {/* Continues the label bar's line across this column */}
        <div aria-hidden className="hidden h-11 border-b border-border lg:block" />
        <Accordion type="single" collapsible>
          {QUESTIONS.map(({ q, a }, i) => (
            <AccordionItem key={q} value={q} className="border-border px-6 md:px-8">
              <AccordionTrigger className="gap-4 py-5 text-[15px] font-medium hover:no-underline">
                <span className="flex gap-4">
                  <span className="font-mono text-[11px] leading-6 text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                  {q}
                </span>
              </AccordionTrigger>
              <AccordionContent className="pl-9 text-[15px] leading-relaxed text-muted-foreground">{a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </div>
  </section>
);
