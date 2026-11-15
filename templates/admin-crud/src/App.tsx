import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Route, Routes } from "react-router-dom";
import { Pencil, Plus, Search, Trash2, Users } from "lucide-react";

import { BRAND_NAME } from "./brand";
import { cn } from "./lib/utils";

type Plan = "Free" | "Pro" | "Team";
type Customer = { id: string; name: string; email: string; plan: Plan; active: boolean; created: string };

const STORAGE_KEY = "customers";
const PAGE_SIZE = 8;
const PLANS: Plan[] = ["Free", "Pro", "Team"];

const SEED: Customer[] = [
  ["Ada Park", "ada@example.com", "Pro"],
  ["Ben Ortiz", "ben@example.com", "Free"],
  ["Chloe Nguyen", "chloe@example.com", "Team"],
  ["Dev Patel", "dev@example.com", "Pro"],
  ["Ella Moreau", "ella@example.com", "Free"],
  ["Finn Larsen", "finn@example.com", "Team"],
  ["Grace Kim", "grace@example.com", "Pro"],
  ["Hugo Silva", "hugo@example.com", "Free"],
  ["Iris Cohen", "iris@example.com", "Pro"],
  ["Jon Bauer", "jon@example.com", "Team"],
].map(([name, email, plan], index) => ({
  id: String(index + 1),
  name,
  email,
  plan: plan as Plan,
  active: index % 4 !== 3,
  created: new Date(2026, 0, 1 + index * 9).toISOString().slice(0, 10),
}));

const loadCustomers = (): Customer[] => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? (JSON.parse(saved) as Customer[]) : SEED;
  } catch {
    return SEED;
  }
};

type Draft = Omit<Customer, "id" | "created">;
const EMPTY_DRAFT: Draft = { name: "", email: "", plan: "Free", active: true };

function CustomerDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: Draft;
  onSave: (draft: Draft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim()) return setError("Name is required.");
    if (!/^\S+@\S+\.\S+$/.test(draft.email)) return setError("Enter a valid email address.");
    onSave({ ...draft, name: draft.name.trim() });
  };
  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Customer"
        onSubmit={submit}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md space-y-4 rounded-xl border bg-card p-6 shadow-lg"
      >
        <h2 className="text-lg font-semibold">{initial.name ? "Edit customer" : "New customer"}</h2>
        <label className="block text-sm">
          Name
          <input
            autoFocus
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <label className="block text-sm">
          Email
          <input
            type="email"
            value={draft.email}
            onChange={(event) => setDraft({ ...draft, email: event.target.value })}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <label className="block text-sm">
          Plan
          <select
            value={draft.plan}
            onChange={(event) => setDraft({ ...draft, plan: event.target.value as Plan })}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2"
          >
            {PLANS.map((plan) => <option key={plan}>{plan}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(event) => setDraft({ ...draft, active: event.target.checked })}
          />
          Active
        </label>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-2 text-sm">Cancel</button>
          <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

function Customers() {
  const [customers, setCustomers] = useState<Customer[]>(loadCustomers);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "created">("name");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Customer | "new" | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(customers));
    } catch {
      // Without storage the list just isn't kept across reloads.
    }
  }, [customers]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return customers
      .filter((c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
      .sort((a, b) => a[sortBy].localeCompare(b[sortBy]));
  }, [customers, query, sortBy]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Deletes and edits can shrink the list under the current page.
  const currentPage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const save = (draft: Draft) => {
    setCustomers((list) =>
      editing === "new"
        ? [...list, { ...draft, id: crypto.randomUUID(), created: new Date().toISOString().slice(0, 10) }]
        : list.map((c) => (editing && c.id === editing.id ? { ...c, ...draft } : c)),
    );
    setEditing(null);
  };
  const remove = (ids: string[]) => {
    if (!confirm(`Delete ${ids.length} customer${ids.length === 1 ? "" : "s"}?`)) return;
    setCustomers((list) => list.filter((c) => !ids.includes(c.id)));
    setSelected(new Set());
  };
  const toggle = (id: string) =>
    setSelected((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <main className="flex-1 p-4 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
        <div className="flex gap-2">
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => remove([...selected])}
              className="rounded-md border px-3 py-2 text-sm text-destructive"
            >
              Delete {selected.size}
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            <Plus className="size-4" /> New customer
          </button>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <label className="relative flex-1 min-w-48">
          <span className="sr-only">Search customers</span>
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            placeholder="Search by name or email"
            className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <select
          aria-label="Sort by"
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value as "name" | "created")}
          className="rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="name">Sort by name</option>
          <option value="created">Sort by created</option>
        </select>
      </div>
      <div className="mt-4 overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="w-10 p-3" />
              <th className="p-3 font-medium">Name</th>
              <th className="p-3 font-medium">Email</th>
              <th className="p-3 font-medium">Plan</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium">Created</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-8 text-center text-muted-foreground">No customers found.</td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="p-3">
                  <input
                    type="checkbox"
                    aria-label={`Select ${c.name}`}
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                </td>
                <td className="p-3 font-medium">{c.name}</td>
                <td className="p-3 text-muted-foreground">{c.email}</td>
                <td className="p-3">{c.plan}</td>
                <td className="p-3">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs",
                      c.active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {c.active ? "Active" : "Paused"}
                  </span>
                </td>
                <td className="p-3 text-muted-foreground">{c.created}</td>
                <td className="p-3">
                  <div className="flex justify-end gap-1">
                    <button type="button" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)} className="rounded p-1.5 hover:bg-muted">
                      <Pencil className="size-4" />
                    </button>
                    <button type="button" aria-label={`Delete ${c.name}`} onClick={() => remove([c.id])} className="rounded p-1.5 hover:bg-muted">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
        <span>{filtered.length} customers</span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="rounded-md border px-3 py-1 disabled:opacity-50">
            Previous
          </button>
          <span>{currentPage + 1} / {pageCount}</span>
          <button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)} className="rounded-md border px-3 py-1 disabled:opacity-50">
            Next
          </button>
        </div>
      </div>
      {editing && (
        <CustomerDialog
          // Each edit starts from its own customer's draft.
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? EMPTY_DRAFT : editing}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </main>
  );
}

function Layout() {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b bg-muted/30 p-4 md:w-56 md:border-b-0 md:border-r">
        <p className="flex items-center gap-2 font-semibold">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            {BRAND_NAME.charAt(0)}
          </span>
          {BRAND_NAME}
        </p>
        <nav className="mt-4 text-sm">
          <a href="/" className="flex items-center gap-2 rounded-md bg-primary/10 px-3 py-2 font-medium text-primary">
            <Users className="size-4" /> Customers
          </a>
        </nav>
      </aside>
      <Customers />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />} />
    </Routes>
  );
}
