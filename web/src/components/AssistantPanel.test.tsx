import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, ApiError, AssistantRun, LeadDetail } from '@/lib/api';
import { AssistantPanel } from './AssistantPanel';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      listRuns: vi.fn(),
      getRun: vi.fn(),
      startRun: vi.fn(),
      approveAction: vi.fn(),
      rejectAction: vi.fn(),
    },
  };
});

const mocked = vi.mocked(api);

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
    {
      id: 'm1',
      leadId: 'lead-1',
      direction: 'inbound',
      channel: 'whatsapp',
      body: 'Looking for a 2-bed in Dubai Marina, around 2M. Call me tomorrow?',
      sentAt: '2026-10-15T10:00:00.000Z',
    },
  ],
};

const followUp = {
  id: 'act-1',
  type: 'create_follow_up_task' as const,
  status: 'pending_approval' as const,
  task: { title: 'Call Karim about Marina 2-beds', notes: 'Send MBR-1001 first', dueAt: '2026-10-16T06:00:00.000Z' },
  needsClarification: null,
};

const run: AssistantRun = {
  id: 'run-1',
  leadId: 'lead-1',
  messageId: 'm1',
  messageIds: ['m1'],
  trigger: 'manual',
  status: 'completed',
  requirements: {
    locations: ['Dubai Marina'],
    bedrooms: 2,
    budgetAed: { min: null, max: 2000000 },
    propertyType: 'apartment',
    intent: 'buy',
    preferences: ['good rental yield'],
  },
  recommendations: [
    {
      propertyId: 'p1',
      reason: 'Best yield in budget',
      reference: 'MBR-1001',
      title: 'Marina Gate 2BR',
      priceAed: 1950000,
      grossYieldPct: 7.32,
    },
    { propertyId: 'p2', reason: 'Lower price, older building', reference: 'MBR-1007', priceAed: 1700000, grossYieldPct: null },
  ],
  summary: 'Karim wants a 2-bed in Dubai Marina to buy, with a good yield.',
  priceChecks: [],
  proposedActions: [followUp],
  trace: [],
  createdAt: '2026-10-15T10:01:00.000Z',
};

function renderPanel(onChanged = vi.fn()) {
  render(
    <AssistantPanel lead={lead} token="tok" timeZone="Asia/Dubai" onChanged={onChanged} onUnauthorized={vi.fn()} />,
  );
  return onChanged;
}

describe('AssistantPanel', () => {
  beforeEach(() => vi.resetAllMocks());

  it('shows the latest run: what was understood, the ranked listings and the follow-up due date', async () => {
    mocked.listRuns.mockResolvedValue([run]);
    renderPanel();

    expect(await screen.findByText('Karim wants a 2-bed in Dubai Marina to buy, with a good yield.')).toBeInTheDocument();
    expect(screen.getByText(/1\. MBR-1001/)).toBeInTheDocument();
    expect(screen.getByText(/2\. MBR-1007/)).toBeInTheDocument();
    expect(screen.getByText('AED 1,950,000 · 7.32% gross yield')).toBeInTheDocument();
    expect(screen.getByText('up to AED 2,000,000')).toBeInTheDocument();
    // 06:00 UTC is 10:00 in Dubai.
    expect(screen.getByText('Due 16 Oct, 10:00')).toBeInTheDocument();
    expect(mocked.listRuns).toHaveBeenCalledWith('tok', 'lead-1');
  });

  it('approves a follow-up, updates it in place, shows warnings and tells the page', async () => {
    mocked.listRuns.mockResolvedValue([run]);
    mocked.approveAction.mockResolvedValue({
      action: { ...followUp, status: 'approved', taskId: 't1' },
      task: {
        id: 't1',
        leadId: 'lead-1',
        title: followUp.task.title,
        notes: followUp.task.notes,
        dueAt: followUp.task.dueAt,
        status: 'open',
        createdBy: { id: 'a1', name: 'Sara Khan' },
        createdAt: '2026-10-15T10:02:00.000Z',
      },
      warnings: ['MBR-1007 is no longer available.'],
    });
    const onChanged = renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mocked.approveAction).toHaveBeenCalledWith('tok', 'lead-1', 'run-1', 'act-1');
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('MBR-1007 is no longer available.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('says the budget is used up when starting a run gives a 429', async () => {
    mocked.listRuns.mockResolvedValue([]);
    mocked.startRun.mockRejectedValue(new ApiError(429, 'Budget exceeded'));
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Analyze latest message' }));

    expect(await screen.findByText("Your agency's AI budget for this month is used up.")).toBeInTheDocument();
  });

  it('reports a failed run as a failure', async () => {
    mocked.listRuns.mockResolvedValue([
      { ...run, status: 'failed', error: 'Model timed out', recommendations: [], proposedActions: [] },
    ]);
    renderPanel();

    expect(await screen.findByText('The assistant failed: Model timed out')).toBeInTheDocument();
  });
});
