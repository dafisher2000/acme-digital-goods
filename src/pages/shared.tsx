import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { business } from "integra:business";
import { Buy } from "integra:ui";

const NAV: [string, string][] = [
  ["/", "Home"],
  ["/shop", "Shop"],
];

export function Layout({ title, lede, children }: { title: string; lede?: string; children: ReactNode }) {
  const [path] = useLocation();
  return (
    <div className="ad">
      <header className="ad-head">
        <div className="ad-wrap">
          <Link href="/" className="ad-brand">
            {business.name}
          </Link>
          <nav aria-label="Main">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} aria-current={path === href ? "page" : undefined}>
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="ad-wrap">
        <h1>{title}</h1>
        {lede ? <p className="ad-lede">{lede}</p> : null}
        {children}
      </main>
      <footer className="ad-foot">
        <div className="ad-wrap">
          {business.line} Questions: <a href={`mailto:${business.contact}`}>{business.contact}</a>
        </div>
      </footer>
    </div>
  );
}

const KIND: Record<string, string> = {
  file: "File, delivered at purchase",
};

/** One offer in full: its words, its price, its terms and its buy control. */
export function OfferBlock({ id }: { id: string }) {
  const offer = business.offers.find((o) => o.id === id);
  if (!offer) throw new Error(`business.json has no offer "${id}"`);
  return (
    <section className="ad-offer" id={offer.id}>
      <div className="ad-kicker">{KIND[offer.delivers.kind]}</div>
      <h2>{offer.name}</h2>
      <p>{offer.about}</p>
      <p className="ad-price">
        ${offer.price}
        {offer.negotiable ? <span className="ad-kicker"> · price open to negotiation</span> : null}
      </p>
      <dl>
        {Object.entries(offer.terms).map(([heading, text]) => (
          <div key={heading} style={{ display: "contents" }}>
            <dt>{heading}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
      <Buy offer={offer.id} />
    </section>
  );
}
