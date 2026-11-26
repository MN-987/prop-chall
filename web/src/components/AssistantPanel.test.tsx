import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('shows the latest run as cards: what was understood, the ranked listings and the follow-up due date', async () => {
    mocked.listRuns.mockResolvedValue([run]);
    renderPanel();

    expect(await screen.findByText('Karim wants a 2-bed in Dubai Marina to buy, with a good yield.')).toBeInTheDocument();
    expect(screen.getByText('What Karim wants')).toBeInTheDocument();
    expect(screen.getByText('Up to AED 2M')).toBeInTheDocument();
    expect(screen.getByText('2 bed')).toBeInTheDocument();
    expect(screen.getByText('To buy')).toBeInTheDocument();

    const cards = screen.getAllByRole('listitem').filter((item) => item.querySelector('[aria-label^="Rank"]'));
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('MBR-1001')).toBeInTheDocument();
    expect(within(cards[0]).getByText('AED 1.95M')).toBeInTheDocument();
    expect(within(cards[0]).getByText('7.32% gross yield')).toBeInTheDocument();
    expect(within(cards[1]).getByText('MBR-1007')).toBeInTheDocument();
    expect(within(cards[1]).getByText('Yield unknown')).toBeInTheDocument();

    // 06:00 UTC is 10:00 in Dubai.
    expect(screen.getByText('Due 16 Oct, 10:00')).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze again' })).toBeEnabled();
    expect(mocked.listRuns).toHaveBeenCalledWith('tok', 'lead-1');
  });

  it('shows live steps while the agent works', async () => {
    const live: AssistantRun = {
      ...run,
      status: 'running',
      summary: '',
      recommendations: [],
      proposedActions: [],
      createdAt: new Date().toISOString(),
      trace: [
        {
          tool: 'search_listings',
          input: { area: 'Dubai Marina', minBedrooms: 2, maxBedrooms: 2, maxPriceAed: 2200000 },
          output: { totalMatching: 7, returned: 7, listings: [] },
          durationMs: 40,
        },
        {
          tool: 'get_listing',
          input: { listing: 'MBR-1099' },
          output: { found: false, listing: 'MBR-1099' },
          durationMs: 10,
        },
      ],
    };
    mocked.listRuns.mockResolvedValue([live]);
    mocked.getRun.mockResolvedValue(live);
    renderPanel();

    expect(await screen.findByText('Searched Dubai Marina, 2 bed, up to AED 2.2M: 7 found')).toBeInTheDocument();
    expect(screen.getByText('Read the conversation')).toBeInTheDocument();
    expect(screen.getByText('Looked up MBR-1099: not found')).toBeInTheDocument();
    expect(screen.getByText('Checking the picks against the data and drafting the follow-up')).toBeInTheDocument();
    expect(screen.getByText(/^\d+ s$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze again' })).toBeDisabled();
  });

  it('starts a run in the background and polls it until it is done', async () => {
    mocked.listRuns.mockResolvedValue([]);
    mocked.startRun.mockResolvedValue({ ...run, status: 'running', trace: [], proposedActions: [] });
    mocked.getRun.mockResolvedValue(run);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Analyze latest message' }));

    expect(await screen.findByText('Checking the picks against the data and drafting the follow-up')).toBeInTheDocument();
    expect(
      await screen.findByText('Karim wants a 2-bed in Dubai Marina to buy, with a good yield.', {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(mocked.getRun).toHaveBeenCalledWith('tok', 'lead-1', 'run-1');
    expect(screen.queryByText('Checking the picks against the data and drafting the follow-up')).not.toBeInTheDocument();
  });

  it('sends the chosen tool planner with the run, and says which one chose the tools', async () => {
    mocked.listRuns.mockResolvedValue([]);
    mocked.startRun.mockResolvedValue({ ...run, toolPlanner: { name: 'jev', costUsd: 0.0001 } });
    renderPanel();

    fireEvent.change(await screen.findByLabelText('Tools chosen by'), { target: { value: 'jev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze latest message' }));

    await waitFor(() => expect(mocked.startRun).toHaveBeenCalledWith('tok', 'lead-1', 'jev'));
    expect(await screen.findByText(/tools chosen by Jev/)).toBeInTheDocument();
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

    expect(await screen.findByText('The assistant failed')).toBeInTheDocument();
    expect(screen.getByText('Model timed out')).toBeInTheDocument();
    expect(screen.queryByText('Recommended listings')).not.toBeInTheDocument();
  });
});
