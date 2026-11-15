import { useEffect, useRef, useState, type FormEvent } from "react";
import { Route, Routes } from "react-router-dom";
import { Github, Linkedin, Mail, X } from "lucide-react";
import { toast } from "sonner";

import { BRAND_NAME } from "./brand";
import { cn } from "./lib/utils";

const SKILLS = ["Product design", "Prototyping", "Design systems", "User research", "Accessibility"];

type Project = { title: string; category: string; year: string; summary: string };
const PROJECTS: Project[] = [
  { title: "Harbor banking app", category: "Mobile", year: "2026", summary: "A calmer money app: simpler transfers, clearer budgets and a redesigned onboarding that cut drop-off by a third." },
  { title: "Fern plant shop", category: "Web", year: "2025", summary: "An online plant shop with care guides on every product page and a checkout built for one-handed use." },
  { title: "Atlas design system", category: "Systems", year: "2025", summary: "A token-based component library shared by five product teams, with documented accessibility rules." },
  { title: "Tidewater dashboard", category: "Web", year: "2024", summary: "An operations dashboard that turns shipping delays into one prioritised list." },
  { title: "Sprout kids app", category: "Mobile", year: "2024", summary: "A reading app for ages 4 to 7 with big targets, gentle sound and no dark patterns." },
  { title: "Loom brand refresh", category: "Brand", year: "2023", summary: "A new identity, type system and landing page for a small weaving studio." },
];
const CATEGORIES = ["All", ...new Set(PROJECTS.map((p) => p.category))];

const EXPERIENCE = [
  { years: "2024 – now", role: "Senior product designer", place: "Northwind" },
  { years: "2021 – 2024", role: "Product designer", place: "Brightside" },
  { years: "2018 – 2021", role: "UI designer", place: "Studio Kite" },
];

function ProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-title"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-xl border bg-card p-6 shadow-lg"
      >
        <div className="flex items-start justify-between gap-4">
          <h3 id="project-title" className="text-lg font-semibold">{project.title}</h3>
          <button ref={closeRef} type="button" aria-label="Close" onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{project.category} · {project.year}</p>
        <p className="mt-4 text-sm">{project.summary}</p>
      </div>
    </div>
  );
}

function Projects() {
  const [category, setCategory] = useState("All");
  const [open, setOpen] = useState<Project | null>(null);
  const shown = PROJECTS.filter((p) => category === "All" || p.category === category);
  return (
    <section id="work" className="mx-auto max-w-5xl px-6 py-16">
      <h2 className="text-2xl font-semibold tracking-tight">Selected work</h2>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter projects">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={category === c}
            onClick={() => setCategory(c)}
            className={cn("rounded-full border px-3 py-1 text-sm", category === c && "border-primary bg-primary text-primary-foreground")}
          >
            {c}
          </button>
        ))}
      </div>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((project) => (
          <li key={project.title}>
            <button
              type="button"
              onClick={() => setOpen(project)}
              className="w-full rounded-xl border bg-card p-5 text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="text-xs text-muted-foreground">{project.category} · {project.year}</span>
              <span className="mt-2 block font-semibold">{project.title}</span>
              <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">{project.summary}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && <ProjectModal project={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function Contact() {
  const [form, setForm] = useState({ name: "", email: "", message: "" });
  const [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) return setError("Name is required.");
    if (!/^\S+@\S+\.\S+$/.test(form.email)) return setError("Enter a valid email address.");
    if (!form.message.trim()) return setError("Write a short message.");
    setError("");
    toast.success(`Thanks, ${form.name.trim()}! (Demo form: nothing is sent yet.)`);
    setForm({ name: "", email: "", message: "" });
  };
  return (
    <section id="contact" className="bg-muted/50 px-6 py-16">
      <div className="mx-auto max-w-md">
        <h2 className="text-2xl font-semibold tracking-tight">Get in touch</h2>
        <form onSubmit={submit} noValidate className="mt-6 space-y-4">
          {(["name", "email", "message"] as const).map((field) => (
            <label key={field} className="block text-sm capitalize">
              {field}
              {field === "message" ? (
                <textarea
                  rows={4}
                  value={form.message}
                  onChange={(event) => setForm({ ...form, message: event.target.value })}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
                />
              ) : (
                <input
                  type={field === "email" ? "email" : "text"}
                  value={form[field]}
                  onChange={(event) => setForm({ ...form, [field]: event.target.value })}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
                />
              )}
            </label>
          ))}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
            Send message
          </button>
        </form>
      </div>
    </section>
  );
}

function Home() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <nav aria-label="Main" className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4 text-sm">
          <span className="font-semibold">{BRAND_NAME}</span>
          <div className="flex gap-6">
            <a href="#about" className="text-muted-foreground hover:text-foreground">About</a>
            <a href="#work" className="text-muted-foreground hover:text-foreground">Work</a>
            <a href="#contact" className="text-muted-foreground hover:text-foreground">Contact</a>
          </div>
        </nav>
      </header>
      <main>
        <section className="mx-auto max-w-3xl px-6 py-24 text-center">
          <p className="text-sm font-medium text-primary">Product designer</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-6xl">Hi, I'm {BRAND_NAME}</h1>
          <p className="mt-6 text-lg text-muted-foreground">I design simple, accessible products people enjoy using.</p>
          <div className="mt-8 flex justify-center gap-3">
            {[
              { icon: Github, label: "GitHub", href: "https://github.com" },
              { icon: Linkedin, label: "LinkedIn", href: "https://linkedin.com" },
              { icon: Mail, label: "Email", href: "#contact" },
            ].map(({ icon: Icon, label, href }) => (
              <a key={label} href={href} aria-label={label} className="rounded-md border p-2.5 hover:bg-muted">
                <Icon className="size-5" />
              </a>
            ))}
          </div>
        </section>
        <section id="about" className="mx-auto max-w-3xl px-6 py-12">
          <h2 className="text-2xl font-semibold tracking-tight">About</h2>
          <p className="mt-4 text-muted-foreground">
            I've spent eight years turning messy problems into clear interfaces, from banking apps to design systems.
            I like small teams, quick prototypes and testing early with real people.
          </p>
          <ul className="mt-6 flex flex-wrap gap-2">
            {SKILLS.map((skill) => <li key={skill} className="rounded-full bg-muted px-3 py-1 text-sm">{skill}</li>)}
          </ul>
        </section>
        <Projects />
        <section className="mx-auto max-w-3xl px-6 pb-16">
          <h2 className="text-2xl font-semibold tracking-tight">Experience</h2>
          <ol className="mt-6 space-y-6 border-l pl-6">
            {EXPERIENCE.map((job) => (
              <li key={job.role} className="relative">
                <span className="absolute -left-[31px] top-1.5 size-2.5 rounded-full bg-primary" aria-hidden />
                <p className="text-sm text-muted-foreground">{job.years}</p>
                <p className="font-medium">{job.role}, {job.place}</p>
              </li>
            ))}
          </ol>
        </section>
        <Contact />
      </main>
      <footer className="border-t px-6 py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} {BRAND_NAME}
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  );
}
