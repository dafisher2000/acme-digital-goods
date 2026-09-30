// `<Buy offer="…" />` (design §2.3): the offer's buy control. It opens the live purchase, which is the kit's.
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import type { BuyProps } from "@demo-factory/interfaces";
import { business } from "integra:business";
import { LivePurchase, type Scenario } from "./live.tsx";
import { dollars, dueRule, usdc } from "./lib.ts";
import { ANCHOR_AMOUNT, dollarsToAmount } from "@demo-factory/interfaces/price";

export function Buy({ offer: id }: BuyProps) {
  const offer = business.offers.find((candidate) => candidate.id === id);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (scenario && !element.open) element.showModal();
    if (!scenario && element.open) element.close();
  }, [scenario]);

  if (!offer) return <p className="ik-error">business.json has no offer &quot;{id}&quot;.</p>;
  return (
    <div className="ik-buy" data-integra-offer={offer.id}>
      {offer.payment === "deferred" ? (
        <p className="ik-price" data-integra-payment="deferred">
          Listed <strong>{dollars(offer.price)}</strong> · <strong>pay later</strong>: owed as {usdc(dollarsToAmount(offer.price))}, due {dueRule(offer.due)} · paid now:{" "}
          <strong>{usdc(ANCHOR_AMOUNT)}</strong>, which anchors the agreement on a test network and is not part of the price
        </p>
      ) : (
        <p className="ik-price" data-integra-payment={offer.payment}>
          Listed <strong>{dollars(offer.price)}</strong> · paid as <strong>{usdc(dollarsToAmount(offer.price))}</strong> on a test network
          {offer.payment === "authorise" ? " · authorised now, collected later" : ""}
        </p>
      )}
      <div className="ik-actions">
        <button type="button" className="ik-button" onClick={() => setScenario("buy")}>
          Watch an agent buy
        </button>
        <Link className="ik-button ik-quiet" href={`/agents?offer=${offer.id}`}>
          Connect your agent
        </Link>
        {offer.negotiable ? (
          <button type="button" className="ik-button ik-quiet" onClick={() => setScenario("negotiate")}>
            Watch two agents negotiate
          </button>
        ) : null}
      </div>
      <dialog ref={dialog} className="ik-dialog" onClose={() => setScenario(null)}>
        <div className="ik-dialog-head">
          <strong>{offer.name}</strong>
          <button type="button" className="ik-button ik-quiet" onClick={() => setScenario(null)}>
            Close
          </button>
        </div>
        {scenario ? <LivePurchase key={scenario} offer={offer} scenario={scenario} /> : null}
      </dialog>
    </div>
  );
}
