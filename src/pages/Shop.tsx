import { Layout, OfferBlock } from "./shared";

export default function Shop() {
  return (
    <Layout
      title="The shop"
      lede="Every product is a file delivered the moment the purchase clears. Licences are on each product and in the agreement."
    >
      {["bracken-display", "moor-patterns", "studio-palettes", "extended-licence", "pitch-kit"].map((id) => (
        <OfferBlock key={id} id={id} />
      ))}
    </Layout>
  );
}
