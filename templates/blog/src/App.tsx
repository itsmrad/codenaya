import { useState, type ReactNode } from "react";
import { Link, Route, Routes, useParams } from "react-router-dom";
import { Search } from "lucide-react";

import { BRAND_NAME } from "./brand";
import { cn } from "./lib/utils";

type Post = {
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  date: string;
  tags: string[];
  sections: { heading: string; text: string }[];
};

const POSTS: Post[] = [
  {
    slug: "small-habits",
    title: "Small habits that make writing easier",
    excerpt: "You don't need a free weekend. You need ten minutes and a place to start.",
    author: "Maya Lin",
    date: "2026-11-02",
    tags: ["Writing", "Habits"],
    sections: [
      { heading: "Start before you're ready", text: "Open the page and write one bad sentence. Momentum beats motivation, and a bad sentence is easy to fix later." },
      { heading: "Keep a running list", text: "Ideas arrive at the wrong time. Keep one note for them, and pick from it when you sit down so you never face a blank page." },
      { heading: "Stop mid-thought", text: "End each session with the next sentence half written. Tomorrow's start becomes effortless." },
    ],
  },
  {
    slug: "reading-slowly",
    title: "In praise of reading slowly",
    excerpt: "Skimming gets you facts. Slow reading gets you ideas that stay.",
    author: "Ben Ortiz",
    date: "2026-10-18",
    tags: ["Reading", "Habits"],
    sections: [
      { heading: "Why slow wins", text: "When you read slowly you notice how an argument is built, not only what it says. That's the part you can borrow." },
      { heading: "A simple method", text: "Read a page, look away, say what it said in one sentence. If you can't, read it again." },
    ],
  },
  {
    slug: "notes-on-tools",
    title: "Notes on choosing tools",
    excerpt: "The best tool is the one you'll still open in three months.",
    author: "Maya Lin",
    date: "2026-09-27",
    tags: ["Tools", "Writing"],
    sections: [
      { heading: "Fewer, plainer tools", text: "Every new app is a new place to lose a thought. A plain text file has survived every trend." },
      { heading: "Test with real work", text: "Use a tool for one real project before you move your life into it." },
      { heading: "Plan for leaving", text: "Pick tools that export to formats you can open anywhere." },
    ],
  },
];
const TAGS = [...new Set(POSTS.flatMap((p) => p.tags))].sort();

const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const minutes = (post: Post) =>
  Math.max(1, Math.round(post.sections.map((s) => s.text).join(" ").split(/\s+/).length / 200));

function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b">
        <nav aria-label="Main" className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4 text-sm">
          <Link to="/" className="text-lg font-semibold">{BRAND_NAME}</Link>
          <div className="flex gap-6">
            <Link to="/" className="text-muted-foreground hover:text-foreground">Posts</Link>
            <Link to="/about" className="text-muted-foreground hover:text-foreground">About</Link>
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">{children}</main>
      <footer className="border-t px-6 py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} {BRAND_NAME}
      </footer>
    </div>
  );
}

function Home() {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const q = query.toLowerCase();
  const shown = POSTS.filter(
    (p) => (!tag || p.tags.includes(tag)) && (p.title.toLowerCase().includes(q) || p.excerpt.toLowerCase().includes(q)),
  );
  return (
    <Layout>
      <h1 className="text-3xl font-semibold tracking-tight">Latest posts</h1>
      <label className="relative mt-6 block">
        <span className="sr-only">Search posts</span>
        <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search posts"
          className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filter by tag">
        {TAGS.map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tag === t}
            onClick={() => setTag(tag === t ? null : t)}
            className={cn("rounded-full border px-3 py-1 text-sm", tag === t && "border-primary bg-primary text-primary-foreground")}
          >
            {t}
          </button>
        ))}
      </div>
      <ul className="mt-8 space-y-4">
        {shown.length === 0 && <li className="py-8 text-center text-muted-foreground">No posts found.</li>}
        {shown.map((post) => (
          <li key={post.slug}>
            <article className="rounded-xl border bg-card p-6">
              <p className="text-xs text-muted-foreground">
                {post.author} · <time dateTime={post.date}>{post.date}</time> · {minutes(post)} min read
              </p>
              <h2 className="mt-2 text-xl font-semibold">
                <Link to={`/post/${post.slug}`} className="hover:text-primary">{post.title}</Link>
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">{post.excerpt}</p>
              <ul className="mt-3 flex gap-2">
                {post.tags.map((t) => <li key={t} className="rounded-full bg-muted px-2 py-0.5 text-xs">{t}</li>)}
              </ul>
            </article>
          </li>
        ))}
      </ul>
    </Layout>
  );
}

function Article() {
  const { slug } = useParams();
  const post = POSTS.find((p) => p.slug === slug);
  if (!post) {
    return (
      <Layout>
        <h1 className="text-2xl font-semibold">Post not found</h1>
        <Link to="/" className="mt-4 inline-block text-primary underline">Back to all posts</Link>
      </Layout>
    );
  }
  return (
    <Layout>
      <article>
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">← All posts</Link>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight">{post.title}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {post.author} · <time dateTime={post.date}>{post.date}</time> · {minutes(post)} min read
        </p>
        <nav aria-label="Table of contents" className="mt-8 rounded-xl border bg-muted/30 p-5 text-sm">
          <p className="font-medium">In this post</p>
          <ol className="mt-2 list-inside list-decimal space-y-1">
            {post.sections.map((s) => (
              <li key={s.heading}><a href={`#${slugify(s.heading)}`} className="text-primary hover:underline">{s.heading}</a></li>
            ))}
          </ol>
        </nav>
        <div className="mt-8 space-y-8 text-lg leading-8">
          {post.sections.map((s) => (
            <section key={s.heading}>
              <h2 id={slugify(s.heading)} className="scroll-mt-6 text-2xl font-semibold tracking-tight">{s.heading}</h2>
              <p className="mt-3 text-muted-foreground">{s.text}</p>
            </section>
          ))}
        </div>
      </article>
    </Layout>
  );
}

function About() {
  return (
    <Layout>
      <h1 className="text-3xl font-semibold tracking-tight">About</h1>
      <p className="mt-4 text-lg leading-8 text-muted-foreground">
        {BRAND_NAME} is a small blog about writing, reading and the tools that get in the way. New posts every couple
        of weeks, no ads and no tracking.
      </p>
    </Layout>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/post/:slug" element={<Article />} />
      <Route path="/about" element={<About />} />
    </Routes>
  );
}
