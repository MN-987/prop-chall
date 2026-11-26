import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { api, AssistantRun, LeadDetail } from '../lib/api';
import { AssistantPanel } from './AssistantPanel';

jest.mock('../lib/api', () => {
  const actual = jest.requireActual('../lib/api');
  return {
    ...actual,
    api: { listRuns: jest.fn(), getRun: jest.fn(), startRun: jest.fn(), approveAction: jest.fn(), rejectAction: jest.fn() },
  };
});

const mocked = jest.mocked(api);

const lead: LeadDetail = {
  id: 'lead-1',
  name: 'Karim',
  phone: null,
  email: null,
  source: 'whatsapp',
  status: 'new',
  notes: null,
  assignedAgent: null,
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  messageCount: 1,
  messages: [
    { id: 'm1', leadId: 'lead-1', direction: 'inbound', channel: 'whatsapp', body: 'Hi', sentAt: '2026-10-15T10:00:00.000Z' },
  ],
};

const followUp = {
  id: 'act-1',
  type: 'create_follow_up_task' as const,
  status: 'pending_approval' as const,
  task: { title: 'Call Karim', notes: null, dueAt: '2026-10-16T06:00:00.000Z' },
  needsClarification: null,
};

const run: AssistantRun = {
  id: 'run-1',
  leadId: 'lead-1',
  messageId: 'm1',
  messageIds: ['m1'],
  trigger: 'whatsapp',
  status: 'completed',
  requirements: {
    locations: ['Dubai Marina'],
    bedrooms: 0,
    budgetAed: { min: null, max: 2000000 },
    propertyType: 'apartment',
    intent: 'buy',
    preferences: [],
  },
  recommendations: [
    { propertyId: 'p1', reason: 'Best yield in budget', reference: 'MBR-1001', priceAed: 1950000, grossYieldPct: 7.32 },
  ],
  summary: 'Karim wants a studio in Dubai Marina.',
  priceChecks: [],
  proposedActions: [followUp],
  trace: [],
  createdAt: '2026-10-15T10:01:00.000Z',
};

describe('AssistantPanel', () => {
  beforeEach(() => jest.resetAllMocks());

  it('shows the latest run and approves its follow-up', async () => {
    mocked.listRuns.mockResolvedValue([run]);
    mocked.approveAction.mockResolvedValue({
      action: { ...followUp, status: 'approved' },
      task: {
        id: 't1',
        leadId: 'lead-1',
        title: 'Call Karim',
        notes: null,
        dueAt: followUp.task.dueAt,
        status: 'open',
        createdBy: { id: 'a1', name: 'Sara Khan' },
        createdAt: '2026-10-15T10:02:00.000Z',
      },
      warnings: [],
    });
    const onChanged = jest.fn();
    await render(
      <AssistantPanel lead={lead} token="tok" timeZone="Asia/Dubai" onChanged={onChanged} onUnauthorized={jest.fn()} />,
    );

    expect(await screen.findByText('Karim wants a studio in Dubai Marina.')).toBeTruthy();
    expect(screen.getByText(/1\. MBR-1001/)).toBeTruthy();
    expect(screen.getByText('AED 1,950,000 · 7.32% gross yield')).toBeTruthy();
    expect(screen.getByText(/Studio/)).toBeTruthy();
    // 06:00 UTC is 10:00 in Dubai.
    expect(screen.getByText('Due 16 Oct, 10:00')).toBeTruthy();

    await fireEvent.press(screen.getByText('Approve'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mocked.approveAction).toHaveBeenCalledWith('tok', 'lead-1', 'run-1', 'act-1');
    expect(screen.getByText('Approved')).toBeTruthy();
  });
});
