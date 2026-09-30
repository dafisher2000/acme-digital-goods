import { Link } from "wouter";
import { business } from "integra:business";
import { Purchases } from "integra:ui";
import { Layout } from "./shared";

export default function Home() {
  return (
    <Layout title={business.name} lede={business.line}>
      <p>
        A two-person foundry and tool shop in Leeds. We draw display faces and pattern packs, sample colour from the
        moors and mills around us, and sell the result as files: bought here, delivered at once, licensed in plain
        words. Everything on the shop page is a download.
      </p>
      <div className="ad-grid">
        {business.offers.map((o) => (
          <article className="ad-card" key={o.id}>
            <h3>
              <Link href={`/shop#${o.id}`}>{o.name}</Link>
            </h3>
            <p>{o.about}</p>
            <p className="ad-price">${o.price}</p>
          </article>
        ))}
      </div>
      <h2>Lately bought</h2>
      <Purchases limit={5} />
    </Layout>
  );
}
