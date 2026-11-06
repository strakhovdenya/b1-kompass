import { readAttemptStatus } from '../../../../../server/attempts/read';
import {
  commandResponse,
  readCommandBody,
  withAttemptId,
} from '../../../../../server/next/http';
import {
  getServerDeps,
  readGuestToken,
} from '../../../../../server/next/request';

export const dynamic = 'force-dynamic';

interface AttemptRoute {
  params: Promise<{ attemptId: string }>;
}

// The status of the guest's own attempt. POST, because reading may close a
// timed run at its deadline and complete a submitted attempt. It is its own
// request, never queued behind a save; only an open timed run is locked, so
// it may wait for a save that holds that row and then judges the deadline
// by the database clock read after the lock. Origin, method,
// type and size are checked before the session; the guest comes only from
// the httpOnly cookie and the attempt only from the address.
export const POST = async (
  request: Request,
  { params }: AttemptRoute,
): Promise<Response> => {
  const command = await readCommandBody(request);
  if (!command.ok) return command.response;
  const { attemptId } = await params;
  const result = await readAttemptStatus(
    getServerDeps(),
    await readGuestToken(),
    withAttemptId(command.body, attemptId),
  );
  return commandResponse(result);
};
