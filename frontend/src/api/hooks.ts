import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CompetitorQuery, type SnapshotQuery } from "./client";

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
  snapshots: (id: string, query: SnapshotQuery) => ["snapshots", id, query] as const,
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

export function useSnapshots(id: string, query: SnapshotQuery) {
  return useQuery({
    queryKey: keys.snapshots(id, query),
    queryFn: ({ signal }) => api.listSnapshots(id, query, signal),
    refetchInterval: REFRESH_MS,
    // Keep showing the current list while a new filter or a longer list loads.
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
