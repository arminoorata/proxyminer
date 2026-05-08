/**
 * Source-text search workspace. Query input + company filter + result
 * cards with highlighted snippets and links into the relevant company
 * workspace. Backed by /api/search.
 */
import SearchView from "@/components/SearchView";
import { listCompanies } from "@/lib/data/source";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const company = typeof sp.company === "string" ? sp.company : "";
  const companies = await listCompanies();
  return <SearchView companies={companies} initialQuery={q} initialCompany={company} />;
}
