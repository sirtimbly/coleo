import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';

export function useGardenScene() {
  return useQuery({
    queryKey: ['garden', 'scene'],
    queryFn: async () => {
      const response = await api.getGardenScene();
      return response.scene;
    },
    refetchInterval: 5000,
  });
}
