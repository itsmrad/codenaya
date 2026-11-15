import { describe, expect, it } from "vitest";

import { sanitizeCart } from "../../../templates/ecommerce-storefront/src/cart";

const products = [{ id: "shirt", sizes: ["S", "M"] }];
const line = { id: "shirt", size: "M", qty: 2 };
const read = (value: unknown) => sanitizeCart(JSON.stringify(value), products);

describe("storefront saved cart", () => {
  it("parses string quantities so incrementing adds numbers", () => {
    const [saved] = read([{ ...line, qty: "2" }]);
    expect(saved).toEqual(line);
    expect(saved.qty + 1).toBe(3);
  });

  it.each([[0, 1], [-5, 1], [1000, 99], ["101", 99], [2.9, 2]])("clamps/truncates %s to %s", (qty, expected) => {
    expect(read([{ ...line, qty }])[0].qty).toBe(expected);
  });

  it.each([null, {}, "cart", [null, false, {}, { ...line, id: "gone" }, { ...line, size: "XL" }]].map((value) => [value]))("ignores invalid cart shapes and variants: %j", (value) => {
    expect(read(value)).toEqual([]);
  });

  it.each([null, true, {}, [], "", " ", "two", "2x", "Infinity"])("ignores invalid quantity %j", (qty) => {
    expect(read([{ ...line, qty }])).toEqual([]);
  });

  it("never throws on corrupt JSON and keeps valid lines beside bad ones", () => {
    expect(sanitizeCart("{broken", products)).toEqual([]);
    expect(sanitizeCart(null, products)).toEqual([]);
    expect(read([null, line, line, { ...line, size: "bad" }])).toEqual([line]);
  });
});
