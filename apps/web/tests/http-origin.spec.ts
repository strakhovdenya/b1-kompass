import { randomUUID } from 'node:crypto';
import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { GUEST_COOKIE } from '../src/server/guest-session/cookie';
import { PILOT_EXAM_SLUG } from '../src/server/material/published';
import {
  depsNow,
  newGuest,
  readAttempts,
  readCommandRows,
  serviceDb,
  startBody,
} from './support/db';
import {
  FULL_EXAM,
  FULL_PILOT,
  fullKeyOf,
  publishExamPair,
} from './support/full-exam';
import { createTestRecording } from './support/global-setup';
import { confirmationOf, postCommand } from './support/guest-browser';
import { PAIR_EXAM } from './support/pair-exam';
import { examAttemptOwners, guestRows, sqlRunnerAs } from './support/sql';

// The start Route Handler on each of the three e2e servers. Every server
// trusts exactly its own APP_ORIGIN: a missing Origin, another site and the
// sibling test servers are refused before the session is even read. The
// guest is authorized by its cookie only.

const SERVERS = [
  { origin: 'http://localhost:3100', slug: PILOT_EXAM_SLUG },
  { origin: 'http://localhost:3101', slug: PAIR_EXAM.slug },
  { origin: 'http://localhost:3102', slug: FULL_EXAM.slug },
] as const;

const FULL_SERVER = SERVERS[2];
const START_PATH = '/api/attempts/start';
const MAX_COMMAND_BYTES = 64 * 1024;

interface Guest {
  token: string;
  sessionId: string;
  visitorId: string;
}

const createGuest = async (): Promise<Guest> => {
  const created = await newGuest(depsNow());
  return {
    token: created.token,
    sessionId: created.guest.sessionId,
    visitorId: created.guest.visitorId,
  };
};

const clientFor = (baseURL: string): Promise<APIRequestContext> =>
  request.newContext({ baseURL });

const cookieOf = (guest: Guest): string => `${GUEST_COOKIE}=${guest.token}`;

interface Writes {
  attempts: number;
  runs: number;
  commands: number;
  events: number;
}

// Everything a start could write for the guest, re-read from the database.
const writesOf = async (guest: Guest): Promise<Writes> => {
  const attempts = await readAttempts(guest.sessionId);
  const ids = attempts.map((attempt) => attempt.id);
  const runs = await serviceDb
    .from('attempt_runs')
    .select('attempt_id')
    .in('attempt_id', ids);
  if (runs.error) throw runs.error;
  const events = await serviceDb
    .from('guest_events')
    .select('kind')
    .eq('visitor_id', guest.visitorId)
    .neq('kind', 'entry');
  if (events.error) throw events.error;
  return {
    attempts: attempts.length,
    runs: runs.data.length,
    commands: (await readCommandRows(guest.sessionId)).length,
    events: events.data.length,
  };
};

const NOTHING: Writes = { attempts: 0, runs: 0, commands: 0, events: 0 };

const postStart = (
  client: APIRequestContext,
  guest: Guest,
  data: string,
  headers: Record<string, string>,
): Promise<APIResponse> =>
  client.post(START_PATH, {
    headers: { cookie: cookieOf(guest), ...headers },
    data,
    maxRedirects: 0,
  });

const expectRefused = async (
  response: APIResponse,
  status: number,
  failure: string,
) => {
  expect(response.status()).toBe(status);
  expect(response.headers()['cache-control']).toBe('private, no-store');
  expect(await response.json()).toEqual({ ok: false, failure });
};

test('each server accepts only its configured origin positive control', async () => {
  for (const server of SERVERS) {
    const guest = await createGuest();
    const client = await clientFor(server.origin);
    try {
      const body = await startBody(server.slug);
      const response = await postStart(client, guest, JSON.stringify(body), {
        origin: server.origin,
        'content-type': 'application/json',
      });
      expect(response.status(), server.origin).toBe(200);
      expect(response.headers()['cache-control']).toBe('private, no-store');
      const text = await response.text();
      const json = JSON.parse(text) as {
        ok: boolean;
        result: { outcome: string; attemptId: string; state: unknown };
      };
      expect(Object.keys(json).sort()).toEqual(['ok', 'result']);
      expect(json.ok).toBe(true);
      expect(Object.keys(json.result).sort()).toEqual([
        'attemptId',
        'outcome',
        'state',
      ]);
      expect(json.result.outcome).toBe('accepted');
      expect(json.result.state).toMatchObject({
        mode: 'training',
        selection: 'all',
        status: 'active',
        phase: 'open',
      });
      // The start answers with the lifecycle only: no key, no material.
      expect(text).not.toMatch(/correct|solution|answer_key|options/i);

      const attempts = await readAttempts(guest.sessionId);
      expect(attempts).toEqual([
        { id: json.result.attemptId, status: 'active' },
      ]);
      expect(await writesOf(guest)).toEqual({
        attempts: 1,
        runs: 1,
        commands: 1,
        events: 1,
      });
    } finally {
      await client.dispose();
    }
  }
});

test('missing foreign and sibling origins are refused on every server', async () => {
  for (const server of SERVERS) {
    const siblings = SERVERS.filter((other) => other !== server).map(
      (other) => other.origin,
    );
    const origins: (string | null)[] = [
      null,
      'https://evil.example',
      'null',
      ...siblings,
    ];
    const client = await clientFor(server.origin);
    try {
      for (const origin of origins) {
        const guest = await createGuest();
        const body = JSON.stringify(await startBody(server.slug));
        const headers: Record<string, string> = {
          'content-type': 'application/json',
        };
        if (origin !== null) headers.origin = origin;
        const response = await postStart(client, guest, body, headers);
        await expectRefused(response, 403, 'origin-refused');
        expect(await writesOf(guest), `${server.origin} ${origin}`).toEqual(
          NOTHING,
        );
      }
    } finally {
      await client.dispose();
    }
  }
});

test('invalid method content type oversized body and extra fields are refused', async () => {
  const client = await clientFor(FULL_SERVER.origin);
  const json = { 'content-type': 'application/json' };
  const origin = { origin: FULL_SERVER.origin };
  try {
    const guest = await createGuest();
    const body = await startBody(FULL_SERVER.slug);
    const valid = JSON.stringify(body);

    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const response = await client.fetch(START_PATH, {
        method,
        headers: { cookie: cookieOf(guest), ...origin, ...json },
        data: method === 'GET' ? undefined : valid,
        maxRedirects: 0,
      });
      expect(response.status(), method).toBe(405);
    }

    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      const response = await postStart(client, guest, valid, {
        ...origin,
        'content-type': type,
      });
      await expectRefused(response, 415, 'unsupported-media-type');
    }

    const oversized = JSON.stringify({
      ...body,
      examSlug: 'x'.repeat(MAX_COMMAND_BYTES + 1),
    });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(MAX_COMMAND_BYTES);
    await expectRefused(
      await postStart(client, guest, oversized, { ...origin, ...json }),
      413,
      'payload-too-large',
    );

    const extras = {
      owner: guest.sessionId,
      status: 'completed',
      score: 45,
      guestSessionId: guest.sessionId,
      acceptedAt: '2020-01-01T00:00:00.000Z',
      token: guest.token,
    };
    for (const [field, value] of Object.entries(extras)) {
      const data = JSON.stringify({ ...body, [field]: value });
      await expectRefused(
        await postStart(client, guest, data, { ...origin, ...json }),
        400,
        'invalid-input',
      );
    }

    await expectRefused(
      await postStart(client, guest, '{"commandId":', { ...origin, ...json }),
      400,
      'invalid-input',
    );
    expect(await writesOf(guest)).toEqual(NOTHING);

    // The same guest, origin and route with the allowed body start.
    const accepted = await postStart(client, guest, valid, {
      ...origin,
      ...json,
    });
    expect(accepted.status()).toBe(200);
    const result = (await accepted.json()) as {
      ok: boolean;
      result: { outcome: string };
    };
    expect(result.ok).toBe(true);
    expect(result.result.outcome).toBe('accepted');
    expect(await writesOf(guest)).toEqual({
      attempts: 1,
      runs: 1,
      commands: 1,
      events: 1,
    });
  } finally {
    await client.dispose();
  }
});

// The second exam (#85) ------------------------------------------------------
//
// CSRF on its own: the guest, the cookie, the attempt and the body are all
// valid, only the Origin is not. The victim holds an attempt of exam B and a
// free slot of exam A, so an accepted start would write. Every refused body
// is sent again with the trusted Origin afterwards and is accepted: nothing
// but the Origin refused it.

const otherOptionOf = (questionId: string): string => {
  const question = FULL_PILOT.content.questions.find(
    (item) => item.id === questionId,
  );
  const first = fullKeyOf(questionId);
  const other = question?.options.find((option) => option.id !== first);
  if (!other) throw new Error(`no other option for ${questionId}`);
  return other.id;
};

test('wrong origin is refused for second exam commands', async ({
  request,
}) => {
  const { examA, examB } = await publishExamPair({
    db: serviceDb,
    owner: sqlRunnerAs('owner'),
    audioA: createTestRecording(587),
    audioB: createTestRecording(593),
  });
  const examIds = [examA.examId, examB.examId];

  for (const server of SERVERS) {
    const where = server.origin;
    const victim = await createGuest();
    const trusted = { token: victim.token, server: server.origin };
    const send = (pathname: string, body: unknown) =>
      postCommand(request, pathname, body, trusted);

    // The victim really works on this server: an attempt of B with an answer.
    const started = await send(
      START_PATH,
      await startBody(examB.slug, { expectedVersionId: examB.versionId }),
    );
    expect(started.status, where).toBe(200);
    const attemptId = (started.body.result as { attemptId: string }).attemptId;
    const answerPath = `/api/attempts/${attemptId}/answer`;
    const submitPath = `/api/attempts/${attemptId}/submit`;
    const first = await send(answerPath, {
      questionId: 'hoeren-1',
      optionId: fullKeyOf('hoeren-1'),
      revision: 1,
    });
    expect(first.status, where).toBe(200);
    const confirmation = await confirmationOf(request, attemptId, trusted);

    // The three commands of the attacker. The answer rewrites a stored
    // answer, so the confirmation of the submission stays the valid one.
    const startOfA = await startBody(examA.slug, {
      expectedVersionId: examA.versionId,
    });
    const answer = {
      questionId: 'hoeren-1',
      optionId: otherOptionOf('hoeren-1'),
      revision: 2,
    };
    const submit = {
      commandId: randomUUID(),
      answers: [],
      confirmation,
    };
    const commands: [string, string, unknown][] = [
      ['start', START_PATH, startOfA],
      ['answer', answerPath, answer],
      ['submit', submitPath, submit],
    ];

    const before = guestRows(victim.sessionId);
    const owners = examAttemptOwners(examIds);
    expect(before.attempts).toHaveLength(1);
    expect(before.attempts[0]?.answers).toHaveLength(1);
    expect(before.attempts[0]?.result).toBeNull();

    const siblings = SERVERS.filter((other) => other !== server).map(
      (other) => other.origin,
    );
    const port = new URL(server.origin).port;
    const origins: (string | null)[] = [
      null,
      'null',
      'https://evil.example',
      ...siblings,
      // The same machine under another name, scheme or spelling: the rule is
      // the exact configured string, not the host of the request.
      `http://127.0.0.1:${port}`,
      `https://localhost:${port}`,
      `${server.origin}/`,
      `${server.origin}.evil.example`,
      server.origin.toUpperCase(),
    ];
    for (const origin of origins) {
      for (const [name, pathname, body] of commands) {
        const reply = await postCommand(request, pathname, body, {
          token: victim.token,
          server: server.origin,
          origin,
          // A trusted Referer does not stand in for the Origin.
          headers: { referer: `${server.origin}/exams` },
        });
        const label = `${where} ${name} origin ${String(origin)}`;
        expect(reply.status, label).toBe(403);
        expect(reply.body, label).toEqual({
          ok: false,
          failure: 'origin-refused',
        });
        expect(reply.cacheControl, label).toBe('private, no-store');
      }
    }
    expect(guestRows(victim.sessionId), where).toEqual(before);
    expect(examAttemptOwners(examIds), where).toEqual(owners);

    // The control: the very same bodies with the Origin this server trusts.
    const answered = await send(answerPath, answer);
    expect(answered.status, where).toBe(200);
    expect(answered.body, where).toMatchObject({ ok: true });
    const startedA = await send(START_PATH, startOfA);
    expect(startedA.status, where).toBe(200);
    expect(startedA.body, where).toMatchObject({
      ok: true,
      result: { outcome: 'accepted' },
    });
    const submitted = await send(submitPath, submit);
    expect(submitted.status, where).toBe(200);
    expect(submitted.body, where).toMatchObject({ ok: true });

    const after = guestRows(victim.sessionId);
    expect(after.attempts, where).toHaveLength(2);
    const ofB = after.attempts.find((item) => item.attempt.id === attemptId);
    expect(ofB?.attempt.status, where).toBe('completed');
    expect(ofB?.result, where).not.toBeNull();
    expect(ofB?.answers, where).toMatchObject([
      { question_id: 'hoeren-1', option_id: answer.optionId, revision: 2 },
    ]);
    const ofA = after.attempts.find((item) => item.attempt.id !== attemptId);
    expect(ofA?.attempt, where).toMatchObject({
      exam_id: examA.examId,
      exam_version_id: examA.versionId,
      status: 'active',
    });
  }
});
