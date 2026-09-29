import { useEffect, useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import type { PersonalModeration, Sanction } from '../../../shared/moderation';
import { organizationRequest } from '../organization/useOrganization';
import { useActiveSanctions } from './useActiveSanctions';

export function usePersonalModeration() {
  const [rows, setRows] = useState<Sanction[]>([]);
  const [details, setDetails] = useState<PersonalModeration | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    let version = 0;
    const refresh = () => {
      const request = ++version;
      void organizationRequest<PersonalModeration>(API_PATHS.moderationPersonal)
        .then((data) => {
          if (active && request === version) {
            setRows(data.sanctions);
            setDetails(data);
            setError('');
          }
        })
        .catch(() => {
          if (active && request === version)
            setError('利用制限を取得できませんでした。ページを開き直してください。');
        })
        .finally(() => {
          if (active && request === version) setLoading(false);
        });
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('notifications:refresh', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('notifications:refresh', refresh);
    };
  }, []);
  return { details, rows: useActiveSanctions(rows), error, loading };
}
