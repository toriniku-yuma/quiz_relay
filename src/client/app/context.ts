import { createContext, type Dispatch, type SetStateAction, useContext } from 'react';
import type { Auth } from '../features/auth/useAuth';
import type { useExternalInstances } from '../features/federation/useExternalInstances';
import type { useForeignLogin } from '../features/federation/useForeignLogin';
import type { useForeignParticipation } from '../features/federation/useForeignParticipation';
import type { useOrganization } from '../features/organization/useOrganization';
import type { useGuest } from '../features/rooms/useGuest';

export type MatchStatus = {
  instanceId: string;
  retained: boolean;
  roomId: string | null;
  finished: boolean;
  href?: string;
  mode?: 'ranked' | 'casual' | 'room';
  playing?: boolean;
};

export const AppContext = createContext<{
  auth: Auth;
  organization: ReturnType<typeof useOrganization>;
  url: URL;
  matchStatus: MatchStatus | null;
  setMatchStatus: Dispatch<SetStateAction<MatchStatus | null>>;
  guest?: ReturnType<typeof useGuest>;
  externalInstances?: ReturnType<typeof useExternalInstances>;
  foreignLogin?: ReturnType<typeof useForeignLogin>;
  foreignParticipation?: ReturnType<typeof useForeignParticipation>;
  logout?: () => Promise<void>;
} | null>(null);

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('AppContext is required');
  return context;
}
