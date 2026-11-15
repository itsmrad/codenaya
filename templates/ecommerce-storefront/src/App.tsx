import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Route, Routes, useParams } from "react-router-dom";
import { Plus, XIcon as X } from "lucide-react";

import { BRAND_NAME } from "./brand";
import { sanitizeCart, type CartLine } from "./cart";
import { cn } from "./lib/utils";

function Minus({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /></svg>;
}

function ShoppingBag({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16l1 14H3L4 7Z" /><path d="M8 7V6a4 4 0 0 1 8 0v1" /></svg>;
}

type Product = { id: string; name: string; category: string; price: number; sizes: string[]; blurb: string };

const PRODUCTS: Product[] = [
  { id: "linen-shirt", name: "Linen shirt", category: "Tops", price: 68, sizes: ["S", "M", "L"], blurb: "Breathable European linen with a relaxed cut." },
  { id: "wool-sweater", name: "Wool sweater", category: "Tops", price: 120, sizes: ["S", "M", "L"], blurb: "A warm, soft sweater in midweight merino." },
  { id: "chino-pants", name: "Chino pants", category: "Bottoms", price: 85, sizes: ["28", "30", "32"], blurb: "Straight-leg chinos that look good with everything." },
  { id: "denim-jacket", name: "Denim jacket", category: "Outerwear", price: 140, sizes: ["S", "M", "L"], blurb: "A classic jacket in sturdy, washed denim." },
  { id: "canvas-tote", name: "Canvas tote", category: "Accessories", price: 32, sizes: ["One size"], blurb: "Heavy cotton canvas with an inside pocket." },
  { id: "leather-belt", name: "Leather belt", category: "Accessories", price: 45, sizes: ["M", "L"], blurb: "Full-grain leather with a brushed buckle." },
];
const CATEGORIES = ["All", ...new Set(PRODUCTS.map((p) => p.category))];
const CART_KEY = "cart";

const money = (n: number) => `$${n.toFixed(2)}`;
const find = (id: string) => PRODUCTS.find((p) => p.id === id)!;

const loadCart = (): CartLine[] => {
  try {
    return sanitizeCart(localStorage.getItem(CART_KEY), PRODUCTS);
  } catch {
    return [];
  }
};

function useCart() {
  const [lines, setLines] = useState<CartLine[]>(loadCart);
  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(lines));
    } catch {
      // Without storage the cart just isn't kept across reloads.
    }
  }, [lines]);
  const add = (id: string, size: string) =>
    setLines((list) =>
      list.some((l) => l.id === id && l.size === size)
        ? list.map((l) => (l.id === id && l.size === size ? { ...l, qty: Math.min(99, l.qty + 1) } : l))
        : [...list, { id, size, qty: 1 }],
    );
  const change = (id: string, size: string, delta: number) =>
    setLines((list) =>
      list.map((l) => (l.id === id && l.size === size ? { ...l, qty: Math.min(99, l.qty + delta) } : l)).filter((l) => l.qty > 0),
    );
  const subtotal = lines.reduce((sum, l) => sum + find(l.id).price * l.qty, 0);
  return { lines, add, change, clear: () => setLines([]), subtotal, count: lines.reduce((n, l) => n + l.qty, 0) };
}
type Cart = ReturnType<typeof useCart>;

function CartPanel({ cart, onClose }: { cart: Cart; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current!;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.close();
      opener?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Shopping cart"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'));
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={onClose}
      className="fixed inset-0 z-20 bg-black/50 p-0 m-0 h-full max-h-none w-full max-w-none border-0 text-foreground"
    >
      <aside
        onClick={(event) => event.stopPropagation()}
        className="ml-auto flex h-full w-full max-w-sm flex-col bg-background p-6 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Your cart</h2>
          <button ref={closeRef} type="button" aria-label="Close cart" onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>
        {cart.lines.length === 0 ? (
          <p className="mt-8 text-center text-muted-foreground">Your cart is empty.</p>
        ) : (
          <>
            <ul className="mt-6 flex-1 divide-y overflow-y-auto">
              {cart.lines.map((line) => {
                const product = find(line.id);
                return (
                  <li key={`${line.id}-${line.size}`} className="flex items-center justify-between gap-3 py-3 text-sm">
                    <div>
                      <p className="font-medium">{product.name}</p>
                      <p className="text-muted-foreground">{line.size} · {money(product.price)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button" aria-label={`Remove one ${product.name}`} onClick={() => cart.change(line.id, line.size, -1)} className="rounded border p-1">
                        <Minus className="size-3" />
                      </button>
                      <span aria-label="Quantity">{line.qty}</span>
                      <button type="button" aria-label={`Add one ${product.name}`} onClick={() => cart.change(line.id, line.size, 1)} className="rounded border p-1">
                        <Plus className="size-3" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-4 flex justify-between font-medium"><span>Subtotal</span>{money(cart.subtotal)}</p>
            <Link to="/checkout" onClick={onClose} className="mt-4 block rounded-md bg-primary px-4 py-2 text-center text-sm font-medium text-primary-foreground">
              Checkout
            </Link>
          </>
        )}
      </aside>
    </dialog>
  );
}

function Shell({ cart, children }: { cart: Cart; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <nav aria-label="Main" className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-lg font-semibold">{BRAND_NAME}</Link>
          <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
            <ShoppingBag className="size-4" aria-hidden /> Cart
            <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground" aria-label={`${cart.count} items`}>{cart.count}</span>
          </button>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
      {open && <CartPanel cart={cart} onClose={() => setOpen(false)} />}
    </div>
  );
}

function Catalog({ cart }: { cart: Cart }) {
  const [category, setCategory] = useState("All");
  const [sort, setSort] = useState<"featured" | "low" | "high">("featured");
  const [maxPrice, setMaxPrice] = useState(150);
  const shown = PRODUCTS.filter((p) => (category === "All" || p.category === category) && p.price <= maxPrice);
  if (sort !== "featured") shown.sort((a, b) => (sort === "low" ? a.price - b.price : b.price - a.price));
  return (
    <Shell cart={cart}>
      <h1 className="text-3xl font-semibold tracking-tight">Shop all</h1>
      <div className="mt-6 flex flex-wrap items-end gap-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Category">
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
        <label className="text-sm">
          Max price: {money(maxPrice)}
          <input type="range" min={30} max={150} step={5} value={maxPrice} onChange={(event) => setMaxPrice(Number(event.target.value))} className="ml-2 align-middle" />
        </label>
        <label className="text-sm">
          <span className="sr-only">Sort by</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="rounded-md border bg-background px-3 py-1.5">
            <option value="featured">Featured</option>
            <option value="low">Price: low to high</option>
            <option value="high">Price: high to low</option>
          </select>
        </label>
      </div>
      <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {shown.length === 0 && <li className="col-span-full py-8 text-center text-muted-foreground">No products match.</li>}
        {shown.map((p) => (
          <li key={p.id} className="rounded-xl border bg-card p-4">
            <Link to={`/product/${p.id}`} className="block">
              <div className="grid aspect-square place-items-center rounded-lg bg-muted text-4xl font-semibold text-muted-foreground" aria-hidden>
                {p.name.charAt(0)}
              </div>
              <p className="mt-3 font-medium hover:text-primary">{p.name}</p>
            </Link>
            <p className="text-sm text-muted-foreground">{p.category} · {money(p.price)}</p>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function ProductPage({ cart }: { cart: Cart }) {
  const { id } = useParams();
  const product = PRODUCTS.find((p) => p.id === id);
  const [size, setSize] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  if (!product) {
    return (
      <Shell cart={cart}>
        <h1 className="text-2xl font-semibold">Product not found</h1>
        <Link to="/" className="mt-4 inline-block text-primary underline">Back to the shop</Link>
      </Shell>
    );
  }
  return (
    <Shell cart={cart}>
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">← Shop all</Link>
      <div className="mt-4 grid gap-8 md:grid-cols-2">
        <div className="grid aspect-square place-items-center rounded-xl bg-muted text-7xl font-semibold text-muted-foreground" aria-hidden>
          {product.name.charAt(0)}
        </div>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{product.name}</h1>
          <p className="mt-2 text-xl">{money(product.price)}</p>
          <p className="mt-4 text-muted-foreground">{product.blurb}</p>
          <fieldset className="mt-6">
            <legend className="text-sm font-medium">Size</legend>
            <div className="mt-2 flex gap-2">
              {product.sizes.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={size === s}
                  onClick={() => setSize(s)}
                  className={cn("rounded-md border px-4 py-2 text-sm", size === s && "border-primary bg-primary text-primary-foreground")}
                >
                  {s}
                </button>
              ))}
            </div>
          </fieldset>
          <button
            type="button"
            disabled={!size}
            onClick={() => {
              cart.add(product.id, size!);
              setAdded(true);
            }}
            className="mt-6 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {size ? "Add to cart" : "Select a size"}
          </button>
          <p role="status" className="mt-2 text-sm text-primary">{added ? "Added to your cart." : ""}</p>
        </div>
      </div>
    </Shell>
  );
}

function Checkout({ cart }: { cart: Cart }) {
  const [form, setForm] = useState({ name: "", email: "", address: "" });
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) return setError("Name is required.");
    if (!/^\S+@\S+\.\S+$/.test(form.email)) return setError("Enter a valid email address.");
    if (!form.address.trim()) return setError("Address is required.");
    setDone(true);
    cart.clear();
  };
  return (
    <Shell cart={cart}>
      <h1 className="text-3xl font-semibold tracking-tight">Checkout</h1>
      {done ? (
        <p role="status" className="mt-6 font-medium text-primary">Thanks for your order! (Demo checkout: no payment was taken.)</p>
      ) : cart.lines.length === 0 ? (
        <p className="mt-6 text-muted-foreground">Your cart is empty. <Link to="/" className="text-primary underline">Keep shopping</Link></p>
      ) : (
        <form onSubmit={submit} noValidate className="mt-6 max-w-md space-y-4">
          {(["name", "email", "address"] as const).map((field) => (
            <label key={field} className="block text-sm capitalize">
              {field}
              <input
                type={field === "email" ? "email" : "text"}
                value={form[field]}
                onChange={(event) => setForm({ ...form, [field]: event.target.value })}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          ))}
          <p className="flex justify-between font-medium"><span>Total</span>{money(cart.subtotal)}</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
            Place order
          </button>
        </form>
      )}
    </Shell>
  );
}

export default function App() {
  const cart = useCart();
  return (
    <Routes>
      <Route path="/" element={<Catalog cart={cart} />} />
      <Route path="/product/:id" element={<ProductPage cart={cart} />} />
      <Route path="/checkout" element={<Checkout cart={cart} />} />
    </Routes>
  );
}
