import { describe, it, expect, beforeEach } from 'vitest';
import { spacetimeClient } from '../services/spacetimeClient';
import { MOCK_USERS } from '../fixtures/mockData';

describe('Role Authorization Matrix & Reducer Privilege Checks', () => {
  beforeEach(() => {
    spacetimeClient.setCurrentUser(MOCK_USERS[0]); // Commander
  });

  it('allows Commander to approve tasks and commits audit event', async () => {
    const task = await spacetimeClient.createTask({
      title: 'Emergency Firewall Rule Modification',
      description: 'Block outbound TCP 445 on perimeter interface',
      priority: 'CRITICAL',
      assigned_identity: 'identity_elena_rostova',
      requires_approval: true,
    });

    expect(task.approval_status).toBe('PENDING_APPROVAL');

    const approved = await spacetimeClient.approveTask(task.id);
    expect(approved.approval_status).toBe('APPROVED');
    expect(approved.status).toBe('IN_PROGRESS');
    expect(approved.approved_by).toBe(MOCK_USERS[0].auth_identity);

    // Verify audit log appended
    const auditLogs = spacetimeClient.getState().auditLogs;
    const approvalAudit = auditLogs.find((l) => l.target_id === task.id && l.event_type === 'TASK_APPROVED');
    expect(approvalAudit).toBeDefined();
  });

  it('rejects Observer attempting privileged mutations', async () => {
    spacetimeClient.setCurrentUser(MOCK_USERS[3]); // Observer David Kim

    // Cannot approve tasks
    await expect(spacetimeClient.approveTask('tsk_06')).rejects.toThrowError(/ACCESS_DENIED/);

    // Cannot send messages
    await expect(spacetimeClient.sendMessage('Unauthorized broadcast')).rejects.toThrowError(/ACCESS_DENIED/);

    // Cannot create tasks
    await expect(
      spacetimeClient.createTask({
        title: 'Observer task',
        description: 'Should fail',
        priority: 'LOW',
        assigned_identity: 'identity_david_kim',
      })
    ).rejects.toThrowError(/ACCESS_DENIED/);
  });

  it('follows the shared capability matrix: RESPONDER cannot create tasks, ANALYST cannot approve', async () => {
    spacetimeClient.setCurrentUser(MOCK_USERS[2]); // Responder
    await expect(
      spacetimeClient.createTask({
        title: 'Responder task',
        description: 'Should fail',
        priority: 'LOW',
        assigned_identity: 'identity_elena_rostova',
      })
    ).rejects.toThrowError(/ACCESS_DENIED/);

    spacetimeClient.setCurrentUser(MOCK_USERS[1]); // Analyst
    await expect(spacetimeClient.approveTask('tsk_06')).rejects.toThrowError(/ACCESS_DENIED/);
  });
});

