import { resolveAttemptAudio } from '../../../../../server/audio/audio';
import {
  audioResponse,
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

// The recording of the guest's own attempt, on its own request beside any
// save. The same phase gate as the Server Action of the free player: a full
// exam gets an address only while its Hören is open or for its review.
// Origin, method, type and size are checked before the session; the guest
// comes only from the httpOnly cookie and the attempt only from the address.
export const POST = async (
  request: Request,
  { params }: AttemptRoute,
): Promise<Response> => {
  const command = await readCommandBody(request);
  if (!command.ok) return command.response;
  const { attemptId } = await params;
  const result = await resolveAttemptAudio(
    getServerDeps(),
    await readGuestToken(),
    withAttemptId(command.body, attemptId),
  );
  return audioResponse(result);
};
