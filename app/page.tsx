import { redirect } from "next/navigation";

// The console is the product; the marketing surface (01-PRODUCT-SPEC.md §17) is not part of v1.
export default function Home() {
  redirect("/dashboard");
}
