import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { navigate } from '../../app/navigation';
import { useMutation } from '../moderation/useMutation';

export function useDeletion(refresh: () => Promise<boolean>) {
  const [name, setName] = useState('');
  const mutation = useMutation(API_PATHS.instanceDeletion, async () => {
    await refresh();
    navigate('/game/?view=organization');
  });
  return { name, setName, mutation };
}
