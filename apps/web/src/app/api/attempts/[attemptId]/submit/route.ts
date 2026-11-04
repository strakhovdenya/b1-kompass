import { submitAttempt } from '../../../../../server/attempts/submit';
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

// The final submission. It is sent on its own, never behind a save or the
// place, and accepted before the result is computed. Origin, method,
// type and size are checked before the session; the guest comes only from
// the httpOnly cookie and the attempt only from the address.
export const POST = async (
  request: Request,
  { params }: AttemptRoute,
): Promise<Response> => {
  const command = await readCommandBody(request);
  if (!command.ok) return command.response;
  const { attemptId } = await params;
  const result = await submitAttempt(
    getServerDeps(),
    await readGuestToken(),
    withAttemptId(command.body, attemptId),
  );
  return commandResponse(result);
};
