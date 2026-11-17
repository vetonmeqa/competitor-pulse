import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, type CompetitorQuery } from "./client";

/**
 * The data changes on the server as polls come in, so every list refreshes on a timer.
 * TanStack Query pauses the timer while the tab is in the background.
 */
const REFRESH_MS = 5000;

const keys = {
  /** The start of every competitor key, so one call refreshes the list and the single ones. */
  competitors: ["competitors"] as const,
  competitorList: (query: CompetitorQuery) => ["competitors", "list", query] as const,
  competitor: (id: string) => ["competitors", "one", id] as const,
  snapshots: (id: string, changedOnly: boolean) => ["snapshots", id, { changedOnly }] as const,
  status: ["status"] as const,
};

/** One page of the list. The server does the paging and the search. */
export function useCompetitors(query: CompetitorQuery) {
  return useQuery({
    queryKey: keys.competitorList(query),
    queryFn: ({ signal }) => api.listCompetitors(query, signal),
    refetchInterval: REFRESH_MS,
    // Keep showing the current page while another page or another search loads.
    placeholderData: keepPreviousData,
  });
}

export function useCompetitor(id: string) {
  return useQuery({
    queryKey: keys.competitor(id),
    queryFn: ({ signal }) => api.getCompetitor(id, signal),
    refetchInterval: REFRESH_MS,
  });
}

/** How many snapshots one request brings. */
export const SNAPSHOT_PAGE_SIZE = 50;

/**
 * A competitor's history, newest first, loaded a page at a time. An older page is asked
 * for by the id of the last snapshot already here ("the 50 before this one"), so new
 * polls arriving at the top never shift it.
 *
 * On the refresh timer TanStack Query fetches the loaded pages again in order, each one
 * starting from the last snapshot of the refreshed page before it. The list therefore
 * never has a gap or a repeat. The cost is one small request per loaded page.
 */
export function useSnapshots(id: string, changedOnly: boolean) {
  return useInfiniteQuery({
    queryKey: keys.snapshots(id, changedOnly),
    queryFn: ({ pageParam, signal }) =>
      api.listSnapshots(id, { limit: SNAPSHOT_PAGE_SIZE, changedOnly, before: pageParam }, signal),
    initialPageParam: undefined as number | undefined,
    // A page that is not full is the end of the history.
    getNextPageParam: (lastPage) =>
      lastPage.length < SNAPSHOT_PAGE_SIZE ? undefined : lastPage.at(-1)?.id,
    refetchInterval: REFRESH_MS,
    // Keep showing the current list while a new filter loads.
    placeholderData: keepPreviousData,
  });
}

export function useSystemStatus() {
  return useQuery({
    queryKey: keys.status,
    queryFn: ({ signal }) => api.getStatus(signal),
    refetchInterval: REFRESH_MS * 2,
  });
}

export function useAddCompetitor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.addCompetitor(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.competitors }),
  });
}

export function useRemoveCompetitor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.removeCompetitor(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.competitors }),
  });
}
