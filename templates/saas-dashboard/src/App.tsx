import { useMemo, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { ArrowDownRight, ArrowUpRight, LayoutDashboard, Menu, Search, ShoppingCart, Users } from "lucide-react";

import { BRAND_NAME } from "./brand";
import { cn } from "./lib/utils";

const KPIS = [
  { label: "Revenue", value: "$48,230", change: 12.4 },
  { label: "Users", value: "3,482", change: 8.1 },
  { label: "Conversion", value: "3.2%", change: 0.6 },
  { label: "Churn", value: "1.9%", change: -0.4 },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const REVENUE = [21, 24, 23, 29, 31, 30, 36, 39, 38, 43, 46, 48];
const SIGNUPS = [120, 150, 140, 190, 210, 180, 240, 260, 250, 310, 330, 360];

type Status = "Paid" | "Pending" | "Refunded";
type Order = { id: string; customer: string; amount: number; status: Status; date: string };

const ORDERS: Order[] = [
  ["Ada Park", 129, "Paid"],
  ["Ben Ortiz", 49, "Pending"],
  ["Chloe Nguyen", 299, "Paid"],
  ["Dev Patel", 79, "Refunded"],
  ["Ella Moreau", 149, "Paid"],
  ["Finn Larsen", 19, "Pending"],
  ["Grace Kim", 249, "Paid"],
  ["Hugo Silva", 59, "Paid"],
  ["Iris Cohen", 99, "Pending"],
  ["Jon Bauer", 189, "Refunded"],
  ["Kai Tanaka", 39, "Paid"],
  ["Lena Weber", 119, "Paid"],
].map(([customer, amount, status], index) => ({
  id: `#${1040 + index}`,
  customer: customer as string,
  amount: amount as number,
  status: status as Status,
  date: new Date(2026, 10, 12 - index).toISOString().slice(0, 10),
}));

const PAGE_SIZE = 5;
type SortKey = "customer" | "amount" | "date";
const STATUS_STYLE: Record<Status, string> = {
  Paid: "bg-primary/15 text-primary",
  Pending: "bg-muted text-muted-foreground",
  Refunded: "bg-destructive/15 text-destructive",
};

function Kpi({ label, value, change }: (typeof KPIS)[number]) {
  const up = change >= 0;
  // Churn going down is good news, so the colour follows the metric, not the sign.
  const good = label === "Churn" ? !up : up;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="rounded-xl border bg-card p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      <span
        className={cn(
          "mt-3 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
          good ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive",
        )}
      >
        <Arrow className="size-3" aria-hidden /> {Math.abs(change)}%
        <span className="sr-only"> {up ? "up" : "down"} from last month</span>
      </span>
    </div>
  );
}

// shortcut: hand-drawn SVG charts keep the template dependency-free; add a chart library when the data gets real.
function RevenueChart() {
  const max = Math.max(...REVENUE);
  const points = REVENUE.map((v, i) => `${(i / (REVENUE.length - 1)) * 300},${100 - (v / max) * 90}`).join(" ");
  return (
    <figure className="rounded-xl border bg-card p-5">
      <figcaption className="font-medium">Revenue ($k, 2026)</figcaption>
      <svg
        viewBox="0 0 300 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Monthly revenue rising from $${REVENUE[0]}k in ${MONTHS[0]} to $${REVENUE.at(-1)}k in ${MONTHS.at(-1)}`}
        className="mt-4 h-40 w-full text-primary"
      >
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground" aria-hidden>
        <span>{MONTHS[0]}</span>
        <span>{MONTHS.at(-1)}</span>
      </div>
    </figure>
  );
}

function SignupsChart() {
  const max = Math.max(...SIGNUPS);
  return (
    <figure className="rounded-xl border bg-card p-5">
      <figcaption className="font-medium">Signups per month</figcaption>
      <ul className="mt-4 flex h-40 items-end gap-1.5" aria-label="Signups per month">
        {SIGNUPS.map((count, i) => (
          <li key={MONTHS[i]} className="flex h-full flex-1 flex-col justify-end" title={`${MONTHS[i]}: ${count}`}>
            <div className="rounded-t bg-primary/80" style={{ height: `${(count / max) * 100}%` }} />
            <span className="sr-only">{MONTHS[i]}: {count}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground" aria-hidden>
        <span>{MONTHS[0]}</span>
        <span>{MONTHS.at(-1)}</span>
      </div>
    </figure>
  );
}

function OrdersTable({ query }: { query: string }) {
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [desc, setDesc] = useState(true);
  const [page, setPage] = useState(0);

  const rows = useMemo(() => {
    const q = query.toLowerCase();
    const sorted = ORDERS.filter((o) => o.customer.toLowerCase().includes(q) || o.id.includes(q)).sort((a, b) =>
      typeof a[sortKey] === "number"
        ? (a[sortKey] as number) - (b[sortKey] as number)
        : String(a[sortKey]).localeCompare(String(b[sortKey])),
    );
    return desc ? sorted.reverse() : sorted;
  }, [query, sortKey, desc]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // A new search can shrink the list under the current page.
  const current = Math.min(page, pageCount - 1);

  const header = (key: SortKey, label: string) => (
    <th scope="col" className="p-3 font-medium" aria-sort={sortKey === key ? (desc ? "descending" : "ascending") : "none"}>
      <button
        type="button"
        onClick={() => {
          setDesc(sortKey === key ? !desc : false);
          setSortKey(key);
        }}
        className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
        {sortKey === key && <span aria-hidden> {desc ? "↓" : "↑"}</span>}
      </button>
    </th>
  );

  return (
    <section className="rounded-xl border bg-card" aria-labelledby="orders-heading">
      <h2 id="orders-heading" className="p-5 font-medium">Recent orders</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" className="p-3 font-medium">Order</th>
              {header("customer", "Customer")}
              {header("amount", "Amount")}
              <th scope="col" className="p-3 font-medium">Status</th>
              {header("date", "Date")}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 && (
              <tr><td colSpan={5} className="p-8 text-center text-muted-foreground">No orders found.</td></tr>
            )}
            {rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((o) => (
              <tr key={o.id}>
                <td className="p-3 text-muted-foreground">{o.id}</td>
                <td className="p-3 font-medium">{o.customer}</td>
                <td className="p-3">${o.amount}</td>
                <td className="p-3">
                  <span className={cn("rounded-full px-2 py-0.5 text-xs", STATUS_STYLE[o.status])}>{o.status}</span>
                </td>
                <td className="p-3 text-muted-foreground">{o.date}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between p-4 text-sm text-muted-foreground">
        <span>{rows.length} orders</span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)} className="rounded-md border px-3 py-1 disabled:opacity-50">
            Previous
          </button>
          <span>{current + 1} / {pageCount}</span>
          <button type="button" disabled={current + 1 >= pageCount} onClick={() => setPage(current + 1)} className="rounded-md border px-3 py-1 disabled:opacity-50">
            Next
          </button>
        </div>
      </div>
    </section>
  );
}

function UserMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen(!open)}
        className="grid size-9 place-items-center rounded-full bg-primary text-sm font-medium text-primary-foreground"
      >
        AP
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-10 mt-2 w-40 rounded-md border bg-card p-1 text-sm shadow-lg">
          {["Profile", "Settings", "Sign out"].map((item) => (
            <button key={item} type="button" role="menuitem" onClick={() => setOpen(false)} className="block w-full rounded px-3 py-2 text-left hover:bg-muted">
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Dashboard() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [query, setQuery] = useState("");
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {sidebarOpen && (
        <aside id="sidebar" className="border-b bg-muted/30 p-4 md:w-56 md:border-b-0 md:border-r">
          <p className="flex items-center gap-2 font-semibold">
            <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
              {BRAND_NAME.charAt(0)}
            </span>
            {BRAND_NAME}
          </p>
          <nav aria-label="Main" className="mt-4 flex gap-1 text-sm md:flex-col">
            <a href="/" aria-current="page" className="flex items-center gap-2 rounded-md bg-primary/10 px-3 py-2 font-medium text-primary">
              <LayoutDashboard className="size-4" aria-hidden /> Overview
            </a>
            <a href="/" className="flex items-center gap-2 rounded-md px-3 py-2 text-muted-foreground hover:bg-muted">
              <ShoppingCart className="size-4" aria-hidden /> Orders
            </a>
            <a href="/" className="flex items-center gap-2 rounded-md px-3 py-2 text-muted-foreground hover:bg-muted">
              <Users className="size-4" aria-hidden /> Customers
            </a>
          </nav>
        </aside>
      )}
      <div className="min-w-0 flex-1">
        <header className="flex items-center gap-3 border-b px-4 py-3 sm:px-8">
          <button
            type="button"
            aria-label="Toggle sidebar"
            aria-expanded={sidebarOpen}
            aria-controls="sidebar"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="rounded-md p-2 hover:bg-muted"
          >
            <Menu className="size-5" />
          </button>
          <label className="relative flex-1">
            <span className="sr-only">Search orders</span>
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search orders"
              className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <UserMenu />
        </header>
        <main className="space-y-6 p-4 sm:p-8">
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {KPIS.map((kpi) => <Kpi key={kpi.label} {...kpi} />)}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <RevenueChart />
            <SignupsChart />
          </div>
          <OrdersTable query={query} />
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
    </Routes>
  );
}
