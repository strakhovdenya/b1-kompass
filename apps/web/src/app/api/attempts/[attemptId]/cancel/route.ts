import { cancelAttempt } from '../../../../../server/attempts/cancel';
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

// The cancel of an active attempt, without a result. Origin, method,
// type and size are checked before the session; the guest comes only from
// the httpOnly cookie and the attempt only from the address.
export const POST = async (
  request: Request,
  { params }: AttemptRoute,
): Promise<Response> => {
  const command = await readCommandBody(request);
  if (!command.ok) return command.response;
  const { attemptId } = await params;
  const result = await cancelAttempt(
    getServerDeps(),
    await readGuestToken(),
    withAttemptId(command.body, attemptId),
  );
  return commandResponse(result);
};
