import { useState, useEffect } from 'react';
import { spacetimeClient } from '../services/spacetimeClient';
import { UserProfile, Role } from '../services/contracts';
import { MOCK_USERS } from '../fixtures/mockData';
import { useUIStore } from '../stores/uiStore';
import { roleHas, type Capability } from '@shared/permissions';

export function useAuth() {
  const [currentUser, setCurrentUser] = useState<UserProfile>(spacetimeClient.getState().currentUser);
  const activeRole = useUIStore((s) => s.activeRole);
  const setActiveRole = useUIStore((s) => s.setActiveRole);

  useEffect(() => {
    return spacetimeClient.subscribe((state) => {
      setCurrentUser(state.currentUser);
    });
  }, []);

  const switchRole = (newRole: Role) => {
    const matchedUser = MOCK_USERS.find((u) => u.role === newRole) || {
      id: `usr_${newRole.toLowerCase()}`,
      auth_identity: `identity_${newRole.toLowerCase()}`,
      display_name: `${newRole.charAt(0) + newRole.slice(1).toLowerCase()} User`,
      email: `${newRole.toLowerCase()}@out-of-band-ops.net`,
      role: newRole,
    };
    setActiveRole(newRole);
    spacetimeClient.setCurrentUser(matchedUser);
  };

  const isCommander = currentUser.role === 'COMMANDER' || currentUser.role === 'OWNER';
  const isAnalyst = currentUser.role === 'ANALYST';
  const isResponder = currentUser.role === 'RESPONDER';
  const isObserver = currentUser.role === 'OBSERVER';

  const can = (capability: Capability) => roleHas(currentUser.role, capability);

  const canApproveTasks = can('APPROVE_TASK');
  const canMutate = !isObserver;
  const canReopenIncident = isCommander;
  const canRequestAgentRun = can('REQUEST_AGENT_RUN');
  const canViewAgentActivity = can('VIEW_AGENT_ACTIVITY');

  return {
    currentUser,
    role: currentUser.role,
    isCommander,
    isAnalyst,
    isResponder,
    isObserver,
    canApproveTasks,
    canMutate,
    canReopenIncident,
    canRequestAgentRun,
    canViewAgentActivity,
    can,
    switchRole,
    availableUsers: MOCK_USERS,
  };
}

