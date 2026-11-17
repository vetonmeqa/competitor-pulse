import { useRef } from "react";
import { Link, useSearchParams } from "react-router";
import { useCompetitors } from "../api/hooks";
import { AddCompetitorForm } from "../components/AddCompetitorForm";
import { CompetitorList } from "../components/CompetitorList";
import { Notice } from "../components/Notice";
import { Pager } from "../components/Pager";
import { SearchField } from "../components/SearchField";
import { formatCount } from "../lib/format";
import { pageCountFor, parsePage } from "../lib/pagination";
import styles from "./pages.module.css";

const PAGE_SIZE = 25;

/** What the list is showing: a search, a filter and a page. */
interface ListView {
  search: string;
  activeOnly: boolean;
  page: number;
}

/** The address of a view of the list, leaving out whatever has its default value. */
function listAddress({ search, activeOnly, page }: ListView): { search: string } {
  const params = new URLSearchParams();
  if (search !== "") {
    params.set("q", search);
  }
  if (activeOnly) {
    params.set("show", "active");
  }
  if (page > 1) {
    params.set("page", String(page));
  }
  return { search: params.toString() };
}

export function CompetitorsPage() {
  // The search, the filter and the page live in the URL, so a view can be bookmarked and
  // shared, and the back button returns to the page before.
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get("q")?.trim() ?? "";
  const activeOnly = searchParams.get("show") === "active";
  const competitors = useCompetitors({
    page: parsePage(searchParams.get("page")),
    pageSize: PAGE_SIZE,
    search,
    activeOnly,
  });
  const { data, isPending, isError, error, isPlaceholderData } = competitors;
  const listTop = useRef<HTMLElement>(null);

  // The server says which page it returned: the last one, when the address asks for a
  // page past the end. Everything below goes by that page, not by the address.
  const pageCount = data ? pageCountFor(data.total, data.pageSize) : 1;
  const firstShown = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const nothingTracked = data?.totalTracked === 0;
  const narrowed = search !== "" || activeOnly;

  /** A change of the search or the filter starts at the first page of the new view. */
  function show(view: Omit<ListView, "page">) {
    // It replaces the address, so the back button does not walk through every word typed.
    setSearchParams(listAddress({ ...view, page: 1 }).search, { replace: true });
  }

  return (
    <>
      <title>Competitors · CompetitorPulse</title>
      <div className={styles.heading}>
        <h1>Competitors</h1>
        <p className="muted">
          Each tracked listing is polled regularly. Open one to see its history and what changed.
        </p>
      </div>

      <AddCompetitorForm />

      <section ref={listTop} className={styles.section} aria-label="Tracked competitors">
        {!nothingTracked && (
          <div className={styles.toolbar}>
            <SearchField
              query={search}
              onQueryChange={(next) => {
                show({ search: next, activeOnly });
              }}
              label="Search competitors"
              placeholder="Search by id or name"
            />
            {/* Done by the server like the search, so it covers every page. */}
            <label className={styles.filter}>
              <input
                type="checkbox"
                checked={activeOnly}
                onChange={(event) => {
                  show({ search, activeOnly: event.target.checked });
                }}
              />
              Only show active
            </label>
            {/* Announced by a screen reader when a search or the filter changes it. */}
            <p className={styles.count} role="status">
              {data &&
                (narrowed
                  ? `${formatCount(data.total)} of ${formatCount(data.totalTracked)} competitors`
                  : `${formatCount(data.total)} ${data.total === 1 ? "competitor" : "competitors"}`)}
            </p>
          </div>
        )}

        {/* Shown next to the last good list, if there is one, so a failed refresh hides nothing. */}
        {isError && (
          <Notice tone="danger" role="alert">
            Could not load the competitors: {error.message}
          </Notice>
        )}
        {isPending && <Notice role="status">Loading competitors…</Notice>}
        {nothingTracked && (
          <Notice>No competitors are tracked yet. Add one above to get started.</Notice>
        )}
        {data?.total === 0 && !nothingTracked && (
          <Notice>
            {search === "" ? (
              "No competitor is active. Tracking is paused for all of them."
            ) : (
              <>
                No {activeOnly && "active "}competitor matches “{search}”. The search looks at ids
                and names.
              </>
            )}{" "}
            <Link to={listAddress({ search: "", activeOnly: false, page: 1 })} replace>
              {activeOnly ? "Show all competitors" : "Clear the search"}
            </Link>
          </Notice>
        )}

        {data !== undefined && data.items.length > 0 && (
          // Dimmed while another page, search or filter is on its way.
          <div className={styles.results} aria-busy={isPlaceholderData}>
            <CompetitorList competitors={data.items} />
          </div>
        )}

        {data !== undefined && pageCount > 1 && (
          <div className={styles.listFooter}>
            <p className={styles.count}>
              Showing {formatCount(firstShown)}–{formatCount(firstShown + data.items.length - 1)}{" "}
              of {formatCount(data.total)}
            </p>
            <Pager
              page={data.page}
              pageCount={pageCount}
              to={(page) => listAddress({ search, activeOnly, page })}
              onNavigate={() => {
                // The pager is under the list. Bring the top of the new page into view.
                const top = listTop.current;
                if (top !== null && top.getBoundingClientRect().top < 0) {
                  top.scrollIntoView({ block: "start" });
                }
              }}
            />
          </div>
        )}
      </section>
    </>
  );
}
