import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { edgeApi } from '../api/edge';
import type { EdgePresetInput } from '../api/types';

const QUERY_KEY = ['edge'] as const;

// `enabled=false` stops the 3s poll entirely — used by the dashboard shell
// while the Edge component is parked server-side (the route answers 503).
export function useEdge(enabled = true) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => edgeApi.get(),
    refetchInterval: enabled ? 3_000 : false,
    staleTime: 1_000,
    enabled,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: QUERY_KEY });
  const save = useMutation({
    mutationFn: ({ ticker, preset }: { ticker: string; preset: EdgePresetInput }) => edgeApi.save(ticker, preset),
    onSuccess: invalidate,
  });
  const reset = useMutation({ mutationFn: edgeApi.reset, onSuccess: invalidate });
  const remove = useMutation({ mutationFn: edgeApi.remove, onSuccess: invalidate });

  return {
    rows: query.data?.rows ?? [],
    events: query.data?.events ?? [],
    isLoading: query.isLoading,
    error: query.error,
    save: save.mutateAsync,
    saving: save.isPending,
    reset: reset.mutateAsync,
    remove: remove.mutateAsync,
  };
}
