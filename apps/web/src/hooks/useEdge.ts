import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { edgeApi } from '../api/edge';
import type { EdgePresetInput } from '../api/types';

const QUERY_KEY = ['edge'] as const;

export function useEdge() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => edgeApi.get(),
    refetchInterval: 3_000,
    staleTime: 1_000,
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
