export type CartLine = { id: string; size: string; qty: number };

/** Treat persisted cart data as untrusted; only return usable product variants. */
export function sanitizeCart(raw: string | null, products: readonly { id: string; sizes: readonly string[] }[]): CartLine[] {
  try {
    const saved: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(saved)) return [];
    const lines: CartLine[] = [];
    for (const line of saved) {
      if (!line || typeof line !== "object") continue;
      const product = products.find((p) => p.id === line.id);
      if (!product || !product.sizes.includes(line.size)) continue;
      if (typeof line.qty !== "number" && (typeof line.qty !== "string" || !line.qty.trim())) continue;
      const qty = Number(line.qty);
      if (!Number.isFinite(qty)) continue;
      if (lines.some((l) => l.id === line.id && l.size === line.size)) continue;
      lines.push({ id: product.id, size: line.size, qty: Math.max(1, Math.min(99, Math.trunc(qty))) });
    }
    return lines;
  } catch {
    return [];
  }
}
