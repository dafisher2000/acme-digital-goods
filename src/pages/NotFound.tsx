import { Link } from "wouter";
import { Layout } from "./shared";

export default function NotFound() {
  return (
    <Layout title="Nothing at this address">
      <p>
        There is no page here. <Link href="/">Back to the shop.</Link>
      </p>
    </Layout>
  );
}
