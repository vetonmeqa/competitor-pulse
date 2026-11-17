/** One place in the row of page numbers: a page, or a gap that stands for the pages left out. */
export type PageSlot = number | "gap-before" | "gap-after";

/** With more pages than this, some are left out and shown as a gap. */
const MAX_SLOTS = 7;

/**
 * The page numbers to show for `current` out of `pageCount`.
 *
 * The first, the last and the current page are always there, with the current page's
 * neighbours. With more than seven pages the row always has exactly seven places, so the
 * Next button does not move while someone clicks through:
 *
 *   1 2 3 4 5 … 40      near the start
 *   1 … 19 20 21 … 40   in the middle
 *   1 … 36 37 38 39 40  near the end
 */
export function pageSlots(current: number, pageCount: number): PageSlot[] {
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_unused, index) => from + index);

  if (pageCount <= MAX_SLOTS) {
    return range(1, pageCount);
  }
  if (current <= 4) {
    return [...range(1, 5), "gap-after", pageCount];
  }
  if (current >= pageCount - 3) {
    return [1, "gap-before", ...range(pageCount - 4, pageCount)];
  }
  return [1, "gap-before", current - 1, current, current + 1, "gap-after", pageCount];
}

/** The page number in a URL. Anything that is not a whole number from 1 up counts as 1. */
export function parsePage(raw: string | null): number {
  return raw !== null && /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : 1;
}

/** How many pages `total` items fill. An empty list still has one (empty) page. */
export function pageCountFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
