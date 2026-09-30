// `<Purchases />` (design §2.3, §8.4): the latest purchases, each with a link to its proof.
import { useEffect, useState } from "react";
import { Link } from "wouter";
import type { PurchaseSummary, PurchasesProps } from "@demo-factory/interfaces";
import { dollars, shortHash, usdc } from "./lib.ts";

export function Purchases({ offer, limit = 10 }: PurchasesProps) {
  const [purchases, setPurchases] = useState<PurchaseSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const query = new URLSearchParams({ limit: String(limit), ...(offer ? { offer } : {}) });
    const load = () =>
      fetch(`/api/purchases?${query}`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`The app answered ${response.status}.`);
          return (await response.json()) as { purchases: PurchaseSummary[] };
        })
        .then((body) => live && (setPurchases(body.purchases), setFailure(null)))
        .catch((error: unknown) => live && setFailure(error instanceof Error ? error.message : String(error)));
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [offer, limit]);

  if (failure) return <p className="ik-error">The latest purchases could not be read: {failure}</p>;
  if (!purchases) return <p className="ik-wait">Reading the latest purchases…</p>;
  if (purchases.length === 0) return <p className="ik-wait">No purchase has been made here yet.</p>;
  return (
    <ul className="ik-purchases" data-integra-purchases>
      {purchases.map((purchase) => (
        // A purchase is the seller's own record: `data-seq` is the number of the seller's latest event for it, when the
        // list carries one.
        <li key={purchase.checkout} data-from="seller" data-seq={(purchase as { seq?: number }).seq}>
          <span className="ik-purchase-name">
            {purchase.offerName}
            {purchase.test ? " (test checkout)" : ""}
          </span>
          <span className="ik-purchase-state">{purchase.headline}</span>
          <span className="ik-purchase-price">
            listed {dollars(purchase.price.listed)}
            {purchase.price.agreed ? `, agreed ${dollars(purchase.price.agreed)}` : ""} · paid {usdc(purchase.amount)}
          </span>
          <Link href={`/proof/${purchase.atrHash}`}>
            Proof <code>{shortHash(purchase.atrHash)}</code>
          </Link>
        </li>
      ))}
    </ul>
  );
}
