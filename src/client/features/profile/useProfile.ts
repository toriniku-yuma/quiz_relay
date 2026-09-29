import { useState } from 'react';
import { API_PATHS } from '../../../shared/api-paths';
import { normalizeDisplayName, type Profile } from '../../../shared/profile';
import { useApp } from '../../app/context';
import { organizationRequest } from '../organization/useOrganization';

export function useProfile(initial: Profile) {
  const { organization } = useApp();
  const [profile, setProfile] = useState(initial);
  const [name, setName] = useState(initial.displayName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function save() {
    if (busy) return;
    setError('');
    setMessage('');
    const displayName = normalizeDisplayName(name);
    if (displayName === undefined) {
      setError('表示名を1〜32文字で入力してください。改行・制御文字は使えません。');
      return;
    }
    setBusy(true);
    try {
      const saved = await organizationRequest<Profile>(API_PATHS.organizationProfile, {
        displayName,
        revision: profile.revision,
      });
      setProfile(saved);
      setName((current) => (current === name ? (saved.displayName ?? '') : current));
      setMessage('表示名を保存しました。');
      await organization.refresh();
      window.dispatchEvent(new Event('profile:refresh'));
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  return { name, setName, busy, error, message, save };
}
