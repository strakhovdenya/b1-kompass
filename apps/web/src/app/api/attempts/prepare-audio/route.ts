import { prepareExamAudio } from '../../../../server/audio/audio';
import { audioResponse, readCommandBody } from '../../../../server/next/http';
import { getServerDeps, readGuestToken } from '../../../../server/next/request';

export const dynamic = 'force-dynamic';

// The preparation of a full exam: the address of its one Hören recording
// before any attempt exists. Origin, method, type and size are checked
// before the session; the guest comes only from the httpOnly cookie. It
// creates no attempt, start or deadline and returns no material.
export const POST = async (request: Request): Promise<Response> => {
  const command = await readCommandBody(request);
  if (!command.ok) return command.response;
  const result = await prepareExamAudio(
    getServerDeps(),
    await readGuestToken(),
    command.body,
  );
  return audioResponse(result);
};
