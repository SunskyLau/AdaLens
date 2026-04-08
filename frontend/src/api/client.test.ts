import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { startRun, steerRun, uploadDataset } from './client.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('steerRun posts steer content to the run gateway', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        run_id: 'run_123',
        status: 'accepted',
        message: {
          message_id: 'msg_123',
          timestamp: '2026-03-07T22:00:00',
          content: 'Focus on Q4',
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }) as typeof fetch;

  const response = await steerRun('run_123', { content: 'Focus on Q4' });

  assert.equal(capturedUrl, '/api/runs/run_123/steer');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.headers && (capturedInit.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), { content: 'Focus on Q4' });
  assert.equal(response.status, 'accepted');
  assert.equal(response.message.content, 'Focus on Q4');
});

test('steerRun posts structured focus metadata to the run gateway', async () => {
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return new Response(
      JSON.stringify({
        run_id: 'run_123',
        status: 'accepted',
        message: {
          message_id: 'msg_456',
          timestamp: '2026-03-15T10:00:00.000Z',
          content: 'Focus prompt',
          kind: 'focus',
          display_text: 'Revenue spike',
          generated_prompt: 'Legacy focus prompt',
          user_prompt: 'Focus follow-up analysis on the summary "Revenue spike".',
          system_prompt: 'Focus steering semantics:\n- Continue allocating attention around this summary target in subsequent planning.',
          selected_keywords: ['Revenue', 'Q4'],
          target: {
            kind: 'summary',
            summary_id: 's1',
            summary_short_label: 'Revenue spike',
            summary_text: 'Revenue spikes in Q4.',
            columns: ['Revenue', 'Quarter'],
          },
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }) as typeof fetch;

  await steerRun('run_123', {
    content: 'Focus prompt',
    kind: 'focus',
    display_text: 'Revenue spike',
    user_prompt: 'Focus follow-up analysis on the summary "Revenue spike".',
    system_prompt: 'Focus steering semantics:\n- Continue allocating attention around this summary target in subsequent planning.',
    selected_keywords: ['Revenue', 'Q4'],
    target: {
      kind: 'summary',
      summary_id: 's1',
      summary_short_label: 'Revenue spike',
      summary_text: 'Revenue spikes in Q4.',
      columns: ['Revenue', 'Quarter'],
    },
  });

  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    content: 'Focus prompt',
    kind: 'focus',
    display_text: 'Revenue spike',
    user_prompt: 'Focus follow-up analysis on the summary "Revenue spike".',
    system_prompt: 'Focus steering semantics:\n- Continue allocating attention around this summary target in subsequent planning.',
    selected_keywords: ['Revenue', 'Q4'],
    target: {
      kind: 'summary',
      summary_id: 's1',
      summary_short_label: 'Revenue spike',
      summary_text: 'Revenue spikes in Q4.',
      columns: ['Revenue', 'Quarter'],
    },
  });
});

test('steerRun posts elaborate steering metadata to the run gateway', async () => {
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return new Response(
      JSON.stringify({
        run_id: 'run_123',
        status: 'accepted',
        message: {
          message_id: 'msg_elaborate',
          timestamp: '2026-03-20T10:15:00.000Z',
          content: 'Elaborate on the Q4 spike',
          kind: 'elaborate',
          display_text: 'Revenue spikes in Q4.',
          generated_prompt: 'Legacy elaborate prompt',
          user_prompt: 'Elaborate on the summary "Revenue spike" by explaining what it means, what drives it, and why it happens.',
          system_prompt: 'Elaborate steering semantics:\n- Keep investigating the explanation, mechanism, and root causes of this specific insight.',
          target: {
            kind: 'summary',
            summary_id: 's1',
            summary_short_label: 'Revenue spike',
            summary_text: 'Revenue spikes in Q4.',
            columns: ['Revenue', 'Quarter'],
          },
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }) as typeof fetch;

  await steerRun('run_123', {
    content: 'Elaborate on the Q4 spike',
    kind: 'elaborate',
    display_text: 'Revenue spikes in Q4.',
    user_prompt: 'Elaborate on the summary "Revenue spike" by explaining what it means, what drives it, and why it happens.',
    system_prompt: 'Elaborate steering semantics:\n- Keep investigating the explanation, mechanism, and root causes of this specific insight.',
    target: {
      kind: 'summary',
      summary_id: 's1',
      summary_short_label: 'Revenue spike',
      summary_text: 'Revenue spikes in Q4.',
      columns: ['Revenue', 'Quarter'],
    },
  });

  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    content: 'Elaborate on the Q4 spike',
    kind: 'elaborate',
    display_text: 'Revenue spikes in Q4.',
    user_prompt: 'Elaborate on the summary "Revenue spike" by explaining what it means, what drives it, and why it happens.',
    system_prompt: 'Elaborate steering semantics:\n- Keep investigating the explanation, mechanism, and root causes of this specific insight.',
    target: {
      kind: 'summary',
      summary_id: 's1',
      summary_short_label: 'Revenue spike',
      summary_text: 'Revenue spikes in Q4.',
      columns: ['Revenue', 'Quarter'],
    },
  });
});

test('steerRun posts structured ignore column metadata to the run gateway', async () => {
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return new Response(
      JSON.stringify({
        run_id: 'run_123',
        status: 'accepted',
        message: {
          message_id: 'msg_789',
          timestamp: '2026-03-15T10:05:00.000Z',
          content: 'Ignore Revenue',
          kind: 'ignore',
          display_text: 'Revenue',
          generated_prompt: 'Legacy ignore prompt',
          user_prompt: 'Deprioritize future analysis on the dataset column Revenue.',
          system_prompt: 'Ignore steering semantics:\n- Stop pursuing future planning centered on this dataset column.',
          target: {
            kind: 'column',
            summary_id: '',
            summary_short_label: '',
            summary_text: '',
            columns: ['Revenue'],
          },
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }) as typeof fetch;

  await steerRun('run_123', {
    content: 'Ignore Revenue',
    kind: 'ignore',
    display_text: 'Revenue',
    user_prompt: 'Deprioritize future analysis on the dataset column Revenue.',
    system_prompt: 'Ignore steering semantics:\n- Stop pursuing future planning centered on this dataset column.',
    target: {
      kind: 'column',
      summary_id: '',
      summary_short_label: '',
      summary_text: '',
      columns: ['Revenue'],
    },
  });

  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    content: 'Ignore Revenue',
    kind: 'ignore',
    display_text: 'Revenue',
    user_prompt: 'Deprioritize future analysis on the dataset column Revenue.',
    system_prompt: 'Ignore steering semantics:\n- Stop pursuing future planning centered on this dataset column.',
    target: {
      kind: 'column',
      summary_id: '',
      summary_short_label: '',
      summary_text: '',
      columns: ['Revenue'],
    },
  });
});

test('steerRun posts targetless create metadata to the run gateway', async () => {
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return new Response(
      JSON.stringify({
        run_id: 'run_123',
        status: 'accepted',
        message: {
          message_id: 'msg_create',
          timestamp: '2026-03-15T10:10:00.000Z',
          content: 'Check whether Q4 growth is concentrated in a single segment',
          kind: 'create',
          display_text: 'Check whether Q4 growth is concentrated in a single segment',
          generated_prompt: '',
          target: null,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }) as typeof fetch;

  await steerRun('run_123', {
    content: 'Check whether Q4 growth is concentrated in a single segment',
    kind: 'create',
    display_text: 'Check whether Q4 growth is concentrated in a single segment',
    target: null,
  });

  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    content: 'Check whether Q4 growth is concentrated in a single segment',
    kind: 'create',
    display_text: 'Check whether Q4 growth is concentrated in a single segment',
    target: null,
  });
});

test('steerRun surfaces gateway validation errors', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'content is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  await assert.rejects(() => steerRun('run_123', { content: '' }), {
    message: 'content is required',
  });
});

test('steerRun surfaces ended-session errors from the run gateway', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'The analysis session has ended. Please start a new conversation.' }), {
      status: 410,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

  await assert.rejects(() => steerRun('run_123', { content: 'Continue the analysis' }), {
    message: 'The analysis session has ended. Please start a new conversation.',
  });
});

test('startRun posts user goal to the run gateway', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        run_id: 'run_456',
        status: 'started',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }) as typeof fetch;

  const response = await startRun({
    dataset_path: 'data/vgsales.csv',
    user_goal: 'Summarize the main patterns in this dataset',
  });

  assert.equal(capturedUrl, '/api/runs/start');
  assert.equal(capturedInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    dataset_path: 'data/vgsales.csv',
    user_goal: 'Summarize the main patterns in this dataset',
  });
  assert.equal(response.run_id, 'run_456');
});

test('startRun strips removed initial_informs payloads before posting to the run gateway', async () => {
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedInit = init;
    return new Response(
      JSON.stringify({
        run_id: 'run_789',
        status: 'started',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }) as typeof fetch;

  await startRun({
    dataset_path: 'data/vgsales.csv',
    user_goal: 'Summarize the main patterns in this dataset',
    initial_informs: ['Prefer business impact first', 'Avoid sports-specific assumptions'],
  } as any);

  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    dataset_path: 'data/vgsales.csv',
    user_goal: 'Summarize the main patterns in this dataset',
  });
});

test('uploadDataset posts multipart form data to the dataset upload endpoint', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        dataset_path: '/abs/path/upload.csv',
        original_filename: 'upload.csv',
        size_bytes: 12,
        temporary: true,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }) as typeof fetch;

  const file = new File(['a,b\n1,2\n'], 'upload.csv', { type: 'text/csv' });
  const response = await uploadDataset(file);

  assert.equal(capturedUrl, '/api/datasets/upload');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.body instanceof FormData, true);
  assert.equal(response.dataset_path, '/abs/path/upload.csv');
  assert.equal(response.original_filename, 'upload.csv');
  assert.equal(response.temporary, true);
});

