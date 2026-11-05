"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const FAQS = [
  {
    question: "How does in-browser code execution work without a local environment?",
    answer:
      "Every project runs in an isolated cloud microVM sandbox. It executes Node.js, installs npm dependencies, and powers a hot-reloading live preview and interactive terminal entirely in your browser window. You never have to install Node, Docker, or compilers on your local machine.",
  },
  {
    question: "Which AI models are supported, and can I bring my own API keys?",
    answer:
      "Codenaya supports frontier models including Claude Sonnet 5.5, GPT-6.1 Sol, Gemini 3.1 Pro, DeepSeek V4 Pro, and more via OpenRouter. You can use platform credits or bring your own API keys (BYOK) with encrypted storage and zero token markup.",
  },
  {
    question: "How does Firecrawl live documentation grounding work?",
    answer:
      "When your prompt references modern libraries or external APIs, Codenaya uses Firecrawl under the hood to scrape and extract clean, LLM-ready markdown from upstream documentation. This feeds the latest API signatures directly into the agent's context, preventing hallucinations from stale training cutoffs.",
  },
  {
    question: "Can I import an existing GitHub repository to start from?",
    answer:
      "Yes. You can paste any GitHub repository URL to import it directly into Codenaya. The file tree is populated automatically, and you can immediately start prompting the agent to add features, fix bugs, or refactor code.",
  },
  {
    question: "How do I export my project when I am ready?",
    answer:
      "You have complete ownership with zero platform lock-in. You can export your project to a new or existing GitHub repository with one click, or download the entire source code as a standard ZIP archive at any time.",
  },
  {
    question: "Can I develop on an iPad, tablet, or phone?",
    answer:
      "Yes. Because Codenaya executes everything in the cloud sandbox and streams code to the browser, the interface is responsive across tablets, mobile devices, Chromebooks, and low-spec laptops.",
  },
];

export const LandingFAQ = () => {
  return (
    <section aria-label="Frequently asked questions" className="relative py-14 md:py-24 border-t border-border/40">
      <div className="max-w-4xl mx-auto px-6 md:px-8">
        <div className="text-center mb-12 md:mb-16">
          <p className="text-xs uppercase tracking-[0.25em] text-brand-text font-mono mb-4">
            FAQ
          </p>
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-foreground">
            Frequently asked questions
          </h2>
          <p className="mt-4 text-base md:text-lg text-muted-foreground max-w-xl mx-auto">
            Everything you need to know about in-browser development, AI models, and exporting your code.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 md:p-8 shadow-md">
          <Accordion type="single" collapsible className="w-full divide-y divide-border/40">
            {FAQS.map((faq, index) => (
              <AccordionItem key={faq.question} value={`item-${index}`} className="py-2 border-b-0">
                <AccordionTrigger className="text-base font-semibold text-foreground hover:text-brand transition-colors text-left py-4">
                  {faq.question}
                </AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground leading-relaxed pb-4 pt-1">
                  {faq.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </section>
  );
};
