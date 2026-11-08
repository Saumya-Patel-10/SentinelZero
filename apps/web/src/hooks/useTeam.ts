import { useState, useEffect, useCallback } from 'react';
import { spacetimeClient } from '../services/spacetimeClient';
import { UserProfile, Role } from '../services/contracts';

export function useTeam() {
  const [users, setUsers] = useState<UserProfile[]>(spacetimeClient.getState().users || []);
  const [currentUser, setCurrentUser] = useState<UserProfile>(spacetimeClient.getState().currentUser);

  useEffect(() => {
    return spacetimeClient.subscribe((state) => {
      setUsers(state.users || []);
      setCurrentUser(state.currentUser);
    });
  }, []);

  const inviteMember = useCallback(async (payload: { displayName: string; email: string; role: Role }) => {
    return await spacetimeClient.inviteMember(payload);
  }, []);

  const updateUserRole = useCallback(async (userId: string, newRole: Role) => {
    return await spacetimeClient.updateUserRole(userId, newRole);
  }, []);

  const removeMember = useCallback(async (userId: string) => {
    return await spacetimeClient.removeMember(userId);
  }, []);

  return {
    users,
    currentUser,
    inviteMember,
    updateUserRole,
    removeMember,
  };
}

